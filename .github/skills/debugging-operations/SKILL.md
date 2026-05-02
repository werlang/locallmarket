---
name: debugging-operations
description: Diagnose runtime and integration issues across the API and Worker services. Use when services fail to boot, workers do not connect, LLM jobs stall, SSE streams are silent, database operations fail, or Docker networking breaks.
---

# Debugging and Operations

## Container Architecture

| Service | Container | Port (host) | Port (container) | Compose file | Network |
|---------|-----------|-------------|------------------|--------------|---------|
| **API** | `api-api-1` | 80 (HTTP), 3030 (WebSocket) | 3000 | `api/compose.yaml` | `llm` |
| **Worker** | `worker-worker-1` | none | 3000 | `worker/compose.dev.yaml` | `llm` |
| **MySQL** | `mysql-mysql-1` | 3306 | 3306 | `api/compose.yaml` | `llm` |

All services communicate over the Docker bridge network `llm`.

## Quick Start & Health Checks

### Check Container Status

```bash
# API + MySQL
docker compose -f api/compose.yaml ps

# Worker
docker compose -f worker/compose.dev.yaml ps
```

Expected: all services in `running` state.

### Health Probes

```bash
# API health + queue state (should return JSON)
curl http://localhost/ready
# Expected: { "ok": true, "connectedWorkers": 1, "availableWorkers": 1, "activeJobs": 0, "queuedJobs": 0 }

# Worker health (from inside llm network or if port exposed)
docker compose -f worker/compose.dev.yaml exec worker curl http://localhost:3000/ready
# Expected: { "ok": true, "message": "I am ready!", "timestamp": "...", "uptime": ... }
```

### Tail Logs

```bash
# API service
docker compose -f api/compose.yaml logs --tail=100 -f api

# Worker service
docker compose -f worker/compose.dev.yaml logs --tail=100 -f worker

# MySQL (startup messages)
docker compose -f api/compose.yaml logs --tail=50 mysql
```

### Shell into Containers

```bash
# API container
docker compose -f api/compose.yaml exec api sh

# Worker container
docker compose -f worker/compose.dev.yaml exec worker sh

# MySQL container
docker compose -f api/compose.yaml exec mysql mysql -uroot -p${MYSQL_ROOT_PASSWORD} ${MYSQL_DATABASE}
```

## Troubleshooting Matrix

### Issue: API Container Fails to Start

**Symptom:** `docker compose -f api/compose.yaml up` exits immediately or throws error.

**Steps:**

1. Check logs for error message:
   ```bash
   docker compose -f api/compose.yaml logs api
   ```

2. Common causes:
   - **Port 80 already in use** — another service running on port 80
     ```bash
     lsof -i :80  # macOS/Linux
     ```
     Solution: Either kill the process or change `ports: [ "80:3000" ]` in `api/compose.yaml`

   - **Environment variables missing** — check `.env` in `api/` directory
     ```bash
     ls -la api/.env
     cat api/.env  # verify MYSQL_DATABASE, MYSQL_ROOT_PASSWORD, PORT, API_WS_PORT
     ```

   - **MySQL connection fails** — MySQL container not running or network `llm` doesn't exist
     ```bash
     docker compose -f api/compose.yaml ps mysql
     docker network ls | grep llm
     ```

3. Restart the service:
   ```bash
   docker compose -f api/compose.yaml restart api
   ```

### Issue: Worker Cannot Connect to API

**Symptom:** Worker logs show repeating errors like:
```
[timestamp] API WebSocket error: ECONNREFUSED or Connection rejected
[timestamp] Retrying WebSocket connection in Xms...
```

**Steps:**

1. Verify Worker has correct `API_WS_URL`:
   ```bash
   docker compose -f worker/compose.dev.yaml exec worker env | grep API_WS_URL
   # Expected: ws://api:3000/ws/workers (internal Docker name)
   ```
   
   If `API_WS_URL` is pointing to `localhost` or external IP, update `worker/.env`:
   ```bash
   echo "API_WS_URL=ws://api:3000/ws/workers" >> worker/.env
   ```

2. Verify both containers are on the `llm` network:
   ```bash
   docker network inspect llm
   # Check: api and worker containers listed
   ```

3. Verify API WebSocket server is running and listening:
   ```bash
   docker compose -f api/compose.yaml exec api curl http://localhost:3000/ready
   # If this succeeds, API is running; WebSocket should be reachable
   ```

4. Test WebSocket connectivity manually from worker container:
   ```bash
   docker compose -f worker/compose.dev.yaml exec worker sh
   # Inside container:
   apk add --no-cache curl websocat  # or equivalent for your base image
   websocat ws://api:3000/ws/workers
   # Should establish connection; type Ctrl+C to exit
   ```

5. Restart worker service:
   ```bash
   docker compose -f worker/compose.dev.yaml restart worker
   ```

### Issue: Worker Registered but Jobs Not Dispatching

**Symptom:**
- `GET /ready` shows `connectedWorkers > 0`
- `POST /tasks/run` or `POST /v1/chat/completions` returns SSE stream but no output
- API logs don't show dispatch message

**Steps:**

1. Check if worker is actually ready (not busy):
   ```bash
   curl http://localhost/ready
   # availableWorkers should be > 0
   ```

2. Check API logs for job enqueue:
   ```bash
   docker compose -f api/compose.yaml logs --tail=200 api | grep -i "dispatch\|enqueue\|job"
   ```

3. Check worker logs for job receipt:
   ```bash
   docker compose -f worker/compose.dev.yaml logs --tail=200 worker | grep -i "stream-job\|dispatch"
   ```

4. If no "dispatch" message in API logs:
   - StreamRouter may not have enqueued the job
   - Check validation errors in API logs
   - Verify `model` in request matches a registered worker's model

5. If worker received job but produced no output:
   - Check LLM model runner is reachable
   - Check `MODEL_RUNNER_HOST` env var in worker
   - Test LLM runner directly (see below)

### Issue: LLM Model Runner Unreachable

**Symptom:** Worker logs show:
```
Error calling LLM API: ECONNREFUSED or Connection timeout
```

**Steps:**

1. Verify `MODEL_RUNNER_HOST` in worker environment:
   ```bash
   docker compose -f worker/compose.dev.yaml exec worker env | grep MODEL_RUNNER_HOST
   ```

2. Test connectivity from worker container:
   ```bash
   docker compose -f worker/compose.dev.yaml exec worker sh
   # Inside container:
   curl -v http://${MODEL_RUNNER_HOST}/engines/llama.cpp/v1/chat/completions
   ```

3. If unreachable:
   - Is the LLM runner service running and exposed?
   - Is `MODEL_RUNNER_HOST` correct (hostname vs IP)?
   - If LLM runner is outside Docker, is it accessible from `llm` network?
   - Update `worker/.env` if needed and restart

### Issue: MySQL Cannot Connect or Database Not Initialized

**Symptom:** API logs show:
```
Error: connect ECONNREFUSED 127.0.0.1:3306
or
Error: ER_NO_DB_ERROR
```

**Steps:**

1. Verify MySQL container is running:
   ```bash
   docker compose -f api/compose.yaml ps mysql
   ```

2. Check MySQL logs for initialization errors:
   ```bash
   docker compose -f api/compose.yaml logs mysql
   # Look for: "ready for connections" message
   ```

3. Test MySQL connectivity:
   ```bash
   docker compose -f api/compose.yaml exec api \
     sh -c 'mysql -h mysql -u root -p${MYSQL_ROOT_PASSWORD} -e "SELECT 1;"'
   ```

4. Verify schema was created:
   ```bash
   docker compose -f api/compose.yaml exec api \
     sh -c 'mysql -h mysql -u root -p${MYSQL_ROOT_PASSWORD} ${MYSQL_DATABASE} \
       -e "SHOW TABLES;"'
   # Expected: orders, users, workers tables
   ```

5. If schema not created:
   - Check `api/schema.sql` exists
   - Manual schema load:
     ```bash
     docker compose -f api/compose.yaml exec mysql \
       mysql -u root -p${MYSQL_ROOT_PASSWORD} ${MYSQL_DATABASE} < api/schema.sql
     ```

6. Restart MySQL to force re-initialization:
   ```bash
   docker compose -f api/compose.yaml down mysql
   docker compose -f api/compose.yaml up -d mysql
   # Wait ~10 seconds for initialization
   ```

## Advanced Debugging

### WebSocket Message Inspection

Intercept WebSocket messages between API and worker:

```bash
# From inside API container, monitor port 3030
docker compose -f api/compose.yaml exec api sh
# Inside:
netstat -an | grep 3030
# or use tcpdump if available:
tcpdump -i eth0 'port 3030' -A
```

Alternatively, add console.log in `api/helpers/wsserver.js`:
```js
this.ws.on('message', (message) => {
  const parsed = JSON.parse(message);
  console.log(`[WebSocket message] type=${parsed.type}`, JSON.stringify(parsed.payload).slice(0, 100));
  // ... rest of handler
});
```

### Database Query Logging

To see SQL queries executed, add logging to `api/helpers/mysql.js`:

```js
async find(table, { filter = {}, view = [], opt = {} } = {}) {
  const query = this.#buildFindQuery(table, filter, view, opt);
  console.log(`[MySQL query]`, query);  // ADD THIS
  const results = await this.connection.query(query);
  return results;
}
```

Then restart API and tail logs:
```bash
docker compose -f api/compose.yaml restart api
docker compose -f api/compose.yaml logs --tail=100 -f api | grep "\[MySQL query\]"
```

### Worker Reconnect Backoff Timing

Worker reconnects with exponential backoff (1s → 10s). Monitor in logs:

```bash
docker compose -f worker/compose.dev.yaml logs --tail=50 -f worker | grep -i "reconnect\|retrying"
# Expected: increasing delays between attempts
```

### Performance/Memory Issues

Check resource usage:

```bash
# CPU, memory for each container
docker stats --no-stream

# If API is slow, check queue depth
curl http://localhost/ready | jq .queuedJobs

# If many jobs queued but not processing, worker may be stuck
docker compose -f worker/compose.dev.yaml logs --tail=50 worker
```

## Rebuild and Clean Start

When making code changes or suspect stale Docker state:

```bash
# Full rebuild (both services + MySQL)
docker compose -f api/compose.yaml down
docker compose -f worker/compose.dev.yaml down
docker compose -f api/compose.yaml up -d --build
docker compose -f worker/compose.dev.yaml up -d --build

# Wait for MySQL initialization (~5-10 seconds)
sleep 10

# Verify health
curl http://localhost/ready
docker compose -f worker/compose.dev.yaml logs worker | tail -20
```

## Logging Strategy (Current)

- **Framework**: `console.log` (no structured logging library)
- **Output**: STDOUT/STDERR captured by Docker
- **Limitations**:
  - No log levels (debug/info/warn/error)
  - No timestamps in most logs (container adds them)
  - No request ID correlation across services
  - No sampling for high-volume logs

**Improvement roadmap:**
- Consider `pino` or `winston` for structured JSON logs
- Add request IDs for tracing across services
- Add debug-level verbosity flag

## Checklist for "Service Not Working"

Use this flow to diagnose most issues:

1. ✅ Are all containers running? (`docker compose ps`)
2. ✅ Is API responding to `/ready`? (`curl http://localhost/ready`)
3. ✅ Are workers connected? (`connectedWorkers > 0` in `/ready` response)
4. ✅ Are workers available? (`availableWorkers > 0`)
5. ✅ Can you reach worker health endpoint? (`docker exec worker curl ...`)
6. ✅ Does API show job dispatch in logs? (`grep dispatch api logs`)
7. ✅ Does worker show job receipt in logs? (`grep stream-job worker logs`)
8. ✅ Is LLM runner reachable? (`curl ${MODEL_RUNNER_HOST}/...`)
9. ✅ Is MySQL running and schema loaded? (`mysql ... SHOW TABLES;`)
10. ✅ Check environment variables in `.env` files match Docker setup

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
