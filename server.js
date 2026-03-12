"use strict";

const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_FILE = path.join(__dirname, "config.json");
const FETCH_INTERVAL_MS = 10 * 60 * 1000; // 10 min

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("config.json not found. Copy config.example.json to config.json and fill in your values.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

// ---------------------------------------------------------------------------
// Puppeteer browser pool + Claude fetcher
// ---------------------------------------------------------------------------
let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
}

async function claudeGetJson(urlPath, sessionKey) {
  const b = await getBrowser();
  // Use an isolated context per request so cookies are never shared between
  // accounts (default context shares a single cookie jar across all pages).
  const context = await b.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.setCookie({
      name: "sessionKey",
      value: sessionKey,
      domain: "claude.ai",
      path: "/",
      httpOnly: true,
      secure: true,
    });

    const res = await page.goto(`https://claude.ai${urlPath}`, {
      waitUntil: "networkidle0",
      timeout: 20000,
    });

    const status = res.status();
    if (status === 401 || status === 403) {
      throw new Error(`HTTP ${status}: session invalid or expired`);
    }
    if (status !== 200) {
      throw new Error(`HTTP ${status}`);
    }

    const text = await page.evaluate(() => document.body.innerText);
    return JSON.parse(text);
  } finally {
    await context.close();
  }
}

async function fetchAccountUsage(account) {
  const { label, sessionKey } = account;

  try {
    // Step 1: Get org UUID
    const orgsData = await claudeGetJson("/api/organizations", sessionKey);
    const orgs = Array.isArray(orgsData) ? orgsData : (orgsData?.organizations || []);
    const orgId = orgs[0]?.uuid || orgs[0]?.id;

    if (!orgId) {
      console.error(`[${label}] /api/organizations response:`, JSON.stringify(orgsData).slice(0, 200));
      return { label, status: "error", error: "Could not find organization ID" };
    }

    // Step 2: Get usage — response: { five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at } }
    const data = await claudeGetJson(`/api/organizations/${orgId}/usage`, sessionKey);

    return {
      label,
      status: "ok",
      fiveHour: {
        utilization: Math.round(data.five_hour?.utilization ?? 0),
        resetsAt: data.five_hour?.resets_at ?? null,
      },
      sevenDay: {
        utilization: Math.round(data.seven_day?.utilization ?? 0),
        resetsAt: data.seven_day?.resets_at ?? null,
      },
    };
  } catch (err) {
    console.error(`[${label}] fetchAccountUsage error:`, err.message);
    return { label, status: "error", error: err.message };
  }
}

// ---------------------------------------------------------------------------
// History storage (one JSONL file per day: data/history-YYYY-MM-DD.jsonl)
// ---------------------------------------------------------------------------

const HISTORY_DIR = path.join(__dirname, "data");

function historyFilePath(date) {
  const d = date ?? new Date();
  const ymd = d.toISOString().slice(0, 10);
  return path.join(HISTORY_DIR, `history-${ymd}.jsonl`);
}

function appendHistory(snapshot) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.appendFileSync(historyFilePath(), JSON.stringify(snapshot) + "\n");
}

function readHistory(rangeMs) {
  const now = Date.now();
  const cutoff = now - rangeMs;

  // Collect the set of dates (UTC) that overlap with the range.
  const dates = [];
  for (let t = cutoff; t <= now + 86400000; t += 86400000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  // Deduplicate (the loop can produce duplicates at boundaries).
  const uniqueDates = [...new Set(dates)];

  const result = [];
  for (const ymd of uniqueDates) {
    const file = path.join(HISTORY_DIR, `history-${ymd}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const snap = JSON.parse(line);
        if (snap.timestamp >= cutoff) result.push(snap);
      } catch {}
    }
  }

  result.sort((a, b) => a.timestamp - b.timestamp);
  return result;
}

const RANGE_MS = {
  "1h": 60 * 60 * 1000,
  "5h": 5 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Usage cache
// ---------------------------------------------------------------------------
let cachedUsage = null;

async function refreshUsage() {
  const config = loadConfig();
  const accounts = await Promise.all(config.accounts.map(fetchAccountUsage));
  const snapshot = {
    timestamp: Date.now(),
    accounts: accounts
      .filter((a) => a.status === "ok")
      .map((a) => ({
        label: a.label,
        fiveHour: a.fiveHour.utilization,
        sevenDay: a.sevenDay.utilization,
      })),
  };
  appendHistory(snapshot);
  cachedUsage = { fetchedAt: new Date().toISOString(), accounts };
  console.log(`[${new Date().toISOString()}] Refreshed usage for ${accounts.length} accounts`);
  return cachedUsage;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(
  session({
    secret: loadConfig().sessionSecret || "cldmon-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

// Static frontend
app.use(express.static(path.join(__dirname, "public")));

// POST /api/auth
app.post("/api/auth", (req, res) => {
  const config = loadConfig();
  const { password } = req.body;
  if (!config.password || password === config.password) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});

function requireAuth(req, res, next) {
  const config = loadConfig();
  if (!config.password || req.session?.authenticated) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// GET /api/usage — always returns 200; returns empty accounts while first fetch is in progress
app.get("/api/usage", requireAuth, (req, res) => {
  res.json(cachedUsage || { fetchedAt: null, accounts: [], loading: true });
});

// GET /api/history?range=1h|5h|1d|7d
app.get("/api/history", requireAuth, (req, res) => {
  const range = req.query.range || "1h";
  const rangeMs = RANGE_MS[range] || RANGE_MS["1h"];
  res.json(readHistory(rangeMs));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const config = loadConfig();
const PORT = config.port || 3000;

app.listen(PORT, () => {
  console.log(`Claude Status Dashboard running at http://localhost:${PORT}`);
  // Initial fetch
  refreshUsage().catch(console.error);
  // Schedule periodic refresh
  setInterval(() => refreshUsage().catch(console.error), FETCH_INTERVAL_MS);
});
