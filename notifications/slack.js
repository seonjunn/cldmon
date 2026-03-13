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

function formatSlackMessage(event, mention) {
  const prefix = mention ? `${mention} ` : "";

  if (event.type === "limit_hit") {
    return `${prefix}Claude usage limit hit for *${event.accountLabel}* (${event.windowLabel}). Usage is now ${event.currentUtilization}%. Next reset: ${event.resetsAt}.`;
  }

  return `${prefix}Claude usage reset detected for *${event.accountLabel}* (${event.windowLabel}). Previous usage was ${event.previousUtilization}% and is now ${event.currentUtilization}%. Next reset: ${event.resetsAt}.`;
}

function formatSubscriptionMessage(change) {
  const stateText = change.enabled ? "enabled" : "disabled";
  const alertTypeText = change.key === "limitHit" ? "limit hit" : "reset";
  return `Slack alert ${stateText} for *${change.accountLabel}* (${alertTypeText}).`;
}

function createSlackNotifier(slackConfig) {
  return {
    name: "slack",
    async notifyEvent(event) {
      await postJson("https://slack.com/api/chat.postMessage", {
        Authorization: `Bearer ${slackConfig.botToken}`,
      }, {
        channel: slackConfig.channelId,
        text: formatSlackMessage(event, slackConfig.mention),
        unfurl_links: false,
        unfurl_media: false,
      });
    },
    async notifySubscriptionChange(change) {
      await postJson("https://slack.com/api/chat.postMessage", {
        Authorization: `Bearer ${slackConfig.botToken}`,
      }, {
        channel: slackConfig.channelId,
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
