import express from 'express';
import { parseBearerApiKey } from '../helpers/auth.js';
import { sendCreated, sendSuccess } from '../helpers/response.js';
import { usersModel } from '../models/users.js';
import {
    parseCreateUserBody,
    parseListUsersQuery,
    parseRechargeBody,
    parseUpdateUserBody
} from '../helpers/users.js';

export const router = express.Router();

router.post('/', async (req, res, next) => {
    try {
        const payload = parseCreateUserBody(req.body);
        const { user, apiKey } = await usersModel.register(payload);

        return sendCreated(res, { body: { user: { ...user, apiKey } } });
    } catch (error) {
        return next(error);
    }
});

router.get('/', async (req, res, next) => {
    try {
        const query = parseListUsersQuery(req.query);
        const users = await usersModel.list(query);

        return sendSuccess(res, { body: { users } });
    } catch (error) {
        return next(error);
    }
});

router.get('/:apiKey', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);

        return sendSuccess(res, { body: { user } });
    } catch (error) {
        return next(error);
    }
});

router.put('/:apiKey', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        const payload = parseUpdateUserBody(req.body);
        const updatedUser = await usersModel.updateById(user.id, payload);

        return sendSuccess(res, { body: { user: updatedUser } });
    } catch (error) {
        return next(error);
    }
});

router.post('/:apiKey/recharge', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        const amount = parseRechargeBody(req.body);
        const updatedUser = await usersModel.rechargeById(user.id, amount);

        return sendSuccess(res, { body: { user: updatedUser } });
    } catch (error) {
        return next(error);
    }
});

router.post('/:apiKey/reset', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const currentUser = await usersModel.getByApiKey(apiKey);
        const { user: refreshedUser, apiKey: refreshedApiKey } = await usersModel.resetApiKeyById(currentUser.id);

        return sendSuccess(res, { body: { user: refreshedUser, apiKey: refreshedApiKey } });
    } catch (error) {
        return next(error);
    }
});

router.delete('/:apiKey', async (req, res, next) => {
    try {
        const apiKey = parseBearerApiKey(req.headers);
        const user = await usersModel.getByApiKey(apiKey);
        await usersModel.deleteById(user.id);

        return sendSuccess(res);
    } catch (error) {
        return next(error);
    }
});
