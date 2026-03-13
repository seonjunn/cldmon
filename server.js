"use strict";

const express = require("express");
const session = require("express-session");
const fs = require("fs");
const https = require("https");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { createUsageEventDetector } = require("./lib/usage-reset-detector");
const { createNotificationDispatcher } = require("./notifications");
const {
  getAccountSubscriptions,
  getSlackRecipientsForEvent,
  updateAccountSubscription,
} = require("./lib/subscriptions");
puppeteer.use(StealthPlugin());

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_FILE = path.join(__dirname, "config.json");
const SLACK_USERS_CACHE_FILE = path.join(__dirname, "data", "slack-users-cache.json");
const FETCH_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const SLACK_USER_CACHE_MS = 24 * 60 * 60 * 1000;
const SLACK_USER_REFRESH_MS = 24 * 60 * 60 * 1000;
const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("config.json not found. Copy config.example.json to config.json and fill in your values.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function postJson(url, headers, body) {
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        ...headers,
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${responseBody}`));
          return;
        }

        try {
          const parsed = JSON.parse(responseBody);
          if (parsed.ok === false) {
            reject(new Error(parsed.error || "Slack API request failed"));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      headers,
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${responseBody}`));
          return;
        }

        try {
          const parsed = JSON.parse(responseBody);
          if (parsed.ok === false) {
            reject(new Error(parsed.error || "Slack API request failed"));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", reject);
    request.end();
  });
}

async function getSlackApiJson(pathname, botToken, params = {}) {
  const url = new URL(`https://slack.com/api/${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return getJson(url, {
    Authorization: `Bearer ${botToken}`,
  });
}

function normalizeSlackSearchValue(value) {
  return String(value || "").trim().toLowerCase();
}

function fuzzySlackNameScore(name, query) {
  const normalizedName = normalizeSlackSearchValue(name);
  const normalizedQuery = normalizeSlackSearchValue(query);
  if (!normalizedName || !normalizedQuery) {
    return Number.POSITIVE_INFINITY;
  }

  let score = 0;
  let searchIndex = 0;
  let previousMatchIndex = -1;

  for (const char of normalizedQuery) {
    const matchIndex = normalizedName.indexOf(char, searchIndex);
    if (matchIndex === -1) {
      return Number.POSITIVE_INFINITY;
    }

    const isConsecutive = matchIndex === previousMatchIndex + 1;
    const isWordBoundary = matchIndex === 0 || [" ", "-", "_"].includes(normalizedName[matchIndex - 1]);

    score += matchIndex;
    if (isConsecutive) score -= 6;
    if (isWordBoundary) score -= 4;

    previousMatchIndex = matchIndex;
    searchIndex = matchIndex + 1;
  }

  return score + (normalizedName.length - normalizedQuery.length);
}

function mapSlackMember(member) {
  const profile = member?.profile || {};
  const displayName = profile.display_name_normalized || profile.display_name || "";
  const realName = profile.real_name_normalized || profile.real_name || member.real_name || "";
  const username = member.name || "";
  const fullName = displayName || realName || username || member.id;

  return {
    id: member.id,
    name: fullName,
    displayName,
    realName,
    username,
  };
}

let slackUsersCache = {
  fetchedAt: 0,
  users: [],
};

function readSlackUsersCacheFromDisk() {
  try {
    if (!fs.existsSync(SLACK_USERS_CACHE_FILE)) {
      return;
    }

    const parsed = JSON.parse(fs.readFileSync(SLACK_USERS_CACHE_FILE, "utf8"));
    if (!Array.isArray(parsed?.users)) {
      return;
    }

    slackUsersCache = {
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
      users: parsed.users,
    };
  } catch (error) {
    console.error(`[slack-users] Failed to read cache file: ${error.message}`);
  }
}

function writeSlackUsersCacheToDisk() {
  try {
    fs.mkdirSync(path.dirname(SLACK_USERS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(SLACK_USERS_CACHE_FILE, JSON.stringify(slackUsersCache, null, 2) + "\n");
  } catch (error) {
    console.error(`[slack-users] Failed to write cache file: ${error.message}`);
  }
}

async function fetchSlackChannelMemberIds(botToken) {
  const config = loadConfig();
  const memberChannelId = config?.notifications?.slack?.memberChannelId;

  if (!memberChannelId) {
    return [];
  }

  const info = await getSlackApiJson("conversations.info", botToken, {
    channel: memberChannelId,
  });
  const conversation = info.channel || {};
  console.log(
    `[slack-users] Channel ${memberChannelId}: name=${conversation.name || "unknown"} ` +
    `is_channel=${conversation.is_channel === true} is_private=${conversation.is_private === true} ` +
    `is_member=${conversation.is_member === true}`
  );

  const members = [];
  let cursor = "";

  do {
    const response = await getSlackApiJson("conversations.members", botToken, {
      channel: memberChannelId,
      limit: 1000,
      cursor,
    });

    if (Array.isArray(response.members)) {
      members.push(...response.members);
    }

    cursor = response.response_metadata?.next_cursor || "";
  } while (cursor);

  return members;
}

async function fetchSlackWorkspaceUsers(botToken) {
  const users = [];
  let cursor = "";

  do {
    const response = await getSlackApiJson("users.list", botToken, {
      limit: 200,
      cursor,
    });

    if (Array.isArray(response.members)) {
      users.push(...response.members);
    }

    cursor = response.response_metadata?.next_cursor || "";
  } while (cursor);

  return users;
}

async function getSlackUsers(forceRefresh = false) {
  const config = loadConfig();
  const botToken = config?.notifications?.slack?.botToken;

  if (!botToken) {
    return [];
  }

  if (!forceRefresh && Date.now() - slackUsersCache.fetchedAt < SLACK_USER_CACHE_MS && slackUsersCache.users.length > 0) {
    return slackUsersCache.users;
  }

  try {
    const allowedMemberIds = new Set(await fetchSlackChannelMemberIds(botToken));
    const workspaceUsers = await fetchSlackWorkspaceUsers(botToken);

    const users = workspaceUsers
      .filter((member) => (
        member?.id &&
        (allowedMemberIds.size === 0 || allowedMemberIds.has(member.id)) &&
        !member.deleted &&
        !member.is_bot &&
        !member.is_app_user &&
        member.id !== "USLACKBOT"
      ))
      .map(mapSlackMember);

    slackUsersCache = {
      fetchedAt: Date.now(),
      users,
    };
    writeSlackUsersCacheToDisk();

    return users;
  } catch (error) {
    if (slackUsersCache.users.length > 0) {
      console.error(`[slack-users] Using stale cache after Slack API failure: ${error.message}`);
      return slackUsersCache.users;
    }
    throw error;
  }
}

async function refreshSlackUsers() {
  try {
    const users = await getSlackUsers(true);
    console.log(`[slack-users] Refreshed ${users.length} cached Slack user(s)`);
  } catch (error) {
    console.error(`[slack-users] Background refresh failed: ${error.message}`);
  }
}

async function resolveSlackUser(slackId) {
  const normalizedId = typeof slackId === "string" ? slackId.trim() : "";
  if (!normalizedId) {
    return null;
  }

  const users = await getSlackUsers();
  return users.find((user) => user.id === normalizedId) || null;
}

async function searchSlackUsers(query) {
  const normalizedQuery = normalizeSlackSearchValue(query);
  if (!normalizedQuery) {
    return [];
  }

  const users = await getSlackUsers();
  const rankedUsers = users
    .map((user) => {
      const score = fuzzySlackNameScore(user.name, normalizedQuery);
      return { user, score };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.user.name.localeCompare(b.user.name);
    })
    .slice(0, 8)
    .map((entry) => entry.user);

  return rankedUsers;
}

// ---------------------------------------------------------------------------
// Puppeteer browser pool + Claude fetcher
// ---------------------------------------------------------------------------
let browser = null;

function resolveChromeExecutable() {
  return CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

async function getBrowser() {
  if (!browser || !browser.connected) {
    const executablePath = resolveChromeExecutable();
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    }).catch((error) => {
      browser = null;
      throw error;
    });
  }
  return browser;
}

async function claudeGetJson(urlPath, sessionKey) {
  const b = await getBrowser();
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
const usageEventDetector = createUsageEventDetector();

function getSessionState(req) {
  const authenticated = req.session?.authenticated === true;
  const slackId = typeof req.session?.slackId === "string" ? req.session.slackId : "";
  const slackName = typeof req.session?.slackName === "string" ? req.session.slackName : "";
  return {
    authenticated,
    guest: authenticated && !slackId,
    slackId,
    slackName,
  };
}

function isSlackEnabled(config = loadConfig()) {
  return config?.notifications?.slack?.enabled === true;
}

async function validateSlackConfig(config) {
  if (!isSlackEnabled(config)) {
    return;
  }

  const slackConfig = config?.notifications?.slack || {};
  const botToken = typeof slackConfig.botToken === "string" ? slackConfig.botToken.trim() : "";
  const memberChannelId = typeof slackConfig.memberChannelId === "string" ? slackConfig.memberChannelId.trim() : "";

  if (!botToken) {
    throw new Error("Slack is enabled but notifications.slack.botToken is missing in config.json");
  }

  let authInfo;
  try {
    authInfo = await getSlackApiJson("auth.test", botToken);
  } catch (error) {
    throw new Error(`Invalid Slack bot token in config.json: ${error.message}`);
  }

  console.log(
    `[startup] Slack bot authenticated for team=${authInfo.team || "unknown"} user=${authInfo.user || "unknown"}`
  );

  if (!memberChannelId) {
    return;
  }

  let channelInfo;
  try {
    channelInfo = await getSlackApiJson("conversations.info", botToken, {
      channel: memberChannelId,
    });
  } catch (error) {
    throw new Error(
      `Invalid notifications.slack.memberChannelId in config.json: ${error.message}`
    );
  }

  const channel = channelInfo.channel || {};
  console.log(
    `[startup] Slack member channel validated: id=${memberChannelId} name=${channel.name || "unknown"} ` +
    `is_channel=${channel.is_channel === true} is_private=${channel.is_private === true}`
  );
}

async function refreshUsage() {
  const config = loadConfig();
  const accounts = await Promise.all(config.accounts.map(fetchAccountUsage));
  const usageEvents = usageEventDetector.detect(accounts);
  const notificationDispatcher = createNotificationDispatcher(config);
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
  cachedUsage = {
    fetchedAt: new Date().toISOString(),
    accounts,
    refreshIntervalMs: FETCH_INTERVAL_MS,
  };
  const deliveries = usageEvents.flatMap((event) => (
    getSlackRecipientsForEvent(event).map((slackId) => ({ event, slackId }))
  ));
  if (deliveries.length > 0) {
    await notificationDispatcher.notifyEvents(deliveries);
  }
  console.log(`[${new Date().toISOString()}] Refreshed usage for ${accounts.length} accounts`);
  return cachedUsage;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
readSlackUsersCacheFromDisk();
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

app.get("/api/slack/users", async (req, res) => {
  if (!isSlackEnabled()) {
    res.json({ users: [] });
    return;
  }

  const query = typeof req.query.q === "string" ? req.query.q : "";

  try {
    const users = await searchSlackUsers(query);
    res.json({ users });
  } catch (error) {
    console.error(`[slack-users] Failed to search users: ${error.message}`);
    res.status(500).json({ error: "Failed to search Slack users" });
  }
});

// POST /api/auth
app.post("/api/auth", async (req, res) => {
  if (!isSlackEnabled()) {
    res.status(404).json({ error: "Slack login is disabled" });
    return;
  }

  const slackId = typeof req.body?.slackId === "string" ? req.body.slackId.trim() : "";

  if (!slackId) {
    req.session.authenticated = true;
    req.session.slackId = "";
    req.session.slackName = "";
    res.json({
      ok: true,
      session: getSessionState(req),
    });
    return;
  }

  try {
    const user = await resolveSlackUser(slackId);
    if (!user) {
      res.status(400).json({ error: "Unknown Slack user" });
      return;
    }

    req.session.authenticated = true;
    req.session.slackId = user.id;
    req.session.slackName = user.name;
    res.json({
      ok: true,
      session: getSessionState(req),
    });
  } catch (error) {
    console.error(`[auth] Failed to resolve Slack user: ${error.message}`);
    res.status(500).json({ error: "Failed to validate Slack user" });
  }
});

function requireAuth(req, res, next) {
  if (!isSlackEnabled()) return next();
  if (req.session?.authenticated) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.get("/api/session", (req, res) => {
  res.json({
    ...getSessionState(req),
    slackEnabled: isSlackEnabled(),
  });
});

app.post("/api/logout", requireAuth, (req, res) => {
  if (!isSlackEnabled()) {
    res.json({ ok: true });
    return;
  }

  req.session.destroy((error) => {
    if (error) {
      res.status(500).json({ error: "Failed to log out" });
      return;
    }
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// GET /api/usage — always returns 200; returns empty accounts while first fetch is in progress
app.get("/api/usage", requireAuth, (req, res) => {
  const config = loadConfig();
  const accountLabels = config.accounts.map((account) => account.label);
  const slackEnabled = isSlackEnabled(config);
  if (!cachedUsage) {
    res.json({
      fetchedAt: null,
      accounts: [],
      loading: true,
      refreshIntervalMs: FETCH_INTERVAL_MS,
      session: getSessionState(req),
      slackEnabled,
      alertSubscriptions: slackEnabled
        ? getAccountSubscriptions(getSessionState(req).slackId, accountLabels)
        : {},
    });
    return;
  }

  const session = getSessionState(req);
  res.json({
    ...cachedUsage,
    session,
    slackEnabled,
    alertSubscriptions: slackEnabled
      ? getAccountSubscriptions(session.slackId, accountLabels)
      : {},
  });
});

app.post("/api/subscriptions", requireAuth, (req, res) => {
  if (!isSlackEnabled()) {
    res.status(404).json({ error: "Slack alerts are disabled" });
    return;
  }

  const { label, key, enabled } = req.body || {};

  if (!label || !["limitHit", "reset"].includes(key) || typeof enabled !== "boolean") {
    res.status(400).json({ error: "Invalid subscription payload" });
    return;
  }

  const config = loadConfig();
  const accountExists = config.accounts.some((account) => account.label === label);
  if (!accountExists) {
    res.status(404).json({ error: "Unknown account" });
    return;
  }

  const session = getSessionState(req);
  if (session.guest) {
    res.status(403).json({ error: "Guest mode cannot manage Slack alerts" });
    return;
  }

  let subscription;
  try {
    subscription = updateAccountSubscription(session.slackId, label, key, enabled);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  const notificationDispatcher = createNotificationDispatcher(config);

  notificationDispatcher.notifySubscriptionChange({
    accountLabel: label,
    key,
    enabled,
    slackId: session.slackId,
  }, session.slackId).catch((error) => {
    console.error(`[subscriptions] Failed to send Slack confirmation: ${error.message}`);
  });

  res.json({ ok: true, label, subscription });
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
async function startServer() {
  const config = loadConfig();
  const PORT = config.port || 3000;
  const HOST = config.host || "0.0.0.0";

  await validateSlackConfig(config);

  app.listen(PORT, HOST, () => {
    console.log(`Claude Status Dashboard running at http://${HOST}:${PORT}`);
    // Initial fetch
    refreshUsage().catch(console.error);
    refreshSlackUsers();
    // Schedule periodic refresh
    setInterval(() => refreshUsage().catch(console.error), FETCH_INTERVAL_MS);
    setInterval(refreshSlackUsers, SLACK_USER_REFRESH_MS);
  });
}

startServer().catch((error) => {
  console.error(`[startup] ${error.message}`);
  process.exit(1);
});
