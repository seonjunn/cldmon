# cldmon — Claude Usage Monitor

A self-hosted dashboard that tracks Claude subscription usage (5-hour and 7-day utilization) across multiple accounts, with history charts.

## Prerequisites

- **Node.js** v18+ (`node --version`)
- **npm** v8+ (bundled with Node)
- A valid `claude.ai` session key for each account you want to monitor

### Getting your session key

1. Log in to [claude.ai](https://claude.ai) in your browser
2. Open DevTools (`F12` or `Cmd+Option+I`)
3. Go to **Application** tab → **Cookies** → `https://claude.ai`
4. Find the cookie named `sessionKey` and copy its value (starts with `sk-ant-sid02-`)

> The session key grants full access to your Claude account — treat it like a password. It lives only in `config.json` on this server and is never sent over the network (Puppeteer uses it server-side). Rotate it by logging out and back in on claude.ai.
>
> Sessions typically expire after a few weeks of inactivity or when you explicitly log out on that device.

## Setup

```sh
git clone <repo-url>
cd cldmon
npm install
node node_modules/puppeteer/lib/cjs/puppeteer/node/cli.js browsers install chrome
cp config.example.json config.json   # if config.example.json exists, otherwise edit config.json directly
```

Edit `config.json`:

```json
{
  "password": "your-strong-password",
  "sessionSecret": "random-secret-string",
  "port": 3000,
  "fetchIntervalMinutes": 10,
  "accounts": [
    { "label": "alice", "sessionKey": "sk-ant-sid02-..." },
    { "label": "bob",   "sessionKey": "sk-ant-sid02-..." }
  ]
}
```

> **Important:** Set a non-empty `password` if the service is publicly accessible.

## Running

```sh
# Development (foreground)
npm start

# Production (persistent, with pm2)
npx pm2 start ecosystem.config.js
npx pm2 save
npx pm2 startup   # follow the printed command to auto-start on reboot
```

## API

All endpoints except `POST /api/auth` require an active session (login first).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth` | Login. Body: `{ "password": "..." }` |
| `GET`  | `/api/usage` | Latest usage snapshot for all accounts |
| `GET`  | `/api/history?range=1h\|5h\|1d\|7d` | Historical snapshots within the given range |

### `GET /api/usage` response

```json
{
  "fetchedAt": "2026-03-12T02:47:15.095Z",
  "accounts": [
    {
      "label": "alice",
      "status": "ok",
      "fiveHour":  { "utilization": 17, "resetsAt": "2026-03-12T06:00:00Z" },
      "sevenDay":  { "utilization": 45, "resetsAt": "2026-03-13T07:00:00Z" }
    }
  ]
}
```

`utilization` is 0–100 (percent). An account with `"status": "error"` includes an `"error"` string instead of utilization data.

### `GET /api/history?range=1h` response

Array of snapshots saved to `data/history.jsonl`:

```json
[
  {
    "timestamp": 1773283635095,
    "accounts": [
      { "label": "alice", "fiveHour": 17, "sevenDay": 45 }
    ]
  }
]
```

History is stored as a JSONL file (`data/history.jsonl`, one JSON object per line). It is **not** automatically pruned — each successful poll appends one line. For long-running deployments, periodically archive or truncate old entries.

## Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `password` | `""` (no auth) | Dashboard login password. Leave empty to disable auth. |
| `sessionSecret` | `"cldmon-secret-change-me"` | Express session signing secret. Change this. |
| `port` | `3000` | HTTP port to listen on. |
| `fetchIntervalMinutes` | `10` | How often to poll claude.ai for fresh data (in minutes). See note below. |
| `accounts` | `[]` | List of `{ label, sessionKey }` objects. |

### Controlling the update rate

The poll interval is set via `fetchIntervalMinutes` in `config.json` (default: 10 minutes, hardcoded as `FETCH_INTERVAL_MS` in `server.js`). The config key is read only at startup, so restart the server after changing it.

> Polling too frequently may trigger rate limiting or flag your session on claude.ai. 10 minutes is a safe default.

## Health check

Run this any time to verify the service is up and accounts are reporting:

```sh
./healthcheck.sh
```

Output examples:

```
[2026-03-12T02:54:43Z] OK:   2 account(s) reporting, 0 error(s), last fetched 2026-03-12T02:47:15.095Z
[2026-03-12T02:54:43Z] FAIL: all 2 account(s) have errors — check session keys
[2026-03-12T02:54:43Z] FAIL: server process not found
```

Every run appends a timestamped line to `data/health.log`. To tail it live:

```sh
tail -f data/health.log
```

To run it automatically every 10 minutes via cron:

```sh
crontab -e
# add:
*/10 * * * * cd /home/seonjunkim/projects/dev/cldmon && ./healthcheck.sh
```

## Troubleshooting

**Chrome not found on first run**

```sh
node node_modules/puppeteer/lib/cjs/puppeteer/node/cli.js browsers install chrome
```

`npx puppeteer browsers install chrome` does not work due to a broken `.bin` shim — use the path above directly.

**Session expired / 401 / 404 errors on an account**

The session key has expired. To refresh it:

1. Log in to [claude.ai](https://claude.ai) on the affected account
2. DevTools → Application → Cookies → `https://claude.ai` → copy `sessionKey`
3. Paste the new value into `config.json` under that account's `sessionKey`
4. No restart needed — the server re-reads config on the next poll (within 10 min)

**Port already in use**

```sh
lsof -i :3000        # find the occupying process
kill <PID>
```
