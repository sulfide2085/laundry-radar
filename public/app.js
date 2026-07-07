const positions = [
  { key: "hongdou-washer", name: "红豆斋洗衣机", positionId: "37142", categoryCode: "00", floorCode: "" },
  { key: "basement-washer", name: "负一层洗衣机", positionId: "37148", categoryCode: "00", floorCode: "B1" },
  { key: "basement-dryer", name: "负一层烘干机", positionId: "37148", categoryCode: "02", floorCode: "" }
];

const stateMap = {
  1: { label: "空闲", bucket: "free" },
  2: { label: "运作中", bucket: "busy" }
};

const deviceTypes = {
  washer: { key: "washer", label: "洗衣机", short: "WASH" },
  dryer: { key: "dryer", label: "烘干机", short: "DRY" }
};

const pinnedStorageKey = "laundry.pinnedMachines";
const themeStorageKey = "laundry.theme";
const autoRefreshIntervalMs = 5 * 60 * 1000;

const state = {
  data: null,
  filter: "all",
  siteFilter: "all",
  pinnedMachines: readPinnedMachines(),
  timer: null,
  messageTimer: null
};

const authForm = document.querySelector("#authForm");
const authToken = document.querySelector("#authToken");
const message = document.querySelector("#message");
const updatedAt = document.querySelector("#updatedAt");
const overviewBar = document.querySelector("#overviewBar");
const summaryGrid = document.querySelector("#summaryGrid");
const siteGrid = document.querySelector("#siteGrid");
const autoRefresh = document.querySelector("#autoRefresh");
const themeToggle = document.querySelector("#themeToggle");
const authMode = document.querySelector("#authMode");
const authStatus = document.querySelector("#authStatus");
const scrollTopButton = document.querySelector("#scrollTopButton");

authToken.value = sessionStorage.getItem("laundry.authToken") || "";
applySavedTheme();
loadConfig();

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await refreshStatus();
});

document.querySelectorAll("[data-state-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.stateFilter;
    document.querySelectorAll("[data-state-filter]").forEach((item) => {
      const isActive = item === button;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-pressed", String(isActive));
    });
    render();
  });
});

document.querySelectorAll("[data-site-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.siteFilter = button.dataset.siteFilter;
    document.querySelectorAll("[data-site-filter]").forEach((item) => {
      const isActive = item === button;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-pressed", String(isActive));
    });
    render();
  });
});

autoRefresh.addEventListener("click", () => {
  setAutoRefresh(autoRefresh.getAttribute("aria-pressed") !== "true");
});

themeToggle.addEventListener("click", () => {
  setNightMode(!document.body.classList.contains("nightMode"));
});

scrollTopButton.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
});

window.addEventListener("scroll", updateScrollTopButton, { passive: true });

siteGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-pin-machine]");
  if (!button) return;
  const isPinned = togglePinnedMachine(button.dataset.pinMachine);
  showMessage(isPinned ? "已置顶" : "已取消置顶", "ok");
  render();
});

async function refreshStatus(options = {}) {
  const token = authToken.value.trim();
  if (token) {
    sessionStorage.setItem("laundry.authToken", token);
  }
  setBusy(true);
  if (!state.data) renderSkeleton();
  if (!options.quiet) showMessage("刷新中", "info");

  try {
    const response = await fetch(apiUrl("status"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authToken: token, positions })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    }
    state.data = payload;
    showMessage("已更新", "ok");
    render();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function loadConfig() {
  try {
    const response = await fetch(apiUrl("config"), { cache: "no-store" });
    const config = await response.json();
    document.body.classList.toggle("localAuth", Boolean(config.hasLocalAuth));
    authMode.textContent = config.hasLocalAuth ? "本机授权" : "手动授权";
    authStatus.querySelector("strong").textContent = config.hasLocalAuth ? "已连接" : "待输入";
    if (config.hasLocalAuth && !authToken.value.trim()) {
      authToken.placeholder = "已读取本机授权";
      setTimeout(() => refreshStatus({ quiet: true }), 200);
    }
  } catch {
    document.body.classList.remove("localAuth");
    authMode.textContent = "手动授权";
    authStatus.querySelector("strong").textContent = "待输入";
  }
}

function render() {
  if (!state.data) {
    updatedAt.textContent = "未刷新";
    overviewBar.innerHTML = renderOverviewShell();
    summaryGrid.innerHTML = "";
    siteGrid.innerHTML = renderWarmupWall();
    return;
  }

  const machines = getMachines(state.data.positions);
  const siteFilteredMachines = filterBySite(machines);
  const fetchedAt = new Date(state.data.fetchedAt);
  updatedAt.textContent = `更新于 ${formatTime(fetchedAt)}`;
  overviewBar.innerHTML = renderOverview(siteFilteredMachines);
  summaryGrid.innerHTML = "";
  siteGrid.innerHTML = renderMachineWall(siteFilteredMachines);
  updateScrollTopButton();
}

function renderOverviewShell() {
  return `
    <div class="overviewMetric primaryMetric">
      <span>空闲机器</span>
      <strong>--</strong>
      <small>等待同步</small>
    </div>
    <div class="overviewMetric">
      <span>正在运作</span>
      <strong>--</strong>
      <small>等待同步</small>
    </div>
    <div class="overviewMetric wide">
      <span>下一台释放</span>
      <strong>--:--</strong>
      <small>打开后自动刷新</small>
    </div>
  `;
}

function renderOverview(machines) {
  const counts = countDevices(machines);
  const total = machines.length;
  const busyRate = total ? Math.round((counts.busy / total) * 100) : 0;
  const dryerCount = machines.filter((machine) => machine.type.key === "dryer").length;
  const nextBusy = machines
    .filter((machine) => machine.state === 2 && machine.finishTime)
    .sort((a, b) => new Date(a.finishTime) - new Date(b.finishTime))[0];

  return `
    <div class="overviewMetric primaryMetric">
      <span>空闲机器</span>
      <strong>${counts.free}</strong>
      <small>${total} 台设备 · ${dryerCount} 台烘干</small>
    </div>
    <div class="overviewMetric">
      <span>正在运作</span>
      <strong>${counts.busy}</strong>
      <small>运作率 ${busyRate}%</small>
    </div>
    <div class="overviewMetric wide">
      <span>下一台释放</span>
      <strong>${nextBusy ? escapeHtml(nextBusy.finishTime.slice(11, 16)) : "--:--"}</strong>
      <small>${nextBusy ? `${escapeHtml(nextBusy.siteName)} · ${escapeHtml(nextBusy.name)}` : "现在没有等待释放的设备"}</small>
    </div>
  `;
}

function renderMachineWall(machines) {
  const visible = sortMachines(machines).filter((machine) => {
    if (state.filter === "all") return true;
    return (stateMap[machine.state]?.bucket || "unknown") === state.filter;
  });

  if (!visible.length) {
    return `<article class="emptyPanel machineEmpty">没有匹配的设备</article>`;
  }

  return visible.map((machine, index) => renderMachine(machine, index)).join("");
}

function renderWarmupWall() {
  const placeholders = Array.from({ length: 18 }, (_, index) => {
    const isDryer = index % 5 === 4;
    return {
      name: `${isDryer ? "烘干机" : "洗衣机"} ${String(index + 1).padStart(2, "0")}`,
      siteName: "同步中",
      floorCode: "",
      state: 1,
      finishTime: "",
      type: isDryer ? deviceTypes.dryer : deviceTypes.washer,
      placeholder: true
    };
  });

  return placeholders.map((machine, index) => renderMachine(machine, index)).join("");
}

function renderMachine(machine, index) {
  const stateInfo = stateMap[machine.state] || { label: `状态 ${machine.state}`, bucket: "unknown" };
  const statusText = machineStatusText(machine, stateInfo);
  const type = machine.type || deviceTypes.washer;
  const isPinnedMachine = isPinned(machine);
  const classes = ["machineCard", stateInfo.bucket, type.key, machine.placeholder ? "placeholder" : ""]
    .concat(isPinnedMachine ? "pinned" : [])
    .filter(Boolean)
    .join(" ");
  const pinButton = machine.placeholder
    ? ""
    : `
      <button class="pinButton ${isPinnedMachine ? "active" : ""}" type="button" data-pin-machine="${escapeHtml(machine.pinKey)}" title="${isPinnedMachine ? "取消置顶" : "置顶这台"}" aria-label="${isPinnedMachine ? `取消置顶 ${escapeHtml(machine.name)}` : `置顶 ${escapeHtml(machine.name)}`}" aria-pressed="${String(isPinnedMachine)}">
        <svg class="pinIcon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m15 4 5 5"></path>
          <path d="M14 5 8 11l-4 1 8 8 1-4 6-6"></path>
          <path d="m9 15-5 5"></path>
        </svg>
      </button>
    `;

  return `
    <article class="${classes}" style="--machine-delay: ${((index % 7) * -0.12).toFixed(2)}s" aria-label="${escapeHtml(machine.name)}，${stateInfo.label}">
      ${pinButton}
      <div class="machineShell" aria-hidden="true">
        <div class="machineCap">
          <span class="statusLight"></span>
          <span class="statusLight small"></span>
          <span class="machineCode">${type.short}</span>
        </div>
        <div class="machineDoor">
          <span class="drum">
            <span class="loadBlob one"></span>
            <span class="loadBlob two"></span>
            <span class="loadBlob three"></span>
          </span>
        </div>
        <div class="machineSlot"></div>
        <div class="machineFeet"><span></span><span></span></div>
      </div>
      <div class="machineMeta">
        <div class="machineTitleRow">
          <strong title="${escapeHtml(machine.name)}">${escapeHtml(machine.name)}</strong>
          <span class="machineBadge ${stateInfo.bucket}">${stateInfo.label}</span>
        </div>
        <span>${escapeHtml(type.label)} · ${escapeHtml(machine.siteName)} · ${escapeHtml(floorLabel(machine.floorCode))}</span>
        <small>${escapeHtml(statusText)}</small>
      </div>
    </article>
  `;
}

function getMachines(sites) {
  return sites.flatMap((site) => {
    const items = Array.isArray(site.items) ? site.items : [];
    return items.map((item) => ({
      ...item,
      pinKey: machineKey(site, item),
      siteKey: site.key,
      siteGroup: inferSiteGroup(site),
      siteName: site.name,
      type: inferType(site, item)
    }));
  });
}

function inferSiteGroup(site) {
  const text = `${site.key || ""} ${site.name || ""}`;
  if (/basement|负一|B1/i.test(text)) return "basement";
  if (/hongdou|红豆/i.test(text)) return "hongdou";
  return "other";
}

function filterBySite(machines) {
  if (state.siteFilter === "all") return machines;
  return machines.filter((machine) => machine.siteGroup === state.siteFilter);
}

function machineKey(site, item) {
  const uniqueDevicePart = item.deviceId ?? item.id ?? item.imei ?? item.deviceNo ?? item.deviceCode ?? item.name;
  return [
    site.key || site.positionId || "site",
    site.categoryCode || "00",
    item.floorCode || site.floorCode || "",
    uniqueDevicePart || item.name || "machine"
  ].map(normalizeKeyPart).join("::");
}

function normalizeKeyPart(value) {
  return String(value ?? "").trim().replace(/\s+/g, "-");
}

function inferType(site, item) {
  const text = `${site.categoryCode || ""} ${site.name || ""} ${item.name || ""}`.toLowerCase();
  if (site.categoryCode === "02" || /烘|dryer|dry/.test(text)) {
    return deviceTypes.dryer;
  }
  return deviceTypes.washer;
}

function machineStatusText(machine, stateInfo) {
  if (machine.placeholder) return "正在同步状态";
  if (stateInfo.bucket === "busy") {
    return machine.finishTime ? `预计 ${machine.finishTime.slice(11, 16)} 完成` : "正在运作";
  }
  if (stateInfo.bucket === "free") return "空闲待用";
  return "状态未识别";
}

function sortMachines(machines) {
  return [...machines].sort((a, b) => {
    const pinDiff = pinOrder(a) - pinOrder(b);
    if (pinDiff) return pinDiff;
    const statusDiff = statusOrder(a) - statusOrder(b);
    if (statusDiff) return statusDiff;
    const siteDiff = String(a.siteName || "").localeCompare(String(b.siteName || ""), "zh-CN", {
      numeric: true,
      sensitivity: "base"
    });
    if (siteDiff) return siteDiff;
    const floorDiff = floorOrder(String(a.floorCode || "")) - floorOrder(String(b.floorCode || ""));
    if (floorDiff) return floorDiff;
    const typeDiff = typeOrder(a.type.key) - typeOrder(b.type.key);
    if (typeDiff) return typeDiff;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN", { numeric: true, sensitivity: "base" });
  });
}

function pinOrder(machine) {
  const index = state.pinnedMachines.indexOf(machine.pinKey);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function isPinned(machine) {
  return state.pinnedMachines.includes(machine.pinKey);
}

function togglePinnedMachine(pinKey) {
  const currentIndex = state.pinnedMachines.indexOf(pinKey);
  if (currentIndex >= 0) {
    state.pinnedMachines.splice(currentIndex, 1);
    savePinnedMachines();
    return false;
  }
  state.pinnedMachines.unshift(pinKey);
  savePinnedMachines();
  return true;
}

function readPinnedMachines() {
  try {
    const parsed = JSON.parse(localStorage.getItem(pinnedStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function savePinnedMachines() {
  try {
    localStorage.setItem(pinnedStorageKey, JSON.stringify(state.pinnedMachines));
  } catch {
    showMessage("置顶保存失败", "warn");
  }
}

function applySavedTheme() {
  const savedTheme = localStorage.getItem(themeStorageKey);
  setNightMode(savedTheme === "dark", { persist: false });
}

function setNightMode(isNightMode, options = {}) {
  document.body.classList.toggle("nightMode", isNightMode);
  themeToggle.classList.toggle("active", isNightMode);
  themeToggle.setAttribute("aria-pressed", String(isNightMode));
  if (options.persist !== false) {
    localStorage.setItem(themeStorageKey, isNightMode ? "dark" : "light");
  }
}

function setAutoRefresh(isEnabled) {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }

  autoRefresh.classList.toggle("active", isEnabled);
  autoRefresh.setAttribute("aria-pressed", String(isEnabled));

  if (isEnabled) {
    state.timer = setInterval(() => refreshStatus({ quiet: true }), autoRefreshIntervalMs);
  }
}

function statusOrder(machine) {
  const bucket = stateMap[machine.state]?.bucket || "unknown";
  if (bucket === "free") return 0;
  if (bucket === "busy") return 1;
  return 2;
}

function typeOrder(type) {
  return type === "dryer" ? 2 : 1;
}

function floorOrder(floor) {
  if (/^B\d+$/i.test(floor)) return -Number(floor.slice(1));
  const numeric = Number(floor);
  return Number.isFinite(numeric) ? numeric : 999;
}

function countDevices(items) {
  return items.reduce(
    (acc, item) => {
      const bucket = stateMap[item.state]?.bucket || "unknown";
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    },
    { free: 0, busy: 0, unknown: 0 }
  );
}

function floorLabel(floor) {
  if (!floor) return "未分楼层";
  if (/^B\d+$/i.test(floor)) return floor.toUpperCase();
  return `${floor}F`;
}

function setBusy(isBusy) {
  const button = authForm.querySelector("button");
  button.disabled = isBusy;
  button.setAttribute("aria-busy", String(isBusy));
  document.body.classList.toggle("busy", isBusy);
}

function showMessage(text, tone) {
  if (state.messageTimer) {
    clearTimeout(state.messageTimer);
    state.messageTimer = null;
  }
  message.textContent = text;
  message.dataset.tone = tone;
  const delay = tone === "error" ? 6500 : tone === "warn" ? 4200 : 2400;
  if (text) {
    state.messageTimer = setTimeout(() => {
      message.textContent = "";
      delete message.dataset.tone;
      state.messageTimer = null;
    }, delay);
  }
}

function formatTime(date) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function updateScrollTopButton() {
  scrollTopButton.classList.toggle("visible", window.scrollY > 280);
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function apiUrl(path) {
  return new URL(`api/${path}`, document.baseURI).toString();
}

function renderSkeleton() {
  overviewBar.innerHTML = renderOverviewShell();
  summaryGrid.innerHTML = "";
  siteGrid.innerHTML = renderWarmupWall();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

render();
updateScrollTopButton();
