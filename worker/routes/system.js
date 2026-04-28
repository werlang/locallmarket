import { Router } from 'express';

export const router = Router();

/**
 * Build the readiness response payload.
 * @returns {{ ok: boolean, message: string, timestamp: string, uptime: number }}
 */
function buildReadyPayload() {
    return {
        ok: true,
        message: 'I am ready!',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    };
}

/**
 * Readiness endpoint for health checks and local smoke tests.
 */
router.get('/ready', async (req, res, next) => {
    try {
        res.status(200).json(buildReadyPayload());
    } catch (error) {
        next(error);
    }
});
