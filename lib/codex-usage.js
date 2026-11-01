"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DEFAULT_TIMEOUT_MS = 20_000;

function formatWindowLabel(durationMins) {
  if (durationMins === 300) return "5-hour session";
  if (durationMins === 10_080) return "7-day weekly";
  if (!Number.isFinite(durationMins) || durationMins <= 0) return "Usage limit";
  if (durationMins % 10_080 === 0) return `${durationMins / 10_080}-week usage`;
  if (durationMins % 1_440 === 0) return `${durationMins / 1_440}-day usage`;
  if (durationMins % 60 === 0) return `${durationMins / 60}-hour usage`;
  return `${durationMins}-minute usage`;
}

function normalizeWindow(window, position) {
  if (!window || typeof window.usedPercent !== "number") return null;

  const durationMins = Number.isFinite(window.windowDurationMins)
    ? window.windowDurationMins
    : null;
  const resetsAt = Number.isFinite(window.resetsAt)
    ? new Date(window.resetsAt * 1000).toISOString()
    : null;

  return {
    key: durationMins ? `${durationMins}m` : position,
    label: formatWindowLabel(durationMins),
    utilization: Math.round(window.usedPercent),
    resetsAt,
    durationMins,
  };
}

function normalizeRateLimits(result) {
  const rateLimits = result?.rateLimitsByLimitId?.codex || result?.rateLimits;
  if (!rateLimits) {
    throw new Error("Codex did not return rate-limit data");
  }

  return {
    planType: rateLimits.planType || null,
    ordinaryUsageAllowed: result.ordinaryUsageAllowed ?? null,
    usageWindows: [
      normalizeWindow(rateLimits.primary, "primary"),
      normalizeWindow(rateLimits.secondary, "secondary"),
    ].filter(Boolean),
  };
}

function findCcsPackageRoot(command = "ccs") {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (process.env.PATH || "")
        .split(path.delimiter)
        .map((directory) => path.join(directory, command));

  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const realCommandPath = fs.realpathSync(candidate);
      const executableDirectory = path.dirname(realCommandPath);
      const directories = [
        executableDirectory,
        path.resolve(executableDirectory, ".."),
        // Nix installs a wrapper in bin and the package under lib/node_modules.
        path.resolve(executableDirectory, "../lib/node_modules/@kaitranntt/ccs"),
      ];
      const match = realCommandPath.match(/^(.*\/lib\/node_modules\/@kaitranntt\/ccs)(?:\/|$)/);
      if (match) directories.push(match[1]);
      for (const directory of directories) {
        const packageJsonPath = path.join(directory, "package.json");
        if (!fs.existsSync(packageJsonPath)) continue;
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        if (packageJson.name === "@kaitranntt/ccs") return directory;
      }
    } catch {}
  }

  throw new Error(`Could not locate the CCS package through command: ${command}`);
}

function loadCcsCodexApi(command) {
  const packageRoot = findCcsPackageRoot(command);
  const distRoot = path.join(packageRoot, "dist", "cliproxy");
  const { getProviderAccounts } = require(path.join(distRoot, "accounts", "query.js"));
  const { fetchCodexQuota } = require(path.join(distRoot, "quota", "quota-fetcher-codex.js"));

  return { getProviderAccounts, fetchCodexQuota };
}

function toCodexUsageWindow(window) {
  if (!window || typeof window.remainingPercent !== "number") return null;
  // CCS can report a weekly-only account's sole window as "Primary / 5h".
  // Its reset countdown still reflects the real cadence, so use that when it
  // exceeds the maximum length of a five-hour window.
  const isWeekly = window.cadence === "weekly"
    || window.label?.toLowerCase().includes("secondary")
    || window.resetAfterSeconds > 5 * 60 * 60;
  const durationMins = isWeekly ? 10_080 : 300;
  return {
    key: `${durationMins}m`,
    label: isWeekly ? "7-day weekly" : "5-hour session",
    utilization: Math.round(100 - window.remainingPercent),
    resetsAt: window.resetAt || null,
    durationMins,
  };
}

async function fetchCcsCodexAccounts(options = {}) {
  const command = options.ccsCommand || process.env.CCS_COMMAND || "ccs";
  const { getProviderAccounts, fetchCodexQuota } = loadCcsCodexApi(command);
  const accounts = getProviderAccounts("codex");

  return Promise.all(accounts.map(async (account, index) => {
    const label = account.nickname || `Codex ${index + 1}`;

    try {
      const quota = await fetchCodexQuota(account.id);
      if (!quota.success) {
        return {
          label,
          provider: "codex",
          status: "error",
          error: quota.error || "CCS could not fetch this account's Codex quota",
        };
      }

      const windows = (quota.windows || []).filter((window) => (
        !window.category || window.category === "usage"
      ));
      const usageWindows = windows
        .map(toCodexUsageWindow)
        .filter(Boolean);

      return {
        label,
        provider: "codex",
        status: "ok",
        planType: quota.planType || null,
        usageWindows,
      };
    } catch (error) {
      console.error(`[${label}] CCS Codex quota error:`, error.message);
      return { label, provider: "codex", status: "error", error: error.message };
    }
  }));
}

function fetchCodexRateLimits(account = {}) {
  const command = account.codexCommand || process.env.CODEX_COMMAND || "codex";
  const timeoutMs = account.timeoutMs || DEFAULT_TIMEOUT_MS;
  const child = spawn(command, ["app-server", "--listen", "stdio://"], {
    env: {
      ...process.env,
      ...(account.codexHome ? { CODEX_HOME: account.codexHome } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const lines = readline.createInterface({ input: child.stdout });

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (!child.killed) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    };

    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Codex usage request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });

    child.on("error", (error) => {
      finish(new Error(`Could not start Codex: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      if (!settled) {
        const detail = stderr.trim() || `exit ${code ?? signal}`;
        finish(new Error(`Codex app-server stopped before replying: ${detail}`));
      }
    });

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          finish(new Error(message.error.message || "Codex initialization failed"));
          return;
        }
        send({ method: "initialized" });
        send({
          method: "account/rateLimits/read",
          id: 2,
          params: { excludeResetCreditDetails: true },
        });
        return;
      }

      if (message.id === 2) {
        if (message.error) {
          finish(new Error(message.error.message || "Codex usage request failed"));
          return;
        }
        try {
          finish(null, normalizeRateLimits(message.result));
        } catch (error) {
          finish(error);
        }
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "cldmon", title: "cldmon", version: "1.0.0" },
        capabilities: null,
      },
    });
  });
}

module.exports = {
  fetchCcsCodexAccounts,
  fetchCodexRateLimits,
  formatWindowLabel,
  normalizeRateLimits,
};
