#!/bin/sh
set -e

UNIT=cldmon.service

case "$1" in
  start)
    systemctl --user enable --now "$UNIT"
    ;;
  restart)
    systemctl --user restart "$UNIT"
    ;;
  stop)
    systemctl --user stop "$UNIT"
    ;;
  status)
    systemctl --user status "$UNIT"
    ;;
  logs)
    journalctl --user -u "$UNIT" -f
    ;;
  *)
    echo "Usage: $0 {start|restart|stop|status|logs}"
    exit 1
    ;;
esac
