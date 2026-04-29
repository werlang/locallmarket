import express from 'express';
import { applyLegacyStream, applyOrderUseStream } from '../helpers/orders.js';
import { ordersModel } from '../models/orders.js';

export const router = express.Router();

router.post('/:orderid/use', async (req, res, next) => {
    await applyOrderUseStream({
        req,
        res,
        next,
        orderIdRaw: req.params.orderid,
        ordersModel: resolvedOrdersModel,
        streamRouter: resolvedStreamRouter
    });
});

router.post('/use', async (req, res, next) => {
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