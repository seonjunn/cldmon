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

function normalizeSlackId(value) {
  return typeof value === "string" ? value.trim() : "";
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
      return { users: {} };
    }

    const parsed = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, "utf8"));
    return {
      users: parsed?.users && typeof parsed.users === "object" ? parsed.users : {},
    };
  } catch (error) {
    console.error(`[subscriptions] Failed to read subscriptions: ${error.message}`);
    return { users: {} };
  }
}

function writeSubscriptions(subscriptions) {
  ensureDirectory();
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2) + "\n");
}

function getAccountSubscriptions(slackId, accountLabels) {
  const normalizedSlackId = normalizeSlackId(slackId);
  const result = {};

  for (const label of accountLabels) {
    result[label] = defaultAccountSubscription();
  }

  if (!normalizedSlackId) {
    return result;
  }

  const subscriptions = readSubscriptions();
  const userSubscriptions = subscriptions.users[normalizedSlackId]?.accounts || {};

  for (const label of accountLabels) {
    result[label] = normalizeAccountSubscription(userSubscriptions[label]);
  }

  return result;
}

function updateAccountSubscription(slackId, label, key, enabled) {
  const normalizedSlackId = normalizeSlackId(slackId);
  if (!normalizedSlackId) {
    throw new Error("Slack ID is required");
  }

  const subscriptions = readSubscriptions();
  const current = normalizeAccountSubscription(
    subscriptions.users[normalizedSlackId]?.accounts?.[label]
  );

  subscriptions.users[normalizedSlackId] = subscriptions.users[normalizedSlackId] || { accounts: {} };
  subscriptions.users[normalizedSlackId].accounts[label] = {
    ...current,
    [key]: enabled,
  };
  writeSubscriptions(subscriptions);
  return subscriptions.users[normalizedSlackId].accounts[label];
}

function getSlackRecipientsForEvent(event) {
  const subscriptions = readSubscriptions();
  const recipients = [];

  for (const [slackId, userConfig] of Object.entries(subscriptions.users)) {
    const current = normalizeAccountSubscription(userConfig?.accounts?.[event.accountLabel]);
    if (event.type === "limit_hit" && current.limitHit) {
      recipients.push(slackId);
    }
    if (event.type === "usage_reset" && current.reset) {
      recipients.push(slackId);
    }
  }

  return recipients;
}

function isSubscribed(accountSubscriptions, event) {
  const current = accountSubscriptions[event.accountLabel] || defaultAccountSubscription();
  if (event.type === "limit_hit") return current.limitHit;
  if (event.type === "usage_reset") return current.reset;
  return false;
}

module.exports = {
  getAccountSubscriptions,
  getSlackRecipientsForEvent,
  updateAccountSubscription,
  isSubscribed,
};
