const stateMap = {
  1: { label: "空闲", bucket: "free" },
  2: { label: "运作中", bucket: "busy" },
  3: { label: "不可用", bucket: "unavailable" }
};

const siteStateMap = {
  1: { label: "营业中", bucket: "open" },
  2: { label: "暂停营业", bucket: "paused" }
};

const deviceTypes = {
  washer: { key: "washer", label: "洗衣机", short: "WASH" },
  dryer: { key: "dryer", label: "烘干机", short: "DRY" },
  shoe: { key: "shoe", label: "洗鞋机", short: "SHOE" },
  dispenser: { key: "dispenser", label: "投放器", short: "DISP" },
  other: { key: "other", label: "设备", short: "DEV" }
};

const defaultPositionId = "37142";
const defaultPositionKey = `position-${defaultPositionId}`;
const defaultPositionLabel = "红豆斋";

const pinnedStorageKey = "laundry.pinnedMachines";
const themeStorageKey = "laundry.theme";
const emailStorageKey = "laundry.recipientEmail";
const clientIdStorageKey = "laundry.clientId";
const autoRefreshIntervalMs = 5 * 60 * 1000;
const manualRefreshMinIntervalMs = 60 * 1000;

const state = {
  data: null,
  settings: null,
  clientId: readClientId(),
  recipientEmail: readRecipientEmail(),
  filter: "",
  siteFilter: "",
  positionFilter: defaultPositionKey,
  typeFilter: "",
  pinnedMachines: readPinnedMachines(),
  timer: null,
  messageTimer: null,
  lastManualRefreshAt: 0,
  settingsOpen: false,
  filtersOpen: false,
  roomSearch: ""
};

const refreshForm = document.querySelector("#refreshForm");
const message = document.querySelector("#message");
const updatedAt = document.querySelector("#updatedAt");
const overviewBar = document.querySelector("#overviewBar");
const summaryGrid = document.querySelector("#summaryGrid");
const siteGrid = document.querySelector("#siteGrid");
const filterOpen = document.querySelector("#filterOpen");
const filterPanel = document.querySelector("#filterPanel");
const filterClose = document.querySelector("#filterClose");
const filterContent = document.querySelector("#filterContent");
const filterSummary = document.querySelector("#filterSummary");
const filterPanelSummary = document.querySelector("#filterPanelSummary");
const autoRefresh = document.querySelector("#autoRefresh");
const themeToggle = document.querySelector("#themeToggle");
const scrollTopButton = document.querySelector("#scrollTopButton");
const settingsOpen = document.querySelector("#settingsOpen");
const settingsPanel = document.querySelector("#settingsPanel");
const settingsClose = document.querySelector("#settingsClose");
const settingsForm = document.querySelector("#settingsForm");
const emailInput = document.querySelector("#emailInput");
const mailServerState = document.querySelector("#mailServerState");
const testEmailButton = document.querySelector("#testEmailButton");
const subscriptionList = document.querySelector("#subscriptionList");

applySavedTheme();
loadSettings();
setTimeout(() => refreshStatus({ quiet: true }), 200);

refreshForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await refreshStatus({ manual: true });
});

filterOpen.addEventListener("click", () => openFilterPanel());
filterClose.addEventListener("click", () => closeFilterPanel());
filterPanel.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-filters]")) {
    closeFilterPanel();
    return;
  }

  const resetButton = event.target.closest("[data-reset-filters]");
  if (resetButton) {
    resetFilters();
    render();
    return;
  }

  const applyButton = event.target.closest("[data-apply-filters]");
  if (applyButton) {
    closeFilterPanel();
    return;
  }

  const choice = event.target.closest("[data-filter-kind]");
  if (!choice) return;

  applyFilterChoice(choice.dataset.filterKind, choice.dataset.filterValue || "");
});

filterPanel.addEventListener("input", (event) => {
  if (!event.target.matches("[data-room-search]")) return;
  state.roomSearch = event.target.value;
  renderFilterPanel();
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
settingsOpen.addEventListener("click", () => openSettingsPanel());
settingsClose.addEventListener("click", () => closeSettingsPanel());
settingsPanel.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-settings]")) closeSettingsPanel();
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveSettings();
});

emailInput.addEventListener("input", () => {
  testEmailButton.disabled = !emailInput.value.trim();
});

testEmailButton.addEventListener("click", () => sendTestEmail());

subscriptionList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cancel-subscription]");
  if (!button) return;
  await cancelSubscription(button.dataset.cancelSubscription);
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.filtersOpen) {
    closeFilterPanel();
    return;
  }
  if (state.settingsOpen) closeSettingsPanel();
});

siteGrid.addEventListener("click", (event) => {
  const subscribeButton = event.target.closest("[data-subscribe-machine]");
  if (subscribeButton) {
    handleMachineOneShotSubscribe(subscribeButton.dataset.subscribeMachine);
    return;
  }

  const reminderButton = event.target.closest("[data-remind-machine]");
  if (reminderButton) {
    handleReminderClick(reminderButton.dataset.remindMachine);
    return;
  }

  const button = event.target.closest("[data-pin-machine]");
  if (!button) return;
  const isPinned = togglePinnedMachine(button.dataset.pinMachine);
  showMessage(isPinned ? "已置顶" : "已取消置顶", "ok");
  render();
});

async function refreshStatus(options = {}) {
  if (options.manual) {
    const remainingMs = manualRefreshMinIntervalMs - (Date.now() - state.lastManualRefreshAt);
    if (remainingMs > 0) {
      showMessage(`手动刷新太快了，${Math.ceil(remainingMs / 1000)} 秒后再试`, "warn");
      return;
    }
    state.lastManualRefreshAt = Date.now();
  }

  setBusy(true);
  if (!state.data) renderSkeleton();
  if (!options.quiet) showMessage("刷新中", "info");

  try {
    const response = await fetch(apiUrl("status"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    }
    mergeStatusPayload(payload);
    await loadSettings({ rerender: false, quiet: true });
    if (!options.quiet) showMessage("已更新", "ok");
    render();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function mergeStatusPayload(payload) {
  const incomingPositions = Array.isArray(payload.positions) ? payload.positions : [];
  ensurePositionFilter(incomingPositions);
  state.data = {
    ...payload,
    positions: incomingPositions
  };
}

async function loadSettings(options = {}) {
  try {
    const response = await fetch(apiUrl(`settings?clientId=${encodeURIComponent(state.clientId)}`));
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    }
    state.settings = payload;
    renderSettingsPanel();
    if (options.rerender !== false) render();
  } catch (error) {
    if (!options.quiet) showMessage(error.message, "error");
  }
}

async function saveSettings() {
  const email = emailInput.value.trim();
  if (email && !isValidEmail(email)) {
    showMessage("邮箱格式不正确", "warn");
    return;
  }

  try {
    setSettingsBusy(true);
    state.recipientEmail = email;
    saveRecipientEmail();
    const response = await fetch(apiUrl("settings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: state.clientId, email })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    }
    state.settings = payload;
    showMessage(email ? "邮箱已保存" : "邮箱已清空", "ok");
    render();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setSettingsBusy(false);
  }
}

async function sendTestEmail() {
  const email = emailInput.value.trim() || state.recipientEmail;
  try {
    setSettingsBusy(true);
    const response = await fetch(apiUrl("email/test"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: state.clientId, email })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    }
    state.settings = payload;
    showMessage("测试邮件已发送", "ok");
    render();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setSettingsBusy(false);
  }
}

async function handleReminderClick(machineKeyValue) {
  const subscription = activeSubscriptionForMachine(machineKeyValue);
  if (subscription) {
    await cancelSubscription(subscription.id);
    return;
  }

  const machine = findMachineByPinKey(machineKeyValue);
  if (!machine?.finishTime) {
    showMessage("这台设备暂时没有完成时间", "warn");
    return;
  }

  const email = recipientEmail();
  if (!email) {
    openSettingsPanel();
    showMessage("先在设置里填写邮箱", "warn");
    return;
  }

  try {
    const response = await fetch(apiUrl("subscriptions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        clientId: state.clientId,
        machine: {
          machineKey: machine.pinKey,
          machineName: machine.name,
          siteName: machine.siteName,
          typeLabel: machine.type?.label,
          finishTime: machine.finishTime
        }
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    }
    state.settings = payload;
    showMessage(payload.emailServer?.configured ? "已订阅完成前提醒" : "已订阅，但服务器邮件未配置", payload.emailServer?.configured ? "ok" : "warn");
    render();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function handleMachineOneShotSubscribe(machineKeyValue) {
  const activeSubscription = activeOneShotSubscriptionForMachine(machineKeyValue);
  if (activeSubscription) {
    await cancelSubscription(activeSubscription.id);
    return;
  }

  const machine = findMachineByPinKey(machineKeyValue);
  if (!machine) {
    showMessage("没有找到这台设备", "warn");
    return;
  }

  const email = recipientEmail();
  if (!email) {
    openSettingsPanel();
    showMessage("先在设置里填写邮箱", "warn");
    return;
  }

  const position = positionForMachine(machine);
  if (!position) {
    showMessage("没有找到这台设备的位置", "warn");
    return;
  }

  try {
    const response = await fetch(apiUrl("subscriptions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "availability",
        email,
        clientId: state.clientId,
        scopeKey: `machine::${machine.pinKey}`,
        scopeLabel: machine.name,
        targetMachineKey: machine.pinKey,
        machineName: machine.name,
        siteName: machine.siteName,
        typeLabel: machine.type?.label,
        positions: [position]
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    }
    state.settings = payload;
    showMessage(payload.emailServer?.configured ? "已订阅这台设备的下一次空闲提醒" : "已订阅，但服务器邮件未配置", payload.emailServer?.configured ? "ok" : "warn");
    render();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function cancelSubscription(subscriptionId) {
  try {
    const response = await fetch(apiUrl(`subscriptions/${encodeURIComponent(subscriptionId)}?clientId=${encodeURIComponent(state.clientId)}`), {
      method: "DELETE"
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    }
    state.settings = payload;
    showMessage("已取消邮件提醒", "ok");
    render();
  } catch (error) {
    showMessage(error.message, "error");
  }
}

function findMachineByPinKey(pinKey) {
  if (!state.data?.positions) return null;
  return getMachines(state.data.positions).find((machine) => machine.pinKey === pinKey) || null;
}

function activeSubscriptionForMachine(machineKeyValue) {
  const subscriptions = state.settings?.subscriptions || [];
  return subscriptions.find((subscription) => subscription.status === "active" && subscription.machineKey === machineKeyValue) || null;
}

function activeOneShotSubscriptionForMachine(machineKeyValue) {
  const scopeKey = `machine::${machineKeyValue}`;
  const subscriptions = state.settings?.subscriptions || [];
  return subscriptions.find(
    (subscription) =>
      subscription.status === "active" &&
      subscription.kind === "availability" &&
      (subscription.targetMachineKey === machineKeyValue ||
        subscription.scopeKey === scopeKey ||
        subscription.machineKey === `availability::${scopeKey}`)
  ) || null;
}

function recipientEmail() {
  return emailInput.value.trim() || state.recipientEmail;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function openSettingsPanel() {
  if (state.filtersOpen) {
    state.filtersOpen = false;
    renderFilterPanel();
    updateFilterSummary();
  }
  state.settingsOpen = true;
  renderSettingsPanel();
  loadSettings({ rerender: false, quiet: true });
  setTimeout(() => emailInput.focus(), 0);
}

function closeSettingsPanel() {
  state.settingsOpen = false;
  renderSettingsPanel();
  settingsOpen.focus();
}

function openFilterPanel() {
  if (state.settingsOpen) {
    state.settingsOpen = false;
    renderSettingsPanel();
  }
  state.filtersOpen = true;
  renderFilterPanel();
  updateFilterSummary();
  setTimeout(() => {
    filterPanel.querySelector("[data-room-search]")?.focus();
  }, 0);
}

function closeFilterPanel() {
  state.filtersOpen = false;
  renderFilterPanel();
  updateFilterSummary();
  filterOpen.focus();
}

function applyFilterChoice(kind, value) {
  if (kind === "position") {
    if (value) state.positionFilter = value;
    render();
    return;
  }

  const stateKey = {
    siteStatus: "siteFilter",
    machineState: "filter",
    type: "typeFilter"
  }[kind];
  if (!stateKey) return;
  state[stateKey] = state[stateKey] === value ? "" : value;
  render();
}

function resetFilters() {
  state.positionFilter = defaultPositionKeyFor(state.data?.positions || []);
  state.siteFilter = "";
  state.filter = "";
  state.typeFilter = "";
  state.roomSearch = "";
}

function updateFilterSummary() {
  const labels = activeFilterLabels();
  const text = labels.length ? labels.join(" · ") : defaultPositionLabel;
  filterSummary.textContent = text;
  filterPanelSummary.textContent = text;
  filterOpen.classList.toggle("active", labels.length > 0);
  filterOpen.setAttribute("aria-expanded", String(state.filtersOpen));
}

function activeFilterLabels() {
  const labels = [];
  if (state.positionFilter) {
    labels.push(positionLabel(state.positionFilter));
  }
  if (state.siteFilter) {
    labels.push(siteStatusLabel(state.siteFilter));
  }
  if (state.filter) {
    labels.push(machineStateFilterLabel(state.filter));
  }
  if (state.typeFilter) {
    labels.push(deviceTypes[state.typeFilter]?.label || state.typeFilter);
  }
  return labels.filter(Boolean);
}

function positionLabel(positionKey) {
  const position = (state.data?.positions || []).find((site) => site.key === positionKey);
  if (position?.name) return position.name;
  if (positionKey === defaultPositionKey) return defaultPositionLabel;
  return "洗衣房";
}

function ensurePositionFilter(positions) {
  if (!Array.isArray(positions) || !positions.length) {
    if (!state.positionFilter) state.positionFilter = defaultPositionKey;
    return;
  }

  if (positions.some((position) => position.key === state.positionFilter)) return;
  state.positionFilter = defaultPositionKeyFor(positions);
}

function defaultPositionKeyFor(positions) {
  const preferred = (positions || []).find(
    (position) => String(position.positionId || "") === defaultPositionId || /红豆斋/.test(String(position.name || ""))
  );
  return preferred?.key || positions?.[0]?.key || defaultPositionKey;
}

function siteStatusLabel(bucket) {
  return bucket === "open" ? "营业中" : bucket === "paused" ? "暂停营业" : "";
}

function machineStateFilterLabel(bucket) {
  return {
    free: "空闲",
    busy: "运作",
    paused: "暂停",
    unavailable: "不可用",
    unknown: "未知"
  }[bucket] || "";
}

function renderFilterPanel() {
  filterPanel.hidden = !state.filtersOpen;
  document.body.classList.toggle("filtersVisible", state.filtersOpen);

  const positions = state.data?.positions || [];
  const machines = state.data ? getMachines(positions) : [];
  const searchText = state.roomSearch;
  const normalizedSearch = String(searchText || "").trim().toLowerCase();
  const shouldRestoreSearchFocus = state.filtersOpen && document.activeElement?.matches("[data-room-search]");
  const visiblePositions = normalizedSearch
    ? positions.filter((site) => `${site.name || ""} ${site.address || ""}`.toLowerCase().includes(normalizedSearch))
    : positions;

  filterContent.innerHTML = `
    ${renderFilterChoiceGroup("营业状态", "siteStatus", [
      { value: "open", label: "营业中", count: positions.filter((site) => siteStateBucket(site) === "open").length },
      { value: "paused", label: "暂停营业", count: positions.filter((site) => siteStateBucket(site) === "paused").length }
    ], state.siteFilter)}
    ${renderFilterChoiceGroup("机器状态", "machineState", [
      { value: "free", label: "空闲", count: countMatching(machines, (machine) => machineStateInfo(machine).bucket === "free") },
      { value: "busy", label: "运作", count: countMatching(machines, (machine) => machineStateInfo(machine).bucket === "busy") },
      { value: "paused", label: "暂停", count: countMatching(machines, (machine) => machineStateInfo(machine).bucket === "paused") },
      { value: "unavailable", label: "不可用", count: countMatching(machines, (machine) => machineStateInfo(machine).bucket === "unavailable") }
    ], state.filter)}
    ${renderFilterChoiceGroup("设备类型", "type", Object.values(deviceTypes)
      .filter((type) => type.key !== "other" && machines.some((machine) => machine.type.key === type.key))
      .map((type) => ({
        value: type.key,
        label: type.label,
        count: countMatching(machines, (machine) => machine.type.key === type.key)
      })), state.typeFilter)}
    <section class="filterBlock">
      <header class="filterBlockHeader">
        <h3>洗衣房</h3>
        <span>${positions.length ? `${visiblePositions.length}/${positions.length}` : "--"}</span>
      </header>
      <input class="roomSearch" type="search" value="${escapeHtml(searchText)}" placeholder="搜索洗衣房" data-room-search>
      <div class="roomFilterList">
        ${
          positions.length
            ? visiblePositions.map(renderRoomFilterOption).join("") || `<p class="filterEmpty">没有匹配的洗衣房</p>`
            : `<p class="filterEmpty">等待同步</p>`
        }
      </div>
    </section>
  `;

  if (shouldRestoreSearchFocus) {
    requestAnimationFrame(() => {
      const input = filterPanel.querySelector("[data-room-search]");
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
}

function renderFilterChoiceGroup(title, kind, options, activeValue) {
  if (!options.length) return "";
  return `
    <section class="filterBlock">
      <header class="filterBlockHeader">
        <h3>${escapeHtml(title)}</h3>
      </header>
      <div class="filterPills">
        ${options.map((option) => renderFilterPill(kind, option, activeValue)).join("")}
      </div>
    </section>
  `;
}

function renderFilterPill(kind, option, activeValue) {
  const isActive = activeValue === option.value;
  return `
    <button class="filterPill ${isActive ? "active" : ""}" type="button" data-filter-kind="${escapeHtml(kind)}" data-filter-value="${escapeHtml(option.value)}" aria-pressed="${String(isActive)}">
      <span>${escapeHtml(option.label)}</span>
      <small>${option.count ?? "--"}</small>
    </button>
  `;
}

function renderRoomFilterOption(site) {
  const machines = getMachines([site]);
  const counts = countDevices(machines);
  const status = siteStateMap[Number(site.state)] || { label: `状态 ${site.state ?? "未知"}`, bucket: "unknown" };
  const isActive = state.positionFilter === site.key;
  return `
    <button class="roomFilterOption ${isActive ? "active" : ""}" type="button" data-filter-kind="position" data-filter-value="${escapeHtml(site.key)}" aria-pressed="${String(isActive)}">
      <span>
        <strong>${escapeHtml(site.name || "洗衣房")}</strong>
        <small>${machines.length} 台 · 空闲 ${counts.free || 0} · 运作 ${counts.busy || 0}</small>
      </span>
      <em class="${escapeHtml(status.bucket)}">${escapeHtml(status.label)}</em>
    </button>
  `;
}

function siteStateBucket(site) {
  return siteStateMap[Number(site.state)]?.bucket || "unknown";
}

function countMatching(items, predicate) {
  return items.reduce((count, item) => count + (predicate(item) ? 1 : 0), 0);
}

function renderSettingsPanel() {
  settingsPanel.hidden = !state.settingsOpen;
  document.body.classList.toggle("settingsVisible", state.settingsOpen);

  const settings = state.settings;
  if (!settings) {
    mailServerState.textContent = "邮件服务未同步";
    subscriptionList.innerHTML = `<p class="subscriptionEmpty">暂无提醒</p>`;
    return;
  }

  if (document.activeElement !== emailInput) {
    emailInput.value = state.recipientEmail || "";
  }

  const configured = settings.emailServer?.configured;
  mailServerState.textContent = configured ? "邮件服务已配置" : "邮件服务未配置";
  mailServerState.dataset.tone = configured ? "ok" : "warn";
  testEmailButton.disabled = !emailInput.value.trim();

  const subscriptions = Array.isArray(settings.subscriptions) ? settings.subscriptions : [];
  if (!subscriptions.length) {
    subscriptionList.innerHTML = `<p class="subscriptionEmpty">暂无提醒</p>`;
    return;
  }

  subscriptionList.innerHTML = subscriptions.map(renderSubscriptionItem).join("");
}

function renderSubscriptionItem(subscription) {
  const isActive = subscription.status === "active";
  const isAvailability = subscription.kind === "availability";
  const isMachineAvailability = isAvailability && subscription.targetMachineKey;
  const title = isAvailability
    ? isMachineAvailability ? subscription.machineName || "一次性空闲提醒" : "一次性空闲提醒"
    : subscription.machineName || "洗衣设备";
  const place = isAvailability && subscription.status === "active"
    ? subscription.scopeLabel || "当前范围"
    : subscription.siteName || "未标注";
  return `
    <article class="subscriptionItem ${escapeHtml(subscription.status)}">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(place)} · ${escapeHtml(subscriptionStatusText(subscription))}</span>
        <small>${escapeHtml(formatReminderLine(subscription))}</small>
      </div>
      ${
        isActive
          ? `<button class="iconOnlyButton" type="button" data-cancel-subscription="${escapeHtml(subscription.id)}" aria-label="取消提醒">
              <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 6 6 18"></path>
                <path d="m6 6 12 12"></path>
              </svg>
            </button>`
          : ""
      }
    </article>
  `;
}

function subscriptionStatusText(subscription) {
  if (subscription.kind === "availability" && subscription.targetMachineKey && subscription.status === "active") return "等待这台设备空闲";
  if (subscription.kind === "availability" && subscription.status === "active") return "等待下一台空闲";
  if (subscription.status === "active") return "等待发送";
  if (subscription.status === "sent") return "已发送";
  if (subscription.status === "canceled") return "已取消";
  if (subscription.status === "expired") return subscription.lastError ? "发送失败" : "已过期";
  return "未知状态";
}

function formatReminderLine(subscription) {
  if (subscription.lastError) return subscription.lastError;
  if (subscription.kind === "availability" && subscription.targetMachineKey && subscription.status === "active") return "这台设备进入空闲前 3 分钟时提醒一次";
  if (subscription.kind === "availability" && subscription.status === "active") return "任一设备进入空闲前 3 分钟时提醒一次";
  if (subscription.status === "sent" && subscription.sentAt) return `发送于 ${formatDateTime(subscription.sentAt)}`;
  if (subscription.remindAt) return `提醒 ${formatDateTime(subscription.remindAt)} · 完成 ${formatDateTime(subscription.finishTime)}`;
  return `完成 ${formatDateTime(subscription.finishTime)}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "--");
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function setSettingsBusy(isBusy) {
  settingsForm.querySelector("button").disabled = isBusy;
  testEmailButton.disabled = isBusy || !emailInput.value.trim();
  settingsPanel.setAttribute("aria-busy", String(isBusy));
}

function render() {
  updateFilterSummary();
  renderFilterPanel();

  if (!state.data) {
    updatedAt.textContent = "未刷新";
    overviewBar.innerHTML = renderOverviewShell();
    summaryGrid.innerHTML = "";
    siteGrid.innerHTML = renderWarmupWall();
    renderSettingsPanel();
    return;
  }

  const machines = getMachines(state.data.positions);
  const siteFilteredMachines = filterBySite(machines);
  const fetchedAt = new Date(state.data.fetchedAt);
  updatedAt.textContent = `更新于 ${formatTime(fetchedAt)}`;
  overviewBar.innerHTML = renderOverview(siteFilteredMachines);
  summaryGrid.innerHTML = "";
  siteGrid.innerHTML = renderMachineWall(siteFilteredMachines);
  renderSettingsPanel();
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
  const siteCount = new Set(machines.map((machine) => machine.siteKey).filter(Boolean)).size;
  const reservableCount = machines.filter(isReservable).length;
  const nextBusy = machines
    .filter((machine) => machineStateInfo(machine).bucket === "busy" && machine.finishTime)
    .sort((a, b) => new Date(a.finishTime) - new Date(b.finishTime))[0];

  return `
    <div class="overviewMetric primaryMetric">
      <span>空闲机器</span>
      <strong>${counts.free}</strong>
      <small>${siteCount} 个洗衣房 · ${total} 台设备 · ${dryerCount} 台烘干</small>
    </div>
    <div class="overviewMetric">
      <span>正在运作</span>
      <strong>${counts.busy}</strong>
      <small>运作率 ${busyRate}% · 暂停 ${counts.paused || 0} 台 · 可约 ${reservableCount} 台</small>
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
    if (!state.filter) return true;
    return machineStateInfo(machine).bucket === state.filter;
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
  const stateInfo = machineStateInfo(machine);
  const reserveInfo = reserveStatus(machine, stateInfo);
  const stateBadgeLabel = machineStateBadgeLabel(machine, stateInfo);
  const type = machine.type || deviceTypes.washer;
  const isPinnedMachine = isPinned(machine);
  const classes = ["machineCard", stateInfo.bucket, type.key, machine.placeholder ? "placeholder" : ""]
    .concat(isPinnedMachine ? "pinned" : [])
    .filter(Boolean)
    .join(" ");
  const machineActions = machine.placeholder
    ? ""
    : `
      <div class="machineActions">
        <button class="pinButton ${isPinnedMachine ? "active" : ""}" type="button" data-pin-machine="${escapeHtml(machine.pinKey)}" title="${isPinnedMachine ? "取消置顶" : "置顶这台"}" aria-label="${isPinnedMachine ? `取消置顶 ${escapeHtml(machine.name)}` : `置顶 ${escapeHtml(machine.name)}`}" aria-pressed="${String(isPinnedMachine)}">
          <svg class="pinIcon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m15 4 5 5"></path>
            <path d="M14 5 8 11l-4 1 8 8 1-4 6-6"></path>
            <path d="m9 15-5 5"></path>
          </svg>
        </button>
        ${renderMachineSubscribeButton(machine)}
      </div>
  `;

  return `
    <article class="${classes}" style="--machine-delay: ${((index % 7) * -0.12).toFixed(2)}s" aria-label="${escapeHtml(machine.name)}，${escapeHtml(stateBadgeLabel)}${reserveInfo ? `，${escapeHtml(reserveInfo.label)}` : ""}">
      ${machineActions}
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
        </div>
        <span class="machineDetail">${escapeHtml(type.label)} · ${escapeHtml(machine.siteName)} · ${escapeHtml(floorLabel(machine.floorCode))}</span>
        ${renderMachineFooter(machine, stateInfo, stateBadgeLabel, reserveInfo)}
      </div>
    </article>
  `;
}

function renderMachineSubscribeButton(machine) {
  const subscription = activeOneShotSubscriptionForMachine(machine.pinKey);
  const label = subscription ? "取消订阅一次" : "订阅一次";
  return `
    <button class="reminderButton machineSubscribeButton ${subscription ? "active" : ""}" type="button" data-subscribe-machine="${escapeHtml(machine.pinKey)}" title="${label}" aria-label="${label} ${escapeHtml(machine.name)}" aria-pressed="${String(Boolean(subscription))}">
      <svg class="pinIcon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"></path>
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 7-3 9h18c0-2-3-2-3-9"></path>
      </svg>
    </button>
  `;
}

function renderMachineFooter(machine, stateInfo, stateBadgeLabel, reserveInfo) {
  return `
    <div class="machineFooter">
      <span class="machineBadges">
        <span class="machineBadge ${stateInfo.bucket}">${escapeHtml(stateBadgeLabel)}</span>
        ${reserveInfo ? `<span class="machineBadge ${reserveInfo.className}" title="${escapeHtml(reserveInfo.title)}">${escapeHtml(reserveInfo.label)}</span>` : ""}
      </span>
    </div>
  `;
}

function machineStateBadgeLabel(machine, stateInfo) {
  if (stateInfo.bucket === "busy" && machine.finishTime) {
    return `预计 ${machine.finishTime.slice(11, 16)} 完成`;
  }
  return stateInfo.label;
}

function machineStateInfo(machine) {
  if (isSitePaused(machine)) {
    return { label: "暂停营业", bucket: "paused" };
  }
  return stateMap[machine.state] || { label: `状态 ${machine.state ?? "未知"}`, bucket: "unknown" };
}

function isSitePaused(machine) {
  return Number(machine.siteState) === 2 || machine.siteStatus?.bucket === "paused";
}

function getMachines(sites) {
  return sites.flatMap((site) => {
    const items = Array.isArray(site.items) ? site.items : [];
    const siteState = Number(site.state);
    const siteStatus = siteStateMap[siteState] || { label: `场地状态 ${site.state ?? "未知"}`, bucket: "unknown" };
    return items.map((item) => ({
      ...item,
      pinKey: machineKey(site, item),
      siteKey: site.key,
      siteState: Number.isFinite(siteState) ? siteState : null,
      siteStatus,
      siteName: site.name,
      type: inferType(site, item)
    }));
  });
}

function filterBySite(machines) {
  const requiredPositionFilter = state.positionFilter || defaultPositionKeyFor(state.data?.positions || []);
  return machines.filter((machine) => {
    if (machine.siteKey !== requiredPositionFilter) return false;
    if (state.siteFilter === "open" && isSitePaused(machine)) return false;
    if (state.siteFilter === "paused" && !isSitePaused(machine)) return false;
    if (state.typeFilter && machine.type.key !== state.typeFilter) return false;
    return true;
  });
}

function positionForMachine(machine) {
  const sites = state.data?.positions || [];
  const position = sites.find((site) => site.key === machine.siteKey);
  if (!position) return null;
  return {
    key: position.key,
    name: position.name,
    positionId: position.positionId,
    categoryCode: position.categoryCode,
    categoryCodeList: position.categoryCodeList,
    floorCode: position.floorCode ?? "",
    state: position.state,
    workTime: position.workTime,
    idleCount: position.idleCount,
    reserveNum: position.reserveNum,
    enableReserve: position.enableReserve
  };
}

function hasSelectedPositionData() {
  return Boolean(state.data?.positions?.length);
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

function normalizeKeyPart(value) {
  return String(value ?? "").trim().replace(/\s+/g, "-");
}

function inferType(site, item) {
  const categoryCode = String(item.categoryCode || site.categoryCode || "");
  const text = `${categoryCode} ${site.name || ""} ${item.name || ""}`.toLowerCase();
  // Upstream category codes: 00 washer, 02 dryer, 09 detergent dispenser (often mislabeled).
  // Only treat as shoe washer when the device/site name actually mentions shoes.
  if (categoryCode === "02" || /烘|dryer|dry/.test(text)) {
    return deviceTypes.dryer;
  }
  if (/鞋|shoe/.test(text)) {
    return deviceTypes.shoe;
  }
  if (categoryCode === "09" || /投放|dispenser|detergent/.test(text)) {
    return deviceTypes.dispenser;
  }
  return deviceTypes.washer;
}

function reserveStatus(machine, stateInfo = machineStateInfo(machine)) {
  if (machine.placeholder || stateInfo?.bucket !== "busy") return null;
  if (isReservable(machine)) {
    return {
      label: "可预约",
      className: "reservable",
      title: "这台正在运作，但当前支持预约下一轮"
    };
  }
  if (isReserveEnabled(machine) && machine.reserveState !== undefined && machine.reserveState !== null) {
    return {
      label: "暂不可约",
      className: "notReservable",
      title: "这台正在运作，但当前没有开放预约名额"
    };
  }
  return null;
}

function isReservable(machine) {
  if (isSitePaused(machine)) return false;
  return isReserveEnabled(machine) && Number(machine.reserveState) === 1;
}

function isReserveEnabled(machine) {
  return machine.enableReserve === true || String(machine.enableReserve).toLowerCase() === "true";
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

function readRecipientEmail() {
  try {
    return localStorage.getItem(emailStorageKey) || "";
  } catch {
    return "";
  }
}

function saveRecipientEmail() {
  try {
    if (state.recipientEmail) {
      localStorage.setItem(emailStorageKey, state.recipientEmail);
    } else {
      localStorage.removeItem(emailStorageKey);
    }
  } catch {
    showMessage("邮箱保存失败", "warn");
  }
}

function readClientId() {
  try {
    const savedClientId = localStorage.getItem(clientIdStorageKey);
    if (savedClientId) return savedClientId;
    const clientId = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(clientIdStorageKey, clientId);
    return clientId;
  } catch {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  const bucket = machineStateInfo(machine).bucket;
  if (bucket === "free") return 0;
  if (bucket === "busy") return 1;
  if (bucket === "unavailable") return 2;
  if (bucket === "paused") return 3;
  return 4;
}

function typeOrder(type) {
  if (type === "washer") return 1;
  if (type === "dryer") return 2;
  if (type === "shoe") return 3;
  if (type === "dispenser") return 4;
  return 5;
}

function floorOrder(floor) {
  if (/^B\d+$/i.test(floor)) return -Number(floor.slice(1));
  const numeric = Number(floor);
  return Number.isFinite(numeric) ? numeric : 999;
}

function countDevices(items) {
  return items.reduce(
    (acc, item) => {
      const bucket = machineStateInfo(item).bucket;
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    },
    { free: 0, busy: 0, paused: 0, unavailable: 0, unknown: 0 }
  );
}

function floorLabel(floor) {
  if (!floor) return "未分楼层";
  if (/^B\d+$/i.test(floor)) return floor.toUpperCase();
  return `${floor}F`;
}

function setBusy(isBusy) {
  const button = refreshForm.querySelector('button[type="submit"]');
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
