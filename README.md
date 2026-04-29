# Stream Router

Queued LLM streaming over an API-owned SSE endpoint and worker-side WebSocket delivery.

The shipped runtime is intentionally narrow:

- Clients call `POST /stream` on the API.
- The API queues requests, assigns each job to the first available worker, and relays streamed chunks back over SSE.
- Workers connect outbound to the API over WebSocket and do not expose the client-facing stream endpoint.
- `GET /ready` on the API reports worker capacity and queue depth.

## Services

| Service | Folder | Host Port | Responsibility |
| --- | --- | --- | --- |
| `api` | `api/` | `80` | Client-facing `GET /ready`, `POST /stream`, queueing, SSE relay, worker WebSocket server |
| `worker` | `worker/` | not published by compose | Outbound WebSocket client that executes model streams and returns chunk events |

## Runtime Flow

1. A client sends `POST /stream` with `message` and `model` to the API.
2. The API opens an SSE response immediately, enqueues the job, and waits for the first available worker.
3. A worker receives the job over `ws://.../ws/workers`, calls the configured model runner, and emits `message`, `end`, or `error` events back over WebSocket.
4. The API relays those events to the original HTTP client and updates `/ready` counts as jobs start and drain.

## API Contract

### `GET /ready`

Returns the current API queue and worker state.

```json
{
  "ok": true,
  "connectedWorkers": 5,
  "availableWorkers": 5,
  "activeJobs": 0,
  "queuedJobs": 0
}
```

### `POST /stream`

Streams model output back to the client with Server-Sent Events.

- Request body: `{ "message": string, "model": string, "host"?: string }`
- `message` is the documented user prompt field.
- `model` is required for each request.
- `host` is an optional per-request model runner override for local testing.

Example request:

```sh
curl --max-time 45 -sS -N \
  -X POST http://127.0.0.1:3000/stream \
  -H 'content-type: application/json' \
  --data '{"message":"Reply with OK only.","model":"ai/smollm2:135M-Q2_K"}'
```

Example stream:

```text
event: message
data: Echo: 

event: message
data: Reply with OK only.

event: end
data: Stream complete.
```

Validation failures return the standard JSON error envelope before SSE starts.

Compatibility note: the API still tolerates `input` as an alias internally, but new clients should send `message`.

## Repository Layout

```text
api/
  app.js                 # API entrypoint and worker WebSocket server
  compose.yaml           # API compose file (host port 80 → container 3000)
  Dockerfile
  package.json
  helpers/
    error.js             # HTTP-safe error types
    queue.js             # FIFO queue for pending stream jobs
    router.js            # Worker registration, dispatch, and job lifecycle
    stream.js            # SSE response wrapper
    wsserver.js          # Typed WebSocket server for worker messages
  middleware/
    error.js             # JSON error envelope middleware
  test/
    unit/
    integration/

worker/
  app.js                 # Worker entrypoint and outbound API WebSocket client
  compose.dev.yaml       # Worker development compose file (no exposed ports)
  Dockerfile
  package.json
  helpers/
    api-client.js        # Worker socket lifecycle and job relay
    error.js             # Worker-side HTTP/model error types
  middleware/
    error.js             # Worker HTTP error envelope middleware
  model/
    llm.js               # Model runner SSE parser used by stream jobs
  routes/
    system.js            # Local worker `/ready` endpoint for process checks
  test/
    integration/
      stream-api.test.mjs
    unit/
      llm.test.mjs
      stream-router-reconnect.test.mjs
```

## Running Locally

### Docker Compose

```sh
docker compose -f api/compose.yaml up -d --build api
docker compose -f worker/compose.dev.yaml up -d --build worker
curl -sS http://127.0.0.1/ready
```

The API compose file publishes the API on `127.0.0.1:80` and the worker compose file keeps workers internal to the `llm` compose network.

### API Standalone

```sh
cd api
npm install
PORT=3300 node app.js
```

### Worker Standalone

```sh
cd worker
npm install
PORT=3301 \
API_WS_URL=ws://127.0.0.1:3300/ws/workers \
MODEL_RUNNER_HOST=http://127.0.0.1:3900 \
node app.js
```

When running both processes locally, choose different `PORT` values so the worker's local health server does not collide with the API.

## Environment Variables

### API

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | API listen port |
| `API_WS_PORT` | `3000` | Port for the WebSocket server that workers connect to |
| `WORKER_ROUTE` | `/ws/workers` | WebSocket path used by workers to register and receive jobs |
| `NODE_ENV` | unset | Controls whether error payloads include debug data |

### Worker

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local worker HTTP port for `/ready` only |
| `API_WS_URL` | `ws://127.0.0.1:3000/ws/workers` | Outbound WebSocket URL for API registration |
| `MODEL_RUNNER_HOST` | unset | Base URL for the model runner SSE API |
| `MODEL_RUNNER_MODEL` | unset | Default model name when a request does not override it |
| `NODE_ENV` | unset | Controls whether worker error payloads include debug data |

## Running Tests

### Worker

```sh
cd worker && npm test
```

Unit-only or integration-only:

```sh
cd worker && npm run test:unit
cd worker && npm run test:integration
```

### API

```sh
cd api && npm test
```

Unit-only or integration-only:

```sh
cd api && npm run test:unit
cd api && npm run test:integration
```

The active suite covers the worker reconnect guardrails, the live LLM stream parser, and the end-to-end API queue plus WebSocket relay flow.

