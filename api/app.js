import express from 'express';
import { HttpError } from './helpers/error.js';
import { WSServer } from './helpers/wsServer.js';
import { StreamRouter } from './helpers/router.js';
import { sendSuccess } from './helpers/response.js';
import { errorMiddleware } from './middleware/error.js';
import { router as usersRouter } from './routes/users.js';
import { router as ordersRouter } from './routes/orders.js';
import { router as streamRoutesRouter } from './routes/stream.js';

const app = express();
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

const wsHost = '0.0.0.0';
const wsPort = Number(process.env.API_WS_PORT || 3000);
const wsPath = process.env.WORKER_ROUTE || '/ws/workers';

const workerSocketServer = new WSServer({ port: wsPort, path: wsPath });
console.log(`WebSocket server listening on ws://${wsHost}:${wsPort}${wsPath}`);

export const streamRouter = new StreamRouter({
    wsServer: workerSocketServer
});

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
    sendSuccess(res, {
        body: buildReadyPayload()
    });
});

app.use(streamRoutesRouter);
app.use(usersRouter);
app.use(ordersRouter);

app.use((req, res, next) => {
    next(new HttpError(404, 'I am sorry, but I think you are lost.'));
});

app.use(errorMiddleware);

app.listen(port, host, () => {
    console.log(`API running on http://${host}:${port}`);
});

export { app, streamRouter };
