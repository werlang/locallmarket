---
name: docker-deployment
description: Configure and run the API and Worker services with Docker Compose. Use when starting, stopping, rebuilding, or troubleshooting either service container, or when investigating networking, port, environment variable, or WebSocket connectivity issues.
---

# Docker Deployment

## Compose Files

| Service | Compose file | Purpose |
|---|---|---|
| API | `api/compose.yaml` | Runs the API service in production-like mode |
| Worker | `worker/compose.dev.yaml` | Runs the worker service in dev mode (source mounted) |

> **Important**: The worker compose declares the `llm` network as **external**. The API compose creates it. Always start the API service first so the network exists before the worker starts.

## API Service (`api/compose.yaml`)

```yaml
services:
  api:
    build: .
    ports:
      - 80:3000
      - 3030:3030
    env_file: .env
    volumes:
      - .:/app
      - node_modules_api:/app/node_modules
    restart: unless-stopped
    networks:
      - llm
    command: npm start
networks:
  llm:
    name: llm
```

- External port **80** maps to container port **3000** (HTTP).
- Port **3030** is available for the WebSocket server if `API_WS_PORT=3030` is set.
- Source directory is mounted for live updates.

## Worker Service (`worker/compose.dev.yaml`)

```yaml
services:
  worker:
    build: .
    env_file: .env
    volumes:
      - .:/app
      - node_modules_worker:/app/node_modules
    restart: unless-stopped
    networks:
      - llm
    command: npm start
    deploy:
      replicas: ${WORKER_REPLICAS:-1}
networks:
  llm:
    external: true
```

- No published ports (worker does not accept inbound HTTP from outside Docker).
- Scale workers with `WORKER_REPLICAS=N` in `worker/.env`.
- Network `llm` must already exist (created by API compose).

## Environment Variables

### API (`api/.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port inside container |
| `API_WS_PORT` | `3000` | WebSocket server port (shares HTTP port by default) |
| `WORKER_ROUTE` | `/ws/workers` | WebSocket path for worker connections |

### Worker (`worker/.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Worker HTTP health port inside container |
| `API_WS_URL` | `ws://127.0.0.1:3000/ws/workers` | WebSocket URL to connect to the API |
| `MODEL_RUNNER_HOST` | *(required)* | Base URL of the LLM model runner (e.g., `http://model-runner.docker.internal:80`) |
| `MODEL_RUNNER_MODEL` | *(required)* | Default model identifier (e.g., `ai/smollm2`) |
| `WORKER_REPLICAS` | `1` | Number of worker container replicas |

## Start / Stop

```bash
# Start API (creates the llm network)
docker compose -f api/compose.yaml up -d --build api

# Start worker (after API is running)
docker compose -f worker/compose.dev.yaml up -d --build worker

# Logs
docker compose -f api/compose.yaml logs -f api
docker compose -f worker/compose.dev.yaml logs -f worker

# Status
docker compose -f api/compose.yaml ps
docker compose -f worker/compose.dev.yaml ps

# Stop
docker compose -f api/compose.yaml down
docker compose -f worker/compose.dev.yaml down
```

## Development Characteristics

- Both services mount their source directory so code changes take effect on container restart.
- API and Worker both run `npm start` which uses `node --watch app.js` for automatic restart on file changes.
- `node_modules` are isolated in named volumes to avoid host/container conflicts.

## Validation

After startup:

```bash
# API health check
curl http://localhost/ready

# Worker health check (from inside the llm network or with exposed port)
curl http://localhost:3000/ready
```

Expected API response:
```json
{ "ok": true, "connectedWorkers": 1, "availableWorkers": 1, "activeJobs": 0, "queuedJobs": 0 }
```

## Troubleshooting

**Worker not connecting to API WebSocket**
- Verify `API_WS_URL` in `worker/.env` uses the API container name as host (e.g., `ws://api:3000/ws/workers` when both are on the `llm` network).
- Check API logs for connection messages: `Worker socket registered:`.
- Confirm `GET /ready` shows `connectedWorkers > 0`.

**LLM model runner not reachable**
- Verify `MODEL_RUNNER_HOST` points to the correct host/port visible from inside the worker container.
- Docker Desktop: use `host.docker.internal` or `model-runner.docker.internal` for host-side services.
- Check worker logs for `Error calling LLM API:` messages.

**Worker not processing jobs (`availableWorkers: 0`)**
- Worker may be busy with a long job; check `activeJobs` in `/ready`.
- If worker crashed, check container status: `docker compose -f worker/compose.dev.yaml ps`.
- Reconnect is automatic with exponential backoff (1s up to 10s); wait or restart the worker container.

**Stale dependencies**
```bash
docker compose -f api/compose.yaml build --no-cache api
docker compose -f worker/compose.dev.yaml build --no-cache worker
```

**Network not found when starting worker**
- The `llm` bridge network is created by `api/compose.yaml`. Start the API service first.
- Or create it manually: `docker network create llm`.
