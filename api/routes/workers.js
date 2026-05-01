import express from 'express';
import { parseBearerApiKey } from '../helpers/auth.js';
import { sendSuccess } from '../helpers/response.js';
import { usersModel } from '../models/users.js';

/**
 * Creates worker visibility routes.
 * @param {{ workersModel: { listPoolByOwner: Function, listPool: Function }, streamRouter: { getWorkersSnapshot?: Function } }} deps
 */
export function workersRouterFactory({ workersModel, streamRouter }) {
    const router = express.Router();

    // GET /pool/me - returns the list of workers owned by the requester, with optional runtime status from streamRouter
    router.get('/pool/me', async (req, res, next) => {
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

    // GET /pool - returns the list of all connected workers with optional runtime status from streamRouter
    router.get('/pool', async (req, res, next) => {
        try {
            const apiKey = parseBearerApiKey(req.headers);
            await usersModel.getByApiKey(apiKey); // Just validate the API key, no need for owner-specific filtering
            const runtimeWorkers = typeof streamRouter?.getWorkersSnapshot === 'function'
                ? streamRouter.getWorkersSnapshot()
                : [];
            const workers = await workersModel.listPool({ runtimeWorkers });

            return sendSuccess(res, { body: { workers } });
        } catch (error) {
            return next(error);
        }
    });

    return router;
}
