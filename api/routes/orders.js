import express from 'express';
import { sendCreated, sendSuccess } from '../helpers/response.js';
import { ordersModel } from '../models/orders.js';
import {
    parseCreateOrderBody,
    parseListOrdersQuery,
    parseOrderId,
    parseOwnerExternalIdHeader,
    parseUpdateOrderBody
} from '../helpers/orders.js';

export const router = express.Router();

router.post('/order', async (req, res, next) => {
    try {
        const ownerExternalId = parseOwnerExternalIdHeader(req.headers);
        const payload = parseCreateOrderBody(req.body);
        const order = await ordersModel.create(ownerExternalId, payload);

        return sendCreated(res, { body: { order } });
    } catch (error) {
        return next(error);
    }
});

router.get('/orders', async (req, res, next) => {
    try {
        const filters = parseListOrdersQuery(req.query);
        const orders = await ordersModel.listPublic(filters);

        return sendSuccess(res, { body: { orders } });
    } catch (error) {
        return next(error);
    }
});

router.get('/order/:orderId', async (req, res, next) => {
    try {
        const ownerExternalId = parseOwnerExternalIdHeader(req.headers);
        const orderId = parseOrderId(req.params.orderId);
        const order = await ordersModel.getOwnById(ownerExternalId, orderId);

        return sendSuccess(res, { body: { order } });
    } catch (error) {
        return next(error);
    }
});

router.put('/order/:orderId', async (req, res, next) => {
    try {
        const ownerExternalId = parseOwnerExternalIdHeader(req.headers);
        const orderId = parseOrderId(req.params.orderId);
        const payload = parseUpdateOrderBody(req.body);
        const order = await ordersModel.updateOwn(ownerExternalId, orderId, payload);

        return sendSuccess(res, { body: { order } });
    } catch (error) {
        return next(error);
    }
});

router.delete('/order/:orderId', async (req, res, next) => {
    try {
        const ownerExternalId = parseOwnerExternalIdHeader(req.headers);
        const orderId = parseOrderId(req.params.orderId);
        await ordersModel.deleteOwn(ownerExternalId, orderId);

        return sendSuccess(res);
    } catch (error) {
        return next(error);
    }
});