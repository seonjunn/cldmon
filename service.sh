#!/bin/sh
set -e

APP_NAME=$(node -e "console.log(require('./config.json').appName || 'cldmon')")
PM2="npx pm2"

case "$1" in
  start)
    $PM2 start ecosystem.config.js
    $PM2 save
    ;;
  restart)
    $PM2 restart "$APP_NAME"
    ;;
  stop)
    $PM2 stop "$APP_NAME"
    ;;
  status)
    $PM2 describe "$APP_NAME"
    ;;
  logs)
    $PM2 logs "$APP_NAME"
    ;;
  *)
    echo "Usage: $0 {start|restart|stop|status|logs}"
    exit 1
    ;;
esac
