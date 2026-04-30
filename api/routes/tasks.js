import express from 'express';
import { HttpStream } from '../helpers/stream.js';
import {
    parseLegacyStreamBody
} from '../helpers/orders.js';

export function tasksRouterFactory({ streamRouter }) {
    const router = express.Router();

    router.post('/run', async (req, res, next) => {
        try {
            const payload = parseLegacyStreamBody(req.body);
            const stream = new HttpStream(res);

            const jobId = streamRouter.enqueue({ payload, stream });

            res.once('close', () => {
                streamRouter.cancel(jobId);
            });
        }
        catch (error) {
            return next(error);
        }
    });

    return router;
}
