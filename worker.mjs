import { connect } from "cloudflare:sockets";
import { createHash } from "node:crypto";

const SETTINGS_KEY = "settings";

const upstreamUrl = "https://yshz-user.haier-ioc.com/position/deviceDetailPage";
const upstreamNearPositionUrl = "https://yshz-user.haier-ioc.com/position/nearPosition";

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
const szuCacheTtl = 60 * 1000;
const szuLoginTtl = 30 * 60 * 1000;
let szuCache = { positions: null, fetchedAt: 0 };
let szuLoginCache = { loginCode: null, userId: null, accountId: null, projectId: null, expiresAt: 0 };
let szuLoginPromise = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (request.method === "POST" && pathname === "/api/status") {
        return await handleStatus(request, env, ctx);
      }
      if (request.method === "GET" && pathname === "/api/settings") {
        return await handleGetSettings(request, env);
      }
      if (request.method === "POST" && pathname === "/api/settings") {
        return await handleSaveSettings(request, env);
      }
      if (request.method === "POST" && pathname === "/api/subscriptions") {
        return await handleCreateSubscription(request, env, ctx);
      }
      if (request.method === "DELETE" && pathname.startsWith("/api/subscriptions/")) {
        return await handleCancelSubscription(
          request,
          env,
          decodeURIComponent(pathname.slice("/api/subscriptions/".length))
        );
      }
      if (request.method === "POST" && pathname === "/api/email/test") {
        return await handleTestEmail(request, env);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
    } catch (error) {
      return json(500, { error: "internal_error", message: error.message });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      processSubscriptions(env).catch((error) => {
        console.error(`scheduled subscription check failed: ${error.message}`);
      })
    );
  }
};

function envConfig(env) {
  const reminderLeadMinutes = Number(env.REMINDER_LEAD_MINUTES || 3);
  const positionFetchConcurrency = Math.max(1, Number(env.POSITION_FETCH_CONCURRENCY || 8) || 8);
  // Prefer UPSTREAM_* (documented); keep SZU_* as aliases for older local configs.
  const szuPhone = String(env.UPSTREAM_PHONE || env.SZU_PHONE || "").trim();
  const szuPassword = String(env.UPSTREAM_PASSWORD || env.SZU_PASSWORD || "").trim();
  return {
    reminderLeadMinutes,
    reminderLeadMs: Math.max(1, reminderLeadMinutes) * 60 * 1000,
    positionFetchConcurrency,
    campus: {
      lng: Number(env.CAMPUS_LNG || 113.936759),
      lat: Number(env.CAMPUS_LAT || 22.532761),
      organizationId: Number(env.CAMPUS_ORGANIZATION_ID || 2000009571)
    },
    email: {
      enabled: !/^(0|false|no|off)$/i.test(String(env.EMAIL_ENABLED ?? "true")),
      senderName: env.EMAIL_SENDER_NAME || "洗烘雷达",
      sender: env.EMAIL_SENDER || env.EMAIL_USERNAME || "",
      host: env.EMAIL_SMTP_HOST || "",
      port: Number(env.EMAIL_SMTP_PORT || 465),
      security: String(env.EMAIL_SMTP_SECURITY || "ssl").toLowerCase(),
      username: env.EMAIL_USERNAME || "",
      password: env.EMAIL_PASSWORD || ""
    },
    szu: {
      enabled: Boolean(szuPhone && szuPassword),
      phone: szuPhone,
      password: szuPassword,
      baseUrl: String(env.UPSTREAM_BASE_URL || env.SZU_BASE_URL || szuBaseUrl)
    }
  };
}

function isEmailConfigured(emailConfig) {
  return Boolean(
    emailConfig.enabled &&
      emailConfig.host &&
      emailConfig.port >= 1 &&
      emailConfig.port <= 65535 &&
      emailConfig.username &&
      emailConfig.password
  );
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

async function readJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  if (text.length > 1024 * 128) throw new Error("request body too large");
  return JSON.parse(text);
}

async function loadSettings(env) {
  const raw = await env.SETTINGS.get(SETTINGS_KEY, "json");
  return normalizeSettings(raw || {});
}

async function saveSettings(env, settings) {
  const normalized = normalizeSettings(settings);
  await env.SETTINGS.put(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

function normalizeSettings(raw) {
  const subscriptions = Array.isArray(raw?.subscriptions)
    ? raw.subscriptions.map(normalizeSubscription).filter(Boolean)
    : [];
  return { subscriptions: compactSubscriptions(subscriptions) };
}

function normalizeSubscription(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = raw.kind === "availability" ? "availability" : "machine";
  const machineKeyValue = String(raw.machineKey || "").trim();
  const finishTime = normalizeDateText(raw.finishTime);
  if (!machineKeyValue || (kind === "machine" && !finishTime)) return null;

  const status = ["active", "sent", "canceled", "expired"].includes(raw.status) ? raw.status : "active";
  return {
    id: String(raw.id || crypto.randomUUID()),
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
    remindAt: normalizeDateText(raw.remindAt),
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
    const updatedAt = Date.parse(
      subscription.updatedAt || subscription.sentAt || subscription.canceledAt || subscription.createdAt
    );
    return !Number.isFinite(updatedAt) || updatedAt >= cutoff;
  });
}

function publicSettings(settings, clientId, config) {
  return {
    reminderLeadMinutes: config.reminderLeadMinutes,
    emailServer: {
      enabled: config.email.enabled,
      configured: isEmailConfigured(config.email),
      host: config.email.host
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

function buildRemindAt(finishTime, reminderLeadMs) {
  const finishAt = parseLaundryDate(finishTime).getTime();
  if (!Number.isFinite(finishAt)) return "";
  return new Date(finishAt - reminderLeadMs).toISOString();
}

function normalizeKeyPart(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "-");
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
  ]
    .map(normalizeKeyPart)
    .join("::");
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

async function fetchAllPositions(config) {
  let positions;
  try {
    positions = await fetchCampusPositionCatalog(config);
  } catch (error) {
    console.error(`campus position catalog fetch failed: ${error.message}`);
    positions = defaultPositions.map(normalizePositionInput).filter(Boolean);
  }

  if (!positions.length) {
    positions = defaultPositions.map(normalizePositionInput).filter(Boolean);
  }

  return mapLimit(positions, config.positionFetchConcurrency, (position) => fetchPosition(position));
}

async function fetchCampusPositionCatalog(config) {
  const pageSize = 60;
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  const positions = [];

  while ((page - 1) * pageSize < total && page <= 10) {
    const data = await fetchNearPositionPage(page, pageSize, config);
    total = Number(data.total || 0);
    const items = Array.isArray(data.items) ? data.items : [];
    positions.push(...items.filter((p) => isCampusPosition(p, config)).map(normalizeNearPosition).filter(Boolean));
    if (items.length === 0) break;
    page += 1;
  }

  return positions;
}

async function fetchNearPositionPage(page, pageSize, config) {
  const response = await fetch(upstreamNearPositionUrl, {
    method: "POST",
    headers: upstreamHeaders("pages/tabbar/home"),
    body: JSON.stringify({
      lng: config.campus.lng,
      lat: config.campus.lat,
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

function isCampusPosition(position, config) {
  if (!position || typeof position !== "object") return false;
  if (Number.isFinite(config.campus.organizationId)) {
    return Number(position.organizationId) === config.campus.organizationId;
  }
  return /深圳大学|粤海校区/.test(`${position.name || ""} ${position.address || ""}`);
}

function normalizeNearPosition(position) {
  const positionId = String(position.id || position.positionId || "").trim();
  if (!positionId) return null;
  return normalizePositionInput({
    ...position,
    key: `position-${positionId}`,
    positionId,
    categoryCodeList:
      Array.isArray(position.categoryCodeList) && position.categoryCodeList.length
        ? position.categoryCodeList
        : [position.categoryCode || "00"]
  });
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length || 1);
  if (!items.length) return results;
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
  const categoryResults = await mapLimit(categoryCodes, 3, (categoryCode) =>
    fetchPositionCategory(position, categoryCode)
  );
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
  const values =
    Array.isArray(position.categoryCodeList) && position.categoryCodeList.length
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

  return { categoryCode, total, pages, items };
}

// ─── SZU 南区上游 ─────────────────────────────────────────────

function szuHashPassword(password) {
  // Web Crypto does not support MD5; use node:crypto via nodejs_compat.
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
      password: szuHashPassword(config.szu.password),
      phoneSystem: "android",
      telephone: config.szu.phone,
      type: "0",
      version: "6.5.21"
    });

    const response = await fetch(`${config.szu.baseUrl}/user/login`, {
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

function szuHeaders(projectId) {
  // Workers fetch manages Host/Connection/Accept-Encoding; do not set them.
  return {
    "Config-Project": String(projectId),
    "Config-Keys": "module_list,advertise_type,question_list,service_phone_list,banner_list_app,activity_list_app",
    "User-Agent": "okhttp/4.2.2"
  };
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
    telPhone: config.szu.phone,
    areaId: szuDefaultAreaId,
    markId: szuDefaultMarkId,
    phoneSystem: "android",
    loginCode: loginInfo.loginCode,
    childTypeId: "0",
    telephone: config.szu.phone,
    projectId: String(loginInfo.projectId),
    userId: String(loginInfo.userId),
    version: "6.5.21"
    // 不传 buildingId，获取所有楼栋（春笛、夏筝、秋瑟、冬筑）
  });

  const response = await fetch(`${config.szu.baseUrl}/device/reservation/wash/area/List/v2?${params}`, {
    headers: szuHeaders(loginInfo.projectId)
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
    telephone: config.szu.phone,
    userId: String(loginInfo.userId),
    version: "6.5.21",
    buildingId: String(area.buildingId || szuDefaultBuildingId),
    floorId: String(area.floorId || area.id || ""),
    accountId: String(loginInfo.accountId),
    telPhone: config.szu.phone,
    areaId: String(area.areaId || szuDefaultAreaId),
    pageIndex: String(pageIndex),
    phoneSystem: "android",
    projectId: String(loginInfo.projectId)
  });

  const response = await fetch(`${config.szu.baseUrl}/device/reservation/wash/device/List?${params}`, {
    headers: szuHeaders(loginInfo.projectId)
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
    device.workEndTime,
    device.预计完成时间
  ];
  for (const value of candidates) {
    if (value == null || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      // Treat small numbers as remaining minutes/seconds rather than epoch.
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
          d._floorName = area.floorName;
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

async function fetchCombinedPositions(config, requested = null) {
  const haierPromise = requested
    ? mapLimit(requested, config.positionFetchConcurrency, (position) => fetchPosition(position))
    : fetchAllPositions(config);

  const szuPromise = config.szu.enabled
    ? fetchSZUStatus(config).catch((error) => {
        console.error(`SZU 上游拉取失败: ${error.message}`);
        return [];
      })
    : Promise.resolve([]);

  const [haierPositions, szuPositions] = await Promise.all([haierPromise, szuPromise]);
  return [...haierPositions, ...szuPositions];
}

async function handleStatus(request, env, ctx) {
  const config = envConfig(env);
  try {
    const payload = await readJson(request);
    const requested =
      Array.isArray(payload.positions) && payload.positions.length
        ? payload.positions.map(normalizePositionInput).filter(Boolean)
        : null;

    const positions = await fetchCombinedPositions(config, requested);

    ctx.waitUntil(
      processSubscriptions(env, { positions }).catch((error) => {
        console.error(`subscription check after status failed: ${error.message}`);
      })
    );

    return json(200, { positions, fetchedAt: new Date().toISOString() });
  } catch (error) {
    return json(500, { error: "status_fetch_failed", message: error.message });
  }
}

async function handleGetSettings(request, env) {
  const config = envConfig(env);
  const url = new URL(request.url);
  const clientId = normalizeClientId(url.searchParams.get("clientId"));
  const settings = await loadSettings(env);
  return json(200, publicSettings(settings, clientId, config));
}

async function handleSaveSettings(request, env) {
  const config = envConfig(env);
  try {
    const payload = await readJson(request);
    const clientId = normalizeClientId(payload.clientId);
    if (!clientId) {
      return json(400, { error: "missing_client", message: "无法识别当前浏览器，请刷新后重试" });
    }

    const email = normalizeEmail(payload.email || "");
    if (email === null) {
      return json(400, { error: "invalid_email", message: "邮箱格式不正确" });
    }

    const settings = await loadSettings(env);
    for (const subscription of settings.subscriptions) {
      if (subscription.status !== "active" || subscription.clientId !== clientId) continue;
      if (email) {
        subscription.email = email;
        subscription.updatedAt = new Date().toISOString();
      } else {
        subscription.status = "canceled";
        subscription.canceledAt = new Date().toISOString();
        subscription.updatedAt = subscription.canceledAt;
      }
    }

    await saveSettings(env, settings);
    return json(200, publicSettings(settings, clientId, config));
  } catch (error) {
    return json(400, { error: "settings_save_failed", message: error.message });
  }
}

async function handleCreateSubscription(request, env, ctx) {
  const config = envConfig(env);
  try {
    const payload = await readJson(request);
    const settings = await loadSettings(env);
    const clientId = normalizeClientId(payload.clientId);
    if (!clientId) {
      return json(400, { error: "missing_client", message: "无法识别当前浏览器，请刷新后重试" });
    }

    const email = normalizeEmail(payload.email || "");
    if (email === null || !email) {
      return json(400, { error: "missing_email", message: "请先在设置里填写有效邮箱" });
    }

    const subscription =
      payload.kind === "availability"
        ? buildAvailabilitySubscription(payload, email, clientId)
        : buildSubscription(
            payload.machine && typeof payload.machine === "object" ? payload.machine : payload,
            email,
            clientId,
            config
          );
    if (!subscription) {
      return json(400, { error: "invalid_subscription", message: "提醒设备或完成时间不完整" });
    }

    const finishAt = subscription.finishTime
      ? parseLaundryDate(subscription.finishTime).getTime()
      : Number.POSITIVE_INFINITY;
    if (subscription.kind === "machine" && (!Number.isFinite(finishAt) || finishAt <= Date.now() - 60 * 1000)) {
      return json(400, { error: "invalid_finish_time", message: "这台设备的完成时间已经过期" });
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

    await saveSettings(env, settings);
    ctx.waitUntil(
      processSubscriptions(env).catch((error) => {
        console.error(`subscription check failed: ${error.message}`);
      })
    );
    return json(201, publicSettings(settings, clientId, config));
  } catch (error) {
    return json(400, { error: "subscription_save_failed", message: error.message });
  }
}

function buildSubscription(machine, email, clientId, config) {
  const machineKeyValue = String(machine.machineKey || machine.pinKey || "").trim();
  const finishTime = normalizeDateText(machine.finishTime);
  if (!machineKeyValue || !finishTime) return null;
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind: "machine",
    clientId,
    email,
    machineKey: machineKeyValue,
    machineName: String(machine.machineName || machine.name || "洗衣设备").trim(),
    siteName: String(machine.siteName || "").trim(),
    typeLabel: String(machine.typeLabel || "").trim(),
    finishTime,
    remindAt: buildRemindAt(finishTime, config.reminderLeadMs),
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
  const scopeKey = String(
    payload.scopeKey ||
      (targetMachineKey ? `machine::${targetMachineKey}` : positions.map((position) => position.key).join("+"))
  ).trim();
  const scopeLabel = String(payload.scopeLabel || payload.machineName || "当前范围").trim();
  const machineName = String(payload.machineName || (targetMachineKey ? "洗衣设备" : "一次性空闲提醒")).trim();
  const now = new Date();
  return {
    id: crypto.randomUUID(),
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

async function handleCancelSubscription(request, env, id) {
  const config = envConfig(env);
  const url = new URL(request.url);
  const clientId = normalizeClientId(url.searchParams.get("clientId"));
  const settings = await loadSettings(env);
  const subscription = settings.subscriptions.find((item) => item.id === id);
  if (!subscription || !subscriptionVisibleToClient(subscription, clientId)) {
    return json(404, { error: "subscription_not_found", message: "提醒不存在或已经取消" });
  }

  subscription.status = "canceled";
  subscription.canceledAt = new Date().toISOString();
  subscription.updatedAt = subscription.canceledAt;
  await saveSettings(env, settings);
  return json(200, publicSettings(settings, clientId, config));
}

async function handleTestEmail(request, env) {
  const config = envConfig(env);
  try {
    const payload = await readJson(request);
    const settings = await loadSettings(env);
    const clientId = normalizeClientId(payload.clientId);
    const email = normalizeEmail(payload.email || "");
    if (email === null || !email) {
      return json(400, { error: "missing_email", message: "请先填写有效邮箱" });
    }

    await sendMail(config, {
      recipient: email,
      subject: "【洗烘雷达】测试邮件",
      body: `这是一封来自洗烘雷达的测试邮件。\n\n发送时间：${formatChinaDateTime(new Date().toISOString())}`
    });

    return json(200, publicSettings(settings, clientId, config));
  } catch (error) {
    return json(500, { error: "test_email_failed", message: error.message });
  }
}

async function processSubscriptions(env, { positions } = {}) {
  const config = envConfig(env);
  const settings = await loadSettings(env);
  if (!settings.subscriptions.some((item) => item.status === "active")) return;

  let machineList = positions ? buildMachineList(positions) : null;
  if (!machineList) {
    try {
      machineList = buildMachineList(await fetchCombinedPositions(config));
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
      changed = (await processAvailabilitySubscription(subscription, machineList, now, config)) || changed;
      continue;
    }

    const currentMachine = machineIndex?.get(subscription.machineKey);
    if (currentMachine) {
      changed = applyCurrentMachine(subscription, currentMachine, config) || changed;
    }

    const finishAt = parseLaundryDate(subscription.finishTime).getTime();
    const remindAt = parseLaundryDate(
      subscription.remindAt || buildRemindAt(subscription.finishTime, config.reminderLeadMs)
    ).getTime();
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
      await sendReminderEmail(config, subscription);
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
    await saveSettings(env, settings);
  }
}

async function processAvailabilitySubscription(subscription, machineList, now, config) {
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
      if (positionKeys.size && !positionKeys.has(machine.positionKey) && !positionKeys.has(machine.siteKey))
        return false;
      if (machine.siteState === 2) return false;
      return machine.state === 2 && machine.finishTime;
    })
    .map((machine) => ({
      ...machine,
      finishAt: parseLaundryDate(machine.finishTime).getTime()
    }))
    .filter((machine) => {
      if (!Number.isFinite(machine.finishAt)) return false;
      return now >= machine.finishAt - config.reminderLeadMs && now <= machine.finishAt + 60 * 1000;
    })
    .sort((a, b) => a.finishAt - b.finishAt);

  const candidate = candidates[0];
  if (!candidate) return false;

  Object.assign(subscription, {
    machineName: candidate.machineName,
    siteName: candidate.siteName,
    typeLabel: candidate.typeLabel,
    finishTime: candidate.finishTime,
    remindAt: buildRemindAt(candidate.finishTime, config.reminderLeadMs),
    lastAttemptAt: new Date().toISOString(),
    attempts: subscription.attempts + 1,
    updatedAt: new Date().toISOString()
  });

  try {
    await sendReminderEmail(config, subscription);
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

function applyCurrentMachine(subscription, machine, config) {
  let changed = false;
  for (const field of ["machineName", "siteName", "typeLabel"]) {
    if (machine[field] && subscription[field] !== machine[field]) {
      subscription[field] = machine[field];
      changed = true;
    }
  }

  if (machine.finishTime && subscription.finishTime !== machine.finishTime) {
    subscription.finishTime = machine.finishTime;
    subscription.remindAt = buildRemindAt(machine.finishTime, config.reminderLeadMs);
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

async function sendReminderEmail(config, subscription) {
  const finishText = formatChinaDateTime(subscription.finishTime);
  const subject = `【洗烘雷达】${subscription.machineName} 约 ${config.reminderLeadMinutes} 分钟后空闲`;
  const body = [
    `${subscription.machineName} 约 ${config.reminderLeadMinutes} 分钟后空闲。`,
    "",
    `位置：${subscription.siteName || "未标注"}`,
    `类型：${subscription.typeLabel || "洗衣设备"}`,
    `预计空闲：${finishText}`,
    "",
    "这封邮件由洗烘雷达自动发送。"
  ].join("\n");

  await sendMail(config, { recipient: subscription.email, subject, body });
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

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

async function sendMail(config, { recipient, subject, body }) {
  if (!isEmailConfigured(config.email)) {
    throw new Error("邮件服务器未配置，请检查 EMAIL_SMTP_HOST / EMAIL_USERNAME / EMAIL_PASSWORD");
  }

  const emailConfig = config.email;
  const senderAddress = emailConfig.sender || emailConfig.username;
  const message = buildEmailMessage({
    fromName: emailConfig.senderName,
    fromAddress: senderAddress,
    toAddress: recipient,
    subject,
    body
  });

  const useSsl =
    emailConfig.security === "ssl" || (emailConfig.security === "auto" && emailConfig.port === 465);
  const secureTransport =
    useSsl ? "on" : emailConfig.security === "starttls" || emailConfig.security === "auto" ? "starttls" : "off";

  const socket = connect(
    { hostname: emailConfig.host, port: emailConfig.port },
    { secureTransport }
  );
  await socket.opened;

  const client = new SmtpClient(socket);
  try {
    await client.expect([220]);
    const ehlo = await client.ehlo();
    const startTlsSupported = ehlo.some((line) => /STARTTLS/i.test(line));
    const shouldStartTls =
      secureTransport === "starttls" &&
      (emailConfig.security === "starttls" ||
        (emailConfig.security === "auto" && (emailConfig.port === 587 || startTlsSupported)));

    if (shouldStartTls) {
      await client.startTls();
      await client.ehlo();
    }

    await client.authLogin(emailConfig.username, emailConfig.password);
    await client.sendMessage(senderAddress, recipient, message);
    await client.quit();
  } finally {
    await client.close();
  }
}

function buildEmailMessage({ fromName, fromAddress, toAddress, subject, body }) {
  const bodyBase64 = wrapBase64(textToBase64(body));
  return [
    `From: ${formatEmailAddress(fromName, fromAddress)}`,
    `To: <${toAddress}>`,
    `Subject: ${encodeMimeWord(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@laundry-radar.workers.dev>`,
    "",
    bodyBase64
  ].join("\r\n");
}

function encodeMimeWord(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `=?UTF-8?B?${textToBase64(text)}?=`;
}

function formatEmailAddress(name, address) {
  const displayName = String(name || "").trim();
  return displayName ? `${encodeMimeWord(displayName)} <${address}>` : `<${address}>`;
}

function wrapBase64(value) {
  return String(value)
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
}

class LineReader {
  constructor(readable) {
    this.reader = readable.getReader();
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.closed = false;
  }

  async readLine(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        return line;
      }
      if (this.closed) throw new Error("SMTP 连接已关闭");

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("SMTP 响应超时");

      const result = await Promise.race([
        this.reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("SMTP 响应超时")), remaining))
      ]);

      if (result.done) {
        this.closed = true;
        if (this.buffer) {
          const line = this.buffer.replace(/\r$/, "");
          this.buffer = "";
          return line;
        }
        throw new Error("SMTP 连接已关闭");
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
    }
  }
}

class SmtpClient {
  constructor(socket) {
    this.socket = socket;
    this.writer = socket.writable.getWriter();
    this.reader = new LineReader(socket.readable);
    this.encoder = new TextEncoder();
  }

  async writeLine(line) {
    await this.writer.write(this.encoder.encode(`${line}\r\n`));
  }

  async writeRaw(text) {
    await this.writer.write(this.encoder.encode(text));
  }

  async ehlo() {
    return this.command(`EHLO laundry-radar.workers.dev`, [250]);
  }

  async startTls() {
    await this.command("STARTTLS", [220]);
    await this.writer.close().catch(() => {});
    this.socket = this.socket.startTls();
    await this.socket.opened;
    this.writer = this.socket.writable.getWriter();
    this.reader = new LineReader(this.socket.readable);
  }

  async authLogin(username, password) {
    await this.command("AUTH LOGIN", [334]);
    await this.command(textToBase64(username), [334]);
    await this.command(textToBase64(password), [235]);
  }

  async sendMessage(senderAddress, recipient, message) {
    await this.command(`MAIL FROM:<${senderAddress}>`, [250]);
    await this.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await this.command("DATA", [354]);
    await this.writeRaw(`${message.replace(/^\./gm, "..")}\r\n.\r\n`);
    await this.expect([250]);
  }

  async quit() {
    try {
      await this.command("QUIT", [221]);
    } catch {
      // best-effort
    }
  }

  async close() {
    try {
      await this.writer.close();
    } catch {
      // ignore
    }
    try {
      await this.socket.close();
    } catch {
      // ignore
    }
  }

  async command(command, expectedCodes) {
    await this.writeLine(command);
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
