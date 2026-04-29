import express from 'express';
import { sendCreated, sendSuccess } from '../helpers/response.js';
import { usersModel } from '../models/users.js';
import {
    parseCreateUserBody,
    parseExternalId,
    parseListUsersQuery,
    parseRechargeBody,
    parseUpdateUserBody
} from '../helpers/users.js';

export const router = express.Router();

router.post('/users', async (req, res, next) => {
    try {
        const payload = parseCreateUserBody(req.body);
        const user = await usersModel.register(payload);

        return sendCreated(res, { body: { user } });
    } catch (error) {
        return next(error);
    }
});

router.get('/users', async (req, res, next) => {
    try {
        const query = parseListUsersQuery(req.query);
        const users = await usersModel.list(query);

        return sendSuccess(res, { body: { users } });
    } catch (error) {
        return next(error);
    }
});

router.get('/users/:externalId', async (req, res, next) => {
    try {
        const externalId = parseExternalId(req.params.externalId);
        const user = await usersModel.getByExternalId(externalId);

        return sendSuccess(res, { body: { user } });
    } catch (error) {
        return next(error);
    }
});

router.put('/users/:externalId', async (req, res, next) => {
    try {
        const externalId = parseExternalId(req.params.externalId);
        const payload = parseUpdateUserBody(req.body);
        const user = await usersModel.updateByExternalId(externalId, payload);

        return sendSuccess(res, { body: { user } });
    } catch (error) {
        return next(error);
    }
});

router.post('/users/:externalId/recharge', async (req, res, next) => {
    try {
        const externalId = parseExternalId(req.params.externalId);
        const amount = parseRechargeBody(req.body);
        const user = await usersModel.rechargeByExternalId(externalId, amount);

        return sendSuccess(res, { body: { user } });
    } catch (error) {
        return next(error);
    }
});

router.delete('/users/:externalId', async (req, res, next) => {
    try {
        const externalId = parseExternalId(req.params.externalId);
        await usersModel.deleteByExternalId(externalId);

        return sendSuccess(res);
    } catch (error) {
        return next(error);
    }
});