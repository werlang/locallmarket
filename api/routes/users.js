import express from 'express';
import { sendCreated, sendSuccess } from '../helpers/response.js';
import { usersModel } from '../models/users.js';
import {
    parseCreateUserBody,
    parseUserId,
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

router.get('/users/:id', async (req, res, next) => {
    try {
        const id = parseUserId(req.params.id);
        const user = await usersModel.getById(id);

        return sendSuccess(res, { body: { user } });
    } catch (error) {
        return next(error);
    }
});

router.put('/users/:id', async (req, res, next) => {
    try {
        const id = parseUserId(req.params.id);
        const payload = parseUpdateUserBody(req.body);
        const user = await usersModel.updateById(id, payload);

        return sendSuccess(res, { body: { user } });
    } catch (error) {
        return next(error);
    }
});

router.post('/users/:id/recharge', async (req, res, next) => {
    try {
        const id = parseUserId(req.params.id);
        const amount = parseRechargeBody(req.body);
        const user = await usersModel.rechargeById(id, amount);

        return sendSuccess(res, { body: { user } });
    } catch (error) {
        return next(error);
    }
});

router.delete('/users/:id', async (req, res, next) => {
    try {
        const id = parseUserId(req.params.id);
        await usersModel.deleteById(id);

        return sendSuccess(res);
    } catch (error) {
        return next(error);
    }
});