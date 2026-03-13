"use strict";

const { createSlackNotifier } = require("./slack");

function createNotificationDispatcher(config) {
  const notifiers = [];
  const slackConfig = config?.notifications?.slack;

  if (slackConfig?.enabled && slackConfig.botToken && slackConfig.channelId) {
    notifiers.push(createSlackNotifier(slackConfig));
  }

  return {
    async notifyEvents(events) {
      for (const event of events) {
        const results = await Promise.allSettled(
          notifiers.map((notifier) => notifier.notifyEvent(event))
        );

        results.forEach((result, index) => {
          if (result.status === "rejected") {
            console.error(`[notifications:${notifiers[index].name}] ${result.reason.message}`);
          }
        });
      }
    },
    async notifySubscriptionChange(change) {
      const subscriptionNotifiers = notifiers
        .filter((notifier) => typeof notifier.notifySubscriptionChange === "function");
      const results = await Promise.allSettled(
        subscriptionNotifiers.map((notifier) => notifier.notifySubscriptionChange(change))
      );

      results.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error(`[notifications:${subscriptionNotifiers[index].name}] ${result.reason.message}`);
        }
      });
    },
  };
}

module.exports = {
  createNotificationDispatcher,
};
