import express from 'express';
import { ApiStreamClient } from './helpers/api-client.js';
import { HttpError } from './helpers/error.js';
import { errorMiddleware } from './middleware/error.js';
import { router as systemRouter } from './routes/system.js';

const app = express();
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

const apiClient = new ApiStreamClient({
    url: process.env.API_WS_URL,
    apiKey: process.env.WORKER_USER_API_KEY,
    model: process.env.WORKER_MODEL,
    tps: process.env.WORKER_TPS ? Number(process.env.WORKER_TPS) : undefined,
    price: process.env.WORKER_PRICE ? Number(process.env.WORKER_PRICE) : undefined
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/', systemRouter);

apiClient.connect();

/**
 * Forwards unmatched API requests to the terminal error middleware.
 */
app.use((req, res, next) => {
    next(new HttpError(404, 'I am sorry, but I think you are lost.'));
});

app.use(errorMiddleware);

app.listen(port, host, () => {
    console.log(`WORKER running on http://${host}:${port}`);
});

export { app, apiClient };