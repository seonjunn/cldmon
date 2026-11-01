# cldmon — Agent Instructions

## Project overview

Node.js + Express dashboard that scrapes claude.ai usage data via Puppeteer (stealth) and serves it as a web UI with history charts.

## Key files

- `server.js` — all backend logic (Express, Puppeteer, history, scheduling)
- `config.json` — runtime config (accounts, password, port, interval); re-read on each poll, no restart needed for account changes
- `data/history-YYYY-MM-DD.jsonl` — append-only JSONL history, one file per day
- `public/` — static frontend (vanilla JS + Chart.js)
- `service.sh` — systemd user service commands

## Setup commands (must run in order)

```sh
npm install
node node_modules/puppeteer/lib/cjs/puppeteer/node/cli.js browsers install chrome
```

> **Do not use** `npx puppeteer browsers install chrome` — the `.bin/puppeteer` shim is broken. Always invoke the CLI via the full path above.

## Running

Use the systemd user service, matching the other local services. Never launch a separate `node server.js` process or add this app back to PM2.

```sh
./service.sh start
./service.sh restart
./service.sh stop
./service.sh status
./service.sh logs
```

The unit is `~/.config/systemd/user/cldmon.service`. It is enabled for boot; user lingering is enabled. Check `ss -tlnp | grep 3000` when diagnosing port conflicts. PM2 no longer manages this app.

## Architecture notes

- Puppeteer launches a headless Chrome per poll cycle, injects the `sessionKey` cookie, hits `/api/organizations` then `/api/organizations/{uuid}/usage`, and closes the page
- An account can belong to several orgs (an unused team org may be listed first), so usage is fetched for every org and the one with the highest 7d (then 5h) utilization is shown; set `org` (uuid or name) on an account to pin one
- `cachedUsage` is an in-memory variable; history is persisted to daily files (`data/history-YYYY-MM-DD.jsonl`)
- Poll interval is `FETCH_INTERVAL_MS` (hardcoded at top of `server.js`); `fetchIntervalMinutes` in config.json is the intended override but requires wiring into the server (currently hardcoded)
- Sessions use `express-session` with in-memory store; sessions are lost on restart

## Config reference

```json
{
  "password": "",           // empty = no auth
  "sessionSecret": "...",   // express-session secret
  "port": 3000,
  "accounts": [
    { "label": "alice", "sessionKey": "sk-ant-sid02-...", "org": "optional uuid or name" }
  ]
}
```

## API endpoints

- `POST /api/auth` — `{ password }` → sets session cookie
- `GET  /api/usage` — latest snapshot (requires auth if password set)
- `GET  /api/history?range=1h|5h|1d|7d` — filtered history array

## Health check

```sh
./healthcheck.sh          # prints OK/FAIL and appends to data/health.log
tail -f data/health.log   # live log
```

Checks: process running → HTTP 200/401 → valid JSON → at least one account without error.

## Known issues / gotchas

- The `.bin/puppeteer` shim requires `../puppeteer.js` relative to `.bin/`, which doesn't exist — always use the full CLI path
- History files (`data/history-YYYY-MM-DD.jsonl`) accumulate indefinitely; delete old day files manually when no longer needed
- Config is re-read on each poll for accounts/sessionKey, but `port` and `fetchIntervalMinutes` are only read at startup
