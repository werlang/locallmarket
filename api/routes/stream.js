import express from 'express';
import { applyLegacyStream, applyOrderUseStream } from '../helpers/orders.js';
import { ordersModel } from '../models/orders.js';
import { streamRouter } from '../helpers/runtime.js';

export function createStreamRouter({ ordersModel: resolvedOrdersModel = ordersModel, streamRouter: resolvedStreamRouter = streamRouter } = {}) {
    const router = express.Router();

    router.post('/workers/:orderid/use', async (req, res, next) => {
        await applyOrderUseStream({
            req,
            res,
            next,
            orderIdRaw: req.params.orderid,
            ordersModel: resolvedOrdersModel,
            streamRouter: resolvedStreamRouter
        });
    });

    router.post('/stream', async (req, res, next) => {
        const hasOrderId = Object.hasOwn(req.body || {}, 'orderId')
            && req.body.orderId !== undefined
            && req.body.orderId !== null
            && String(req.body.orderId).trim().length > 0;

        if (!hasOrderId) {
            await applyLegacyStream({
                req,
                res,
                next,
                streamRouter: resolvedStreamRouter
            });
            return;
        }

        await applyOrderUseStream({
            req,
            res,
            next,
            orderIdRaw: req.body?.orderId,
            ordersModel: resolvedOrdersModel,
            streamRouter: resolvedStreamRouter
        });
    });

    return router;
}

export const router = createStreamRouter();