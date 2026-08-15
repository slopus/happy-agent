import { createHash } from "node:crypto";

import type {
    CreateSessionRequest,
    ModelCatalog,
    SessionEvent,
    SubagentSummary,
} from "../protocol/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import type { InMemorySession } from "../session/InMemorySession.js";
import { isLiveOnlySessionEvent } from "../session/isLiveOnlySessionEvent.js";
import { HappyMachineClient } from "./HappyMachineClient.js";
import {
    HappySessionClient,
    type HappyProjectContext,
    type HappySessionClientOptions,
} from "./HappySessionClient.js";
import { HappySyncOutboxFullError, HappySyncRepository } from "./HappySyncRepository.js";
import { HappyMessageMapper } from "./mapSessionEventToHappyMessages.js";
import { handleHappySpawnSession } from "./handleHappySpawnSession.js";
import type { HappyConnectionConfiguration, HappySessionProtocolMessage } from "./types.js";
import type { Context } from "@steve.kite/stdlib";
import { withWorkerContext } from "../observability/index.js";
import type { SessionDatabase } from "../persistence/database/SessionDatabase.js";
import type { RigAgentService } from "../agent/RigAgentService.js";

const MAX_BACKFILLED_MESSAGES = 10_000;
const MAX_MAPPED_EVENTS = 4_096;
const MAX_RECOVERY_EVENTS_PER_PASS = 256;
const ATTACH_RETRY_DELAY_MS = 5_000;

export interface HappySyncServiceOptions {
    agents?: RigAgentService;
    configuration: HappyConnectionConfiguration;
    createSession?: (
        ctx: Context,
        id: string,
        request: CreateSessionRequest,
    ) => InMemorySession | Promise<InMemorySession>;
    database: SessionDatabase;
    fetch?: typeof fetch;
    getSubagents?: (
        ctx: Context,
        sessionId: string,
    ) => readonly SubagentSummary[] | Promise<readonly SubagentSummary[]>;
    getProjectContext?: (
        ctx: Context,
        session: InMemorySession,
    ) => HappyProjectContext | Promise<HappyProjectContext>;
    modelCatalog?: ModelCatalog;
    maxPendingMessagesPerSession?: number;
    socketFactory?: HappySessionClientOptions["socketFactory"];
}

export class HappySyncService {
    readonly #attaches = new Map<string, Promise<void>>();
    readonly #agents: RigAgentService | undefined;
    readonly #attachRetryAfter = new Map<string, number>();
    readonly #backfillTimers = new Map<string, NodeJS.Timeout>();
    readonly #clients = new Map<string, HappySessionClient>();
    readonly #detachedClientClosures = new Map<string, Promise<void>>();
    readonly #messageMappers = new Map<string, HappyMessageMapper>();
    readonly #pendingReattachments = new Set<string>();
    #closed = false;
    readonly #configuration: HappyConnectionConfiguration;
    readonly #credentialFingerprint: string;
    readonly #createSession: HappySyncServiceOptions["createSession"];
    readonly #fetch: typeof fetch | undefined;
    readonly #getSubagents: NonNullable<HappySyncServiceOptions["getSubagents"]>;
    readonly #getProjectContext: HappySyncServiceOptions["getProjectContext"];
    readonly #modelCatalog: ModelCatalog | undefined;
    readonly #machineClient: HappyMachineClient | undefined;
    readonly #repository: HappySyncRepository;
    readonly #socketFactory: HappySessionClientOptions["socketFactory"];

    private constructor(options: HappySyncServiceOptions, repository: HappySyncRepository) {
        this.#agents = options.agents;
        this.#configuration = options.configuration;
        this.#credentialFingerprint = fingerprint(options.configuration);
        this.#createSession = options.createSession;
        this.#fetch = options.fetch;
        this.#getSubagents = options.getSubagents ?? (() => []);
        this.#getProjectContext = options.getProjectContext;
        this.#modelCatalog = options.modelCatalog;
        this.#repository = repository;
        this.#socketFactory = options.socketFactory;
        if (
            options.configuration.machineId !== undefined &&
            options.createSession !== undefined &&
            options.modelCatalog !== undefined
        ) {
            try {
                this.#machineClient = new HappyMachineClient({
                    configuration: options.configuration,
                    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                    modelCatalog: options.modelCatalog,
                    ...(options.socketFactory === undefined
                        ? {}
                        : { socketFactory: options.socketFactory }),
                    spawnSession: (params, signal) =>
                        withWorkerContext("happy-machine-spawn-session", (ctx) =>
                            handleHappySpawnSession({
                                createSession: async (id, request) => {
                                    const session = await this.#createSession!(ctx, id, request);
                                    await this.attach(ctx, session);
                                },
                                machineId: options.configuration.machineId!,
                                modelCatalog: options.modelCatalog!,
                                params,
                                signal,
                                waitForRemoteSession: (sessionId) =>
                                    this.#clients.get(sessionId)?.waitForRemoteSession(ctx) ??
                                    Promise.resolve(undefined),
                            }),
                        ),
                });
            } catch (error) {
                this.#machineClient = undefined;
                console.error(`Happy machine sync is unavailable: ${String(error)}`);
            }
        } else {
            this.#machineClient = undefined;
        }
    }

    static async open(ctx: Context, options: HappySyncServiceOptions): Promise<HappySyncService> {
        const repository = HappySyncRepository.using(
            options.database,
            Date.now,
            options.maxPendingMessagesPerSession,
        );
        void ctx;
        return new HappySyncService(options, repository);
    }

    async attach(ctx: Context, session: InMemorySession): Promise<void> {
        if (this.#clients.has(session.id)) return;
        const closure = this.#detachedClientClosures.get(session.id);
        if (closure !== undefined && !session.isArchived()) {
            this.#scheduleReattach(session, closure);
            return;
        }
        await this.#attachOnce(ctx, session, false);
    }

    /** Lets the access hot path avoid creating a worker for an already synchronized session. */
    shouldAttachOnAccess(session: InMemorySession): boolean {
        if (this.#closed || this.#clients.has(session.id) || this.#attaches.has(session.id)) {
            return false;
        }
        if (session.agentMetadata().type !== "primary" || session.isArchived()) return false;
        if (this.#pendingReattachments.has(session.id)) return false;
        return (this.#attachRetryAfter.get(session.id) ?? 0) <= Date.now();
    }

    async #attachOnce(
        ctx: Context,
        session: InMemorySession,
        includeArchived: boolean,
    ): Promise<void> {
        const existing = this.#attaches.get(session.id);
        if (existing !== undefined) return await existing;
        const attachment = this.#attachSession(ctx, session, includeArchived);
        this.#attaches.set(session.id, attachment);
        try {
            await attachment;
        } finally {
            if (this.#attaches.get(session.id) === attachment) {
                this.#attaches.delete(session.id);
            }
        }
    }

    async #attachSession(
        ctx: Context,
        session: InMemorySession,
        includeArchived: boolean,
    ): Promise<void> {
        if (this.#closed || this.#clients.has(session.id)) return;
        if (
            session.agentMetadata().type !== "primary" ||
            (session.isArchived() && !includeArchived)
        ) {
            return;
        }
        let client = this.#clients.get(session.id);
        if (client === undefined) {
            if ((this.#attachRetryAfter.get(session.id) ?? 0) > Date.now()) return;
            try {
                const encryption = this.#configuration.credentials.encryption;
                const state = await this.#repository.ensureSession(ctx, {
                    credentialFingerprint: this.#credentialFingerprint,
                    ...(encryption.type === "legacy" ? { encryptionKey: encryption.secret } : {}),
                    encryptionVariant: encryption.type,
                    sessionId: session.id,
                });
                if (this.#closed) return;
                client = new HappySessionClient({
                    ...(this.#agents === undefined ? {} : { agents: this.#agents }),
                    configuration: this.#configuration,
                    ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
                    getSubagents: (ctx, sessionId) => this.#getSubagents(ctx, sessionId),
                    ...(this.#getProjectContext === undefined
                        ? {}
                        : {
                              projectContext: (ctx) => this.#getProjectContext?.(ctx, session),
                          }),
                    ...(this.#modelCatalog === undefined
                        ? {}
                        : { modelCatalog: this.#modelCatalog }),
                    repository: this.#repository,
                    session,
                    ...(this.#socketFactory === undefined
                        ? {}
                        : { socketFactory: this.#socketFactory }),
                });
                this.#clients.set(session.id, client);
                if (!includeArchived) {
                    const backfill = mapSessionEvents(
                        session,
                        state.historyBackfilled ? state.projectedEventId : undefined,
                    );
                    this.#messageMappers.set(session.id, backfill.mapper);
                    if (!state.historyBackfilled) {
                        await this.#repository.enqueueInitialBackfill(
                            ctx,
                            session.id,
                            backfill.messages,
                            latestDurableEventId(session),
                        );
                    } else if (backfill.cursorFound) {
                        await this.#enqueueRecovered(ctx, session, client, backfill.projections);
                    } else if (state.projectedEventId !== latestDurableEventId(session)) {
                        const reason = `Happy projection cursor '${state.projectedEventId ?? "none"}' is outside the bounded session event window.`;
                        await this.#repository.stallProjectionGap(ctx, session.id, reason);
                        console.error(
                            `Happy sync cannot recover session '${session.id}': ${reason}`,
                        );
                    }
                }
                if (!this.#closed) client.start(ctx);
                this.#attachRetryAfter.delete(session.id);
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                this.#clients.delete(session.id);
                this.#messageMappers.delete(session.id);
                this.#attachRetryAfter.set(session.id, Date.now() + ATTACH_RETRY_DELAY_MS);
                await client?.close(ctx).catch(rethrowDatabaseFailure);
                console.error(
                    `Happy sync could not attach session '${session.id}': ${String(error)}`,
                );
            }
        }
    }

    async close(ctx: Context): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#machineClient?.close();
        for (const timer of this.#backfillTimers.values()) clearTimeout(timer);
        this.#backfillTimers.clear();
        this.#attachRetryAfter.clear();
        const attachmentResults = await Promise.allSettled(this.#attaches.values());
        this.#attaches.clear();
        const clientResults = await Promise.allSettled([
            ...[...this.#clients.values()].map((client) => client.close(ctx)),
            ...this.#detachedClientClosures.values(),
        ]);
        this.#clients.clear();
        this.#detachedClientClosures.clear();
        this.#messageMappers.clear();
        this.#pendingReattachments.clear();
        await this.#repository.close(ctx);
        const results = [...attachmentResults, ...clientResults];
        const failure =
            results.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected" && isDatabaseFailure(result.reason),
            ) ??
            results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure !== undefined) throw failure.reason;
    }

    async observe(
        ctx: Context,
        event: SessionEvent,
        session: InMemorySession | undefined,
    ): Promise<void> {
        if (this.#closed) return;
        if (session === undefined) return;
        if (session.agentMetadata().type !== "primary") return;
        if (isLiveOnlySessionEvent(event)) return;
        if (session.isArchived()) {
            if (
                !this.#detachedClientClosures.has(session.id) &&
                (await this.#repository.getSession(ctx, session.id)) !== undefined
            ) {
                await this.#attachOnce(ctx, session, true);
            }
            this.#detach(session.id);
            return;
        }
        const closure = this.#detachedClientClosures.get(session.id);
        if (closure !== undefined) {
            this.#scheduleReattach(session, closure);
            return;
        }
        try {
            await this.attach(ctx, session);
            if (event.type === "session_archived" && event.data.archived === false) {
                this.#clients.get(session.id)?.resume(ctx);
            }
            const mapper = this.#messageMappers.get(session.id) ?? new HappyMessageMapper();
            this.#messageMappers.set(session.id, mapper);
            const client = this.#clients.get(session.id);
            if (client === undefined) return;
            const result = await this.#repository.enqueueProjection(
                ctx,
                session.id,
                event.id,
                mapper.map(event),
            );
            if (result.status === "stalled") {
                throw new HappySyncOutboxFullError(
                    result.reason,
                    result.cause !== "event_too_large",
                );
            }
            client.kick(ctx);
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            const client = this.#clients.get(session.id);
            if (error instanceof HappySyncOutboxFullError) {
                if (error.recoverable) this.#scheduleBackfill(session);
            } else if (client !== undefined && this.#clients.get(session.id) === client) {
                this.#clients.delete(session.id);
                this.#messageMappers.delete(session.id);
                this.#attachRetryAfter.set(session.id, Date.now() + ATTACH_RETRY_DELAY_MS);
                await client.close(ctx).catch(rethrowDatabaseFailure);
            }
            console.error(`Happy sync could not observe session '${session.id}': ${String(error)}`);
        }
    }

    async start(ctx: Context): Promise<void> {
        if (this.#closed) return;
        this.#machineClient?.start();
        void ctx;
    }

    #detach(sessionId: string): void {
        const timer = this.#backfillTimers.get(sessionId);
        if (timer !== undefined) clearTimeout(timer);
        this.#backfillTimers.delete(sessionId);
        this.#attachRetryAfter.delete(sessionId);
        this.#messageMappers.delete(sessionId);
        const client = this.#clients.get(sessionId);
        if (client === undefined) return;
        this.#clients.delete(sessionId);
        const closure = withWorkerContext("happy-session-archive", (ctx) => client.archive(ctx));
        this.#detachedClientClosures.set(sessionId, closure);
        void closure.then(
            async () => {
                if (this.#detachedClientClosures.get(sessionId) === closure) {
                    this.#detachedClientClosures.delete(sessionId);
                }
            },
            (error: unknown) => {
                if (this.#detachedClientClosures.get(sessionId) === closure) {
                    this.#detachedClientClosures.delete(sessionId);
                }
                rethrowDatabaseFailure(error);
            },
        );
    }

    #scheduleReattach(session: InMemorySession, closure: Promise<void>): void {
        if (this.#pendingReattachments.has(session.id)) return;
        this.#pendingReattachments.add(session.id);
        void closure.then(
            () =>
                withWorkerContext("happy-session-reattach", async (ctx) => {
                    this.#pendingReattachments.delete(session.id);
                    if (this.#closed || session.isArchived()) return;
                    try {
                        await this.attach(ctx, session);
                        this.#clients.get(session.id)?.resume(ctx);
                    } catch (error) {
                        if (isDatabaseFailure(error)) throw error;
                        console.error(
                            `Happy sync could not restore session '${session.id}': ${String(error)}`,
                        );
                    }
                }),
            (error: unknown) => {
                this.#pendingReattachments.delete(session.id);
                rethrowDatabaseFailure(error);
            },
        );
    }

    #scheduleBackfill(session: InMemorySession): void {
        if (this.#backfillTimers.has(session.id)) return;
        const timer = setTimeout(() => {
            this.#backfillTimers.delete(session.id);
            void withWorkerContext("happy-session-backfill", (ctx) =>
                this.#runBackfill(ctx, session),
            ).catch(rethrowDatabaseFailure);
        }, ATTACH_RETRY_DELAY_MS);
        timer.unref();
        this.#backfillTimers.set(session.id, timer);
    }

    async #runBackfill(ctx: Context, session: InMemorySession): Promise<void> {
        const client = this.#clients.get(session.id);
        if (client === undefined) {
            await this.attach(ctx, session);
            return;
        }
        try {
            const state = await this.#repository.getSession(ctx, session.id);
            if (state === undefined) return;
            const backfill = mapSessionEvents(session, state.projectedEventId);
            if (!backfill.cursorFound && state.projectedEventId !== latestDurableEventId(session)) {
                const reason = "Happy projection recovery fell outside the bounded event window.";
                await this.#repository.stallProjectionGap(ctx, session.id, reason);
                console.error(`Happy sync cannot recover session '${session.id}': ${reason}`);
                return;
            }
            this.#messageMappers.set(session.id, backfill.mapper);
            await this.#enqueueRecovered(ctx, session, client, backfill.projections);
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (!(error instanceof HappySyncOutboxFullError) || error.recoverable) {
                this.#scheduleBackfill(session);
            }
            console.error(`Happy sync could not recover session '${session.id}': ${String(error)}`);
        }
    }

    async #enqueueRecovered(
        ctx: Context,
        session: InMemorySession,
        client: HappySessionClient,
        projections: readonly HappyEventProjection[],
    ): Promise<void> {
        const bounded = projections.slice(0, MAX_RECOVERY_EVENTS_PER_PASS);
        for (const projection of bounded) {
            const result = await this.#repository.enqueueProjection(
                ctx,
                session.id,
                projection.event.id,
                projection.messages,
            );
            if (result.status === "stalled") {
                throw new HappySyncOutboxFullError(
                    result.reason,
                    result.cause !== "event_too_large",
                );
            }
        }
        client.kick(ctx);
        if (projections.length > bounded.length) this.#scheduleBackfill(session);
    }
}

interface HappyEventProjection {
    event: SessionEvent;
    messages: ReturnType<HappyMessageMapper["map"]>;
}

function latestDurableEventId(session: InMemorySession): string | undefined {
    return session.events.all().at(-1)?.id;
}

function mapSessionEvents(
    session: InMemorySession,
    afterEventId?: string,
): {
    cursorFound: boolean;
    mapper: HappyMessageMapper;
    messages: ReturnType<HappyMessageMapper["map"]>;
    projections: readonly HappyEventProjection[];
} {
    const mapper = new HappyMessageMapper();
    const events = (session.events.since(undefined) ?? []).slice(-MAX_MAPPED_EVENTS);
    let cursorFound = afterEventId === undefined;
    const projections: HappyEventProjection[] = [];
    const mapped: HappySessionProtocolMessage[] = [];
    for (const event of events) {
        const messages = mapper.map(event);
        if (cursorFound) {
            projections.push({ event, messages });
            mapped.push(...messages);
        }
        if (event.id === afterEventId) cursorFound = true;
    }
    if (mapped.length <= MAX_BACKFILLED_MESSAGES) {
        return { cursorFound, mapper, messages: mapped, projections };
    }
    const cutoff = mapped.length - MAX_BACKFILLED_MESSAGES;
    let start = cutoff;
    for (let index = cutoff; index >= 0; index -= 1) {
        if (mapped[index]?.content.ev.t !== "turn-start") continue;
        start = index;
        break;
    }
    return {
        cursorFound,
        mapper,
        messages: mapped.slice(start),
        projections,
    };
}

function fingerprint(configuration: HappyConnectionConfiguration): string {
    const encryption = configuration.credentials.encryption;
    const key = encryption.type === "legacy" ? encryption.secret : encryption.publicKey;
    return createHash("sha256")
        .update(configuration.serverUrl)
        .update(encryption.type)
        .update(key)
        .digest("hex");
}
