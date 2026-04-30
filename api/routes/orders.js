import express from 'express';
import { parseBearerApiKey } from '../helpers/auth.js';
import { sendCreated, sendSuccess } from '../helpers/response.js';
import { ordersModel } from '../models/orders.js';
import { usersModel } from '../models/users.js';
import {
    parseCreateOrderBody,
    parseListOrdersQuery,
    parseOrderId,
    parseUpdateOrderBody
} from '../helpers/orders.js';

export const router = express.Router();

router.post('/order', async (req, res, next) => {
    try {
        const ownerId = await resolveUserIdFromBearer(req.headers);
        const payload = parseCreateOrderBody(req.body);
        const order = await ordersModel.create(ownerId, payload);

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
        const ownerId = await resolveUserIdFromBearer(req.headers);
        const orderId = parseOrderId(req.params.orderId);
        const order = await ordersModel.getOwnById(ownerId, orderId);

        return sendSuccess(res, { body: { order } });
    } catch (error) {
        return next(error);
    }
});

router.put('/order/:orderId', async (req, res, next) => {
    try {
        const ownerId = await resolveUserIdFromBearer(req.headers);
        const orderId = parseOrderId(req.params.orderId);
        const payload = parseUpdateOrderBody(req.body);
        const order = await ordersModel.updateOwn(ownerId, orderId, payload);

        return sendSuccess(res, { body: { order } });
    } catch (error) {
        return next(error);
    }
});

router.delete('/order/:orderId', async (req, res, next) => {
    try {
        const ownerId = await resolveUserIdFromBearer(req.headers);
        const orderId = parseOrderId(req.params.orderId);
        await ordersModel.deleteOwn(ownerId, orderId);

        return sendSuccess(res);
    } catch (error) {
        return next(error);
    }
});

/**
 * Resolves the authenticated user id from Authorization: Bearer <api-key>.
 * @param {Record<string, unknown>} headers
 */
async function resolveUserIdFromBearer(headers) {
    const apiKey = parseBearerApiKey(headers);
    const user = await usersModel.getByApiKey(apiKey);
    return user.id;
}