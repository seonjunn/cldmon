"use strict";

const fs = require("fs");
const path = require("path");

const SUBSCRIPTIONS_FILE = path.join(__dirname, "..", "data", "subscriptions.json");

function defaultAccountSubscription() {
  return {
    limitHit: false,
    reset: false,
  };
}

function normalizeAccountSubscription(value) {
  return {
    limitHit: value?.limitHit === true,
    reset: value?.reset === true,
  };
}

function ensureDirectory() {
  fs.mkdirSync(path.dirname(SUBSCRIPTIONS_FILE), { recursive: true });
}

function readSubscriptions() {
  try {
    if (!fs.existsSync(SUBSCRIPTIONS_FILE)) {
      return { accounts: {} };
    }

    const parsed = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, "utf8"));
    return {
      accounts: parsed?.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {},
    };
  } catch (error) {
    console.error(`[subscriptions] Failed to read subscriptions: ${error.message}`);
    return { accounts: {} };
  }
}

function writeSubscriptions(subscriptions) {
  ensureDirectory();
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2) + "\n");
}

function getAccountSubscriptions(accountLabels) {
  const subscriptions = readSubscriptions();
  const result = {};

  for (const label of accountLabels) {
    result[label] = normalizeAccountSubscription(subscriptions.accounts[label]);
  }

  return result;
}

function updateAccountSubscription(label, key, enabled) {
  const subscriptions = readSubscriptions();
  const current = normalizeAccountSubscription(subscriptions.accounts[label]);
  subscriptions.accounts[label] = {
    ...current,
    [key]: enabled,
  };
  writeSubscriptions(subscriptions);
  return subscriptions.accounts[label];
}

function isSubscribed(accountSubscriptions, event) {
  const current = accountSubscriptions[event.accountLabel] || defaultAccountSubscription();
  if (event.type === "limit_hit") return current.limitHit;
  if (event.type === "usage_reset") return current.reset;
  return false;
}

module.exports = {
  getAccountSubscriptions,
  updateAccountSubscription,
  isSubscribed,
};
