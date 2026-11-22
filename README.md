# Plutonium CGAPI

Cloud gaming API for Sorastream — accounts, catalog, game sessions and WebRTC signaling. API only: no UI, no static files.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | service info + endpoint index |
| GET | `/health` | liveness probe |
| POST | `/api/accounts` | issue a ready-to-use account (`201`) |
| GET | `/api/catalog/games` | catalog (`?locale`, `?page`, `?size`, `?genre`) |
| GET | `/api/catalog/genres` | genres (`?lang`) |
| GET | `/api/catalog/games/:id` | single game (`?lang`, `?profileId`) |
| POST | `/api/stream` | start a game session (JSON or SSE) |
| GET | `/api/signal?server=` | WebSocket proxy for WebRTC signaling |

### `POST /api/accounts`

```json
{
  "success": true,
  "data": { "email": "...", "password": "...", "token": "...", "userId": "...", "profileId": "..." },
  "source": "pool"
}
```

Accounts are pre-warmed in the background (`POOL_SIZE`) and handed out from the pool; the pool request path creates one live if the pool is empty. The pool is persisted to `DATA_DIR/accounts.json` (owner-only permissions, gitignored, mount it as a volume).

### `POST /api/stream`

```json
{ "token": "...", "userId": "...", "profileId": "...", "gameId": "...", "gameName": "...", "lang": "en-US" }
```

JSON response:

```json
{ "success": true, "data": { "server": "stg-plt-1.ludiumlab.com", "execToken": "..." } }
```

With `Accept: text/event-stream` the same request streams queue progress and aborts upstream work if the client disconnects:

```
event: queue
data: {"position":3,"retryIn":5}

event: ready
data: {"server":"stg-plt-1.ludiumlab.com","execToken":"..."}

event: error
data: {"error":"stream session failed"}
```

### `GET /api/signal?server={server}`

WebSocket (`sorartc-1.0`) proxy to the game server. Only hostnames matching `ALLOWED_SIGNAL_HOSTS` are accepted (default `.ludiumlab.com`). The client owns the WebRTC negotiation: receive `offer`, answer, then send `{"id":"server","type":"answer","sdp":"..."}`.

## Requirements

Bun >= 1.2.

## Run

```bash
bun install
cp .env.example .env
bun run start
```

`bun run dev` restarts on file changes. `bun run typecheck` runs `tsc --noEmit`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | set to `production` in prod |
| `PORT` | `3000` | listen port |
| `HOST` | `0.0.0.0` | bind address; use `127.0.0.1` behind a reverse proxy |
| `LOG_LEVEL` | `info` | pino level (JSON logs to stdout) |
| `CORS_ORIGIN` | `*` | comma separated allowed origins, or `*` |
| `DATA_DIR` | `./data` | writable directory for the account pool |
| `POOL_SIZE` | `5` | pre-warmed accounts; `0` disables the pool |
| `POOL_MAX_AGE_HOURS` | `12` | discard pooled accounts older than this |
| `REGION_CODE` | `US` | region sent when starting a session |
| `REQUEST_TIMEOUT_MS` | `20000` | upstream HTTP timeout |
| `QUEUE_TIMEOUT_MS` | `600000` | max time waiting for a free game server |
| `MAIL_TIMEOUT_MS` | `90000` | max time waiting for a verification email |
| `ALLOWED_SIGNAL_HOSTS` | `.ludiumlab.com` | comma separated host allowlist for `/api/signal` |

## Deployment

### Docker

```bash
docker build -t plutonium-cgapi .
docker run -d --name cgapi -p 3000:3000 \
  -e CORS_ORIGIN=https://your-frontend.example \
  -v cgapi-data:/app/data \
  plutonium-cgapi
```

The image runs as the unprivileged `bun` user, logs JSON to stdout and ships a healthcheck against `/health`.

### systemd

```ini
[Unit]
Description=Plutonium CGAPI
After=network.target

[Service]
Type=simple
User=cgapi
WorkingDirectory=/opt/plutonium-cgapi
EnvironmentFile=/opt/plutonium-cgapi/.env
ExecStart=/usr/local/bin/bun api/index.ts
Restart=always
RestartSec=5
StateDirectory=cgapi

[Install]
WantedBy=multi-user.target
```

### Reverse proxy (Caddy)

```Caddyfile
cgapi.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set `HOST=127.0.0.1` when the API is only reachable through the proxy and keep WebSocket upgrades enabled (Caddy does this automatically). Do not put the API behind buffers that break SSE.

## Operational notes

- `/health` is unauthenticated and safe for load-balancer probes.
- Upstream failures return `502` with a generic message; details go to the logs only.
- `accounts.json` holds live session tokens — treat it as a secret and back it up/rotate with care.
- Graceful shutdown on `SIGTERM`/`SIGINT` drains requests, with a 15s forced exit.

## License

Source-available with required attribution. See [LICENSE](LICENSE). If you use this, you must credit the author visibly.
