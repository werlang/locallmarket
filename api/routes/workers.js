import express from 'express';
import { parseBearerApiKey } from '../helpers/auth.js';
import { sendSuccess } from '../helpers/response.js';
import { usersModel } from '../models/users.js';

/**
 * Creates worker visibility routes.
 * @param {{ workersModel: { listPoolByOwner: Function }, streamRouter: { getWorkersSnapshot?: Function } }} deps
 */
export function workersRouterFactory({ workersModel, streamRouter }) {
    const router = express.Router();

    router.get('/pool', async (req, res, next) => {
        try {
            const apiKey = parseBearerApiKey(req.headers);
            const owner = await usersModel.getByApiKey(apiKey);
            const runtimeWorkers = typeof streamRouter?.getWorkersSnapshot === 'function'
                ? streamRouter.getWorkersSnapshot({ ownerId: owner.id })
                : [];
            const workers = await workersModel.listPoolByOwner(owner.id, { runtimeWorkers });

            return sendSuccess(res, { body: { workers } });
        } catch (error) {
            return next(error);
        }
    });

    return router;
}
