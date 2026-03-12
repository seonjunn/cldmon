# cldmon — Agent Instructions

## Project overview

Node.js + Express dashboard that scrapes claude.ai usage data via Puppeteer (stealth) and serves it as a web UI with history charts.

## Key files

- `server.js` — all backend logic (Express, Puppeteer, history, scheduling)
- `config.json` — runtime config (accounts, password, port, interval); re-read on each poll, no restart needed for account changes
- `data/history.jsonl` — append-only JSONL history file
- `public/` — static frontend (vanilla JS + Chart.js)
- `ecosystem.config.js` — pm2 config

## Setup commands (must run in order)

```sh
npm install
node node_modules/puppeteer/lib/cjs/puppeteer/node/cli.js browsers install chrome
```

> **Do not use** `npx puppeteer browsers install chrome` — the `.bin/puppeteer` shim is broken. Always invoke the CLI via the full path above.

## Running

```sh
node server.js                        # foreground
npx pm2 start ecosystem.config.js    # background / production
```

## Architecture notes

- Puppeteer launches a headless Chrome per poll cycle, injects the `sessionKey` cookie, hits `/api/organizations` then `/api/organizations/{uuid}/usage`, and closes the page
- `cachedUsage` is an in-memory variable; history is persisted to `data/history.jsonl`
- Poll interval is `FETCH_INTERVAL_MS` (hardcoded at top of `server.js`); `fetchIntervalMinutes` in config.json is the intended override but requires wiring into the server (currently hardcoded)
- Sessions use `express-session` with in-memory store; sessions are lost on restart

## Config reference

```json
{
  "password": "",           // empty = no auth
  "sessionSecret": "...",   // express-session secret
  "port": 3000,
  "accounts": [
    { "label": "alice", "sessionKey": "sk-ant-sid02-..." }
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
- `data/history.jsonl` grows unboundedly; prune manually for long-running deployments
- Config is re-read on each poll for accounts/sessionKey, but `port` and `fetchIntervalMinutes` are only read at startup
