const REFRESH_INTERVAL = 10 * 60_000; // 10 min

let countdownTimer = null;
let refreshTimer = null;

// --- Auth ---
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = document.getElementById("password-input").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";

  try {
    const res = await fetch("api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (!res.ok) {
      errEl.textContent = "Wrong password";
      return;
    }
    showDashboard();
  } catch {
    errEl.textContent = "Connection error";
  }
});

async function checkSession() {
  try {
    const res = await fetch("api/usage");
    if (res.ok) { showDashboard(); return; }
  } catch {}
  // not authenticated — login screen stays visible
}

function showDashboard() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app").style.display = "";
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_INTERVAL);
}

checkSession();

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

function renderCard(account) {
  if (account.status === "error") {
    return `
      <div class="card error">
        <div class="card-header">
          <span class="account-label">${account.label}</span>
          <span class="status-dot error"></span>
        </div>
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
        <div class="reset-time" data-resets="${fh.resetsAt || ""}">${formatTimeUntil(fh.resetsAt)}</div>
      </div>
      <div class="usage-section">
        <div class="usage-label">
          <span>7-day weekly</span>
          <span class="usage-pct">${sd.utilization}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill ${getStatusColor(sd.utilization)}" style="width:${sd.utilization}%"></div>
        </div>
        <div class="reset-time" data-resets="${sd.resetsAt || ""}">${formatTimeUntil(sd.resetsAt)}</div>
      </div>
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
    const res = await fetch("api/usage");
    const data = await res.json();

    const dashboard = document.getElementById("dashboard");
    dashboard.innerHTML = data.accounts.map(renderCard).join("");

    const time = new Date(data.fetchedAt).toLocaleTimeString("ko-KR");
    document.getElementById("last-updated").textContent = `updated ${time}`;
    loadHistory(currentRange);
  } catch (err) {
    document.getElementById("last-updated").textContent = "Failed to load";
  }

  startCountdown();
}

function startCountdown() {
  let remaining = REFRESH_INTERVAL / 1000;
  const el = document.getElementById("next-refresh");

  if (countdownTimer) clearInterval(countdownTimer);

  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      el.textContent = "refreshing...";
      return;
    }
    el.textContent = `next refresh ${remaining}s`;
    updateCountdowns();
  }, 1000);
}

// --- Charts ---
const chartInstances = {};
let currentRange = "1h";

const ACCOUNT_COLORS = [
  { fiveHour: "#f97316", sevenDay: "#6366f1" },
  { fiveHour: "#fb923c", sevenDay: "#818cf8" },
  { fiveHour: "#fdba74", sevenDay: "#a5b4fc" },
  { fiveHour: "#fed7aa", sevenDay: "#c7d2fe" },
];

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
    .filter((s) => s.accounts.some((a) => a.label === label))
    .map((s) => {
      const acc = s.accounts.find((a) => a.label === label);
      return { t: s.timestamp, fiveHour: acc.fiveHour, sevenDay: acc.sevenDay };
    });

  const labels = points.map((p) => formatChartTime(p.t, range));
  const datasets = [];

  if (showFiveHour) {
    datasets.push({
      label: "5-hour session",
      data: points.map((p) => p.fiveHour),
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
    data: points.map((p) => p.sevenDay),
    borderColor: "#6366f1",
    backgroundColor: "rgba(99,102,241,0.1)",
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
    fill: true,
  });

  return { labels, datasets };
}

function renderCharts(history, range) {
  const chartsEl = document.getElementById("charts");
  const labels = [...new Set(history.flatMap((s) => s.accounts.map((a) => a.label)))];

  if (labels.length === 0) {
    chartsEl.innerHTML = '<div class="chart-empty">No history data yet</div>';
    return;
  }

  // Remove charts for accounts no longer present
  const existingLabels = new Set(Object.keys(chartInstances));
  const needed = new Set(labels);
  for (const l of existingLabels) {
    if (!needed.has(l)) {
      chartInstances[l].destroy();
      delete chartInstances[l];
    }
  }

  chartsEl.innerHTML = labels
    .map((l) => `<div class="chart-card"><h3>${l}</h3><canvas id="chart-${CSS.escape(l)}"></canvas></div>`)
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
            ticks: { color: "#6b7280", callback: (v) => v + "%" },
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
    const res = await fetch(`api/history?range=${range}`);
    if (!res.ok) return;
    const history = await res.json();
    renderCharts(history, range);
  } catch {}
}

// Range button handlers
document.querySelectorAll(".range-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentRange = btn.dataset.range;
    loadHistory(currentRange);
  });
});
