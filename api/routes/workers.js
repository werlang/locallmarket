import express from 'express';
import { parseBearerApiKey } from '../helpers/auth.js';
import { sendSuccess } from '../helpers/response.js';
import { usersModel } from '../models/users.js';

export function workersRouterFactory({ workersModel, streamRouter }) {
    const router = express.Router();

    /**
     * GET /workers — returns all workers owned by the authenticated requester,
     * enriched with live runtime state from the stream router.
     */
    router.get('/', async (req, res, next) => {
        try {
            const apiKey = parseBearerApiKey(req.headers);
            const owner = await usersModel.getByApiKey(apiKey);
            const runtimeWorkers = typeof streamRouter?.getWorkersSnapshot === 'function'
                ? streamRouter.getWorkersSnapshot({ ownerId: owner.id })
                : [];
            const workers = await workersModel.listPoolByOwner(owner.id, { runtimeWorkers });
            return sendSuccess(res, { body: { workers } });
        } catch (error) { return next(error); }
    });

    /**
     * GET /workers/public — lists all workers currently available for consumption.
     * No authentication required; exposes id, model, tps, price, and status only.
     */
    router.get('/public', async (req, res, next) => {
        try {
            const workers = await workersModel.listPublic();
            return sendSuccess(res, { body: { workers } });
        } catch (error) { return next(error); }
    });

    return router;
}
