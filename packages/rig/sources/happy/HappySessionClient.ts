import { io, type Socket } from "socket.io-client";
import type { Context } from "@steve.kite/stdlib";

import type { ImageBlock } from "../agent/types.js";
import type { RigAgentService } from "../agent/RigAgentService.js";
import type {
    AbortRunResponse,
    ModelCatalog,
    Project,
    ProjectWorkspace,
    SubagentSummary,
} from "../protocol/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import type { InMemorySession } from "../session/InMemorySession.js";
import type { UserInputRequest } from "../user-input/index.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { isPermissionMode } from "../permissions/index.js";
import { withWorkerContext } from "../observability/index.js";
import { rethrowDatabaseFailure } from "../persistence/rethrowDatabaseFailure.js";
import {
    createHappyAgentState,
    type HappyResolvedCommunication,
    rememberHappyResolvedCommunication,
    toHappyCommunication,
} from "./createHappyAgentState.js";
import { createHappySessionMetadata } from "./createHappySessionMetadata.js";
import { decryptHappyBlob } from "./decryptHappyBlob.js";
import { HAPPY_SESSION_RPC_METHODS, handleHappySessionRpc } from "./handleHappySessionRpc.js";
import { decryptHappyPayload, encryptHappyPayload, wrapHappyDataKey } from "./happyEncryption.js";
import { readHappyRemoteInput } from "./readHappyRemoteInput.js";
import type { HappySyncRepository, HappySessionState } from "./HappySyncRepository.js";
import type {
    HappyConnectionConfiguration,
    HappyRemoteMessage,
    HappySessionMetadata,
    HappySessionProtocolMessage,
} from "./types.js";

const SYNC_RETRY_DELAY_MS = 2_000;
const HTTP_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type Fetch = typeof fetch;

export type HappyProjectContext = { project: Project; workspace?: ProjectWorkspace } | undefined;

interface HappySocket {
    connected?: boolean;
    connect(): void;
    disconnect(): void;
    emit(event: string, ...values: any[]): void;
    on(event: string, listener: (...arguments_: any[]) => void): void;
}

export interface HappySessionClientOptions {
    agents?: RigAgentService;
    configuration: HappyConnectionConfiguration;
    fetch?: Fetch;
    getSubagents?: (
        ctx: Context,
        sessionId: string,
    ) => readonly SubagentSummary[] | Promise<readonly SubagentSummary[]>;
    modelCatalog?: ModelCatalog;
    projectContext?: (ctx: Context) => HappyProjectContext | Promise<HappyProjectContext>;
    repository: HappySyncRepository;
    session: InMemorySession;
    socketFactory?: (url: string, options: Parameters<typeof io>[1]) => HappySocket;
}

export class HappySessionClient {
    readonly #agents: RigAgentService | undefined;
    readonly #configuration: HappyConnectionConfiguration;
    readonly #fetch: Fetch;
    readonly #getSubagents: NonNullable<HappySessionClientOptions["getSubagents"]>;
    readonly #modelCatalog: ModelCatalog | undefined;
    readonly #projectContext: HappySessionClientOptions["projectContext"];
    readonly #repository: HappySyncRepository;
    readonly #session: InMemorySession;
    readonly #socketFactory: NonNullable<HappySessionClientOptions["socketFactory"]>;
    #archivePromise: Promise<void> | undefined;
    #archiving = false;
    #closed = false;
    readonly #closeController = new AbortController();
    #lifecycleMetadata: Record<string, unknown> | undefined;
    #needsAnotherSync = false;
    #agentStateVersion: number | undefined;
    // Sessions are created with a null agent state, so nothing needs publishing
    // until a question actually arrives.
    #lastAgentState: string | undefined = "null";
    readonly #resolvedQuestions = new Map<string, HappyResolvedCommunication>();
    readonly #questionFirstSeen = new Map<string, number>();
    #lastMetadata: string | undefined;
    #metadataBase: Record<string, unknown> = {};
    #metadataVersion: number | undefined;
    readonly #pendingAttachments = new Map<string, Promise<ImageBlock | undefined>>();
    readonly #remoteSessionWaiters = new Set<(sessionId: string | undefined) => void>();
    #socket: HappySocket | undefined;
    #started = false;
    #sentSessionEnd = false;
    #summaryTitle: string | undefined;
    #summaryUpdatedAt = Date.now();
    #syncPromise: Promise<void> | undefined;
    #retryTimer: NodeJS.Timeout | undefined;

    constructor(options: HappySessionClientOptions) {
        this.#agents = options.agents;
        this.#configuration = options.configuration;
        this.#fetch = options.fetch ?? fetch;
        this.#getSubagents = options.getSubagents ?? (() => []);
        this.#modelCatalog = options.modelCatalog;
        this.#projectContext = options.projectContext;
        this.#repository = options.repository;
        this.#session = options.session;
        this.#socketFactory =
            options.socketFactory ?? ((url, socketOptions) => io(url, socketOptions) as Socket);
    }

    archive(ctx: Context): Promise<void> {
        if (this.#archivePromise !== undefined) return this.#archivePromise;
        if (this.#closed) return Promise.resolve();
        this.#archiving = true;
        this.#lifecycleMetadata = {
            archiveReason: "Session archived in Rig",
            archivedBy: "rig",
            lifecycleState: "archived",
            lifecycleStateSince: Date.now(),
        };
        this.#clearRetry();
        const archive = this.#finishArchive(ctx);
        this.#archivePromise = archive;
        return archive;
    }

    async close(ctx: Context): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#clearRetry();
        await this.#sendSessionEnd(ctx);
        this.#closeController.abort();
        this.#socket?.disconnect();
        this.#socket = undefined;
        for (const resolve of this.#remoteSessionWaiters) resolve(undefined);
        this.#remoteSessionWaiters.clear();
        await this.#syncPromise?.catch((error: unknown) => {
            if (isDatabaseFailure(error)) throw error;
        });
    }

    resume(ctx: Context): void {
        if (this.#closed || this.#archiving) return;
        this.#lifecycleMetadata = {
            archiveReason: undefined,
            archivedBy: undefined,
            lifecycleState: "running",
            lifecycleStateSince: Date.now(),
        };
        this.kick(ctx);
    }

    async enqueue(ctx: Context, messages: readonly HappySessionProtocolMessage[]): Promise<void> {
        await this.#repository.enqueue(ctx, this.#session.id, messages);
        this.kick(ctx);
    }

    kick(_ctx: Context): void {
        this.#startAutonomousSync();
    }

    start(_ctx: Context): void {
        if (this.#closed || this.#started) return;
        this.#started = true;
        this.#startAutonomousSync();
    }

    #kick(): void {
        if (this.#closed) return;
        if (this.#syncPromise !== undefined) {
            this.#needsAnotherSync = true;
            return;
        }
        this.#clearRetry();
        this.#syncPromise = this.#runSyncLoop().finally(() => {
            this.#syncPromise = undefined;
        });
    }

    #startAutonomousSync(): void {
        if (this.#closed) return;
        if (this.#syncPromise !== undefined) {
            this.#needsAnotherSync = true;
            return;
        }
        void this.#kickAndWait().catch(rethrowDatabaseFailure);
    }

    async waitForRemoteSession(
        ctx: Context,
        timeoutMs = HTTP_TIMEOUT_MS,
    ): Promise<string | undefined> {
        const current = (await this.#repository.getSession(ctx, this.#session.id))?.remoteSessionId;
        if (current !== undefined) return Promise.resolve(current);
        if (this.#closed) return Promise.resolve(undefined);
        this.kick(ctx);
        return new Promise((resolve) => {
            const finish = (sessionId: string | undefined) => {
                clearTimeout(timer);
                this.#remoteSessionWaiters.delete(finish);
                resolve(sessionId);
            };
            const timer = setTimeout(() => finish(undefined), timeoutMs);
            timer.unref();
            this.#remoteSessionWaiters.add(finish);
        });
    }

    async #runSyncLoop(): Promise<void> {
        do {
            this.#needsAnotherSync = false;
            const completed = await withWorkerContext(
                "happy-session-sync",
                async (ctx) => {
                    try {
                        const state = await this.#ensureRemoteSession(ctx);
                        if (state === undefined || this.#closed) return true;
                        this.#ensureSocket(state.remoteSessionId!);
                        await this.#flushOutbox(ctx, state);
                        if (!this.#archiving) await this.#fetchIncoming(ctx, state);
                        await this.#syncMetadata(ctx, state);
                        this.#sendKeepAlive(state.remoteSessionId!);
                        await this.#syncAgentState(ctx, state);
                        return true;
                    } catch (error) {
                        if (isDatabaseFailure(error)) throw error;
                        this.#scheduleRetry();
                        return false;
                    }
                },
                { sessionId: this.#session.id },
            );
            if (!completed) return;
        } while (this.#needsAnotherSync && !this.#closed);
    }

    async #ensureRemoteSession(ctx: Context): Promise<HappySessionState | undefined> {
        const current = await this.#repository.getSession(ctx, this.#session.id);
        if (current === undefined) return undefined;
        if (this.#metadataVersion !== undefined && current.remoteSessionId !== undefined) {
            return current;
        }

        const metadata = await this.#metadata(ctx);
        const encodedMetadata = encodePayload(current, metadata);
        const wrappedKey =
            this.#configuration.credentials.encryption.type === "dataKey"
                ? Buffer.from(
                      wrapHappyDataKey(
                          current.encryptionKey,
                          this.#configuration.credentials.encryption.publicKey,
                      ),
                  ).toString("base64")
                : null;
        const response = await this.#request(ctx, `${this.#configuration.serverUrl}/v1/sessions`, {
            body: JSON.stringify({
                agentState: null,
                dataEncryptionKey: wrappedKey,
                metadata: encodedMetadata,
                tag: current.tag,
            }),
            method: "POST",
        });
        const body = (await response.json()) as unknown;
        const remote = readRemoteSession(body);
        const remoteSessionId = remote.id;
        this.#metadataVersion = remote.metadataVersion;
        this.#agentStateVersion = remote.agentStateVersion;
        // Creating by tag may return an old session. A null or omitted state is
        // already in sync; a non-null state must be reconciled with Rig's
        // current pending questions, including clearing a stale prompt.
        this.#lastAgentState =
            remote.agentState === null || remote.agentState === undefined ? "null" : undefined;
        if (remote.metadata !== undefined) {
            const decoded = decodePayload(current, remote.metadata);
            if (isRecord(decoded)) this.#metadataBase = decoded;
        }
        if (remote.metadata === encodedMetadata) {
            this.#lastMetadata = JSON.stringify(metadata);
            this.#metadataBase = { ...metadata };
        }
        await this.#repository.setRemoteSession(ctx, this.#session.id, remoteSessionId);
        for (const resolve of this.#remoteSessionWaiters) resolve(remoteSessionId);
        this.#remoteSessionWaiters.clear();
        return this.#repository.getSession(ctx, this.#session.id);
    }

    #ensureSocket(remoteSessionId: string): void {
        if (this.#socket !== undefined) return;
        const socket = this.#socketFactory(this.#configuration.serverUrl, {
            auth: {
                clientType: "session-scoped",
                happyClient: `rig/${readPackageVersion()}`,
                sessionId: remoteSessionId,
                token: this.#configuration.credentials.token,
            },
            autoConnect: false,
            path: "/v1/updates",
            reconnection: true,
            transports: ["websocket"],
            withCredentials: true,
        });
        socket.on("connect", () => {
            for (const method of HAPPY_SESSION_RPC_METHODS) {
                socket.emit("rpc-register", { method: `${remoteSessionId}:${method}` });
            }
            void withWorkerContext(
                "happy-session-socket-connect",
                (ctx) => this.#kickAndWait(ctx),
                { sessionId: this.#session.id },
            ).catch(rethrowDatabaseFailure);
        });
        socket.on(
            "rpc-request",
            (request: unknown, callback: (response: string) => void) =>
                void withWorkerContext(
                    "happy-session-rpc",
                    (ctx) => this.#handleRpcRequest(ctx, remoteSessionId, request, callback),
                    { sessionId: this.#session.id },
                ).catch(rethrowDatabaseFailure),
        );
        socket.on("update", () => {
            void withWorkerContext("happy-session-update", (ctx) => this.#kickAndWait(ctx), {
                sessionId: this.#session.id,
            }).catch(rethrowDatabaseFailure);
        });
        this.#socket = socket;
        socket.connect();
    }

    async #flushOutbox(ctx: Context, state: HappySessionState): Promise<void> {
        while (!this.#closed) {
            const pending = await this.#repository.pending(ctx, this.#session.id, 50);
            if (pending.length === 0) return;
            await this.#request(
                ctx,
                `${this.#configuration.serverUrl}/v3/sessions/${encodeURIComponent(state.remoteSessionId!)}/messages`,
                {
                    body: JSON.stringify({
                        messages: pending.map((message) => ({
                            content: encodePayload(state, message),
                            localId: message.localId,
                        })),
                    }),
                    method: "POST",
                },
            );
            await this.#repository.acknowledge(
                ctx,
                this.#session.id,
                pending.map((message) => message.localId),
            );
        }
    }

    async #fetchIncoming(ctx: Context, state: HappySessionState): Promise<void> {
        let afterSequence =
            (await this.#repository.getSession(ctx, this.#session.id))?.lastRemoteSeq ?? 0;
        while (!this.#closed) {
            const url = new URL(
                `${this.#configuration.serverUrl}/v3/sessions/${encodeURIComponent(state.remoteSessionId!)}/messages`,
            );
            url.searchParams.set("after_seq", String(afterSequence));
            url.searchParams.set("limit", String(PAGE_SIZE));
            const response = await this.#request(ctx, url.toString());
            const body = (await response.json()) as unknown;
            const page = readRemoteMessagePage(body);
            let maximumSequence = afterSequence;
            for (const message of page.messages) {
                const canCommit = await this.#handleRemoteMessage(ctx, state, message);
                maximumSequence = Math.max(maximumSequence, message.seq);
                if (canCommit) {
                    await this.#repository.updateLastRemoteSeq(
                        ctx,
                        this.#session.id,
                        maximumSequence,
                    );
                }
            }
            if (!page.hasMore || maximumSequence === afterSequence) return;
            afterSequence = maximumSequence;
        }
    }

    async #handleRemoteMessage(
        ctx: Context,
        state: HappySessionState,
        message: HappyRemoteMessage,
    ): Promise<boolean> {
        if (this.#archiving) return false;
        const decrypted = decryptHappyPayload(
            state.encryptionKey,
            state.encryptionVariant,
            new Uint8Array(Buffer.from(message.content.c, "base64")),
        );
        const incoming = readHappyRemoteInput(decrypted);
        if (incoming === undefined || incoming.kind === "echo") {
            return this.#pendingAttachments.size === 0;
        }
        if (incoming.kind === "attachment") {
            if (!this.#pendingAttachments.has(message.id)) {
                this.#pendingAttachments.set(
                    message.id,
                    withWorkerContext(
                        "happy-attachment-download",
                        (downloadCtx) => this.#downloadAttachment(downloadCtx, state, incoming),
                        { messageId: message.id, sessionId: this.#session.id },
                    ).catch(() => undefined),
                );
            }
            return false;
        }
        const messageId = `happy:${message.id}`;
        const attachments = await Promise.all(this.#pendingAttachments.values());
        this.#pendingAttachments.clear();
        if (hasSubmittedMessage(this.#session, messageId)) return true;
        await this.#applySelection(ctx, incoming.meta);
        const imageBlocks = attachments.filter(
            (attachment): attachment is ImageBlock => attachment !== undefined,
        );
        const content = [
            ...(incoming.text.length === 0
                ? []
                : ([{ text: incoming.text, type: "text" }] as const)),
            ...imageBlocks,
        ];
        const request = {
            clientSubmissionId: messageId,
            ...(imageBlocks.length === 0 ? {} : { content }),
            displayText: incoming.text,
            text: incoming.text,
        };
        await this.#requireAgents().deliverMessage(ctx, this.#session, request);
        return true;
    }

    async #applySelection(
        ctx: Context,
        selection: {
            effort?: string;
            modelId?: string;
            permissionMode?: string;
            providerId?: string;
        },
    ): Promise<void> {
        if (isPermissionMode(selection.permissionMode)) {
            try {
                await this.#requireAgents().changePermissionMode(ctx, this.#session, {
                    permissionMode: selection.permissionMode,
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                // A stale or unknown mobile mode must not prevent message delivery.
            }
        }
        try {
            if (selection.modelId !== undefined && selection.modelId !== "default") {
                await this.#requireAgents().changeModel(ctx, this.#session, {
                    ...(selection.effort === undefined ? {} : { effort: selection.effort }),
                    modelId: selection.modelId,
                    ...(selection.providerId === undefined
                        ? {}
                        : { providerId: selection.providerId }),
                });
            } else if (selection.effort !== undefined) {
                await this.#requireAgents().changeEffort(ctx, this.#session, {
                    effort: selection.effort,
                });
            }
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            // A stale mobile selection must not prevent delivery of the user's message.
        }
    }

    async #downloadAttachment(
        ctx: Context,
        state: HappySessionState,
        attachment: { mimeType?: string; name: string; ref: string; size: number },
    ): Promise<ImageBlock | undefined> {
        if (attachment.size < 0 || attachment.size > MAX_ATTACHMENT_BYTES) return undefined;
        const remoteSessionId = state.remoteSessionId;
        if (remoteSessionId === undefined) return undefined;
        const response = await this.#request(
            ctx,
            `${this.#configuration.serverUrl}/v1/sessions/${encodeURIComponent(remoteSessionId)}/attachments/request-download`,
            { body: JSON.stringify({ ref: attachment.ref }), method: "POST" },
        );
        const body = (await response.json()) as unknown;
        if (!isRecord(body) || typeof body.downloadUrl !== "string") return undefined;
        const downloadUrl = body.downloadUrl;
        const sameServer =
            new URL(downloadUrl).origin === new URL(this.#configuration.serverUrl).origin;
        const download = await this.#fetch(downloadUrl, {
            ...(sameServer
                ? { headers: { Authorization: `Bearer ${this.#configuration.credentials.token}` } }
                : {}),
            signal: AbortSignal.any([
                AbortSignal.timeout(HTTP_TIMEOUT_MS),
                this.#closeController.signal,
            ]),
        });
        if (!download.ok) return undefined;
        const encrypted = new Uint8Array(await download.arrayBuffer());
        if (encrypted.length > MAX_ATTACHMENT_BYTES + 64) return undefined;
        const decrypted = decryptHappyBlob({
            bundle: encrypted,
            encryptionKey: state.encryptionKey,
            encryptionVariant: state.encryptionVariant,
        });
        if (decrypted === undefined || decrypted.length > MAX_ATTACHMENT_BYTES) return undefined;
        const mediaType = attachment.mimeType ?? "image/jpeg";
        if (!mediaType.startsWith("image/")) return undefined;
        return { data: Buffer.from(decrypted).toString("base64"), mediaType, type: "image" };
    }

    async #handleRpcRequest(
        ctx: Context,
        remoteSessionId: string,
        request: unknown,
        callback: (response: string) => void,
    ): Promise<void> {
        const state = await this.#repository.getSession(ctx, this.#session.id);
        if (state === undefined) {
            callback("");
            return;
        }
        if (this.#archiving) {
            callback(encodePayload(state, { error: "This session is archived." }));
            return;
        }
        let response: unknown;
        try {
            if (!isRecord(request) || typeof request.method !== "string") {
                response = { error: "Method not found" };
            } else if (typeof request.params !== "string") {
                response = { error: "Invalid request" };
            } else {
                const params = decryptHappyPayload(
                    state.encryptionKey,
                    state.encryptionVariant,
                    new Uint8Array(Buffer.from(request.params, "base64")),
                );
                const prefix = `${remoteSessionId}:`;
                if (!request.method.startsWith(prefix) || params === undefined) {
                    response = { error: "Invalid request" };
                } else {
                    response = await handleHappySessionRpc({
                        abort: () => this.#abortFromHappy(ctx),
                        archive: async () => {
                            await this.#session.setArchived(ctx, true);
                            return { success: true };
                        },
                        answerQuestion: (requestId, answers) =>
                            this.#answerQuestion(ctx, requestId, answers),
                        cancelQuestion: (requestId) => this.#cancelQuestion(ctx, requestId),
                        context: () => this.#session.externalControlContext(ctx),
                        method: request.method.slice(prefix.length),
                        params,
                    });
                }
            }
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            response = { error: error instanceof Error ? error.message : "Abort failed" };
        }
        callback(encodePayload(state, response));
    }

    #abortFromHappy(ctx: Context): Promise<AbortRunResponse> {
        return this.#requireAgents().abort(ctx, this.#session);
    }

    async #syncMetadata(ctx: Context, state: HappySessionState): Promise<void> {
        if (
            this.#socket === undefined ||
            this.#socket.connected === false ||
            this.#metadataVersion === undefined
        ) {
            return;
        }
        const rigMetadata = { ...(await this.#metadata(ctx)), ...this.#lifecycleMetadata };
        let metadata = { ...this.#metadataBase, ...rigMetadata };
        let serialized = JSON.stringify(metadata);
        if (serialized === this.#lastMetadata) return;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const answer = await this.#emitWithAck("update-metadata", {
                expectedVersion: this.#metadataVersion,
                metadata: encodePayload(state, metadata),
                sid: state.remoteSessionId,
            });
            if (!isRecord(answer)) throw new Error("Happy returned an invalid metadata response.");
            if (answer.result === "success" && typeof answer.version === "number") {
                this.#metadataVersion = answer.version;
                this.#lastMetadata = serialized;
                this.#metadataBase = metadata;
                return;
            }
            if (answer.result === "version-mismatch" && typeof answer.version === "number") {
                if (typeof answer.metadata !== "string") {
                    throw new Error("Happy returned incomplete metadata after a version conflict.");
                }
                const latest = decodePayload(state, answer.metadata);
                if (!isRecord(latest)) {
                    throw new Error("Happy returned invalid metadata after a version conflict.");
                }
                this.#metadataVersion = answer.version;
                this.#metadataBase = latest;
                metadata = { ...latest, ...rigMetadata };
                serialized = JSON.stringify(metadata);
                continue;
            }
            throw new Error("Happy rejected the metadata update.");
        }
        throw new Error("Happy metadata changed concurrently.");
    }

    /**
     * Publishes Rig's pending questions on Happy's communication channel, which
     * is how a remote client learns the agent is waiting on an answer. Without
     * this a session that asks a question simply stalls with nothing on screen.
     */
    async #syncAgentState(_ctx: Context, state: HappySessionState): Promise<void> {
        if (
            this.#socket === undefined ||
            this.#socket.connected === false ||
            this.#agentStateVersion === undefined
        ) {
            return;
        }
        const pending = this.#session.clientSnapshot().pendingUserInputs ?? [];
        const pendingRequestIds = new Set(pending.map((request) => request.requestId));
        for (const requestId of this.#questionFirstSeen.keys()) {
            if (!pendingRequestIds.has(requestId)) this.#questionFirstSeen.delete(requestId);
        }
        const agentState = createHappyAgentState({
            completed: this.#resolvedQuestions,
            createdAt: (requestId) => this.#firstSeen(requestId),
            pending,
        });
        const serialized = JSON.stringify(agentState);
        if (serialized === this.#lastAgentState) return;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const answer = await this.#emitWithAck("update-state", {
                agentState: agentState === null ? null : encodePayload(state, agentState),
                expectedVersion: this.#agentStateVersion,
                sid: state.remoteSessionId,
            });
            if (!isRecord(answer)) {
                throw new Error("Happy returned an invalid agent state response.");
            }
            if (answer.result === "success" && typeof answer.version === "number") {
                this.#agentStateVersion = answer.version;
                this.#lastAgentState = serialized;
                return;
            }
            // Happy owns the version, not the contents: adopt the new version
            // and republish, since Rig is the only writer of question state.
            if (answer.result === "version-mismatch" && typeof answer.version === "number") {
                this.#agentStateVersion = answer.version;
                continue;
            }
            throw new Error("Happy rejected the agent state update.");
        }
        throw new Error("Happy agent state changed concurrently.");
    }

    /** First time this question was published, so its timestamp stays stable. */
    #firstSeen(requestId: string): number {
        const existing = this.#questionFirstSeen.get(requestId);
        if (existing !== undefined) return existing;
        const now = Date.now();
        this.#questionFirstSeen.set(requestId, now);
        return now;
    }

    async #answerQuestion(
        _ctx: Context,
        _requestId: string,
        _answers: Record<string, unknown>,
    ): Promise<void> {
        throw new Error(
            "Answering agent questions from Happy is unavailable until the user-input feature is connected.",
        );
    }

    async #cancelQuestion(_ctx: Context, _requestId: string): Promise<void> {
        throw new Error(
            "Cancelling agent questions from Happy is unavailable until the user-input feature is connected.",
        );
    }

    #emitWithAck(event: string, value: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const finish = (operation: () => void) => {
                clearTimeout(timer);
                this.#closeController.signal.removeEventListener("abort", onAbort);
                operation();
            };
            const onAbort = () => finish(() => reject(new Error("Happy synchronization closed.")));
            const timer = setTimeout(
                () => finish(() => reject(new Error("Happy socket acknowledgement timed out."))),
                HTTP_TIMEOUT_MS,
            );
            timer.unref();
            this.#closeController.signal.addEventListener("abort", onAbort, { once: true });
            this.#socket!.emit(event, value, (answer: unknown) => {
                finish(() => resolve(answer));
            });
        });
    }

    async #metadata(ctx: Context): Promise<HappySessionMetadata> {
        const snapshot = this.#session.clientSnapshot({ includeTools: true });
        const context = await this.#projectContext?.(ctx);
        const title = snapshot.title ?? "Rig session";
        if (title !== this.#summaryTitle) {
            this.#summaryTitle = title;
            this.#summaryUpdatedAt = Date.now();
        }
        return createHappySessionMetadata({
            activity: this.#session.activity(),
            configuration: this.#configuration,
            ...(this.#modelCatalog === undefined ? {} : { modelCatalog: this.#modelCatalog }),
            session: snapshot,
            ...(context === undefined
                ? {}
                : {
                      project: {
                          id: context.project.id,
                          kind: context.project.kind,
                          name: context.project.name,
                      },
                      ...(context.workspace === undefined
                          ? {}
                          : {
                                workspace: {
                                    id: context.workspace.id,
                                    kind: context.workspace.kind,
                                    name: context.workspace.name,
                                },
                            }),
                  }),
            subagents: await this.#getSubagents(ctx, this.#session.id),
            summaryUpdatedAt: this.#summaryUpdatedAt,
        });
    }

    #sendKeepAlive(remoteSessionId: string): void {
        if (this.#archiving) return;
        const activity = this.#session.activity();
        this.#socket?.emit("session-alive", {
            activity,
            sid: remoteSessionId,
            // Kept for older Happy clients. New clients read `activity`.
            thinking: isWorkingActivity(activity.kind),
            time: Date.now(),
        });
    }

    async #finishArchive(ctx: Context): Promise<void> {
        try {
            await this.#kickAndWait();
            await this.#sendSessionEnd(ctx);
            const remoteSessionId = (await this.#repository.getSession(ctx, this.#session.id))
                ?.remoteSessionId;
            if (remoteSessionId !== undefined) {
                await this.#request(
                    ctx,
                    `${this.#configuration.serverUrl}/v1/sessions/${encodeURIComponent(remoteSessionId)}/archive`,
                    { method: "POST" },
                );
            }
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            // Happy is optional. The immediate session-end signal still stops a connected session.
        } finally {
            await this.close(ctx);
        }
    }

    async #sendSessionEnd(ctx: Context): Promise<void> {
        if (this.#sentSessionEnd) return;
        const remoteSessionId = (await this.#repository.getSession(ctx, this.#session.id))
            ?.remoteSessionId;
        if (remoteSessionId === undefined || this.#socket === undefined) return;
        this.#sentSessionEnd = true;
        this.#socket.emit("session-end", { sid: remoteSessionId, time: Date.now() });
    }

    async #request(_ctx: Context, url: string, init: RequestInit = {}): Promise<Response> {
        const signal = AbortSignal.any([
            AbortSignal.timeout(HTTP_TIMEOUT_MS),
            this.#closeController.signal,
        ]);
        const response = await this.#fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.#configuration.credentials.token}`,
                "Content-Type": "application/json",
                "X-Happy-Client": `rig/${readPackageVersion()}`,
                ...init.headers,
            },
            signal,
        });
        if (!response.ok) throw new Error(`Happy returned HTTP ${String(response.status)}.`);
        return response;
    }

    async #kickAndWait(_ctx?: Context): Promise<void> {
        this.#kick();
        await this.#syncPromise;
    }

    #scheduleRetry(): void {
        if (this.#closed || this.#archiving || this.#retryTimer !== undefined) return;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            void withWorkerContext("happy-session-retry", (ctx) => this.#kickAndWait(ctx), {
                sessionId: this.#session.id,
            }).catch(rethrowDatabaseFailure);
        }, SYNC_RETRY_DELAY_MS);
        this.#retryTimer.unref();
    }

    #clearRetry(): void {
        if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
        this.#retryTimer = undefined;
    }

    #requireAgents(): RigAgentService {
        if (this.#agents !== undefined) return this.#agents;
        throw new Error("Agent control is unavailable for this Happy session.");
    }
}

function isWorkingActivity(kind: ReturnType<InMemorySession["activity"]>["kind"]): boolean {
    return (
        kind === "queued" ||
        kind === "thinking" ||
        kind === "generating_message" ||
        kind === "generating_tool_call" ||
        kind === "reviewing_tool_call" ||
        kind === "executing_tool_call" ||
        kind === "waiting" ||
        kind === "compacting" ||
        kind === "retrying"
    );
}

function encodePayload(state: HappySessionState, value: unknown): string {
    return Buffer.from(
        encryptHappyPayload(state.encryptionKey, state.encryptionVariant, value),
    ).toString("base64");
}

function decodePayload(state: HappySessionState, value: string): unknown {
    return decryptHappyPayload(
        state.encryptionKey,
        state.encryptionVariant,
        new Uint8Array(Buffer.from(value, "base64")),
    );
}

function readRemoteSession(value: unknown): {
    agentState?: string | null;
    agentStateVersion: number;
    id: string;
    metadata?: string;
    metadataVersion: number;
} {
    const session = isRecord(value) && isRecord(value.session) ? value.session : undefined;
    if (
        session === undefined ||
        typeof session.id !== "string" ||
        typeof session.metadataVersion !== "number"
    ) {
        throw new Error("Happy returned an invalid session.");
    }
    return {
        ...(typeof session.agentState === "string" || session.agentState === null
            ? { agentState: session.agentState }
            : {}),
        // Older Happy servers omit the agent state version; starting at zero
        // matches a session that has never published any state.
        agentStateVersion:
            typeof session.agentStateVersion === "number" ? session.agentStateVersion : 0,
        id: session.id,
        ...(typeof session.metadata === "string" ? { metadata: session.metadata } : {}),
        metadataVersion: session.metadataVersion,
    };
}

function readRemoteMessagePage(value: unknown): {
    hasMore: boolean;
    messages: HappyRemoteMessage[];
} {
    if (!isRecord(value) || !Array.isArray(value.messages)) {
        throw new Error("Happy returned an invalid message page.");
    }
    return {
        hasMore: value.hasMore === true,
        messages: value.messages.filter(isHappyRemoteMessage),
    };
}

function isHappyRemoteMessage(value: unknown): value is HappyRemoteMessage {
    return (
        isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.seq === "number" &&
        isRecord(value.content) &&
        value.content.t === "encrypted" &&
        typeof value.content.c === "string"
    );
}

function hasSubmittedMessage(session: InMemorySession, messageId: string): boolean {
    return session.events.messageSubmission(messageId) !== undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
