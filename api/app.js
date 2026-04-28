import express from 'express';
import { HttpError } from './helpers/error.js';
import { StreamRouter } from './helpers/router.js';
import { HttpStream } from './helpers/stream.js';
import { WSServer } from './helpers/wsserver.js';
import { errorMiddleware } from './middleware/error.js';

const app = express();
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

const wsPort = process.env.API_WS_PORT || 3000;
const wsPath = process.env.WORKER_ROUTE || '/ws/workers';

const workerSocketServer = new WSServer({
    port: wsPort,
    path: wsPath
});
console.log(`WebSocket server listening on ws://${host}:${wsPort}${wsPath}`);

const streamRouter = new StreamRouter({ wsServer: workerSocketServer });

/**
 * Validate and normalize the client stream payload.
 * @param {any} body
 * @returns {{ message: string, model: string, host: string | undefined }}
 */
function parseStreamBody(body) {
    const payload = body || {};
    const message = typeof payload.message === 'string' && payload.message.trim().length > 0
        ? payload.message.trim()
        : (typeof payload.input === 'string' && payload.input.trim().length > 0
            ? payload.input.trim()
            : null);

    if (!message) {
        throw new HttpError(400, 'message must be a non-empty string.');
    }

    if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
        throw new HttpError(400, 'model is required in the request body.');
    }

    return {
        message,
        model: payload.model.trim(),
    };
}

/**
 * Summarize API readiness and worker capacity for health checks.
 * @returns {{ ok: boolean, connectedWorkers: number, availableWorkers: number, activeJobs: number, queuedJobs: number }}
 */
function buildReadyPayload() {
    return {
        ok: true,
        ...streamRouter.getState()
    };
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Health endpoint for local smoke tests and container readiness checks.
 */
app.get('/ready', (req, res) => {
    res.status(200).json(buildReadyPayload());
});

/**
 * Accepts a stream request, queues it, and relays worker chunks as SSE.
 */
app.post('/stream', (req, res, next) => {
    let stream;

    try {
        const payload = parseStreamBody(req.body);
        stream = new HttpStream(res);

        const jobId = streamRouter.enqueue({ payload, stream });
        console.log(`Enqueued job ${jobId} with model ${payload.model}`);

        res.once('close', () => {
            streamRouter.cancel(jobId);
        });
    } catch (error) {
        if (res.headersSent) {
            stream?.event('error').send(JSON.stringify({ error: error?.message || 'Invalid request.' }));
            stream?.close();
            return;
        }

        next(error);
    }
});

app.use((req, res, next) => {
    next(new HttpError(404, 'I am sorry, but I think you are lost.'));
});

app.use(errorMiddleware);

app.listen(port, host, () => {
    console.log(`API running on http://${host}:${port}`);
});

export { app, streamRouter };
