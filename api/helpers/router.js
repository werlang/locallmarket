import Queue from './queue.js';

/**
 * Routes queued client stream jobs to the first available worker socket.
 */
export class StreamRouter {

    /**
     * @param {{ wsServer: import('./wsserver.js').default }} options
     */
    constructor({ wsServer }) {
        this.queue = new Queue();
        this.wsServer = wsServer;
        this.workers = new Map();
        this.activeJobs = new Map();

        this.wsServer.onConnection((ws) => {
            ws.on('close', () => {
                if (ws.workerId) {
                    this.handleWorkerDisconnect(ws);
                }
            });
        });

        this.wsServer.on('worker-register', (ws, payload) => {
            this.registerWorker(ws, payload);
        });

        this.wsServer.on('worker-ready', (ws) => {
            this.markWorkerReady(ws);
        });

        this.wsServer.on('stream-event', (ws, payload) => {
            this.handleStreamEvent(ws, payload);
        });

        this.wsServer.on('job-complete', (ws, payload) => {
            const worker = this.getWorkerForSocket(ws);

            if (!worker) {
                return;
            }

            this.finishJob(payload?.jobId, { workerId: worker.id });
            console.log(`[${new Date().toISOString()}] Worker ${worker.id} completed job ${payload?.jobId}.`);
        });

        this.wsServer.on('job-failed', (ws, payload) => {
            const worker = this.getWorkerForSocket(ws);

            if (!worker) {
                return;
            }

            this.finishJob(payload?.jobId, {
                workerId: worker.id,
                errorMessage: payload?.error || 'Worker failed to process the request.'
            });
        });
    }

    /**
     * Adds a client stream request to the shared API queue.
     * @param {{ payload: { message: string, model: string }, stream: import('./stream.js').Stream, targetWorkerId?: string, onJobAborted?: () => void }} job
     * @returns {string}
     */
    enqueue(job) {
        const normalizedTargetWorkerId = typeof job.targetWorkerId === 'string' && job.targetWorkerId.trim().length > 0
            ? job.targetWorkerId.trim()
            : null;
        const queuedJob = {
            ...job,
            disconnected: false,
            errorSent: false,
            workerId: null,
            targetWorkerId: normalizedTargetWorkerId,
            onJobAborted: typeof job.onJobAborted === 'function' ? job.onJobAborted : null
        };

        const jobId = this.queue.add(queuedJob);
        this.dispatch();

        if (!this.getFirstAvailableWorker()) {
            this.wsServer.broadcast('worker-ready-request');
        }

        return jobId;
    }

    /**
     * Removes a queued request or marks an active one as client-disconnected.
     * @param {string} jobId
     */
    cancel(jobId) {
        const queuedJob = this.queue.remove(jobId);

        if (queuedJob) {
            return;
        }

        const activeJob = this.activeJobs.get(jobId);
        if (activeJob) {
            activeJob.disconnected = true;
        }
    }

    /**
     * Returns current queue and worker counts for readiness checks.
     * @returns {{ connectedWorkers: number, availableWorkers: number, activeJobs: number, queuedJobs: number }}
     */
    getState() {
        let availableWorkers = 0;

        for (const worker of this.workers.values()) {
            if (worker.available) {
                availableWorkers += 1;
            }
        }

        return {
            connectedWorkers: this.workers.size,
            availableWorkers,
            activeJobs: this.activeJobs.size,
            queuedJobs: this.queue.getSize()
        };
    }

    /**
     * Checks whether a worker is currently connected to the API websocket.
     * @param {string} workerId
     * @returns {boolean}
     */
    isWorkerConnected(workerId) {
        if (typeof workerId !== 'string' || workerId.trim().length === 0) {
            return false;
        }

        return this.workers.has(workerId.trim());
    }

    /**
     * Checks whether a worker is connected and currently marked as available.
     * @param {string} workerId
     * @returns {boolean}
     */
    isWorkerAvailable(workerId) {
        if (typeof workerId !== 'string' || workerId.trim().length === 0) {
            return false;
        }

        const worker = this.workers.get(workerId.trim());
        return Boolean(worker && worker.available && !worker.jobId);
    }

    /**
     * Registers or replaces a worker socket under the reported worker identifier.
     * @param {import('ws').WebSocket & { workerId?: string }} ws
     * @param {{ workerId?: string }} payload
     */
    registerWorker(ws, payload) {
        const requestedId = typeof payload?.workerId === 'string' && payload.workerId.trim().length > 0
            ? payload.workerId.trim()
            : `worker-${this.workers.size + 1}`;
        const previousWorker = this.workers.get(requestedId);

        if (previousWorker && previousWorker.ws !== ws) {
            previousWorker.ws.terminate?.();
        }

        ws.workerId = requestedId;
        ws.activeJobId = null;
        this.workers.set(requestedId, {
            id: requestedId,
            ws,
            available: false,
            jobId: null
        });
        console.log(`[${new Date().toISOString()}] Registered worker ${requestedId}.`);

        this.requestWorkerReady(ws);
    }

    /**
     * Marks a worker as available when it reports readiness.
     * @param {import('ws').WebSocket & { workerId?: string }} ws
     */
    markWorkerReady(ws) {
        const worker = this.getWorkerForSocket(ws);
        if (!worker) {
            return;
        }

        if (!worker.jobId) {
            worker.available = true;
        }

        this.dispatch();
    }

    /**
     * Relays worker stream events back to the waiting HTTP SSE response.
     * @param {import('ws').WebSocket & { workerId?: string }} ws
     * @param {{ jobId?: string, event?: string, data?: unknown }} payload
     */
    handleStreamEvent(ws, payload) {
        const worker = this.getWorkerForSocket(ws);
        const jobId = payload?.jobId;

        if (!worker || typeof jobId !== 'string' || worker.jobId !== jobId) {
            return;
        }

        const job = this.activeJobs.get(jobId);
        if (!job || job.disconnected || job.stream.closed) {
            return;
        }

        const event = payload?.event;
        if (event !== 'message' && event !== 'end' && event !== 'error') {
            return;
        }

        if (event === 'error') {
            job.errorSent = true;
        }

        const data = typeof payload?.data === 'string'
            ? payload.data
            : JSON.stringify(payload?.data ?? '');

        job.stream.event(event).send(data);
    }

    /**
     * Clears worker state when its socket disconnects mid-flight.
     * Also aborts any queued (not yet dispatched) jobs targeting that worker.
     * @param {import('ws').WebSocket & { workerId?: string, activeJobId?: string | null }} ws
     */
    handleWorkerDisconnect(ws) {
        const workerId = ws.workerId;
        const activeJobId = typeof ws.activeJobId === 'string' ? ws.activeJobId : null;

        if (!workerId) {
            return;
        }

        const worker = this.getWorkerForSocket(ws);

        ws.activeJobId = null;

        if (worker) {
            this.workers.delete(workerId);
        }

        if (activeJobId) {
            this.finishJob(activeJobId, {
                workerId,
                errorMessage: 'Worker disconnected while streaming the request.'
            });
        }

        // Abort any queued jobs that were waiting specifically for this worker.
        // These jobs have not been dispatched yet, so we must compensate before discarding.
        const snapshot = Array.isArray(this.queue.queue) ? [...this.queue.queue] : [];
        for (const entry of snapshot) {
            if (entry.targetWorkerId === workerId) {
                this.queue.remove(entry.id);
                if (typeof entry.onJobAborted === 'function') {
                    try {
                        entry.onJobAborted();
                    } catch (error) {
                        console.error('[StreamRouter] onJobAborted callback failed:', error);
                    }
                }
            }
        }
    }

    /**
     * Attempts to dispatch queued jobs to the first available workers.
     */
    dispatch() {
        while (this.queue.getSize() > 0) {
            const queuedEntries = Array.isArray(this.queue.queue) ? this.queue.queue : [];
            let job = null;
            let worker = null;

            for (const queuedEntry of queuedEntries) {
                const candidateWorker = queuedEntry.targetWorkerId
                    ? this.getAvailableWorkerById(queuedEntry.targetWorkerId)
                    : this.getFirstAvailableWorker();

                if (!candidateWorker) {
                    continue;
                }

                job = this.queue.remove(queuedEntry.id);
                worker = candidateWorker;
                break;
            }

            if (!job || !worker) {
                return;
            }

            if (job.disconnected || job.stream.closed) {
                continue;
            }

            worker.available = false;
            worker.jobId = job.id;
            worker.ws.activeJobId = job.id;
            job.workerId = worker.id;
            this.activeJobs.set(job.id, job);

            try {
                console.log(`[${new Date().toISOString()}] Dispatching job ${job.id} to worker ${worker.id}...`);
                this.wsServer.send(worker.ws, 'stream-job', {
                    jobId: job.id,
                    payload: job.payload
                });
            } catch (error) {
                console.error('Failed to dispatch stream job:', error);
                this.activeJobs.delete(job.id);
                worker.jobId = null;
                worker.ws.activeJobId = null;
                this.workers.delete(worker.id);

                if (!job.disconnected) {
                    this.queue.requeue(job);
                }
            }
        }
    }

    /**
     * Finishes a job, closes the client stream, and releases the worker.
     * @param {string | undefined} jobId
     * @param {{ workerId?: string, errorMessage?: string }} options
     */
    finishJob(jobId, { workerId, errorMessage } = {}) {
        if (typeof jobId !== 'string') {
            return;
        }

        const job = this.activeJobs.get(jobId);
        if (!job) {
            this.releaseWorker(workerId, jobId);
            this.dispatch();
            return;
        }

        this.activeJobs.delete(jobId);
        this.releaseWorker(workerId || job.workerId, jobId);

        if (!job.disconnected && errorMessage && !job.errorSent && !job.stream.closed) {
            job.stream.event('error').send(JSON.stringify({ error: errorMessage }));
        }

        if (!job.disconnected && !job.stream.closed) {
            job.stream.close();
        }

        this.dispatch();
    }

    /**
     * Returns the first worker that is currently available for a queued job.
     * @returns {{ id: string, ws: import('ws').WebSocket, available: boolean, jobId: string | null } | null}
     */
    getFirstAvailableWorker() {
        for (const worker of this.workers.values()) {
            if (worker.available && !worker.jobId) {
                return worker;
            }
        }

        return null;
    }

    /**
     * Returns a specific worker when it is connected and currently available.
     * @param {string} workerId
     * @returns {{ id: string, ws: import('ws').WebSocket, available: boolean, jobId: string | null } | null}
     */
    getAvailableWorkerById(workerId) {
        const worker = this.workers.get(workerId);

        if (!worker || !worker.available || worker.jobId) {
            return null;
        }

        return worker;
    }

    /**
     * Requests an explicit ready notification from a worker socket.
     * @param {import('ws').WebSocket} ws
     */
    requestWorkerReady(ws) {
        try {
            this.wsServer.send(ws, 'worker-ready-request');
        } catch (error) {
            console.error('Failed to request worker readiness:', error);
        }
    }

    /**
     * Returns the current worker entry for a socket, ignoring stale replaced sessions.
     * @param {import('ws').WebSocket & { workerId?: string }} ws
     * @returns {{ id: string, ws: import('ws').WebSocket & { activeJobId?: string | null }, available: boolean, jobId: string | null } | null}
     */
    getWorkerForSocket(ws) {
        if (!ws.workerId) {
            return null;
        }

        const worker = this.workers.get(ws.workerId);
        if (!worker || worker.ws !== ws) {
            return null;
        }

        return worker;
    }

    /**
     * Releases an active worker back to the available pool.
     * @param {string | null | undefined} workerId
     * @param {string | undefined} expectedJobId
     */
    releaseWorker(workerId, expectedJobId) {
        if (!workerId) {
            return;
        }

        const worker = this.workers.get(workerId);
        if (!worker) {
            return;
        }

        if (expectedJobId && worker.jobId !== expectedJobId) {
            return;
        }

        worker.jobId = null;
        worker.ws.activeJobId = null;
        worker.available = true;
    }
}