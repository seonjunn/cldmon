module.exports = {
  apps: [{
    name: "cldmon",
    script: "server.js",
    restart_delay: 5000,
    max_restarts: 10,
    env: {
      NODE_ENV: "production",
    },
  }],
};
