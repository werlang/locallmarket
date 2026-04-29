---
name: debugging-operations
description: Diagnose runtime and integration issues across the API and Worker services. Use when services fail to boot, workers do not connect, LLM jobs stall, SSE streams are silent, or Docker networking breaks.
---

# Debugging and Operations

## Service Topology

| Service | Container port | Host port (compose) | Compose file |
|---|---|---|---|
| API | 3000 | 80 | `api/compose.yaml` |
| Worker | 3000 | none (internal) | `worker/compose.dev.yaml` |
| LLM model runner | configurable | external | not managed here |

Network: all services on Docker bridge network `llm`.

## First Checks

1. Container status:
   ```bash
   docker compose -f api/compose.yaml ps
   docker compose -f worker/compose.dev.yaml ps
   ```
2. Tail logs:
   ```bash
   docker compose -f api/compose.yaml logs --tail=100 api
   docker compose -f worker/compose.dev.yaml logs --tail=100 worker
   ```
3. API health:
   ```bash
   curl http://localhost/ready
   ```
4. Worker registered: look for `connectedWorkers > 0` in the `/ready` response.

## Fast Health Checks

```bash
# API readiness + queue state
curl http://localhost/ready

# Worker readiness (from inside llm network, or if port is published)
curl http://<worker-container-ip>:3000/ready

# Shell into API container
docker compose -f api/compose.yaml exec api sh

# Shell into worker container
docker compose -f worker/compose.dev.yaml exec worker sh
```

Expected `GET /ready` (API):
```json
{ "ok": true, "connectedWorkers": 1, "availableWorkers": 1, "activeJobs": 0, "queuedJobs": 0 }
```

Expected `GET /ready` (Worker):
```json
{ "ok": true, "message": "I am ready!", "timestamp": "...", "uptime": ... }
```

## WebSocket Debugging

**Verify worker registration**

Check API logs for:
```
Worker socket registered: <workerId>
```

If not present, the worker either cannot reach the API WebSocket URL or the `llm` network is not connected.

**Test WebSocket connectivity manually**

```bash
# Using wscat (npm install -g wscat)
wscat -c ws://localhost/ws/workers

# Send a registration message
{"type":"worker-register","payload":{"workerId":"debug-1","hostname":"local","pid":0}}
```

**Worker reconnect loop**

Worker logs repeating `API WebSocket error:` indicate the API is unreachable. Check:
- `API_WS_URL` in `worker/.env` — should use the API service name as host inside Docker (e.g., `ws://api:3000/ws/workers`).
- `llm` network: both containers must be on it.
- API container is running and has started the WebSocket server.

**Verify worker is dispatching jobs**

After sending a `POST /stream` request, API logs should show:
```
[<timestamp>] Dispatching job <jobId> to worker <workerId>.
[<timestamp>] Worker <workerId> completed job <jobId>.
```

## SSE Debugging

**Test `POST /stream` manually**

```bash
curl -N -X POST http://localhost/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"Say hello","model":"ai/smollm2"}'
```

Expected output: a sequence of SSE lines:
```
event: message
data: Hello

event: end
data: Stream complete.
```

**Validation error (400)**

```bash
# Missing model
curl -X POST http://localhost/stream \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
# → {"error":true,"status":400,"type":"Bad Request","message":"model is required in the request body."}

# Missing message
curl -X POST http://localhost/stream \
  -H "Content-Type: application/json" \
  -d '{"model":"ai/smollm2"}'
# → {"error":true,"status":400,"type":"Bad Request","message":"message must be a non-empty string."}
```

**SSE stream is silent after connection**

- Check `connectedWorkers` and `availableWorkers` in `/ready`. If both are 0, the worker is not connected.
- Check `queuedJobs` — if it keeps growing, workers are connected but not processing (check worker logs).
- Check worker logs for `Error calling LLM API:` which means the model runner is unreachable.

## LLM Model Runner Debugging

The worker calls:
```
POST {MODEL_RUNNER_HOST}/engines/llama.cpp/v1/chat/completions
```

```bash
# Test model runner reachability from inside worker container
docker compose -f worker/compose.dev.yaml exec worker \
  sh -c 'curl -s $MODEL_RUNNER_HOST/engines/llama.cpp/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL_RUNNER_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true}"'
```

Common failures:
- `MODEL_RUNNER_HOST` not set or wrong — worker logs show `Error calling LLM API: Failed to fetch`.
- Model runner not running — HTTP connection refused.
- Wrong model name — model runner returns `4xx`; worker logs show `Model call failed with status <code>`.

## Queue and Worker State

Use `GET /ready` to inspect the current state at any time:

| Field | Meaning |
|---|---|
| `connectedWorkers` | Workers with open WebSocket connections to API |
| `availableWorkers` | Workers currently idle and ready to accept jobs |
| `activeJobs` | Jobs currently being processed by a worker |
| `queuedJobs` | Jobs waiting for an available worker |

If `queuedJobs` grows unbounded: workers are either all busy or disconnected.  
If `availableWorkers` is 0 but `connectedWorkers > 0`: all workers are busy; this is normal under load.

## Common Failure Points

| Symptom | Likely cause | Check |
|---|---|---|
| `connectedWorkers: 0` | Worker not running or wrong `API_WS_URL` | Worker logs; env var |
| SSE request hangs forever | No available worker; job queued | `GET /ready` — `queuedJobs > 0` |
| SSE sends `event: error` | LLM model runner returned error | Worker logs for `Error calling LLM API:` |
| Worker reconnect loop | API WebSocket not reachable | API running? Network? `API_WS_URL`? |
| 400 on `POST /stream` | Missing or invalid `message` or `model` | Check request body |
| `llm` network not found | API compose not started | `docker compose -f api/compose.yaml up` first |

## Useful Files During Debugging

- `api/app.js` — route registration, `WSServer` setup
- `api/helpers/router.js` — `StreamRouter` dispatch, worker lifecycle
- `api/helpers/wsserver.js` — WebSocket event routing
- `api/helpers/stream.js` — SSE response wrapper
- `api/helpers/queue.js` — FIFO job queue
- `worker/app.js` — worker entry, `ApiStreamClient` initialization
- `worker/helpers/api-client.js` — WebSocket connection, reconnect logic, job handling
- `worker/model/llm.js` — LLM model runner fetch + stream processing
- `api/compose.yaml` — API compose config
- `worker/compose.dev.yaml` — Worker compose config
