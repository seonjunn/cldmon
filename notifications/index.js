"use strict";

const { createSlackNotifier } = require("./slack");

function createNotificationDispatcher(config) {
  const notifiers = [];
  const slackConfig = config?.notifications?.slack;

  if (slackConfig?.enabled && slackConfig.botToken) {
    notifiers.push(createSlackNotifier(slackConfig));
  }

  return {
    async notifyEvents(deliveries) {
      for (const delivery of deliveries) {
        const results = await Promise.allSettled(
          notifiers.map((notifier) => notifier.notifyEvent(delivery.event, delivery.slackId))
        );

        results.forEach((result, index) => {
          if (result.status === "rejected") {
            console.error(`[notifications:${notifiers[index].name}] ${result.reason.message}`);
          }
        });
      }
    },
    async notifySubscriptionChange(change, slackId) {
      const subscriptionNotifiers = notifiers
        .filter((notifier) => typeof notifier.notifySubscriptionChange === "function");
      const results = await Promise.allSettled(
        subscriptionNotifiers.map((notifier) => notifier.notifySubscriptionChange(change, slackId))
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
