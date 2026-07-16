import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(__dirname, "data");
const settingsFile = join(dataDir, "settings.json");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const reminderLeadMinutes = Number(process.env.REMINDER_LEAD_MINUTES || 3);
const reminderLeadMs = Math.max(1, reminderLeadMinutes) * 60 * 1000;
const subscriptionCheckIntervalMs = Math.max(15, Number(process.env.SUBSCRIPTION_CHECK_SECONDS || 60)) * 1000;

const upstreamUrl = "https://yshz-user.haier-ioc.com/position/deviceDetailPage";
const upstreamNearPositionUrl = "https://yshz-user.haier-ioc.com/position/nearPosition";
const yuehaiCampus = {
  lng: Number(process.env.CAMPUS_LNG || 113.936759),
  lat: Number(process.env.CAMPUS_LAT || 22.532761),
  organizationId: Number(process.env.CAMPUS_ORGANIZATION_ID || 2000009571)
};
const configuredPositionFetchConcurrency = Number(process.env.POSITION_FETCH_CONCURRENCY || 8);
const positionFetchConcurrency = Number.isFinite(configuredPositionFetchConcurrency)
  ? Math.max(1, configuredPositionFetchConcurrency)
  : 8;
const defaultPositions = [
  { key: "hongdou-washer", name: "红豆斋洗衣机", positionId: "37142", categoryCode: "00", floorCode: "" },
  { key: "basement-washer", name: "负一层洗衣机", positionId: "37148", categoryCode: "00", floorCode: "B1" },
  { key: "basement-dryer", name: "负一层烘干机", positionId: "37148", categoryCode: "02", floorCode: "" }
];

// SZU 南区上游配置
const szuBaseUrl = "https://v3-api.china-qzxy.cn";
const szuDefaultAreaId = "1";
const szuDefaultBuildingId = "245";
const szuDefaultMarkId = "3";
const szuFetchConcurrency = 2;
const szuDevicePageSize = 50;
const szuCacheTtl = 60 * 1000; // 60s 缓存
const szuLoginTtl = 30 * 60 * 1000; // 30min 登录有效
let szuCache = { positions: null, fetchedAt: 0 };
let szuLoginCache = { loginCode: null, userId: null, accountId: null, projectId: null, expiresAt: 0 };
let szuLoginPromise = null;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

const emailConfig = readEmailConfig();
let settingsCache = null;
let settingsWrite = Promise.resolve();
let subscriptionCheckRunning = false;
let subscriptionCheckQueued = false;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1024 * 128) {
      throw new Error("request body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function readBooleanEnv(names, defaultValue) {
  for (const name of names) {
    const value = process.env[name];
    if (value === undefined || String(value).trim() === "") continue;
    return !/^(0|false|no|off)$/i.test(String(value).trim());
  }
  return defaultValue;
}

function readEmailConfig() {
  const sharedConfig = readSharedEmailConfig();
  const hostName = readEnv("EMAIL_SMTP_HOST", "SMTP_HOST") || sharedConfig.smtp_host || "";
  const username = readEnv("EMAIL_USERNAME", "SMTP_USERNAME", "SMTP_USER") || sharedConfig.username || "";
  const password =
    readEnv("EMAIL_PASSWORD", "SMTP_PASSWORD", "SMTP_PASS", "TG_RADAR_SMTP_PASSWORD") || sharedConfig.password || "";
  const portValue = readEnv("EMAIL_SMTP_PORT", "SMTP_PORT") || sharedConfig.smtp_port || "";
  let security = (readEnv("EMAIL_SMTP_SECURITY", "SMTP_SECURITY", "SMTP_SECURE") || sharedConfig.smtp_security || "auto").toLowerCase();
  if (security === "true") security = "ssl";
  if (security === "false") security = "plain";
  if (!["auto", "plain", "starttls", "ssl"].includes(security)) security = "auto";
  return {
    enabled: readBooleanEnv(["EMAIL_ENABLED", "SMTP_ENABLED"], parseConfigBoolean(sharedConfig.enabled, Boolean(hostName && username && password))),
    senderName: readEnv("EMAIL_SENDER_NAME", "SMTP_SENDER_NAME", "SMTP_FROM_NAME") || sharedConfig.sender_name || "洗烘雷达",
    sender: readEnv("EMAIL_SENDER", "SMTP_SENDER", "SMTP_FROM") || sharedConfig.sender || username,
    host: hostName,
    port: Number(portValue || 25),
    security,
    username,
    password
  };
}

function readSharedEmailConfig() {
  const configPath = readEnv("EMAIL_CONFIG_FILE") || join(__dirname, "config.yaml");
  try {
    return parseEmailSection(readFileSync(configPath, "utf8"));
  } catch (error) {
    if (process.env.EMAIL_CONFIG_FILE) {
      console.error(`email config load failed: ${error.message}`);
    }
    return {};
  }
}

function parseConfigSection(text, sectionName) {
  const result = {};
  let inSection = false;

  for (const rawLine of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const sectionPattern = new RegExp(`^${sectionName}:\\s*(?:#.*)?$`);
    if (sectionPattern.test(rawLine)) {
      inSection = true;
      continue;
    }

    if (inSection && /^\S/.test(rawLine)) break;
    if (!inSection) continue;

    const match = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)(?:\s+#.*)?$/.exec(rawLine);
    if (!match) continue;
    result[match[1]] = unquoteConfigValue(match[2]);
  }

  return result;
}

function parseEmailSection(text) {
  return parseConfigSection(text, "email");
}

function unquoteConfigValue(value) {
  const text = String(value || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function readUpstreamConfig() {
  const baseUrl = readEnv("UPSTREAM_BASE_URL") || szuBaseUrl;
  const envPhone = readEnv("UPSTREAM_PHONE");
  const envPassword = readEnv("UPSTREAM_PASSWORD");

  if (envPhone && envPassword) {
    return { enabled: true, baseUrl, phone: envPhone, password: envPassword };
  }

  try {
    const configPath = join(__dirname, "config.yaml");
    const upstream = parseConfigSection(readFileSync(configPath, "utf8"), "upstream");
    const phone = String(upstream.phone || "").trim();
    const password = String(upstream.password || "").trim();
    if (phone && password) {
      return { enabled: true, baseUrl, phone, password };
    }
  } catch {
    // config file not found or unreadable
  }

  return { enabled: false, baseUrl, phone: "", password: "" };
}

function parseConfigBoolean(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function isEmailConfigured() {
  return Boolean(
    emailConfig.enabled &&
      emailConfig.host &&
      emailConfig.port >= 1 &&
      emailConfig.port <= 65535 &&
      emailConfig.username &&
      emailConfig.password
  );
}

async function readJsonBody(req) {
  const raw = await readRequestBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function loadSettings() {
  if (settingsCache) return settingsCache;

  try {
    const raw = await readFile(settingsFile, "utf8");
    settingsCache = normalizeSettings(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`settings load failed: ${error.message}`);
    }
    settingsCache = normalizeSettings({});
  }

  return settingsCache;
}

async function saveSettings(settings) {
  settingsCache = normalizeSettings(settings);
  settingsWrite = settingsWrite.catch(() => {}).then(async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(settingsFile, `${JSON.stringify(settingsCache, null, 2)}\n`, "utf8");
  });
  await settingsWrite;
  return settingsCache;
}

function normalizeSettings(raw) {
  const subscriptions = Array.isArray(raw.subscriptions)
    ? raw.subscriptions.map(normalizeSubscription).filter(Boolean)
    : [];
  return {
    subscriptions: compactSubscriptions(subscriptions)
  };
}

function normalizeSubscription(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind === "availability" ? "availability" : "machine";
  const machineKeyValue = String(raw.machineKey || "").trim();
  const finishTime = normalizeDateText(raw.finishTime);
  if (!machineKeyValue || (kind === "machine" && !finishTime)) return null;

  const status = ["active", "sent", "canceled", "expired"].includes(raw.status) ? raw.status : "active";
  return {
    id: String(raw.id || randomUUID()),
    kind,
    clientId: normalizeClientId(raw.clientId),
    email: normalizeEmail(raw.email || "") || "",
    machineKey: machineKeyValue,
    scopeKey: String(raw.scopeKey || "").trim(),
    scopeLabel: String(raw.scopeLabel || "").trim(),
    targetMachineKey: String(raw.targetMachineKey || "").trim(),
    positions: Array.isArray(raw.positions) ? raw.positions.map(normalizePositionInput).filter(Boolean) : [],
    machineName: String(raw.machineName || "洗衣设备").trim(),
    siteName: String(raw.siteName || "").trim(),
    typeLabel: String(raw.typeLabel || "").trim(),
    finishTime,
    remindAt: normalizeDateText(raw.remindAt) || (finishTime ? buildRemindAt(finishTime) : ""),
    expiresAt: normalizeDateText(raw.expiresAt),
    status,
    createdAt: normalizeDateText(raw.createdAt) || new Date().toISOString(),
    updatedAt: normalizeDateText(raw.updatedAt) || new Date().toISOString(),
    sentAt: normalizeDateText(raw.sentAt),
    canceledAt: normalizeDateText(raw.canceledAt),
    lastAttemptAt: normalizeDateText(raw.lastAttemptAt),
    attempts: Number.isFinite(Number(raw.attempts)) ? Number(raw.attempts) : 0,
    lastError: String(raw.lastError || "").slice(0, 300)
  };
}

function normalizePositionInput(position) {
  if (!position || typeof position !== "object" || !position.positionId) return null;
  const categoryCodeList = Array.isArray(position.categoryCodeList)
    ? uniqueStrings(position.categoryCodeList)
    : uniqueStrings([position.categoryCode || "00"]);
  const state = Number(position.state);
  const appointmentState = Number(position.appointmentState);
  const idleCount = Number(position.idleCount);
  const reserveNum = Number(position.reserveNum);
  const distance = Number(position.distance);
  return {
    key: String(position.key || position.positionId),
    name: String(position.name || position.positionId),
    positionId: String(position.positionId),
    categoryCode: categoryCodeList[0] || "00",
    categoryCodeList,
    floorCode: position.floorCode ?? "",
    state: Number.isFinite(state) ? state : null,
    appointmentState: Number.isFinite(appointmentState) ? appointmentState : null,
    workTime: String(position.workTime || ""),
    idleCount: Number.isFinite(idleCount) ? idleCount : null,
    reserveNum: Number.isFinite(reserveNum) ? reserveNum : null,
    enableReserve: position.enableReserve,
    distance: Number.isFinite(distance) ? distance : null
  };
}

function compactSubscriptions(subscriptions) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return subscriptions.filter((subscription) => {
    if (subscription.status === "active" && !subscription.clientId) return false;
    if (subscription.status === "active") return true;
    const updatedAt = Date.parse(subscription.updatedAt || subscription.sentAt || subscription.canceledAt || subscription.createdAt);
    return !Number.isFinite(updatedAt) || updatedAt >= cutoff;
  });
}

function publicSettings(settings, clientId = "") {
  return {
    reminderLeadMinutes,
    emailServer: {
      enabled: emailConfig.enabled,
      configured: isEmailConfigured(),
      host: emailConfig.host
    },
    subscriptions: settings.subscriptions
      .filter((subscription) => subscriptionVisibleToClient(subscription, clientId))
      .map(publicSubscription)
  };
}

function publicSubscription(subscription) {
  return {
    id: subscription.id,
    kind: subscription.kind || "machine",
    machineKey: subscription.machineKey,
    scopeKey: subscription.scopeKey || "",
    scopeLabel: subscription.scopeLabel || "",
    targetMachineKey: subscription.targetMachineKey || "",
    machineName: subscription.machineName,
    siteName: subscription.siteName,
    typeLabel: subscription.typeLabel,
    finishTime: subscription.finishTime,
    remindAt: subscription.remindAt,
    expiresAt: subscription.expiresAt || "",
    status: subscription.status,
    createdAt: subscription.createdAt,
    sentAt: subscription.sentAt,
    lastError: subscription.lastError
  };
}

function normalizeClientId(value) {
  return String(value || "")
    .trim()
    .replace(/[^\w:.-]/g, "")
    .slice(0, 120);
}

function subscriptionVisibleToClient(subscription, clientId) {
  const normalizedClientId = normalizeClientId(clientId);
  return Boolean(normalizedClientId && subscription.clientId === normalizedClientId);
}

function normalizeEmail(value) {
  const email = String(value || "").trim();
  if (!email) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function normalizeDateText(value) {
  if (!value) return "";
  const date = parseLaundryDate(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function parseLaundryDate(value) {
  const text = String(value || "").trim();
  if (!text) return new Date(Number.NaN);

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    const normalized = text.replace(" ", "T");
    return new Date(`${normalized.length === 16 ? `${normalized}:00` : normalized}+08:00`);
  }

  return new Date(text);
}

function buildRemindAt(finishTime) {
  const finishAt = parseLaundryDate(finishTime).getTime();
  if (!Number.isFinite(finishAt)) return "";
  return new Date(finishAt - reminderLeadMs).toISOString();
}

function normalizeKeyPart(value) {
  return String(value ?? "").trim().replace(/\s+/g, "-");
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function machineKey(site, item) {
  const uniqueDevicePart = item.deviceId ?? item.id ?? item.imei ?? item.deviceNo ?? item.deviceCode ?? item.name;
  return [
    site.key || site.positionId || "site",
    item.categoryCode || site.categoryCode || "00",
    item.floorCode || site.floorCode || "",
    uniqueDevicePart || item.name || "machine"
  ].map(normalizeKeyPart).join("::");
}

function inferTypeLabel(site, item) {
  const categoryCode = String(item.categoryCode || site.categoryCode || "");
  const text = `${categoryCode} ${site.name || ""} ${item.name || ""}`.toLowerCase();
  // Upstream: 00/09 washer, 02 dryer. Shoe only if name says so.
  if (categoryCode === "02" || /烘|dryer|dry/.test(text)) return "烘干机";
  if (/鞋|shoe/.test(text)) return "洗鞋机";
  if (/投放|dispenser|detergent/.test(text)) return "投放器";
  return "洗衣机";
}

function buildMachineIndex(positions) {
  return new Map(buildMachineList(positions).map((machine) => [machine.machineKey, machine]));
}

function buildMachineList(positions) {
  const machines = [];
  for (const site of positions || []) {
    const items = Array.isArray(site.items) ? site.items : [];
    for (const item of items) {
      const key = machineKey(site, item);
      machines.push({
        machineKey: key,
        machineName: String(item.name || "洗衣设备"),
        siteName: String(site.name || ""),
        siteKey: String(site.key || ""),
        positionKey: String(site.key || site.positionId || ""),
        categoryCode: String(item.categoryCode || site.categoryCode || ""),
        typeLabel: inferTypeLabel(site, item),
        state: finiteNumberOrNull(item.state),
        siteState: finiteNumberOrNull(site.state),
        finishTime: normalizeDateText(item.finishTime)
      });
    }
  }
  return machines;
}

function upstreamHeaders(pageUrl = "subPages/shop/detail") {
  return {
    appVersion: "2.6.7",
    xweb_xhr: "1",
    appType: "2",
    pageUrl,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090819)XWEB/14315",
    "content-type": "application/json",
    accept: "*/*",
    referer: "https://servicewechat.com/wx7519e26c1d2f9edc/169/page-frame.html",
    "accept-language": "zh-CN,zh;q=0.9"
  };
}

function szuHeaders(projectId, baseUrl = szuBaseUrl) {
  let host = "v3-api.china-qzxy.cn";
  try {
    host = new URL(baseUrl).host;
  } catch {
    // keep default host
  }
  return {
    "Config-Project": String(projectId),
    "Config-Keys": "module_list,advertise_type,question_list,service_phone_list,banner_list_app,activity_list_app",
    Host: host,
    Connection: "Keep-Alive",
    "Accept-Encoding": "gzip",
    "User-Agent": "okhttp/4.2.2"
  };
}

async function fetchAllPositions() {
  let positions;
  try {
    positions = await fetchCampusPositionCatalog();
  } catch (error) {
    console.error(`campus position catalog fetch failed: ${error.message}`);
    positions = defaultPositions.map(normalizePositionInput).filter(Boolean);
  }

  if (!positions.length) {
    positions = defaultPositions.map(normalizePositionInput).filter(Boolean);
  }

  return mapLimit(positions, positionFetchConcurrency, fetchPosition);
}

async function fetchCampusPositionCatalog() {
  const pageSize = 60;
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  const positions = [];

  while ((page - 1) * pageSize < total && page <= 10) {
    const data = await fetchNearPositionPage(page, pageSize);
    total = Number(data.total || 0);
    const items = Array.isArray(data.items) ? data.items : [];
    positions.push(...items.filter(isCampusPosition).map(normalizeNearPosition).filter(Boolean));
    if (items.length === 0) break;
    page += 1;
  }

  return positions;
}

async function fetchNearPositionPage(page, pageSize) {
  const response = await fetch(upstreamNearPositionUrl, {
    method: "POST",
    headers: upstreamHeaders("pages/tabbar/home"),
    body: JSON.stringify({
      lng: yuehaiCampus.lng,
      lat: yuehaiCampus.lat,
      page,
      pageSize
    })
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`nearPosition returned non-json HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`nearPosition HTTP ${response.status}: ${data.message || text.slice(0, 80)}`);
  }

  if (data.code !== 0) {
    throw new Error(`nearPosition business code ${data.code}: ${data.message || "unknown error"}`);
  }

  return data.data || { page, pageSize, total: 0, items: [] };
}

function isCampusPosition(position) {
  if (!position || typeof position !== "object") return false;
  if (Number.isFinite(yuehaiCampus.organizationId)) {
    return Number(position.organizationId) === yuehaiCampus.organizationId;
  }
  return /深圳大学|粤海校区/.test(`${position.name || ""} ${position.address || ""}`);
}

function normalizeNearPosition(position) {
  const positionId = String(position.id || position.positionId || "").trim();
  if (!positionId) return null;
  const normalized = normalizePositionInput({
    ...position,
    key: `position-${positionId}`,
    positionId,
    categoryCodeList: Array.isArray(position.categoryCodeList) && position.categoryCodeList.length
      ? position.categoryCodeList
      : [position.categoryCode || "00"]
  });
  return normalized;
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    })
  );
  return results;
}

async function fetchDevicePage({ positionId, categoryCode, floorCode, page, pageSize }) {
  const body = {
    positionId: String(positionId),
    categoryCode: categoryCode || "00",
    page,
    floorCode: floorCode ?? "",
    pageSize
  };

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`upstream returned non-json HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`upstream HTTP ${response.status}: ${data.message || text.slice(0, 80)}`);
  }

  if (data.code !== 0) {
    throw new Error(`upstream business code ${data.code}: ${data.message || "unknown error"}`);
  }

  return data.data || { page, pageSize, total: 0, items: [] };
}

async function fetchPosition(position) {
  const categoryCodes = positionCategoryCodes(position);
  const categoryResults = await mapLimit(categoryCodes, 3, (categoryCode) => fetchPositionCategory(position, categoryCode));
  const items = categoryResults.flatMap((result) => result.items);
  const total = categoryResults.reduce((sum, result) => sum + result.total, 0);

  return {
    ...position,
    categoryCode: categoryCodes[0] || position.categoryCode || "00",
    categoryCodeList: categoryCodes,
    total,
    pages: categoryResults.map((result) => ({
      categoryCode: result.categoryCode,
      total: result.total,
      pages: result.pages
    })),
    items,
    fetchedAt: new Date().toISOString()
  };
}

function positionCategoryCodes(position) {
  const values = Array.isArray(position.categoryCodeList) && position.categoryCodeList.length
    ? position.categoryCodeList
    : [position.categoryCode || "00"];
  return uniqueStrings(values);
}

async function fetchPositionCategory(position, categoryCode) {
  const pageSize = 100;
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  const items = [];
  const pages = [];

  while ((page - 1) * pageSize < total && page <= 20) {
    const data = await fetchDevicePage({
      positionId: position.positionId,
      categoryCode,
      floorCode: position.floorCode ?? "",
      page,
      pageSize
    });

    total = Number(data.total || 0);
    const pageItems = Array.isArray(data.items) ? data.items : [];
    items.push(...pageItems.map((item) => ({ ...item, categoryCode })));
    pages.push({ page: data.page || page, count: pageItems.length });

    if (pageItems.length === 0) break;
    page += 1;
  }

  return {
    categoryCode,
    total,
    pages,
    items
  };
}

// ─── SZU 南区上游 ─────────────────────────────────────────────

function szuHashPassword(password) {
  return createHash("md5").update(String(password)).digest("hex").toUpperCase().slice(-10);
}

function clearSzuLoginCache() {
  szuLoginCache = { loginCode: null, userId: null, accountId: null, projectId: null, expiresAt: 0 };
  szuLoginPromise = null;
}

async function ensureSzuLogin(config) {
  if (szuLoginCache.loginCode && Date.now() < szuLoginCache.expiresAt) {
    return szuLoginCache;
  }
  if (szuLoginPromise) return szuLoginPromise;

  szuLoginPromise = (async () => {
    const body = new URLSearchParams({
      identifier: "",
      password: szuHashPassword(config.password),
      phoneSystem: "android",
      telephone: config.phone,
      type: "0",
      version: "6.5.21"
    });

    const response = await fetch(`${config.baseUrl}/user/login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "okhttp/4.2.2"
      },
      body: body.toString()
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`SZU login 返回非 JSON: HTTP ${response.status}`);
    }

    if (!parsed.success || parsed.errorCode !== 0) {
      throw new Error(`SZU 登录失败: ${parsed.errorMessage || `errorCode ${parsed.errorCode}`}`);
    }

    const userData = parsed.data || {};
    const account = userData.userAccount || {};
    const loginCode = userData.loginCode;
    const userId = userData.userId;
    const accountId = account.accountId;
    const projectId = account.projectId;

    if (!loginCode || userId == null || accountId == null || projectId == null) {
      throw new Error("SZU 登录成功但缺少 loginCode/userId/accountId/projectId");
    }

    szuLoginCache = {
      loginCode,
      userId,
      accountId,
      projectId,
      expiresAt: Date.now() + szuLoginTtl
    };

    console.error(`SZU 登录成功, userId=${userId}, projectId=${projectId}`);
    return szuLoginCache;
  })();

  try {
    return await szuLoginPromise;
  } catch (error) {
    clearSzuLoginCache();
    throw error;
  } finally {
    szuLoginPromise = null;
  }
}

async function szuParseJsonResponse(response, label) {
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} 返回非 JSON: HTTP ${response.status}`);
  }
  if (!parsed.success || parsed.errorCode !== 0) {
    const message = `${label} 失败: ${parsed.errorMessage || `errorCode ${parsed.errorCode}`}`;
    if (parsed.errorCode === 401 || /login|登录|鉴权|token/i.test(String(parsed.errorMessage || ""))) {
      clearSzuLoginCache();
    }
    throw new Error(message);
  }
  return parsed;
}

async function szuFetchAreaList(config, loginInfo) {
  const params = new URLSearchParams({
    accountId: String(loginInfo.accountId),
    telPhone: config.phone,
    areaId: szuDefaultAreaId,
    markId: szuDefaultMarkId,
    phoneSystem: "android",
    loginCode: loginInfo.loginCode,
    childTypeId: "0",
    telephone: config.phone,
    projectId: String(loginInfo.projectId),
    userId: String(loginInfo.userId),
    version: "6.5.21"
    // 不传 buildingId，获取所有楼栋（春笛、夏筝、秋瑟、冬筑）
  });

  const response = await fetch(`${config.baseUrl}/device/reservation/wash/area/List/v2?${params}`, {
    headers: szuHeaders(loginInfo.projectId, config.baseUrl)
  });

  const parsed = await szuParseJsonResponse(response, "SZU area/List/v2");
  return Array.isArray(parsed.data) ? parsed.data : [];
}

async function szuFetchDevicePage(config, loginInfo, area, pageIndex, pageSize) {
  const params = new URLSearchParams({
    markId: szuDefaultMarkId,
    loginCode: loginInfo.loginCode,
    pageSize: String(pageSize),
    childTypeId: "0",
    telephone: config.phone,
    userId: String(loginInfo.userId),
    version: "6.5.21",
    buildingId: String(area.buildingId || szuDefaultBuildingId),
    floorId: String(area.floorId || area.id || ""),
    accountId: String(loginInfo.accountId),
    telPhone: config.phone,
    areaId: String(area.areaId || szuDefaultAreaId),
    pageIndex: String(pageIndex),
    phoneSystem: "android",
    projectId: String(loginInfo.projectId)
  });

  const response = await fetch(`${config.baseUrl}/device/reservation/wash/device/List?${params}`, {
    headers: szuHeaders(loginInfo.projectId, config.baseUrl)
  });

  const parsed = await szuParseJsonResponse(response, "SZU device/List");
  return Array.isArray(parsed.data) ? parsed.data : [];
}

async function szuFetchDeviceList(config, loginInfo, area) {
  const pageSize = szuDevicePageSize;
  const allDevices = [];
  let pageIndex = 1;

  while (pageIndex <= 20) {
    const pageItems = await szuFetchDevicePage(config, loginInfo, area, pageIndex, pageSize);
    allDevices.push(...pageItems);
    if (pageItems.length < pageSize) break;
    pageIndex += 1;
  }

  return allDevices;
}

function normalizeSzuFinishTime(device) {
  const candidates = [
    device.finishTime,
    device.endTime,
    device.remainTime,
    device.remainSeconds,
    device.leftTime,
    device.workEndTime
  ];
  for (const value of candidates) {
    if (value == null || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value > 0 && value < 24 * 60) {
        return new Date(Date.now() + value * 60 * 1000).toISOString();
      }
      if (value > 0 && value < 24 * 60 * 60) {
        return new Date(Date.now() + value * 1000).toISOString();
      }
      if (value > 1e11) return new Date(value).toISOString();
      if (value > 1e9) return new Date(value * 1000).toISOString();
    }
    const text = String(value).trim();
    if (!text) continue;
    if (/^\d+$/.test(text)) {
      const number = Number(text);
      if (number > 0 && number < 24 * 60) {
        return new Date(Date.now() + number * 60 * 1000).toISOString();
      }
      if (number > 0 && number < 24 * 60 * 60) {
        return new Date(Date.now() + number * 1000).toISOString();
      }
    }
    const parsed = normalizeDateText(text);
    if (parsed) return parsed;
  }
  return "";
}

function normalizeSZUAreaToPosition(building, devices) {
  const buildingName = String(building.buildingName || building.name || "");

  return {
    key: `szu-${building.buildingId || "0"}`,
    name: buildingName,
    positionId: String(building.buildingId || "0"),
    categoryCode: "00",
    categoryCodeList: ["00"],
    floorCode: "",
    state: 1,
    workTime: "",
    idleCount: devices.filter((d) => Number(d.isUse) === 0).length,
    reserveNum: 0,
    enableReserve: false,
    items: devices.map((device) => {
      const floorCode = String(device._floorName || "").replace(/层$/, "").trim();
      const floorPrefix = floorCode ? `${floorCode}层-` : "";
      return {
        deviceId: device.deviceId,
        name: floorPrefix + (device.deviceName || device.roomName || `设备 ${device.deviceId}`),
        state: Number(device.isUse) === 0 ? 1 : 2,
        categoryCode: String(device.childTypeId || "00"),
        floorCode,
        finishTime: normalizeSzuFinishTime(device),
        workStatusName: device.workStatusName || "",
        onlineStatusId: device.onlineStatusId,
        macAddress: device.macAddress
      };
    }),
    total: devices.length,
    fetchedAt: new Date().toISOString()
  };
}

async function fetchSZUStatus(config) {
  if (szuCache.positions && Date.now() - szuCache.fetchedAt < szuCacheTtl) {
    return szuCache.positions;
  }

  const loginInfo = await ensureSzuLogin(config);
  const areas = await szuFetchAreaList(config, loginInfo);

  if (!areas.length) {
    szuCache = { positions: [], fetchedAt: Date.now() };
    return [];
  }

  // 按 buildingId 分组，每栋楼合并为一个 position
  const buildingMap = new Map();
  for (const area of areas) {
    const bid = area.buildingId;
    if (bid == null) continue;
    if (!buildingMap.has(bid)) {
      buildingMap.set(bid, { buildingId: bid, buildingName: area.buildingName, floors: [] });
    }
    buildingMap.get(bid).floors.push(area);
  }

  const positions = await mapLimit([...buildingMap.values()], szuFetchConcurrency, async (building) => {
    const allDevices = [];
    for (const area of building.floors) {
      try {
        const devices = await szuFetchDeviceList(config, loginInfo, area);
        for (const d of devices) {
          d._floorName = area.floorName; // 保留楼层信息用于前缀
        }
        allDevices.push(...devices);
      } catch (error) {
        console.error(`SZU ${building.buildingName} ${area.floorName || area.floorId}: ${error.message}`);
      }
    }
    return normalizeSZUAreaToPosition(building, allDevices);
  });

  const validPositions = positions.filter(Boolean);
  szuCache = { positions: validPositions, fetchedAt: Date.now() };
  return validPositions;
}

async function fetchCombinedPositions(requested = null) {
  const haierPromise = requested
    ? mapLimit(requested, positionFetchConcurrency, fetchPosition)
    : fetchAllPositions();

  const upstreamConfig = readUpstreamConfig();
  const szuPromise = upstreamConfig.enabled
    ? fetchSZUStatus(upstreamConfig).catch((error) => {
        console.error(`SZU 上游拉取失败: ${error.message}`);
        return [];
      })
    : Promise.resolve([]);

  const [haierPositions, szuPositions] = await Promise.all([haierPromise, szuPromise]);
  return [...haierPositions, ...szuPositions];
}

async function handleStatus(req, res) {
  try {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};

    const requested = Array.isArray(payload.positions) && payload.positions.length
      ? payload.positions.map(normalizePositionInput).filter(Boolean)
      : null;

    const positions = await fetchCombinedPositions(requested);

    processSubscriptions({ positions }).catch((error) => {
      console.error(`subscription check after status failed: ${error.message}`);
    });

    sendJson(res, 200, { positions, fetchedAt: new Date().toISOString() });
  } catch (error) {
    sendJson(res, 500, { error: "status_fetch_failed", message: error.message });
  }
}

async function handleGetSettings(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const clientId = normalizeClientId(requestUrl.searchParams.get("clientId"));
  const settings = await loadSettings();
  sendJson(res, 200, publicSettings(settings, clientId));
}

async function handleSaveSettings(req, res) {
  try {
    const payload = await readJsonBody(req);
    const clientId = normalizeClientId(payload.clientId);
    if (!clientId) {
      sendJson(res, 400, { error: "missing_client", message: "无法识别当前浏览器，请刷新后重试" });
      return;
    }

    const email = normalizeEmail(payload.email || "");
    if (email === null) {
      sendJson(res, 400, { error: "invalid_email", message: "邮箱格式不正确" });
      return;
    }

    const settings = await loadSettings();
    for (const subscription of settings.subscriptions) {
      if (subscription.status !== "active" || subscription.clientId !== clientId) continue;
      if (email) {
        subscription.email = email;
        subscription.updatedAt = new Date().toISOString();
      } else if (!email) {
        subscription.status = "canceled";
        subscription.canceledAt = new Date().toISOString();
        subscription.updatedAt = subscription.canceledAt;
      }
    }

    await saveSettings(settings);
    sendJson(res, 200, publicSettings(settings, clientId));
  } catch (error) {
    sendJson(res, 400, { error: "settings_save_failed", message: error.message });
  }
}

async function handleCreateSubscription(req, res) {
  try {
    const payload = await readJsonBody(req);
    const settings = await loadSettings();
    const clientId = normalizeClientId(payload.clientId);
    if (!clientId) {
      sendJson(res, 400, { error: "missing_client", message: "无法识别当前浏览器，请刷新后重试" });
      return;
    }

    const email = normalizeEmail(payload.email || "");

    if (email === null || !email) {
      sendJson(res, 400, { error: "missing_email", message: "请先在设置里填写有效邮箱" });
      return;
    }

    const subscription =
      payload.kind === "availability"
        ? buildAvailabilitySubscription(payload, email, clientId)
        : buildSubscription(payload.machine && typeof payload.machine === "object" ? payload.machine : payload, email, clientId);
    if (!subscription) {
      sendJson(res, 400, { error: "invalid_subscription", message: "提醒设备或完成时间不完整" });
      return;
    }

    const finishAt = subscription.finishTime ? parseLaundryDate(subscription.finishTime).getTime() : Number.POSITIVE_INFINITY;
    if (subscription.kind === "machine" && (!Number.isFinite(finishAt) || finishAt <= Date.now() - 60 * 1000)) {
      sendJson(res, 400, { error: "invalid_finish_time", message: "这台设备的完成时间已经过期" });
      return;
    }

    const existing = settings.subscriptions.find(
      (item) => item.status === "active" && item.clientId === clientId && item.machineKey === subscription.machineKey
    );
    if (existing) {
      Object.assign(existing, {
        kind: subscription.kind,
        email: subscription.email,
        scopeKey: subscription.scopeKey,
        scopeLabel: subscription.scopeLabel,
        targetMachineKey: subscription.targetMachineKey,
        positions: subscription.positions,
        machineName: subscription.machineName,
        siteName: subscription.siteName,
        typeLabel: subscription.typeLabel,
        finishTime: subscription.finishTime,
        remindAt: subscription.remindAt,
        expiresAt: subscription.expiresAt,
        updatedAt: new Date().toISOString(),
        lastError: ""
      });
    } else {
      settings.subscriptions.unshift(subscription);
    }

    await saveSettings(settings);
    queueSubscriptionCheck();
    sendJson(res, 201, publicSettings(settings, clientId));
  } catch (error) {
    sendJson(res, 400, { error: "subscription_save_failed", message: error.message });
  }
}

function buildSubscription(machine, email, clientId) {
  const machineKeyValue = String(machine.machineKey || machine.pinKey || "").trim();
  const finishTime = normalizeDateText(machine.finishTime);
  if (!machineKeyValue || !finishTime) return null;
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind: "machine",
    clientId,
    email,
    machineKey: machineKeyValue,
    machineName: String(machine.machineName || machine.name || "洗衣设备").trim(),
    siteName: String(machine.siteName || "").trim(),
    typeLabel: String(machine.typeLabel || "").trim(),
    finishTime,
    remindAt: buildRemindAt(finishTime),
    status: "active",
    createdAt: now,
    updatedAt: now,
    sentAt: "",
    canceledAt: "",
    lastAttemptAt: "",
    attempts: 0,
    lastError: ""
  };
}

function buildAvailabilitySubscription(payload, email, clientId) {
  const positions = Array.isArray(payload.positions)
    ? payload.positions.map(normalizePositionInput).filter(Boolean)
    : [];
  if (!positions.length) return null;
  const targetMachineKey = String(payload.targetMachineKey || "").trim();
  const scopeKey = String(payload.scopeKey || (targetMachineKey ? `machine::${targetMachineKey}` : positions.map((position) => position.key).join("+"))).trim();
  const scopeLabel = String(payload.scopeLabel || payload.machineName || "当前范围").trim();
  const machineName = String(payload.machineName || (targetMachineKey ? "洗衣设备" : "一次性空闲提醒")).trim();
  const now = new Date();
  return {
    id: randomUUID(),
    kind: "availability",
    clientId,
    email,
    machineKey: `availability::${scopeKey}`,
    scopeKey,
    scopeLabel,
    targetMachineKey,
    positions,
    machineName,
    siteName: String(payload.siteName || scopeLabel).trim(),
    typeLabel: String(payload.typeLabel || "洗衣机/烘干机").trim(),
    finishTime: "",
    remindAt: "",
    expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    status: "active",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sentAt: "",
    canceledAt: "",
    lastAttemptAt: "",
    attempts: 0,
    lastError: ""
  };
}

async function handleCancelSubscription(req, res, id) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const clientId = normalizeClientId(requestUrl.searchParams.get("clientId"));
  const settings = await loadSettings();
  const subscription = settings.subscriptions.find((item) => item.id === id);
  if (!subscription || !subscriptionVisibleToClient(subscription, clientId)) {
    sendJson(res, 404, { error: "subscription_not_found", message: "提醒不存在或已经取消" });
    return;
  }

  subscription.status = "canceled";
  subscription.canceledAt = new Date().toISOString();
  subscription.updatedAt = subscription.canceledAt;
  await saveSettings(settings);
  sendJson(res, 200, publicSettings(settings, clientId));
}

async function handleTestEmail(req, res) {
  try {
    const payload = await readJsonBody(req);
    const settings = await loadSettings();
    const clientId = normalizeClientId(payload.clientId);
    const email = normalizeEmail(payload.email || "");
    if (email === null || !email) {
      sendJson(res, 400, { error: "missing_email", message: "请先填写有效邮箱" });
      return;
    }

    await sendMail({
      recipient: email,
      subject: "【洗烘雷达】测试邮件",
      body: `这是一封来自洗烘雷达的测试邮件。\n\n发送时间：${formatChinaDateTime(new Date().toISOString())}`
    });

    await saveSettings(settings);
    sendJson(res, 200, publicSettings(settings, clientId));
  } catch (error) {
    sendJson(res, 500, { error: "test_email_failed", message: error.message });
  }
}

function queueSubscriptionCheck() {
  if (subscriptionCheckQueued) return;
  subscriptionCheckQueued = true;
  setTimeout(() => {
    subscriptionCheckQueued = false;
    processSubscriptions().catch((error) => {
      console.error(`subscription check failed: ${error.message}`);
    });
  }, 0);
}

async function processSubscriptions({ positions } = {}) {
  if (subscriptionCheckRunning) return;
  subscriptionCheckRunning = true;

  try {
    const settings = await loadSettings();
    if (!settings.subscriptions.some((item) => item.status === "active")) return;

    let machineList = positions ? buildMachineList(positions) : null;
    if (!machineList) {
      try {
        machineList = buildMachineList(await fetchCombinedPositions());
      } catch (error) {
        console.error(`subscription status fetch failed: ${error.message}`);
      }
    }
    const machineIndex = machineList ? new Map(machineList.map((machine) => [machine.machineKey, machine])) : null;

    let changed = false;
    const now = Date.now();
    for (const subscription of settings.subscriptions) {
      if (subscription.status !== "active") continue;

      if (subscription.kind === "availability") {
        changed = (await processAvailabilitySubscription(subscription, machineList, now)) || changed;
        continue;
      }

      const currentMachine = machineIndex?.get(subscription.machineKey);
      if (currentMachine) {
        changed = applyCurrentMachine(subscription, currentMachine) || changed;
      }

      const finishAt = parseLaundryDate(subscription.finishTime).getTime();
      const remindAt = parseLaundryDate(subscription.remindAt || buildRemindAt(subscription.finishTime)).getTime();
      if (!Number.isFinite(finishAt) || !Number.isFinite(remindAt)) {
        subscription.status = "expired";
        subscription.updatedAt = new Date().toISOString();
        changed = true;
        continue;
      }

      if (now > finishAt + 5 * 60 * 1000) {
        subscription.status = subscription.attempts > 0 ? "sent" : "expired";
        subscription.updatedAt = new Date().toISOString();
        changed = true;
        continue;
      }

      if (now < remindAt) continue;
      if (subscription.lastAttemptAt && now - Date.parse(subscription.lastAttemptAt) < 45 * 1000) continue;

      subscription.lastAttemptAt = new Date().toISOString();
      subscription.attempts += 1;
      changed = true;

      try {
        await sendReminderEmail(subscription);
        subscription.status = "sent";
        subscription.sentAt = new Date().toISOString();
        subscription.updatedAt = subscription.sentAt;
        subscription.lastError = "";
      } catch (error) {
        subscription.lastError = error.message;
        subscription.updatedAt = new Date().toISOString();
        if (now > finishAt + 60 * 1000 || subscription.attempts >= 5) {
          subscription.status = "expired";
        }
        console.error(`subscription email failed: ${error.message}`);
      }
    }

    if (changed) {
      await saveSettings(settings);
    }
  } finally {
    subscriptionCheckRunning = false;
  }
}

async function processAvailabilitySubscription(subscription, machineList, now) {
  const expiresAt = parseLaundryDate(subscription.expiresAt).getTime();
  if (Number.isFinite(expiresAt) && now > expiresAt) {
    subscription.status = "expired";
    subscription.updatedAt = new Date().toISOString();
    return true;
  }

  if (!Array.isArray(machineList) || !machineList.length) return false;

  const positionKeys = new Set((subscription.positions || []).map((position) => String(position.key || "")));
  const targetMachineKey = String(subscription.targetMachineKey || "").trim();
  const candidates = machineList
    .filter((machine) => {
      if (targetMachineKey && machine.machineKey !== targetMachineKey) return false;
      if (positionKeys.size && !positionKeys.has(machine.positionKey) && !positionKeys.has(machine.siteKey)) return false;
      if (machine.siteState === 2) return false;
      return machine.state === 2 && machine.finishTime;
    })
    .map((machine) => ({
      ...machine,
      finishAt: parseLaundryDate(machine.finishTime).getTime()
    }))
    .filter((machine) => {
      if (!Number.isFinite(machine.finishAt)) return false;
      return now >= machine.finishAt - reminderLeadMs && now <= machine.finishAt + 60 * 1000;
    })
    .sort((a, b) => a.finishAt - b.finishAt);

  const candidate = candidates[0];
  if (!candidate) return false;

  Object.assign(subscription, {
    machineName: candidate.machineName,
    siteName: candidate.siteName,
    typeLabel: candidate.typeLabel,
    finishTime: candidate.finishTime,
    remindAt: buildRemindAt(candidate.finishTime),
    lastAttemptAt: new Date().toISOString(),
    attempts: subscription.attempts + 1,
    updatedAt: new Date().toISOString()
  });

  try {
    await sendReminderEmail(subscription);
    subscription.status = "sent";
    subscription.sentAt = new Date().toISOString();
    subscription.updatedAt = subscription.sentAt;
    subscription.lastError = "";
  } catch (error) {
    subscription.lastError = error.message;
    subscription.updatedAt = new Date().toISOString();
    if (now > candidate.finishAt + 60 * 1000 || subscription.attempts >= 5) {
      subscription.status = "expired";
    }
    console.error(`availability email failed: ${error.message}`);
  }

  return true;
}

function applyCurrentMachine(subscription, machine) {
  let changed = false;
  for (const field of ["machineName", "siteName", "typeLabel"]) {
    if (machine[field] && subscription[field] !== machine[field]) {
      subscription[field] = machine[field];
      changed = true;
    }
  }

  if (machine.finishTime && subscription.finishTime !== machine.finishTime) {
    subscription.finishTime = machine.finishTime;
    subscription.remindAt = buildRemindAt(machine.finishTime);
    subscription.lastError = "";
    changed = true;
  }

  if (machine.siteState === 2 || machine.state !== 2) {
    subscription.status = "expired";
    changed = true;
  }

  if (changed) {
    subscription.updatedAt = new Date().toISOString();
  }
  return changed;
}

async function sendReminderEmail(subscription) {
  const finishText = formatChinaDateTime(subscription.finishTime);
  const subject = `【洗烘雷达】${subscription.machineName} 约 ${reminderLeadMinutes} 分钟后空闲`;
  const body = [
    `${subscription.machineName} 约 ${reminderLeadMinutes} 分钟后空闲。`,
    "",
    `位置：${subscription.siteName || "未标注"}`,
    `类型：${subscription.typeLabel || "洗衣设备"}`,
    `预计空闲：${finishText}`,
    "",
    "这封邮件由洗烘雷达自动发送。"
  ].join("\n");

  await sendMail({ recipient: subscription.email, subject, body });
}

function formatChinaDateTime(value) {
  const date = parseLaundryDate(value);
  if (!Number.isFinite(date.getTime())) return String(value || "");
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function sendMail({ recipient, subject, body }) {
  if (!isEmailConfigured()) {
    throw new Error("邮件服务器未配置，请检查 config.yaml 或 EMAIL_SMTP_HOST / EMAIL_USERNAME / EMAIL_PASSWORD");
  }

  const senderAddress = emailConfig.sender || emailConfig.username;
  const message = buildEmailMessage({
    fromName: emailConfig.senderName,
    fromAddress: senderAddress,
    toAddress: recipient,
    subject,
    body
  });

  const useSsl = emailConfig.security === "ssl" || (emailConfig.security === "auto" && emailConfig.port === 465);
  const smtp = await SmtpClient.connect({
    host: emailConfig.host,
    port: emailConfig.port,
    useSsl
  });

  try {
    const ehlo = await smtp.ehlo();
    const startTlsSupported = ehlo.some((line) => /STARTTLS/i.test(line));
    const shouldStartTls =
      !useSsl &&
      (emailConfig.security === "starttls" ||
        (emailConfig.security === "auto" && (emailConfig.port === 587 || startTlsSupported)));

    if (shouldStartTls) {
      await smtp.startTls(emailConfig.host);
      await smtp.ehlo();
    }

    await smtp.authLogin(emailConfig.username, emailConfig.password);
    await smtp.sendMessage(senderAddress, recipient, message);
    await smtp.quit();
  } finally {
    smtp.close();
  }
}

function buildEmailMessage({ fromName, fromAddress, toAddress, subject, body }) {
  const bodyBase64 = wrapBase64(Buffer.from(body, "utf8").toString("base64"));
  return [
    `From: ${formatEmailAddress(fromName, fromAddress)}`,
    `To: <${toAddress}>`,
    `Subject: ${encodeMimeWord(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@laundry-radar.local>`,
    "",
    bodyBase64
  ].join("\r\n");
}

function encodeMimeWord(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function formatEmailAddress(name, address) {
  const displayName = String(name || "").trim();
  return displayName ? `${encodeMimeWord(displayName)} <${address}>` : `<${address}>`;
}

function wrapBase64(value) {
  return String(value).replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function createLineReader(socket) {
  let buffer = "";
  const lines = [];
  const waiters = [];

  function flush() {
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(line);
      } else {
        lines.push(line);
      }
      index = buffer.indexOf("\n");
    }
  }

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    flush();
  });

  socket.on("error", (error) => {
    while (waiters.length) {
      waiters.shift().reject(error);
    }
  });

  socket.on("close", () => {
    while (waiters.length) {
      waiters.shift().reject(new Error("SMTP 连接已关闭"));
    }
  });

  return {
    readLine(timeoutMs = 20_000) {
      if (lines.length) return Promise.resolve(lines.shift());
      return new Promise((resolveLine, rejectLine) => {
        const timeout = setTimeout(() => {
          const index = waiters.findIndex((item) => item.resolve === resolveLine);
          if (index >= 0) waiters.splice(index, 1);
          rejectLine(new Error("SMTP 响应超时"));
        }, timeoutMs);
        waiters.push({
          resolve(line) {
            clearTimeout(timeout);
            resolveLine(line);
          },
          reject(error) {
            clearTimeout(timeout);
            rejectLine(error);
          }
        });
      });
    }
  };
}

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.reader = createLineReader(socket);
  }

  static async connect({ host: smtpHost, port: smtpPort, useSsl }) {
    const socket = useSsl
      ? tls.connect({ host: smtpHost, port: smtpPort, servername: smtpHost, timeout: 20_000 })
      : net.connect({ host: smtpHost, port: smtpPort, timeout: 20_000 });

    await new Promise((resolveConnect, rejectConnect) => {
      const event = useSsl ? "secureConnect" : "connect";
      socket.once(event, resolveConnect);
      socket.once("error", rejectConnect);
      socket.once("timeout", () => rejectConnect(new Error("SMTP 连接超时")));
    });

    const client = new SmtpClient(socket);
    await client.expect([220]);
    return client;
  }

  async ehlo() {
    return this.command(`EHLO ${smtpClientName()}`, [250]);
  }

  async startTls(servername) {
    await this.command("STARTTLS", [220]);
    this.socket.removeAllListeners("data");
    this.socket = await new Promise((resolveTls, rejectTls) => {
      const secured = tls.connect({ socket: this.socket, servername }, () => resolveTls(secured));
      secured.once("error", rejectTls);
    });
    this.reader = createLineReader(this.socket);
  }

  async authLogin(username, password) {
    await this.command("AUTH LOGIN", [334]);
    await this.command(Buffer.from(username, "utf8").toString("base64"), [334]);
    await this.command(Buffer.from(password, "utf8").toString("base64"), [235]);
  }

  async sendMessage(senderAddress, recipient, message) {
    await this.command(`MAIL FROM:<${senderAddress}>`, [250]);
    await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await this.command("DATA", [354]);
    this.socket.write(`${message.replace(/^\./gm, "..")}\r\n.\r\n`);
    await this.expect([250]);
  }

  async quit() {
    try {
      await this.command("QUIT", [221]);
    } catch {
      // Connection shutdown is best-effort after the message is accepted.
    }
  }

  close() {
    if (!this.socket.destroyed) {
      this.socket.end();
    }
  }

  async command(command, expectedCodes) {
    this.socket.write(`${command}\r\n`);
    return this.expect(expectedCodes);
  }

  async expect(expectedCodes) {
    const lines = [];
    let code = "";

    while (true) {
      const line = await this.reader.readLine();
      lines.push(line);
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match) continue;
      code = match[1];
      if (match[2] === " ") break;
    }

    if (!expectedCodes.includes(Number(code))) {
      throw new Error(`SMTP 返回异常：${lines.join(" | ")}`);
    }
    return lines;
  }
}

function smtpClientName() {
  return "laundry-radar.local";
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname;

  if (req.method === "POST" && pathname === "/api/status") {
    await handleStatus(req, res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/settings") {
    await handleGetSettings(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/settings") {
    await handleSaveSettings(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/subscriptions") {
    await handleCreateSubscription(req, res);
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/subscriptions/")) {
    await handleCancelSubscription(req, res, decodeURIComponent(pathname.slice("/api/subscriptions/".length)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/email/test") {
    await handleTestEmail(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405, { allow: "GET, HEAD, POST" });
  res.end("Method not allowed");
});

server.listen(port, host, () => {
  console.log(`Laundry status web listening at http://${host}:${port}`);
});

setInterval(queueSubscriptionCheck, subscriptionCheckIntervalMs).unref();
