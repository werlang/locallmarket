import express from 'express';
import { parseBearerApiKey } from '../helpers/auth.js';
import { sendSuccess } from '../helpers/response.js';
import { usersModel } from '../models/users.js';
import { ordersModel } from '../models/orders.js';

export const router = express.Router();

/**
 * GET /orders — returns the authenticated user's execution receipts (most recent first).
 */
router.get('/', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        const orders = await ordersModel.listOwn(user.id);
        return sendSuccess(res, { body: { orders } });
    } catch (error) { return next(error); }
});
