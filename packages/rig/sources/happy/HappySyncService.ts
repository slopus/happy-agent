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
import { HappyMachineClient } from "./HappyMachineClient.js";
import { HappySessionClient, type HappySessionClientOptions } from "./HappySessionClient.js";
import { HappySyncOutboxFullError, HappySyncRepository } from "./HappySyncRepository.js";
import { HappyMessageMapper } from "./mapSessionEventToHappyMessages.js";
import { handleHappySpawnSession } from "./handleHappySpawnSession.js";
import type { HappyConnectionConfiguration } from "./types.js";

const MAX_BACKFILLED_MESSAGES = 10_000;
const ATTACH_RETRY_DELAY_MS = 5_000;

export interface HappySyncServiceOptions {
    configuration: HappyConnectionConfiguration;
    createSession?: (id: string, request: CreateSessionRequest) => InMemorySession;
    databasePath: string;
    fetch?: typeof fetch;
    getSubagents?: (sessionId: string) => readonly SubagentSummary[];
    getProjectContext?: (
        session: InMemorySession,
    ) => ReturnType<NonNullable<HappySessionClientOptions["projectContext"]>>;
    loadSession?: (sessionId: string) => InMemorySession | undefined;
    modelCatalog?: ModelCatalog;
    socketFactory?: HappySessionClientOptions["socketFactory"];
}

export class HappySyncService {
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
    readonly #loadSession: HappySyncServiceOptions["loadSession"];
    readonly #modelCatalog: ModelCatalog | undefined;
    readonly #machineClient: HappyMachineClient | undefined;
    readonly #repository: HappySyncRepository;
    readonly #socketFactory: HappySessionClientOptions["socketFactory"];

    constructor(options: HappySyncServiceOptions) {
        this.#configuration = options.configuration;
        this.#credentialFingerprint = fingerprint(options.configuration);
        this.#createSession = options.createSession;
        this.#fetch = options.fetch;
        this.#getSubagents = options.getSubagents ?? (() => []);
        this.#getProjectContext = options.getProjectContext;
        this.#loadSession = options.loadSession;
        this.#modelCatalog = options.modelCatalog;
        this.#repository = new HappySyncRepository(options.databasePath);
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
                        handleHappySpawnSession({
                            createSession: (id, request) => {
                                const session = this.#createSession!(id, request);
                                this.attach(session);
                            },
                            machineId: options.configuration.machineId!,
                            modelCatalog: options.modelCatalog!,
                            params,
                            signal,
                            waitForRemoteSession: (sessionId) =>
                                this.#clients.get(sessionId)?.waitForRemoteSession() ??
                                Promise.resolve(undefined),
                        }),
                });
            } catch (error) {
                this.#machineClient = undefined;
                console.error(`Happy machine sync is unavailable: ${String(error)}`);
            }
        } else {
            this.#machineClient = undefined;
        }
    }

    attach(session: InMemorySession): void {
        const closure = this.#detachedClientClosures.get(session.id);
        if (closure !== undefined && !session.snapshot().archived) {
            this.#scheduleReattach(session, closure);
            return;
        }
        this.#attachSession(session, false);
    }

    #attachSession(session: InMemorySession, includeArchived: boolean): void {
        if (this.#closed) return;
        const snapshot = session.snapshot();
        if (snapshot.agent.type !== "primary" || (snapshot.archived && !includeArchived)) {
            return;
        }
        let client = this.#clients.get(session.id);
        if (client === undefined) {
            if ((this.#attachRetryAfter.get(session.id) ?? 0) > Date.now()) return;
            try {
                const encryption = this.#configuration.credentials.encryption;
                this.#repository.ensureSession({
                    credentialFingerprint: this.#credentialFingerprint,
                    ...(encryption.type === "legacy" ? { encryptionKey: encryption.secret } : {}),
                    encryptionVariant: encryption.type,
                    sessionId: session.id,
                });
                client = new HappySessionClient({
                    configuration: this.#configuration,
                    ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }),
                    getSubagents: this.#getSubagents,
                    ...(this.#getProjectContext === undefined
                        ? {}
                        : { projectContext: () => this.#getProjectContext?.(session) }),
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
                    const backfill = backfillMessages(session);
                    this.#messageMappers.set(session.id, backfill.mapper);
                    client.enqueue(backfill.messages);
                }
                client.start();
                this.#attachRetryAfter.delete(session.id);
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                this.#clients.delete(session.id);
                this.#messageMappers.delete(session.id);
                this.#attachRetryAfter.set(session.id, Date.now() + ATTACH_RETRY_DELAY_MS);
                void client?.close().catch(rethrowDatabaseFailure);
                console.error(
                    `Happy sync could not attach session '${session.id}': ${String(error)}`,
                );
            }
        }
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#machineClient?.close();
        for (const timer of this.#backfillTimers.values()) clearTimeout(timer);
        this.#backfillTimers.clear();
        this.#attachRetryAfter.clear();
        const results = await Promise.allSettled([
            ...[...this.#clients.values()].map((client) => client.close()),
            ...this.#detachedClientClosures.values(),
        ]);
        this.#clients.clear();
        this.#detachedClientClosures.clear();
        this.#messageMappers.clear();
        this.#pendingReattachments.clear();
        this.#repository.close();
        const failure =
            results.find(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected" && isDatabaseFailure(result.reason),
            ) ??
            results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure !== undefined) throw failure.reason;
    }

    observe(event: SessionEvent, session: InMemorySession | undefined): void {
        if (this.#closed) return;
        if (session === undefined) return;
        const snapshot = session.snapshot();
        if (snapshot.agent.type !== "primary") return;
        if (snapshot.archived) {
            if (
                !this.#detachedClientClosures.has(session.id) &&
                this.#repository.getSession(session.id) !== undefined
            ) {
                this.#attachSession(session, true);
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
            this.attach(session);
            if (event.type === "session_archived" && event.data.archived === false) {
                this.#clients.get(session.id)?.resume();
            }
            const mapper = this.#messageMappers.get(session.id) ?? new HappyMessageMapper();
            this.#messageMappers.set(session.id, mapper);
            this.#clients.get(session.id)?.enqueue(mapper.map(event));
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            const client = this.#clients.get(session.id);
            if (error instanceof HappySyncOutboxFullError) {
                this.#scheduleBackfill(session);
            } else if (client !== undefined && this.#clients.get(session.id) === client) {
                this.#clients.delete(session.id);
                this.#messageMappers.delete(session.id);
                this.#attachRetryAfter.set(session.id, Date.now() + ATTACH_RETRY_DELAY_MS);
                void client.close().catch(rethrowDatabaseFailure);
            }
            console.error(`Happy sync could not observe session '${session.id}': ${String(error)}`);
        }
    }

    start(): void {
        if (this.#closed) return;
        this.#machineClient?.start();
        if (this.#loadSession === undefined) return;
        for (const sessionId of this.#repository.sessionIds(this.#credentialFingerprint)) {
            const session = this.#loadSession(sessionId);
            if (session !== undefined) this.attach(session);
        }
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
        const closure = client.archive();
        this.#detachedClientClosures.set(sessionId, closure);
        void closure.then(
            () => {
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
            () => {
                this.#pendingReattachments.delete(session.id);
                if (this.#closed || session.snapshot().archived) return;
                try {
                    this.attach(session);
                    this.#clients.get(session.id)?.resume();
                } catch (error) {
                    if (isDatabaseFailure(error)) throw error;
                    console.error(
                        `Happy sync could not restore session '${session.id}': ${String(error)}`,
                    );
                }
            },
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
            const client = this.#clients.get(session.id);
            if (client === undefined) {
                this.attach(session);
                return;
            }
            try {
                const backfill = backfillMessages(session);
                this.#messageMappers.set(session.id, backfill.mapper);
                client.enqueue(backfill.messages);
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                this.#scheduleBackfill(session);
                console.error(
                    `Happy sync could not recover session '${session.id}': ${String(error)}`,
                );
            }
        }, ATTACH_RETRY_DELAY_MS);
        timer.unref();
        this.#backfillTimers.set(session.id, timer);
    }
}

function backfillMessages(session: InMemorySession): {
    mapper: HappyMessageMapper;
    messages: ReturnType<HappyMessageMapper["map"]>;
} {
    const mapper = new HappyMessageMapper();
    const mapped = (session.events.since(undefined) ?? []).flatMap((event) => mapper.map(event));
    if (mapped.length <= MAX_BACKFILLED_MESSAGES) return { mapper, messages: mapped };
    const cutoff = mapped.length - MAX_BACKFILLED_MESSAGES;
    let start = cutoff;
    for (let index = cutoff; index >= 0; index -= 1) {
        if (mapped[index]?.content.ev.t !== "turn-start") continue;
        start = index;
        break;
    }
    return { mapper, messages: mapped.slice(start) };
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
