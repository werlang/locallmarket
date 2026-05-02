import express from 'express';
import { parseBearerApiKey } from '../helpers/auth.js';
import { HttpError } from '../helpers/error.js';
import { applyStreamHeaders } from '../helpers/stream.js';
import { ordersModel } from '../models/orders.js';
import { workersModel } from '../models/workers.js';
import { usersModel } from '../models/users.js';

/**
 * Creates OpenAI-compatible streaming routes.
 * @param {{ streamRouter: { enqueue: Function, cancel: Function } }} deps
 */
export function openAiRouterFactory({ streamRouter }) {
    const router = express.Router();

    router.post('/chat/completions', async (req, res, next) => {
        return handleOpenAiWorkerRequest({
            req,
            res,
            next,
            streamRouter,
            parseBody: parseChatCompletionsBody,
            createStream: ({ res: response, model }) => new OpenAiChatCompletionsStream({ res: response, model }),
            logPrefix: '[openai.chat.completions]'
        });
    });

    router.post('/responses', async (req, res, next) => {
        return handleOpenAiWorkerRequest({
            req,
            res,
            next,
            streamRouter,
            parseBody: parseResponsesBody,
            createStream: ({ res: response, model }) => new OpenAiResponsesStream({ res: response, model }),
            logPrefix: '[openai.responses]'
        });
    });

    return router;
}

/**
 * Reuses the existing worker claim, receipt, and dispatch flow for OpenAI-compatible streaming endpoints.
 * @param {{ req: import('express').Request, res: import('express').Response, next: import('express').NextFunction, streamRouter: { enqueue: Function, cancel: Function }, parseBody: (body: any) => { model: string, prompt: string }, createStream: ({ res: import('express').Response, model: string }) => { event: Function, send: Function, close: Function, closed: boolean }, logPrefix: string }} input
 */
async function handleOpenAiWorkerRequest({ req, res, next, streamRouter, parseBody, createStream, logPrefix }) {
    let markedBusyWorkerId = null;
    let createdReceiptId = null;

    try {
        const apiKey = parseBearerApiKey(req.headers);
        const requester = await usersModel.getByApiKey(apiKey);
        const payload = parseBody(req.body);

        // Find an available worker that matches the requested model and constraints
        const worker = await workersModel.findFirstAvailableByModel(payload.model, {
            maxPrice: requester.maxPrice,
            minTps: requester.minTps,
            streamRouter
        });
        if (!worker) {
            throw new HttpError(409, `No available worker found for model ${payload.model} within your price and TPS requirements.`);
        }

        // Check if the consumer has sufficient balance to cover the worker's price
        if (requester.credits < worker.price) {
            throw new HttpError(402, 'Insufficient balance to process the request.');
        }

        // Atomically claim the worker; another concurrent request may have grabbed it first
        const claimed = await workersModel.markBusy(worker.id);
        if (!claimed) {
            throw new HttpError(503, `Worker for model ${payload.model} became unavailable. Please retry.`);
        }
        markedBusyWorkerId = worker.id;

        // Create the execution receipt before dispatching so billing is always traceable
        const receipt = await ordersModel.createReceipt(requester.id, {
            workerId: worker.id,
            model: worker.model,
            price: worker.price
        });
        createdReceiptId = receipt.id;

        const stream = createStream({ res, model: payload.model });

        const jobId = streamRouter.enqueue({
            payload: { message: payload.prompt, model: worker.model },
            stream,
            targetWorkerId: worker.id,
            settlement: { orderId: receipt.id, requesterId: requester.id },
            onJobAborted: () => {
                // Worker disconnected before the queued job was dispatched;
                // markDisconnected is handled by the router — only fail the receipt here.
                ordersModel.failReceipt(receipt.id).catch((err) => {
                    console.error(`${logPrefix} failReceipt on abort failed:`, err);
                });

                if (!stream.closed) {
                    stream.event('error').send(JSON.stringify({ error: 'Worker disconnected before processing.' }));
                    stream.close();
                }
            }
        });

        res.once('close', () => streamRouter.cancel(jobId));
    } catch (error) {
        // Release the worker and fail the receipt on any setup error
        if (markedBusyWorkerId !== null) {
            workersModel.markAvailable(markedBusyWorkerId).catch((err) => {
                console.error(`${logPrefix} markAvailable on error failed:`, err);
            });
        }
        if (createdReceiptId !== null) {
            ordersModel.failReceipt(createdReceiptId).catch((err) => {
                console.error(`${logPrefix} failReceipt on error failed:`, err);
            });
        }

        return next(error);
    }
}

/**
 * Validates an OpenAI-compatible chat/completions payload.
 * @param {any} body
 * @returns {{ model: string, prompt: string }}
 */
function parseChatCompletionsBody(body) {
    const payload = body || {};

    if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
        throw new HttpError(400, 'model must be a non-empty string.');
    }

    if (!Array.isArray(payload.messages) || payload.messages.length < 1) {
        throw new HttpError(400, 'messages must be a non-empty array.');
    }

    if (payload.stream !== true) {
        throw new HttpError(400, 'stream must be true for this endpoint.');
    }

    const promptParts = [];

    for (const message of payload.messages) {
        if (!message || typeof message !== 'object') {
            continue;
        }

        const role = typeof message.role === 'string' ? message.role.trim() : '';
        const content = parseMessageContent(message.content);
        if (!content) {
            continue;
        }

        promptParts.push(role ? `[${role}] ${content}` : content);
    }

    const prompt = promptParts.join('\n').trim();
    if (!prompt) {
        throw new HttpError(400, 'messages must include at least one non-empty textual content value.');
    }

    return {
        model: payload.model.trim(),
        prompt
    };
}

/**
 * Validates an OpenAI-compatible responses payload.
 * @param {any} body
 * @returns {{ model: string, prompt: string }}
 */
function parseResponsesBody(body) {
    const payload = body || {};

    if (typeof payload.model !== 'string' || payload.model.trim().length === 0) {
        throw new HttpError(400, 'model must be a non-empty string.');
    }

    if (payload.stream !== true) {
        throw new HttpError(400, 'stream must be true for this endpoint.');
    }

    const prompt = parseResponsesInput(payload.input);
    if (!prompt) {
        throw new HttpError(400, 'input must include at least one non-empty textual content value.');
    }

    return {
        model: payload.model.trim(),
        prompt
    };
}

/**
 * @param {unknown} input
 */
function parseResponsesInput(input) {
    if (typeof input === 'string') {
        return input.trim();
    }

    if (!Array.isArray(input)) {
        return '';
    }

    const promptParts = [];

    for (const item of input) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const role = typeof item.role === 'string' ? item.role.trim() : '';
        let content = '';

        if (typeof item.content === 'string' || Array.isArray(item.content)) {
            content = parseMessageContent(item.content);
        } else if (typeof item.text === 'string') {
            content = item.text.trim();
        }

        if (!content) {
            continue;
        }

        promptParts.push(role ? `[${role}] ${content}` : content);
    }

    return promptParts.join('\n').trim();
}

/**
 * Converts OpenAI message content to plain text.
 * @param {unknown} content
 */
function parseMessageContent(content) {
    if (typeof content === 'string') {
        return content.trim();
    }

    if (!Array.isArray(content)) {
        return '';
    }

    const parts = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
            parts.push(item.text.trim());
        }
    }

    return parts.join('\n').trim();
}

class OpenAiChatCompletionsStream {
    #res;
    #closed;
    #event;
    #id;
    #model;
    #created;
    #sentRole;

    /**
     * @param {{ res: import('express').Response, model: string }} input
     */
    constructor({ res, model }) {
        applyStreamHeaders(res);

        this.#res = res;
        this.#closed = false;
        this.#event = 'message';
        this.#id = `chatcmpl-${Date.now()}`;
        this.#model = model;
        this.#created = Math.floor(Date.now() / 1000);
        this.#sentRole = false;
    }

    event(eventName) {
        this.#event = eventName;
        return this;
    }

    send(data) {
        if (this.closed) {
            return this;
        }

        if (this.#event === 'message') {
            const content = typeof data === 'string' ? data : String(data ?? '');
            if (content.length > 0) {
                if (!this.#sentRole) {
                    this.#writeChunk({ role: 'assistant' });
                    this.#sentRole = true;
                }
                this.#writeChunk({ content });
            }
            return this;
        }

        if (this.#event === 'end') {
            this.#writeChunk({}, 'stop');
            this.#writeRaw('[DONE]');
            return this;
        }

        if (this.#event === 'error') {
            const message = parseWorkerErrorMessage(data);
            const payload = {
                error: {
                    message,
                    type: 'server_error'
                }
            };
            this.#writeRaw(JSON.stringify(payload));
            return this;
        }

        return this;
    }

    close() {
        if (this.closed) {
            return;
        }

        this.#closed = true;
        this.#res.end();
    }

    get closed() {
        return this.#closed || this.#res.writableEnded;
    }

    #writeChunk(delta, finishReason = null) {
        const payload = {
            id: this.#id,
            object: 'chat.completion.chunk',
            created: this.#created,
            model: this.#model,
            choices: [
                {
                    index: 0,
                    delta,
                    finish_reason: finishReason
                }
            ]
        };

        this.#writeRaw(JSON.stringify(payload));
    }

    #writeRaw(raw) {
        if (this.closed) {
            return;
        }

        this.#res.write(`data: ${raw}\n\n`);
    }
}

class OpenAiResponsesStream {
    #res;
    #closed;
    #event;
    #id;
    #model;
    #createdAt;

    /**
     * @param {{ res: import('express').Response, model: string }} input
     */
    constructor({ res, model }) {
        applyStreamHeaders(res);

        this.#res = res;
        this.#closed = false;
        this.#event = 'message';
        this.#id = `resp-${Date.now()}`;
        this.#model = model;
        this.#createdAt = new Date().toISOString();

        this.#writeEvent('response.created', {
            type: 'response.created',
            response: {
                id: this.#id,
                object: 'response',
                status: 'in_progress',
                model: this.#model,
                created_at: this.#createdAt,
                output: []
            }
        });
    }

    event(eventName) {
        this.#event = eventName;
        return this;
    }

    send(data) {
        if (this.closed) {
            return this;
        }

        if (this.#event === 'message') {
            const content = typeof data === 'string' ? data : String(data ?? '');
            if (content.length > 0) {
                this.#writeEvent('response.output_text.delta', {
                    type: 'response.output_text.delta',
                    response_id: this.#id,
                    delta: content,
                    output_index: 0,
                    content_index: 0
                });
            }
            return this;
        }

        if (this.#event === 'end') {
            this.#writeEvent('response.completed', {
                type: 'response.completed',
                response: {
                    id: this.#id,
                    object: 'response',
                    status: 'completed',
                    model: this.#model,
                    created_at: this.#createdAt,
                    output: []
                }
            });
            this.#writeRaw('data: [DONE]\n\n');
            return this;
        }

        if (this.#event === 'error') {
            this.#writeEvent('response.error', {
                type: 'response.error',
                error: {
                    message: parseWorkerErrorMessage(data),
                    type: 'server_error'
                }
            });
            return this;
        }

        return this;
    }

    close() {
        if (this.closed) {
            return;
        }

        this.#closed = true;
        this.#res.end();
    }

    get closed() {
        return this.#closed || this.#res.writableEnded;
    }

    #writeEvent(eventName, payload) {
        this.#writeRaw(`event: ${eventName}\n`);
        this.#writeRaw(`data: ${JSON.stringify(payload)}\n\n`);
    }

    #writeRaw(raw) {
        if (this.closed) {
            return;
        }

        this.#res.write(raw);
    }
}

/**
 * @param {unknown} value
 */
function parseWorkerErrorMessage(value) {
    if (typeof value !== 'string') {
        return 'Worker failed to process the request.';
    }

    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
            return parsed.error.trim();
        }
    } catch {
        // Ignore parse errors and fallback to raw text.
    }

    return value.trim().length > 0 ? value.trim() : 'Worker failed to process the request.';
}