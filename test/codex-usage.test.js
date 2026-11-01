"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRateLimits } = require("../lib/codex-usage");

test("normalizes both five-hour and weekly Codex windows", () => {
  const usage = normalizeRateLimits({
    ordinaryUsageAllowed: true,
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 17.6, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
    },
  });

  assert.equal(usage.planType, "plus");
  assert.deepEqual(usage.usageWindows.map((window) => window.label), [
    "5-hour session",
    "7-day weekly",
  ]);
  assert.deepEqual(usage.usageWindows.map((window) => window.utilization), [42, 18]);
});

test("shows only the weekly window when Codex has no five-hour limit", () => {
  const usage = normalizeRateLimits({
    rateLimitsByLimitId: {
      codex: {
        planType: "pro",
        primary: { usedPercent: 31, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
        secondary: null,
      },
    },
  });

  assert.equal(usage.usageWindows.length, 1);
  assert.equal(usage.usageWindows[0].label, "7-day weekly");
  assert.equal(usage.usageWindows[0].key, "10080m");
});
