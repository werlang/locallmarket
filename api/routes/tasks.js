import express from 'express';
import { applyOrderUseStream } from '../helpers/orders.js';
import { ordersModel } from '../models/orders.js';
import { usersModel } from '../models/users.js';
import { parseBearerApiKey } from '../helpers/auth.js';
import { HttpStream } from '../helpers/stream.js';
import {
    parseLegacyStreamBody,
    parseOrderId,
    parseUseWorkerBody,
} from '../helpers/orders.js';

const router = express.Router();

export function tasksRouterFactory({ streamRouter }) {
    router.post('/:orderid/run', async (req, res, next) => {
        try {
            const apiKey = parseBearerApiKey(headers);
            const user = await usersModel.getByApiKey(apiKey);
            const consumerId = user.id;
            const orderId = parseOrderId(req.params.orderid);
            const streamBody = parseUseWorkerBody(req.body);
            const consumed = await ordersModel.consumeForUse(consumerId, orderId);

            const stream = new HttpStream(res);
            const jobId = streamRouter.enqueue({
                payload: {
                    message: streamBody.message,
                    model: consumed.order.model
                },
                stream,
                targetWorkerId: consumed.order.workerId,
                onJobAborted: async () => {
                    console.error(`[applyOrderUseStream] Queued job aborted for order ${orderId}. Compensating consume...`);
                    try {
                        await ordersModel.unconsumForUse(consumerId, orderId);
                    } catch (refundError) {
                        console.error('[applyOrderUseStream] Compensation refund failed:', refundError);
                    }

                    if (!stream.closed) {
                        stream.event('error').send(JSON.stringify({ error: 'Worker disconnected before processing. Order has been refunded.' }));
                        stream.close();
                    }
                }
            });

            res.once('close', () => {
                streamRouter.cancel(jobId);
            });
        } catch (error) {
            return next(error);
        }
    });

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
