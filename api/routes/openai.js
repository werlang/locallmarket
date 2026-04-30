import express from 'express';
import { parseBearerApiKey } from '../helpers/auth.js';
import { HttpError } from '../helpers/error.js';
import { applyStreamHeaders } from '../helpers/stream.js';
import { ordersModel } from '../models/orders.js';
import { usersModel } from '../models/users.js';

/**
 * Creates OpenAI-compatible streaming routes.
 * @param {{ streamRouter: { enqueue: Function, cancel: Function } }} deps
 */
export function openAiRouterFactory({ streamRouter }) {
    const router = express.Router();

    router.post('/chat/completions', async (req, res, next) => {
        let requesterId = null;
        let createdOrderId = null;

        try {
            const apiKey = parseBearerApiKey(req.headers);
            const requester = await usersModel.getByApiKey(apiKey);
            requesterId = requester.id;
            const payload = parseChatCompletionsBody(req.body);

            const workerOffer = await ordersModel.findFirstAvailableOfferByModel(payload.model);
            if (!workerOffer) {
                throw new HttpError(409, `No available worker found for model ${payload.model}.`);
            }

            const createdOrder = await ordersModel.create(requester.id, {
                workerId: workerOffer.workerId,
                model: payload.model,
                price: workerOffer.price,
                tps: workerOffer.tps
            });
            createdOrderId = createdOrder.id;

            const consumed = await ordersModel.consumeForUse(requester.id, createdOrder.id);
            const stream = new OpenAiChatCompletionsStream({
                res,
                model: payload.model
            });

            const jobId = streamRouter.enqueue({
                payload: {
                    message: payload.prompt,
                    model: consumed.order.model
                },
                stream,
                targetWorkerId: consumed.order.workerId,
                settlement: {
                    orderId: consumed.order.id,
                    requesterId: requester.id
                },
                onJobAborted: async () => {
                    try {
                        await ordersModel.unconsumForUse(requester.id, consumed.order.id);
                    } catch (refundError) {
                        console.error('[openai.chat.completions] Compensation refund failed:', refundError);
                    }

                    if (!stream.closed) {
                        stream.event('error').send(JSON.stringify({ error: 'Worker disconnected before processing. Order has been refunded.' }));
                        stream.close();
                    }
                }
            });

            res.once('close', () => {
                streamRouter.cancel(jobId);
            });
        } catch (error) {
            if (createdOrderId !== null && requesterId !== null && !res.headersSent) {
                try {
                    await ordersModel.deleteOwn(requesterId, createdOrderId);
                } catch {
                    // Keep error contract deterministic; deletion is best-effort cleanup.
                }
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