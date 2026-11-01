"use strict";

const POLL_INTERVAL = 15_000;
const DEFAULT_REFRESH_INTERVAL = 10 * 60_000;
const SLACK_SEARCH_DEBOUNCE_MS = 120;

let countdownTimer = null;
let refreshTimer = null;
let refreshIntervalMs = DEFAULT_REFRESH_INTERVAL;
let lastFetchedAt = null;
let alertSubscriptions = {};
let sessionState = {
  authenticated: false,
  guest: false,
  slackId: "",
  slackName: "",
};
let slackEnabled = true;
let passwordEnabled = false;
let slackSearchTimer = null;
let slackSearchRequestId = 0;
let slackUsers = [];
let highlightedSlackUserIndex = -1;
let selectedSlackUser = null;

const loginForm = document.getElementById("login-form");
const passwordInput = document.getElementById("password-input");
const slackInputWrap = document.getElementById("slack-input-wrap");
const slackIdInput = document.getElementById("slack-id-input");
const slackUserMenu = document.getElementById("slack-user-menu");
const loginError = document.getElementById("login-error");
const logoutButton = document.getElementById("logout-button");
const enterButton = document.getElementById("enter-button");

async function apiFetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(res.ok
        ? "Server returned a non-JSON response. Restart the server and refresh the page."
        : "Server returned an unexpected response. Restart the server and refresh the page.");
    }
  }

  if (!res.ok) {
    const error = new Error(data?.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }

  return data;
}

function setSessionState(nextState) {
  sessionState = {
    authenticated: nextState?.authenticated === true,
    guest: nextState?.guest === true,
    slackId: typeof nextState?.slackId === "string" ? nextState.slackId : "",
    slackName: typeof nextState?.slackName === "string" ? nextState.slackName : "",
  };
}

function updateSessionUi() {
  const sessionBar = document.querySelector(".session-bar");
  const sessionLabel = document.getElementById("session-label");
  const showBar = slackEnabled || passwordEnabled;
  if (sessionBar) {
    sessionBar.style.display = showBar ? "" : "none";
  }
  if (!showBar) {
    sessionLabel.textContent = "";
    return;
  }
  if (!slackEnabled) {
    sessionLabel.textContent = "";
    return;
  }
  if (sessionState.guest) {
    sessionLabel.textContent = "Guest mode";
    return;
  }

  sessionLabel.textContent = sessionState.slackName || sessionState.slackId;
}

function stopRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function clearSlackSelection() {
  selectedSlackUser = null;
}

function hideSlackUserMenu() {
  slackUserMenu.hidden = true;
  slackUserMenu.innerHTML = "";
  slackUsers = [];
  highlightedSlackUserIndex = -1;
}

function renderSlackUserMenu() {
  if (slackUsers.length === 0) {
    slackUserMenu.innerHTML = '<div class="slack-user-empty">No matching Slack members</div>';
    slackUserMenu.hidden = false;
    highlightedSlackUserIndex = -1;
    return;
  }

  if (highlightedSlackUserIndex < 0 || highlightedSlackUserIndex >= slackUsers.length) {
    highlightedSlackUserIndex = 0;
  }

  slackUserMenu.innerHTML = slackUsers.map((user, index) => {
    const activeClass = index === highlightedSlackUserIndex ? "active" : "";
    return `
      <button type="button" class="slack-user-option ${activeClass}" data-user-index="${index}">
        <span class="slack-user-option-name">${user.name}</span>
      </button>`;
  }).join("");
  slackUserMenu.hidden = false;
}

function applySlackUserSelection(user) {
  selectedSlackUser = user;
  slackIdInput.value = user.name;
  hideSlackUserMenu();
  slackIdInput.focus();
}

async function searchSlackUsers(query) {
  const requestId = ++slackSearchRequestId;
  try {
    const data = await apiFetchJson(`/api/slack/users?q=${encodeURIComponent(query.trim())}`);
    if (requestId !== slackSearchRequestId) {
      return;
    }

    slackUsers = data.users || [];
    highlightedSlackUserIndex = slackUsers.length > 0 ? 0 : -1;
    renderSlackUserMenu();
  } catch {
    if (requestId !== slackSearchRequestId) {
      return;
    }
    slackUsers = [];
    highlightedSlackUserIndex = -1;
    slackUserMenu.innerHTML = '<div class="slack-user-empty">Slack member search is unavailable right now</div>';
    slackUserMenu.hidden = false;
  }
}

function scheduleSlackSearch() {
  if (slackSearchTimer) {
    clearTimeout(slackSearchTimer);
  }

  slackSearchTimer = setTimeout(() => {
    searchSlackUsers(slackIdInput.value);
  }, SLACK_SEARCH_DEBOUNCE_MS);
}

function showLoginScreen() {
  if (!slackEnabled && !passwordEnabled) {
    showDashboard();
    return;
  }

  stopRefreshLoop();
  lastFetchedAt = null;
  alertSubscriptions = {};
  setSessionState({ authenticated: false, guest: false, slackId: "", slackName: "" });
  document.getElementById("app").style.display = "none";
  document.getElementById("login-screen").style.display = "";
  document.getElementById("last-updated").textContent = "Loading...";
  document.getElementById("next-refresh").textContent = "";
  document.getElementById("dashboard").innerHTML = "";
  document.getElementById("charts").innerHTML = "";
  loginError.textContent = "";

  const loginDesc = document.querySelector(".login-box p");

  if (passwordEnabled) {
    passwordInput.hidden = false;
    passwordInput.value = "";
  } else {
    passwordInput.hidden = true;
  }

  if (slackEnabled) {
    slackInputWrap.hidden = false;
    slackIdInput.value = "";
    clearSlackSelection();
    hideSlackUserMenu();
    if (loginDesc) {
      loginDesc.textContent = passwordEnabled
        ? "Enter password and your name for Slack alerts."
        : "Type your name for Slack alerts. Leave empty for guest mode.";
    }
  } else {
    slackInputWrap.hidden = true;
    if (loginDesc) {
      loginDesc.textContent = "Enter the password to continue.";
    }
  }

  const firstInput = passwordEnabled ? passwordInput : slackIdInput;
  firstInput.focus();
}

function showDashboard() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "";
  updateSessionUi();
  refresh();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, POLL_INTERVAL);
}

slackIdInput.addEventListener("input", () => {
  loginError.textContent = "";
  if (!slackIdInput.value.trim()) {
    clearSlackSelection();
    hideSlackUserMenu();
    if (slackSearchTimer) {
      clearTimeout(slackSearchTimer);
    }
    slackSearchRequestId += 1;
    return;
  }

  if (selectedSlackUser && slackIdInput.value.trim() !== selectedSlackUser.name) {
    clearSlackSelection();
  }

  scheduleSlackSearch();
});

slackIdInput.addEventListener("focus", () => {
  loginError.textContent = "";
  if (slackIdInput.value.trim()) {
    scheduleSlackSearch();
  }
});

slackIdInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    if (slackUserMenu.hidden || slackUsers.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    highlightedSlackUserIndex = (highlightedSlackUserIndex + 1) % slackUsers.length;
    renderSlackUserMenu();
    return;
  }

  if (event.key === "ArrowUp") {
    if (slackUserMenu.hidden || slackUsers.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    highlightedSlackUserIndex = (highlightedSlackUserIndex - 1 + slackUsers.length) % slackUsers.length;
    renderSlackUserMenu();
    return;
  }

  if (event.key === "Enter" && !slackUserMenu.hidden && highlightedSlackUserIndex >= 0 && slackUsers[highlightedSlackUserIndex]) {
    event.preventDefault();
    event.stopPropagation();
    applySlackUserSelection(slackUsers[highlightedSlackUserIndex]);
    return;
  }

  if (event.key === "Escape") {
    event.stopPropagation();
    hideSlackUserMenu();
  }
});

slackUserMenu.addEventListener("mousedown", (event) => {
  const option = event.target.closest("[data-user-index]");
  if (!(option instanceof HTMLElement)) {
    return;
  }

  event.preventDefault();
  const index = Number(option.dataset.userIndex);
  const user = slackUsers[index];
  if (user) {
    applySlackUserSelection(user);
  }
});

slackIdInput.addEventListener("blur", () => {
  window.setTimeout(() => {
    hideSlackUserMenu();
  }, 100);
});

async function submitLogin() {
  loginError.textContent = "";

  if (slackEnabled) {
    const enteredValue = slackIdInput.value.trim();
    if (enteredValue && !selectedSlackUser) {
      if (slackUsers.length === 1) {
        applySlackUserSelection(slackUsers[0]);
      } else {
        loginError.textContent = "Pick an exact Slack name from the autocomplete list, or leave it empty for guest mode.";
        return;
      }
    }
  }

  const payload = {};
  if (passwordEnabled) {
    payload.password = passwordInput.value;
  }
  if (slackEnabled) {
    payload.slackId = selectedSlackUser?.id || "";
  }

  try {
    const data = await apiFetchJson("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSessionState(data.session);
    showDashboard();
  } catch (error) {
    loginError.textContent = error.message;
  }
}

enterButton.addEventListener("click", submitLogin);

loginForm.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) {
    return;
  }

  if (event.key === "Enter" && !slackUserMenu.hidden) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    submitLogin();
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await apiFetchJson("/api/logout", { method: "POST" });
  } catch {}
  showLoginScreen();
});

async function checkSession() {
  try {
    const data = await apiFetchJson("/api/session");
    slackEnabled = data?.slackEnabled !== false;
    passwordEnabled = data?.passwordEnabled === true;
    setSessionState(data);
    updateSessionUi();
    if (!slackEnabled && !passwordEnabled) {
      showDashboard();
      return;
    }
    if (sessionState.authenticated) {
      showDashboard();
      return;
    }
  } catch {}

  showLoginScreen();
}

function getStatusColor(utilization) {
  if (utilization >= 85) return "red";
  if (utilization >= 60) return "yellow";
  return "green";
}

function getStatusDotClass(windows) {
  const max = Math.max(0, ...windows.map((window) => window.utilization));
  if (max >= 85) return "critical";
  if (max >= 60) return "warn";
  return "";
}

function getUsageWindows(account) {
  if (Array.isArray(account.usageWindows)) {
    return account.usageWindows;
  }

  return [
    account.fiveHour && { key: "300m", label: "5-hour session", durationMins: 300, ...account.fiveHour },
    account.sevenDay && { key: "10080m", label: "7-day weekly", durationMins: 10_080, ...account.sevenDay },
  ].filter(Boolean);
}

function formatTimeUntil(isoString) {
  if (!isoString) return "";
  const diff = new Date(isoString) - Date.now();
  if (diff <= 0) return "resetting...";
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

function formatResetLine(isoString) {
  return formatTimeUntil(isoString) || "\u00A0";
}

function renderNotificationControls(account) {
  if (!slackEnabled || account.provider === "codex") {
    return "";
  }

  const accountLabel = account.label;
  const notificationSettings = alertSubscriptions[accountLabel] || { limitHit: false, reset: false };
  const guestClass = sessionState.guest ? "guest" : "";
  const disabledAttr = sessionState.guest ? "disabled" : "";
  return `
    <div class="notification-controls ${guestClass}" data-account-label="${accountLabel}">
      <span class="notification-title">Slack alerts</span>
      <span class="chip-wrapper${guestClass ? " guest-chip-wrapper" : ""}">
        <button type="button" class="notification-chip ${notificationSettings.limitHit ? "active" : ""}" data-notification-key="limitHit" aria-pressed="${notificationSettings.limitHit ? "true" : "false"}" ${disabledAttr}>Hit</button>
        <button type="button" class="notification-chip ${notificationSettings.reset ? "active" : ""}" data-notification-key="reset" aria-pressed="${notificationSettings.reset ? "true" : "false"}" ${disabledAttr}>Reset</button>
      </span>
      <span class="subscription-feedback" aria-live="polite"></span>
    </div>`;
}

function renderCard(account) {
  const notificationControls = renderNotificationControls(account);
  const provider = account.provider || "claude";
  const providerBadge = `<span class="provider-badge ${provider}">${provider}</span>`;

  if (account.status === "error") {
    return `
      <div class="card error">
        <div class="card-header">
          <span class="account-identity"><span class="account-label">${account.label}</span>${providerBadge}</span>
          <span class="status-dot error"></span>
        </div>
        ${notificationControls}
        <div class="error-msg">Token expired or invalid<br><small>${account.error}</small></div>
      </div>`;
  }

  const windows = getUsageWindows(account);
  const dotClass = getStatusDotClass(windows);
  const renderUsageSection = (window) => `
      <div class="usage-section">
        <div class="usage-label">
          <span>${window.label}</span>
          <span class="usage-pct">${window.utilization}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${getStatusColor(window.utilization)}" style="width:${window.utilization}%"></div>
        </div>
        <div class="reset-time" data-resets="${window.resetsAt || ""}">${formatResetLine(window.resetsAt)}</div>
      </div>`;
  let usageSections;
  if (provider === "codex") {
    const fiveHour = windows.find((window) => window.durationMins === 300);
    const weekly = windows.find((window) => window.durationMins === 10_080);
    const otherWindows = windows.filter((window) => ![300, 10_080].includes(window.durationMins));
    usageSections = [
      fiveHour ? renderUsageSection(fiveHour) : '',
      weekly ? renderUsageSection(weekly) : '',
      ...otherWindows.map(renderUsageSection),
    ].join("");
  } else {
    usageSections = windows.map(renderUsageSection).join("");
  }

  return `
    <div class="card">
      <div class="card-header">
        <span class="account-identity"><span class="account-label">${account.label}</span>${providerBadge}</span>
        <span class="status-dot ${dotClass}"></span>
      </div>
      ${usageSections || '<div class="error-msg">No usage limits reported</div>'}
      ${notificationControls}
    </div>`;
}

function updateCountdowns() {
  document.querySelectorAll(".reset-time[data-resets]").forEach((el) => {
    const iso = el.dataset.resets;
    if (iso) el.textContent = formatTimeUntil(iso);
  });
}

async function refresh() {
  try {
    const data = await apiFetchJson("/api/usage");
    const fetchedAt = data.fetchedAt || null;

    refreshIntervalMs = data.refreshIntervalMs || DEFAULT_REFRESH_INTERVAL;
    slackEnabled = data?.slackEnabled !== false;
    alertSubscriptions = data.alertSubscriptions || {};
    setSessionState(data.session);
    updateSessionUi();

    const dashboard = document.getElementById("dashboard");

    if (fetchedAt !== lastFetchedAt || !dashboard.hasChildNodes()) {
      lastFetchedAt = fetchedAt;
      accountOrder = data.accounts.map((account) => account.label);
      currentWindowKeys = new Map(data.accounts
        .filter((account) => account.status === "ok")
        .map((account) => [account.label, new Set(getUsageWindows(account).map((window) => window.key))]));
      dashboard.style.setProperty("--account-count", Math.max(data.accounts.length, 1));
      dashboard.innerHTML = data.accounts.map(renderCard).join("");

      if (fetchedAt) {
        const time = new Date(fetchedAt).toLocaleTimeString("ko-KR");
        document.getElementById("last-updated").textContent = `updated ${time}`;
      } else {
        document.getElementById("last-updated").textContent = "updating...";
      }

      loadHistory(currentRange);
    }
  } catch (error) {
    if (slackEnabled && error.status === 401) {
      showLoginScreen();
      return;
    }
    document.getElementById("last-updated").textContent = "Failed to load";
  }

  startCountdown();
}

function showSubscriptionFeedback(controls, message, isError = false) {
  const feedback = controls.querySelector(".subscription-feedback");
  if (!feedback || sessionState.guest) return;

  feedback.textContent = message;
  feedback.classList.toggle("error", isError);
  feedback.classList.remove("muted");

  window.setTimeout(() => {
    if (feedback.textContent === message) {
      feedback.textContent = "";
      feedback.classList.remove("error");
    }
  }, 1800);
}

document.getElementById("dashboard").addEventListener("click", async (event) => {
  if (!slackEnabled) {
    return;
  }

  const button = event.target.closest("[data-notification-key]");
  if (!(button instanceof HTMLButtonElement) || sessionState.guest) {
    return;
  }

  const controls = button.closest("[data-account-label]");
  const accountLabel = controls?.dataset.accountLabel;
  if (!accountLabel) {
    return;
  }

  const isActive = button.getAttribute("aria-pressed") === "true";
  const nextEnabled = !isActive;

  button.disabled = true;
  showSubscriptionFeedback(controls, "Saving...");

  try {
    const data = await apiFetchJson("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: accountLabel,
        key: button.dataset.notificationKey,
        enabled: nextEnabled,
      }),
    });

    alertSubscriptions[accountLabel] = data.subscription;
    button.classList.toggle("active", nextEnabled);
    button.setAttribute("aria-pressed", nextEnabled ? "true" : "false");
    showSubscriptionFeedback(controls, nextEnabled ? "Subscribed" : "Unsubscribed");
  } catch (error) {
    showSubscriptionFeedback(controls, error.message, true);
  } finally {
    button.disabled = false;
  }
});

function startCountdown() {
  const el = document.getElementById("next-refresh");

  if (countdownTimer) clearInterval(countdownTimer);

  const updateTimer = () => {
    if (!lastFetchedAt) {
      el.textContent = "refreshing...";
      updateCountdowns();
      return;
    }

    const nextRefreshAt = new Date(lastFetchedAt).getTime() + refreshIntervalMs;
    const remaining = Math.ceil((nextRefreshAt - Date.now()) / 1000);

    if (remaining <= 0) {
      el.textContent = "refreshing...";
      updateCountdowns();
      return;
    }

    el.textContent = `next refresh ${remaining}s`;
    updateCountdowns();
  };

  updateTimer();
  countdownTimer = setInterval(updateTimer, 1000);
}

const chartInstances = {};
let currentRange = "1h";
let accountOrder = [];
let currentWindowKeys = new Map();

function formatChartTime(timestamp, range) {
  const d = new Date(timestamp);
  if (range === "1h" || range === "5h") {
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function buildChartData(history, label, range) {
  const points = history
    .filter((snapshot) => snapshot.accounts.some((account) => account.label === label))
    .map((snapshot) => {
      const account = snapshot.accounts.find((entry) => entry.label === label);
      const windows = Array.isArray(account.windows)
        ? account.windows
        : [
            account.fiveHour !== undefined && { key: "300m", label: "5-hour session", durationMins: 300, utilization: account.fiveHour },
            account.sevenDay !== undefined && { key: "10080m", label: "7-day weekly", durationMins: 10_080, utilization: account.sevenDay },
          ].filter(Boolean);
      return { t: snapshot.timestamp, windows };
    });

  const windowsByKey = new Map();
  for (const point of points) {
    for (const window of point.windows) {
      windowsByKey.set(window.key, window);
    }
  }

  const palette = [
    ["#f97316", "rgba(249,115,22,0.1)"],
    ["#6366f1", "rgba(99,102,241,0.1)"],
    ["#14b8a6", "rgba(20,184,166,0.1)"],
  ];
  const datasets = [...windowsByKey.values()]
    .filter((window) => !currentWindowKeys.has(label) || currentWindowKeys.get(label).has(window.key))
    .sort((a, b) => a.durationMins - b.durationMins)
    .map((window) => ({
      label: window.label,
      data: points.map((point) => ({
        x: point.t,
        y: point.windows.find((candidate) => candidate.key === window.key)?.utilization ?? null,
      })),
      borderColor: palette[(window.durationMins === 300 ? 0 : window.durationMins === 10_080 ? 1 : 2)][0],
      backgroundColor: palette[(window.durationMins === 300 ? 0 : window.durationMins === 10_080 ? 1 : 2)][1],
      tension: 0,
      pointRadius: points.length === 1 ? 3 : 0,
      borderWidth: 2,
      fill: true,
      spanGaps: false,
    }));

  return { datasets };
}

function renderCharts(history, range, order = []) {
  const chartsEl = document.getElementById("charts");
  const inHistory = new Set(history.flatMap((snapshot) => snapshot.accounts.map((account) => account.label)));
  const labels = [
    ...order.filter((label) => inHistory.has(label)),
    ...[...inHistory].filter((label) => !order.includes(label)),
  ];

  if (labels.length === 0) {
    chartsEl.innerHTML = '<div class="chart-empty">No history data yet</div>';
    return;
  }

  const existingLabels = new Set(Object.keys(chartInstances));
  const needed = new Set(labels);
  for (const label of existingLabels) {
    if (!needed.has(label)) {
      chartInstances[label].destroy();
      delete chartInstances[label];
    }
  }

  chartsEl.innerHTML = labels
    .map((label) => `<div class="chart-card"><h3>${label}</h3><canvas id="chart-${CSS.escape(label)}"></canvas></div>`)
    .join("");

  for (const label of labels) {
    const canvasId = `chart-${CSS.escape(label)}`;
    const canvas = document.getElementById(canvasId);
    if (!canvas) continue;

    const data = buildChartData(history, label, range);

    if (chartInstances[label]) {
      chartInstances[label].destroy();
    }

    chartInstances[label] = new Chart(canvas, {
      type: "line",
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            min: 0,
            max: 100,
            ticks: { color: "#6b7280", callback: (value) => value + "%" },
            grid: { color: "rgba(75,85,99,0.3)" },
          },
          x: {
            type: "linear",
            ticks: {
              callback: (value) => formatChartTime(value, range),
              color: "#6b7280",
              maxTicksLimit: 8,
              maxRotation: 0,
            },
            grid: { color: "rgba(75,85,99,0.15)" },
          },
        },
        plugins: {
          legend: {
            labels: { color: "#9ca3af", boxWidth: 12 },
          },
          tooltip: {
            callbacks: {
              title: (items) => items.length ? formatChartTime(items[0].parsed.x, range) : "",
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}%`,
            },
          },
        },
        interaction: { intersect: false, mode: "index" },
      },
    });
  }
}

async function loadHistory(range) {
  try {
    const history = await apiFetchJson(`/api/history?range=${range}`);
    renderCharts(history, range, accountOrder);
  } catch {}
}

document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach((button) => button.classList.remove("active"));
    btn.classList.add("active");
    currentRange = btn.dataset.range;
    loadHistory(currentRange);
  });
});

checkSession();
