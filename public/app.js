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
let slackSearchTimer = null;
let slackSearchRequestId = 0;
let slackUsers = [];
let highlightedSlackUserIndex = -1;
let selectedSlackUser = null;

const loginForm = document.getElementById("login-form");
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
  if (sessionBar) {
    sessionBar.style.display = slackEnabled ? "" : "none";
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
  if (!slackEnabled) {
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
  slackIdInput.value = "";
  clearSlackSelection();
  hideSlackUserMenu();
  slackIdInput.focus();
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

  const enteredValue = slackIdInput.value.trim();
  if (enteredValue && !selectedSlackUser) {
    if (slackUsers.length === 1) {
      applySlackUserSelection(slackUsers[0]);
    } else {
      loginError.textContent = "Pick an exact Slack name from the autocomplete list, or leave it empty for guest mode.";
      return;
    }
  }

  try {
    const data = await apiFetchJson("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackId: selectedSlackUser?.id || "" }),
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
    setSessionState(data);
    updateSessionUi();
    if (!slackEnabled) {
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

function getStatusDotClass(fiveHour, sevenDay) {
  const max = Math.max(fiveHour, sevenDay);
  if (max >= 85) return "critical";
  if (max >= 60) return "warn";
  return "";
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

function renderNotificationControls(accountLabel) {
  if (!slackEnabled) {
    return "";
  }

  const notificationSettings = alertSubscriptions[accountLabel] || { limitHit: false, reset: false };
  const guestClass = sessionState.guest ? "guest" : "";
  const disabledAttr = sessionState.guest ? "disabled" : "";
  return `
    <div class="notification-controls ${guestClass}" data-account-label="${accountLabel}">
      <span class="notification-title">Slack alerts</span>
      <span class="${guestClass ? "guest-chip-wrapper" : ""}">
        <button type="button" class="notification-chip ${notificationSettings.limitHit ? "active" : ""}" data-notification-key="limitHit" aria-pressed="${notificationSettings.limitHit ? "true" : "false"}" ${disabledAttr}>Hit</button>
        <button type="button" class="notification-chip ${notificationSettings.reset ? "active" : ""}" data-notification-key="reset" aria-pressed="${notificationSettings.reset ? "true" : "false"}" ${disabledAttr}>Reset</button>
      </span>
      <span class="subscription-feedback" aria-live="polite"></span>
    </div>`;
}

function renderCard(account) {
  const notificationControls = renderNotificationControls(account.label);

  if (account.status === "error") {
    return `
      <div class="card error">
        <div class="card-header">
          <span class="account-label">${account.label}</span>
          <span class="status-dot error"></span>
        </div>
        ${notificationControls}
        <div class="error-msg">Token expired or invalid<br><small>${account.error}</small></div>
      </div>`;
  }

  const fh = account.fiveHour;
  const sd = account.sevenDay;
  const dotClass = getStatusDotClass(fh.utilization, sd.utilization);

  return `
    <div class="card">
      <div class="card-header">
        <span class="account-label">${account.label}</span>
        <span class="status-dot ${dotClass}"></span>
      </div>
      <div class="usage-section">
        <div class="usage-label">
          <span>5-hour session</span>
          <span class="usage-pct">${fh.utilization}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${getStatusColor(fh.utilization)}" style="width:${fh.utilization}%"></div>
        </div>
        <div class="reset-time" data-resets="${fh.resetsAt || ""}">${formatResetLine(fh.resetsAt)}</div>
      </div>
      <div class="usage-section">
        <div class="usage-label">
          <span>7-day weekly</span>
          <span class="usage-pct">${sd.utilization}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${getStatusColor(sd.utilization)}" style="width:${sd.utilization}%"></div>
        </div>
        <div class="reset-time" data-resets="${sd.resetsAt || ""}">${formatResetLine(sd.resetsAt)}</div>
      </div>
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

function formatChartTime(timestamp, range) {
  const d = new Date(timestamp);
  if (range === "1h" || range === "5h") {
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function buildChartData(history, label, range) {
  const showFiveHour = range === "1h" || range === "5h";
  const points = history
    .filter((snapshot) => snapshot.accounts.some((account) => account.label === label))
    .map((snapshot) => {
      const account = snapshot.accounts.find((entry) => entry.label === label);
      return { t: snapshot.timestamp, fiveHour: account.fiveHour, sevenDay: account.sevenDay };
    });

  const labels = points.map((point) => formatChartTime(point.t, range));
  const datasets = [];

  if (showFiveHour) {
    datasets.push({
      label: "5-hour session",
      data: points.map((point) => point.fiveHour),
      borderColor: "#f97316",
      backgroundColor: "rgba(249,115,22,0.1)",
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
      fill: true,
    });
  }

  datasets.push({
    label: "7-day weekly",
    data: points.map((point) => point.sevenDay),
    borderColor: "#6366f1",
    backgroundColor: "rgba(99,102,241,0.1)",
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
    fill: true,
  });

  return { labels, datasets };
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
            ticks: {
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
