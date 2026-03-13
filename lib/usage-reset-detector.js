"use strict";

const WINDOWS = [
  { key: "fiveHour", label: "5-hour session" },
  { key: "sevenDay", label: "7-day weekly" },
];

function normalizeUtilization(windowUsage) {
  if (!windowUsage || typeof windowUsage.utilization !== "number") return null;
  return Math.round(windowUsage.utilization);
}

function didReset(previousWindow, currentWindow) {
  const previousUtilization = normalizeUtilization(previousWindow);
  const currentUtilization = normalizeUtilization(currentWindow);

  if (previousUtilization !== 100 || currentUtilization !== 0) {
    return false;
  }

  const previousReset = previousWindow?.resetsAt ?? null;
  const currentReset = currentWindow?.resetsAt ?? null;

  if (!previousReset || !currentReset) {
    return false;
  }

  return previousReset !== currentReset;
}

function didHitLimit(previousWindow, currentWindow) {
  const previousUtilization = normalizeUtilization(previousWindow);
  const currentUtilization = normalizeUtilization(currentWindow);

  if (currentUtilization !== 100) {
    return false;
  }

  return previousUtilization !== 100;
}

function snapshotAccountUsage(account) {
  return {
    fiveHour: account.fiveHour,
    sevenDay: account.sevenDay,
  };
}

function createUsageEventDetector() {
  const previousByLabel = new Map();

  return {
    detect(accounts) {
      const events = [];

      for (const account of accounts) {
        if (account.status !== "ok") continue;

        const previous = previousByLabel.get(account.label);
        if (previous) {
          for (const windowInfo of WINDOWS) {
            if (didHitLimit(previous[windowInfo.key], account[windowInfo.key])) {
              events.push({
                type: "limit_hit",
                accountLabel: account.label,
                windowKey: windowInfo.key,
                windowLabel: windowInfo.label,
                previousUtilization: normalizeUtilization(previous[windowInfo.key]),
                currentUtilization: normalizeUtilization(account[windowInfo.key]),
                resetsAt: account[windowInfo.key]?.resetsAt ?? null,
                detectedAt: new Date().toISOString(),
              });
            }

            if (didReset(previous[windowInfo.key], account[windowInfo.key])) {
              events.push({
                type: "usage_reset",
                accountLabel: account.label,
                windowKey: windowInfo.key,
                windowLabel: windowInfo.label,
                previousUtilization: normalizeUtilization(previous[windowInfo.key]),
                currentUtilization: normalizeUtilization(account[windowInfo.key]),
                previousResetsAt: previous[windowInfo.key]?.resetsAt ?? null,
                resetsAt: account[windowInfo.key]?.resetsAt ?? null,
                detectedAt: new Date().toISOString(),
              });
            }
          }
        }

        previousByLabel.set(account.label, snapshotAccountUsage(account));
      }

      return events;
    },
  };
}

module.exports = {
  createUsageEventDetector,
};
