"use strict";

const https = require("https");

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
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          try {
            const parsed = JSON.parse(responseBody);
            if (parsed.ok === false) {
              reject(new Error(parsed.error || "Slack API request failed"));
              return;
            }
          } catch {}

          resolve(responseBody);
          return;
        }

        reject(new Error(`HTTP ${response.statusCode}: ${responseBody}`));
      });
    });

    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

function formatResetTime(isoString) {
  if (!isoString) return "unknown";
  const d = new Date(isoString);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day}, ${hour}:${min} UTC`;
}

function formatSlackMessage(event) {
  const account = `\`${event.accountLabel}\``;
  const reset = formatResetTime(event.resetsAt);

  if (event.type === "limit_hit") {
    return `🔴 *Limit hit* — ${account} (${event.windowLabel})\nResets: ${reset}`;
  }

  return `🟢 *Usage reset* — ${account} (${event.windowLabel})\n${event.previousUtilization}% → ${event.currentUtilization}%  ·  Next reset: ${reset}`;
}

function formatSubscriptionMessage(change) {
  const account = `\`${change.accountLabel}\``;
  const alertType = change.key === "limitHit" ? "limit hit" : "reset";
  const icon = change.enabled ? "🔔" : "🔕";
  return `${icon} ${account} — ${alertType} alerts *${change.enabled ? "enabled" : "disabled"}*`;
}

function createSlackNotifier(slackConfig) {
  return {
    name: "slack",
    async notifyEvent(event, slackId) {
      await postJson("https://slack.com/api/chat.postMessage", {
        Authorization: `Bearer ${slackConfig.botToken}`,
      }, {
        channel: slackId,
        text: formatSlackMessage(event),
        unfurl_links: false,
        unfurl_media: false,
      });
    },
    async notifySubscriptionChange(change, slackId) {
      await postJson("https://slack.com/api/chat.postMessage", {
        Authorization: `Bearer ${slackConfig.botToken}`,
      }, {
        channel: slackId,
        text: formatSubscriptionMessage(change),
        unfurl_links: false,
        unfurl_media: false,
      });
    },
  };
}

module.exports = {
  createSlackNotifier,
};
