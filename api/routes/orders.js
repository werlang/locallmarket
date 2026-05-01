import express from 'express';
import { parseBearerApiKey } from '../helpers/auth.js';
import { HttpError } from '../helpers/error.js';
import {
    parseCreateWorkerOrderBody,
    parseOrderId,
    parseUpdateWorkerOrderBody
} from '../helpers/orders.js';
import { sendSuccess } from '../helpers/response.js';
import { ordersModel } from '../models/orders.js';
import { usersModel } from '../models/users.js';

export const router = express.Router();

// GET /orders - lists orders owned by the authenticated user.
router.get('/', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        const orders = await ordersModel.listOwn(user.id);

        return sendSuccess(res, { body: { orders } });
    } catch (error) {
        return next(error);
    }
});

// GET /orders/public - lists available orders in the public pool.
router.get('/public', async (req, res, next) => {
    try {
        const orders = await ordersModel.listPublic();
        return sendSuccess(res, { body: { orders } });
    } catch (error) {
        return next(error);
    }
});

// POST /orders - creates a worker-bound order offer for the authenticated owner.
router.post('/', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        const payload = parseCreateWorkerOrderBody(req.body);

        if (payload.userId && payload.userId !== user.id) {
            throw new HttpError(403, 'userId in payload must match the authenticated user.');
        }

        const order = await ordersModel.createOwnOffer(user.id, payload);

        return sendSuccess(res, { status: 201, body: { order } });
    } catch (error) {
        return next(error);
    }
});

// PUT /orders/:orderId - updates owner order binding fields.
router.put('/:orderId', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        const orderId = parseOrderId(req.params.orderId);
        const payload = parseUpdateWorkerOrderBody(req.body);
        const order = await ordersModel.updateOwn(user.id, orderId, payload);

        return sendSuccess(res, { body: { order } });
    } catch (error) {
        return next(error);
    }
});

// DELETE /orders/:orderId - deletes an owner order.
router.delete('/:orderId', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        const orderId = parseOrderId(req.params.orderId);
        await ordersModel.deleteOwn(user.id, orderId);

        return sendSuccess(res);
    } catch (error) {
        return next(error);
    }
});

// POST /orders/:orderId/enable - enables an owner order in the public pool.
router.post('/:orderId/enable', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        const orderId = parseOrderId(req.params.orderId);
        const order = await ordersModel.setOwnAvailability(user.id, orderId, true);

        return sendSuccess(res, { body: { order } });
    } catch (error) {
        return next(error);
    }
});

// POST /orders/:orderId/disable - disables an owner order from the public pool.
router.post('/:orderId/disable', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        const orderId = parseOrderId(req.params.orderId);
        const order = await ordersModel.setOwnAvailability(user.id, orderId, false);

        return sendSuccess(res, { body: { order } });
    } catch (error) {
        return next(error);
    }
});
