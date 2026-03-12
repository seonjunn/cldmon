#!/usr/bin/env bash
# Usage: ./healthcheck.sh
# Checks that cldmon is running and responding correctly.
# Appends a timestamped result to data/health.log and exits 0 (ok) or 1 (fail).

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/data/health.log"
PORT="${CLDMON_PORT:-3000}"
URL="http://localhost:$PORT/api/usage"
TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

mkdir -p "$DIR/data"

fail() {
  echo "[$TS] FAIL: $1" | tee -a "$LOG"
  exit 1
}

ok() {
  echo "[$TS] OK:   $1" | tee -a "$LOG"
  exit 0
}

# 1. Process check
if ! pgrep -f "node server.js" > /dev/null; then
  fail "server process not found"
fi

# 2. HTTP check
HTTP_CODE=$(curl -s -o /tmp/cldmon_health.json -w "%{http_code}" "$URL" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "401" ]]; then
  fail "HTTP $HTTP_CODE from $URL"
fi

# 3. JSON validity
if ! python3 -c "import json,sys; json.load(open('/tmp/cldmon_health.json'))" 2>/dev/null; then
  fail "response is not valid JSON"
fi

# 4. Check for any ok accounts (skip if still loading or auth-gated)
if [[ "$HTTP_CODE" == "200" ]]; then
  LOADING=$(python3 -c "import json; d=json.load(open('/tmp/cldmon_health.json')); print(d.get('loading',''))" 2>/dev/null)
  ACCOUNTS=$(python3 -c "import json; d=json.load(open('/tmp/cldmon_health.json')); print(len(d.get('accounts',[])))" 2>/dev/null)
  ERRORS=$(python3 -c "import json; d=json.load(open('/tmp/cldmon_health.json')); print(sum(1 for a in d.get('accounts',[]) if a.get('status')=='error'))" 2>/dev/null)

  if [[ "$LOADING" == "True" ]]; then
    ok "server up, initial fetch in progress"
  elif [[ "$ACCOUNTS" == "0" ]]; then
    fail "server up but no accounts in response"
  elif [[ "$ERRORS" == "$ACCOUNTS" ]]; then
    fail "server up but all $ACCOUNTS account(s) have errors — check session keys"
  else
    FETCHED_AT=$(python3 -c "import json; d=json.load(open('/tmp/cldmon_health.json')); print(d.get('fetchedAt','unknown'))" 2>/dev/null)
    ok "$ACCOUNTS account(s) reporting, $ERRORS error(s), last fetched $FETCHED_AT"
  fi
else
  ok "server up (auth-protected, HTTP 401 — no password check performed)"
fi
