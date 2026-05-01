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
        let markedBusyWorkerId = null;
        let createdReceiptId = null;
        let requesterId = null;

        try {
            const apiKey = parseBearerApiKey(req.headers);
            const requester = await usersModel.getByApiKey(apiKey);
            requesterId = requester.id;
            const payload = parseChatCompletionsBody(req.body);

            // Find an available worker that matches the requested model and constraints
            const worker = await workersModel.findFirstAvailableByModel(payload.model, {
                maxPrice: requester.maxPrice,
                minTps: requester.minTps,
                streamRouter
            });
            if (!worker) {
                throw new HttpError(409, `No available worker found for model ${payload.model} within your price and TPS requirements.`);
            }

            // Check if the consumer has sufficient balance to cover the worker's price;
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

            const stream = new OpenAiChatCompletionsStream({ res, model: payload.model });

            const jobId = streamRouter.enqueue({
                payload: { message: payload.prompt, model: worker.model },
                stream,
                targetWorkerId: worker.id,
                settlement: { orderId: receipt.id, requesterId: requester.id },
                onJobAborted: () => {
                    // Worker disconnected before the queued job was dispatched;
                    // markDisconnected is handled by the router — only fail the receipt here.
                    ordersModel.failReceipt(receipt.id).catch((err) => {
                        console.error('[openai.chat.completions] failReceipt on abort failed:', err);
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
                    console.error('[openai.chat.completions] markAvailable on error failed:', err);
                });
            }
            if (createdReceiptId !== null) {
                ordersModel.failReceipt(createdReceiptId).catch((err) => {
                    console.error('[openai.chat.completions] failReceipt on error failed:', err);
                });
            }

            return next(error);
        }
    });

    return router;
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