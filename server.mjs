import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const localAuthPath = join(__dirname, "auth.local.json");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

const upstreamUrl = "https://yshz-user.haier-ioc.com/position/deviceDetailPage";
const defaultPositions = [
  { key: "hongdou-washer", name: "红豆斋洗衣机", positionId: "37142", categoryCode: "00", floorCode: "" },
  { key: "basement-washer", name: "负一层洗衣机", positionId: "37148", categoryCode: "00", floorCode: "B1" },
  { key: "basement-dryer", name: "负一层烘干机", positionId: "37148", categoryCode: "02", floorCode: "" }
];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readLocalAuthToken() {
  if (process.env.HAIER_AUTH_TOKEN) {
    return process.env.HAIER_AUTH_TOKEN.trim();
  }

  try {
    const raw = await readFile(localAuthPath, "utf8");
    const config = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return String(config.authorization || config.authToken || "").trim();
  } catch {
    return "";
  }
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

function upstreamHeaders(authToken) {
  return {
    appVersion: "2.6.7",
    xweb_xhr: "1",
    appType: "2",
    pageUrl: "subPages/shop/detail",
    authorization: authToken,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090819)XWEB/14315",
    "content-type": "application/json",
    accept: "*/*",
    referer: "https://servicewechat.com/wx7519e26c1d2f9edc/169/page-frame.html",
    "accept-language": "zh-CN,zh;q=0.9"
  };
}

async function fetchDevicePage({ authToken, positionId, categoryCode, floorCode, page, pageSize }) {
  const body = {
    positionId: String(positionId),
    categoryCode: categoryCode || "00",
    page,
    floorCode: floorCode ?? "",
    pageSize
  };

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: upstreamHeaders(authToken),
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

async function fetchPosition(authToken, position) {
  const pageSize = 10;
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  const items = [];
  const pages = [];

  while ((page - 1) * pageSize < total && page <= 20) {
    const data = await fetchDevicePage({
      authToken,
      positionId: position.positionId,
      categoryCode: position.categoryCode || "00",
      floorCode: position.floorCode ?? "",
      page,
      pageSize
    });

    total = Number(data.total || 0);
    const pageItems = Array.isArray(data.items) ? data.items : [];
    items.push(...pageItems);
    pages.push({ page: data.page || page, count: pageItems.length });

    if (pageItems.length === 0) break;
    page += 1;
  }

  return {
    ...position,
    total,
    pages,
    items,
    fetchedAt: new Date().toISOString()
  };
}

async function handleStatus(req, res) {
  try {
    const raw = await readRequestBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const authToken = String(payload.authToken || (await readLocalAuthToken()) || "").trim();

    if (!authToken) {
      sendJson(res, 400, { error: "missing_auth_token" });
      return;
    }

    const requested = Array.isArray(payload.positions) && payload.positions.length
      ? payload.positions
      : defaultPositions;

    const positions = await Promise.all(
      requested.map((position) =>
        fetchPosition(authToken, {
          key: String(position.key || position.positionId),
          name: String(position.name || position.positionId),
          positionId: String(position.positionId),
          categoryCode: String(position.categoryCode || "00"),
          floorCode: position.floorCode ?? ""
        })
      )
    );

    sendJson(res, 200, { positions, fetchedAt: new Date().toISOString() });
  } catch (error) {
    sendJson(res, 500, { error: "status_fetch_failed", message: error.message });
  }
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

async function handleConfig(req, res) {
  const authToken = await readLocalAuthToken();
  sendJson(res, 200, { hasLocalAuth: Boolean(authToken) });
}

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/status") {
    await handleStatus(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/api/config") {
    await handleConfig(req, res);
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
