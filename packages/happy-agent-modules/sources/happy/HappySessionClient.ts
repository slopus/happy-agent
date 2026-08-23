import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { UserInputRequest } from "../userInput/index.js";
import {
    createHappyAgentState,
    rememberHappyResolvedCommunication,
    toHappyCommunication,
    type HappyResolvedCommunication,
} from "./createHappyAgentState.js";
import {
    createHappySessionMetadata,
    MAX_HAPPY_ATTACHMENT_BYTES,
} from "./createHappySessionMetadata.js";
import { decryptHappyBlob } from "./crypto/decryptHappyBlob.js";
import {
    decryptHappyPayload,
    encryptHappyPayload,
    wrapHappyDataKey,
} from "./crypto/happyEncryption.js";
import { connectHappySocket } from "./connectHappySocket.js";
import { HAPPY_SESSION_RPC_METHODS, handleHappySessionRpc } from "./handleHappySessionRpc.js";
import type { HappyConnectionConfiguration } from "./HappyCredentials.js";
import {
    HappyMessageRefused,
    type HappyInboundImage,
    type HappyInboundMessage,
    type HappyModel,
    type HappySessionSnapshot,
} from "./HappySession.js";
import {
    happyRemoteMessageId,
    happyRemoteMessageSchema,
    type HappyRemoteMessage,
    type HappySessionProtocolMessage,
} from "./HappyProtocol.js";
import type { HappySyncSession } from "./HappySync.js";
import type { HappySyncDatabase } from "./HappySyncDatabase.js";
import { readHappyRemoteInput } from "./readHappyRemoteInput.js";
import { isAgentPermissionMode } from "@slopus/happy-agent-base";

const HTTP_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const OUTBOX_BATCH = 50;
const INCOMING_PAGE = 100;

/** The socket surface this client needs, which is the part of Socket.IO it uses. */
export interface HappySocket {
    connected?: boolean;
    connect: () => void;
    disconnect: () => void;
    emit: (event: string, ...values: unknown[]) => void;
    on: (event: string, listener: (...values: any[]) => void) => void;
}

/**
 * What this client asks of the module it belongs to.
 *
 * Everything a person does on the phone is an act on a conversation, and a conversation is the
 * module's business rather than the socket's. Naming that as a narrow contract is what lets the
 * wire handling here be exercised on its own, without a daemon behind it.
 */
export interface HappySessionOperations {
    /** Stops whatever the agent is doing. */
    abort: (ctx: Context, agentId: string) => Promise<void>;

    /** Records what a person answered on the phone. */
    answerQuestion: (
        ctx: Context,
        agentId: string,
        requestId: string,
        answers: Record<string, unknown>,
    ) => Promise<void>;

    /** Ends a session, as the phone's kill switch does. */
    archiveSession: (ctx: Context, sessionId: string) => Promise<void>;

    /** Dismisses a question the person chose not to answer. */
    cancelQuestion: (ctx: Context, agentId: string, requestId: string) => Promise<void>;

    /** Every model the phone may offer, across providers. */
    models: () => readonly HappyModel[];

    /** The questions this agent is waiting on right now. */
    pendingQuestions: (ctx: Context, agentId: string) => Promise<readonly UserInputRequest[]>;

    /** One session as Happy needs to describe it, or nothing when it is gone. */
    session: (ctx: Context, agentId: string) => Promise<HappySessionSnapshot | undefined>;

    /** Delivers what a person said on the phone, and what they chose to say it with. */
    submit: (ctx: Context, agentId: string, message: HappyInboundMessage) => Promise<void>;
}

export interface HappySessionClientOptions {
    readonly agentId: string;
    readonly configuration: HappyConnectionConfiguration;
    /** The lifetime this client's own work runs on; it outlives whoever created it. */
    readonly context: Context;
    readonly fetch?: typeof fetch;
    readonly operations: HappySessionOperations;
    readonly sessionId: string;
    /** Only a test supplies this; left out, the client opens its own connection to Happy. */
    readonly socketFactory?: (url: string, options: Record<string, unknown>) => HappySocket;
    readonly sync: HappySyncDatabase;
    readonly version: string;
}

const remoteSessionSchema = Type.Object(
    {
        session: Type.Object(
            {
                agentState: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                agentStateVersion: Type.Optional(Type.Number()),
                id: Type.String({ minLength: 1 }),
                metadata: Type.Optional(Type.String()),
                metadataVersion: Type.Number(),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);

const messagePageSchema = Type.Object(
    { hasMore: Type.Optional(Type.Boolean()), messages: Type.Array(Type.Unknown()) },
    { additionalProperties: true },
);

const acknowledgementSchema = Type.Object(
    {
        metadata: Type.Optional(Type.String()),
        result: Type.Optional(Type.String()),
        version: Type.Optional(Type.Number()),
    },
    { additionalProperties: true },
);

const downloadSchema = Type.Object(
    { downloadUrl: Type.String({ minLength: 1 }) },
    { additionalProperties: true },
);

const recordSchema = Type.Record(Type.String(), Type.Unknown());

const rpcRequestSchema = Type.Object(
    { method: Type.String(), params: Type.String() },
    { additionalProperties: true },
);

/**
 * One Happy Agent session as it appears on the phone.
 *
 * Everything Happy knows about a session goes through here: the session is
 * created, its messages are delivered, what the person sends comes back, and
 * what Happy Agent is doing is published as it changes. The loop is deliberately dull —
 * do everything owed, then wait to be told there is more — because that is what
 * makes it safe to interrupt at any point and pick up where it stopped.
 */
export class HappySessionClient {
    readonly #options: HappySessionClientOptions;
    readonly #closeController = new AbortController();
    readonly #completedQuestions = new Map<string, HappyResolvedCommunication>();
    readonly #questionFirstSeen = new Map<string, number>();
    readonly #pendingAttachments = new Map<string, Promise<HappyInboundImage | undefined>>();
    #agentStateVersion: number | undefined;
    #archiving = false;
    #closed = false;
    // A new session is created with no agent state, so nothing is owed until a question arrives.
    #lastAgentState: string | undefined = "null";
    #lastMetadata: string | undefined;
    #metadataBase: Record<string, unknown> = {};
    #metadataVersion: number | undefined;
    #needsAnotherSync = false;
    #retryTimer: NodeJS.Timeout | undefined;
    #sentSessionEnd = false;
    #socket: HappySocket | undefined;
    #started = false;
    #summaryTitle: string | undefined;
    #summaryUpdatedAt = Date.now();
    #syncPromise: Promise<void> | undefined;

    constructor(options: HappySessionClientOptions) {
        this.#options = options;
    }

    /** Begins keeping this session in step with Happy. */
    start(): void {
        if (this.#closed || this.#started) return;
        this.#started = true;
        this.kick();
    }

    /** Says there is something new to send, without waiting for it to be sent. */
    kick(): void {
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

    /** Sends everything owed and waits for it, which is what a test or a shutdown needs. */
    async settle(): Promise<void> {
        this.kick();
        await this.#syncPromise;
    }

    /** Tells Happy the session has ended, and stops. */
    async archive(): Promise<void> {
        if (this.#closed || this.#archiving) return;
        this.#archiving = true;
        this.#clearRetry();
        try {
            await this.settle();
            await this.#sendSessionEnd();
            const remoteSessionId = await this.#remoteSessionId();
            if (remoteSessionId !== undefined) {
                await this.#request(
                    `${this.#options.configuration.serverUrl}/v1/sessions/${encodeURIComponent(remoteSessionId)}/archive`,
                    { method: "POST" },
                );
            }
        } catch (error) {
            // Happy is optional; the session ends in Happy Agent whatever the server says.
            this.#options.context.log.debug("Happy did not accept the archive.", {}, error);
        } finally {
            await this.close();
        }
    }

    /** Stops talking to Happy and releases everything held for it. */
    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#clearRetry();
        await this.#sendSessionEnd().catch(() => undefined);
        this.#closeController.abort();
        this.#socket?.disconnect();
        this.#socket = undefined;
        await this.#syncPromise?.catch(() => undefined);
    }

    async #runSyncLoop(): Promise<void> {
        do {
            this.#needsAnotherSync = false;
            try {
                const state = await this.#ensureRemoteSession();
                if (state?.remoteSessionId === undefined || this.#closed) return;
                this.#ensureSocket(state.remoteSessionId);
                await this.#flushOutbox(state);
                if (!this.#archiving) await this.#fetchIncoming(state);
                const snapshot = await this.#session();
                await this.#syncMetadata(state, snapshot);
                this.#sendKeepAlive(state.remoteSessionId, snapshot);
                await this.#syncAgentState(state);
            } catch (error) {
                this.#options.context.log.debug("Happy synchronization will retry.", {}, error);
                this.#scheduleRetry();
                return;
            }
        } while (this.#needsAnotherSync && !this.#closed);
    }

    async #ensureRemoteSession(): Promise<HappySyncSession | undefined> {
        const ctx = this.#options.context;
        const current = await this.#options.sync.readSession(ctx, this.#options.agentId);
        if (current === undefined) return undefined;
        if (this.#metadataVersion !== undefined && current.remoteSessionId !== undefined) {
            return current;
        }
        const metadata = await this.#metadata();
        const encoded = this.#encode(current, metadata);
        const credentials = this.#options.configuration.credentials;
        const wrappedKey =
            credentials.encryption.type === "dataKey"
                ? Buffer.from(
                      wrapHappyDataKey(
                          decodeKey(current.encryptionKeyBase64),
                          credentials.encryption.publicKey,
                      ),
                  ).toString("base64")
                : null;
        const response = await this.#request(
            `${this.#options.configuration.serverUrl}/v1/sessions`,
            {
                body: JSON.stringify({
                    agentState: null,
                    dataEncryptionKey: wrappedKey,
                    metadata: encoded,
                    tag: current.tag,
                }),
                method: "POST",
            },
        );
        const body: unknown = await response.json();
        if (!Value.Check(remoteSessionSchema, body)) {
            throw new Error("Happy returned a session Happy Agent could not read.");
        }
        const remote = body.session;
        this.#metadataVersion = remote.metadataVersion;
        this.#agentStateVersion = remote.agentStateVersion ?? 0;
        // Creating by tag may answer with a session that already existed. State it
        // already holds must be reconciled rather than assumed to match.
        this.#lastAgentState =
            remote.agentState === undefined || remote.agentState === null ? "null" : undefined;
        if (remote.metadata !== undefined) {
            const decoded = this.#decode(current, remote.metadata);
            if (Value.Check(recordSchema, decoded)) this.#metadataBase = decoded;
        }
        if (remote.metadata === encoded) {
            this.#lastMetadata = JSON.stringify(metadata);
            this.#metadataBase = { ...metadata };
        }
        await ctx.inTx(async (txCtx) => {
            await this.#options.sync.setRemoteSession(
                txCtx,
                this.#options.agentId,
                remote.id,
                Date.now(),
            );
        });
        return await this.#options.sync.readSession(ctx, this.#options.agentId);
    }

    #ensureSocket(remoteSessionId: string): void {
        if (this.#socket !== undefined) return;
        const socket = (this.#options.socketFactory ?? connectHappySocket)(
            this.#options.configuration.serverUrl,
            {
                auth: {
                    clientType: "session-scoped",
                    happyClient: `rig/${this.#options.version}`,
                    sessionId: remoteSessionId,
                    token: this.#options.configuration.credentials.token,
                },
                autoConnect: false,
                path: "/v1/updates",
                reconnection: true,
                transports: ["websocket"],
                withCredentials: true,
            },
        );
        socket.on("connect", () => {
            for (const method of HAPPY_SESSION_RPC_METHODS) {
                socket.emit("rpc-register", { method: `${remoteSessionId}:${method}` });
            }
            this.kick();
        });
        socket.on("update", () => {
            this.kick();
        });
        socket.on("rpc-request", (request: unknown, callback: (response: string) => void) => {
            void this.#handleRpcRequest(remoteSessionId, request, callback);
        });
        this.#socket = socket;
        socket.connect();
    }

    async #flushOutbox(state: HappySyncSession): Promise<void> {
        const remoteSessionId = state.remoteSessionId;
        if (remoteSessionId === undefined) return;
        while (!this.#closed) {
            const pending = await this.#options.sync.pending(
                this.#options.context,
                this.#options.agentId,
                OUTBOX_BATCH,
            );
            if (pending.length === 0) return;
            await this.#request(
                `${this.#options.configuration.serverUrl}/v3/sessions/${encodeURIComponent(remoteSessionId)}/messages`,
                {
                    body: JSON.stringify({
                        messages: pending.map((message) => ({
                            content: this.#encode(state, message.payload),
                            localId: message.localId,
                        })),
                    }),
                    method: "POST",
                },
            );
            await this.#options.context.inTx(async (txCtx) => {
                await this.#options.sync.acknowledge(
                    txCtx,
                    this.#options.agentId,
                    pending.map((message) => message.localId),
                    Date.now(),
                );
            });
        }
    }

    async #fetchIncoming(state: HappySyncSession): Promise<void> {
        const remoteSessionId = state.remoteSessionId;
        if (remoteSessionId === undefined) return;
        let after = state.lastRemoteSeq;
        while (!this.#closed) {
            const url = new URL(
                `${this.#options.configuration.serverUrl}/v3/sessions/${encodeURIComponent(remoteSessionId)}/messages`,
            );
            url.searchParams.set("after_seq", String(after));
            url.searchParams.set("limit", String(INCOMING_PAGE));
            const response = await this.#request(url.toString());
            const body: unknown = await response.json();
            if (!Value.Check(messagePageSchema, body)) {
                throw new Error("Happy returned a message page Happy Agent could not read.");
            }
            const messages = body.messages.filter((message): message is HappyRemoteMessage =>
                Value.Check(happyRemoteMessageSchema, message),
            );
            let highest = after;
            for (const message of messages) {
                const settled = await this.#handleRemoteMessage(state, message);
                highest = Math.max(highest, message.seq);
                if (settled) await this.#advanceRemoteSequence(highest);
            }
            if (body.hasMore !== true || highest === after) return;
            after = highest;
        }
    }

    async #advanceRemoteSequence(seq: number): Promise<void> {
        await this.#options.context.inTx(async (txCtx) => {
            await this.#options.sync.advanceRemoteSequence(
                txCtx,
                this.#options.agentId,
                seq,
                Date.now(),
            );
        });
    }

    /**
     * Delivers one message from the phone, and says whether it may be marked read.
     *
     * An attachment arrives as its own message just before the words that go with
     * it, so an attachment is held rather than delivered, and the position is not
     * advanced until the message that claims it has been delivered too.
     */
    async #handleRemoteMessage(
        state: HappySyncSession,
        message: HappyRemoteMessage,
    ): Promise<boolean> {
        if (this.#archiving) return false;
        const decrypted = this.#decode(state, message.content.c);
        const incoming = readHappyRemoteInput(decrypted);
        if (incoming === undefined || incoming.kind === "echo") {
            return this.#pendingAttachments.size === 0;
        }
        if (incoming.kind === "attachment") {
            if (!this.#pendingAttachments.has(message.id)) {
                this.#pendingAttachments.set(
                    message.id,
                    this.#downloadAttachment(state, incoming).catch(() => undefined),
                );
            }
            return false;
        }
        const attachments = await Promise.all(this.#pendingAttachments.values());
        this.#pendingAttachments.clear();
        const permissionMode = incoming.selection.permissionMode;
        try {
            await this.#options.operations.submit(this.#options.context, this.#options.agentId, {
                images: attachments.filter(
                    (attachment): attachment is HappyInboundImage => attachment !== undefined,
                ),
                remoteMessageId: happyRemoteMessageId(message.id),
                selection: {
                    ...(incoming.selection.effort === undefined
                        ? {}
                        : { effort: incoming.selection.effort }),
                    ...(incoming.selection.modelId === undefined
                        ? {}
                        : { modelId: incoming.selection.modelId }),
                    ...(isAgentPermissionMode(permissionMode) ? { permissionMode } : {}),
                    ...(incoming.selection.providerId === undefined
                        ? {}
                        : { providerId: incoming.selection.providerId }),
                },
                text: incoming.text,
            });
        } catch (error) {
            if (!(error instanceof HappyMessageRefused)) throw error;
            // Nothing about this message will ever work, so saying why is the whole answer.
            // Leaving it unacknowledged would only have Happy redeliver it forever, and every
            // message queued behind it would wait on one this daemon can never take.
            await this.#reportRefusal(message, error.message);
        }
        return true;
    }

    /** Tells the phone, in the conversation, why a message of theirs went nowhere. */
    async #reportRefusal(message: HappyRemoteMessage, text: string): Promise<void> {
        const id = `refused:${message.id}`;
        const payload: HappySessionProtocolMessage = {
            content: { ev: { t: "service", text }, id, role: "agent", time: Date.now() },
            localId: `rig:${id}`,
            meta: { sentFrom: "rig" },
            role: "session",
        };
        await this.#options.context.inTx(async (txCtx) => {
            await this.#options.sync.enqueue(
                txCtx,
                this.#options.agentId,
                [{ localId: payload.localId, payload }],
                Date.now(),
            );
        });
        this.kick();
    }

    async #downloadAttachment(
        state: HappySyncSession,
        attachment: { mimeType?: string; ref: string; size: number },
    ): Promise<HappyInboundImage | undefined> {
        if (attachment.size < 0 || attachment.size > MAX_HAPPY_ATTACHMENT_BYTES) return undefined;
        const remoteSessionId = state.remoteSessionId;
        if (remoteSessionId === undefined) return undefined;
        const response = await this.#request(
            `${this.#options.configuration.serverUrl}/v1/sessions/${encodeURIComponent(remoteSessionId)}/attachments/request-download`,
            { body: JSON.stringify({ ref: attachment.ref }), method: "POST" },
        );
        const body: unknown = await response.json();
        if (!Value.Check(downloadSchema, body)) return undefined;
        const sameServer =
            new URL(body.downloadUrl).origin ===
            new URL(this.#options.configuration.serverUrl).origin;
        const download = await (this.#options.fetch ?? fetch)(body.downloadUrl, {
            ...(sameServer
                ? {
                      headers: {
                          Authorization: `Bearer ${this.#options.configuration.credentials.token}`,
                      },
                  }
                : {}),
            signal: this.#signal(),
        });
        if (!download.ok) return undefined;
        const encrypted = new Uint8Array(await download.arrayBuffer());
        if (encrypted.length > MAX_HAPPY_ATTACHMENT_BYTES + 64) return undefined;
        const decrypted = decryptHappyBlob({
            bundle: encrypted,
            encryptionKey: decodeKey(state.encryptionKeyBase64),
            encryptionVariant: state.encryptionVariant,
        });
        if (decrypted === undefined || decrypted.length > MAX_HAPPY_ATTACHMENT_BYTES) {
            return undefined;
        }
        const mimeType = attachment.mimeType ?? "image/jpeg";
        // Happy Agent can put a picture in front of a model; it cannot do that with a spreadsheet.
        if (!mimeType.startsWith("image/")) return undefined;
        return { data: Buffer.from(decrypted).toString("base64"), mimeType };
    }

    async #handleRpcRequest(
        remoteSessionId: string,
        request: unknown,
        callback: (response: string) => void,
    ): Promise<void> {
        const state = await this.#options.sync.readSession(
            this.#options.context,
            this.#options.agentId,
        );
        if (state === undefined) {
            callback("");
            return;
        }
        let answer: unknown;
        try {
            if (this.#archiving) {
                answer = { error: "This session has ended." };
            } else if (!Value.Check(rpcRequestSchema, request)) {
                answer = { error: "Invalid request" };
            } else {
                const prefix = `${remoteSessionId}:`;
                const params = this.#decode(state, request.params);
                answer = request.method.startsWith(prefix)
                    ? await handleHappySessionRpc({
                          abort: () =>
                              this.#options.operations.abort(
                                  this.#options.context,
                                  this.#options.agentId,
                              ),
                          answerQuestion: (requestId, answers) =>
                              this.#answerQuestion(requestId, answers),
                          archive: () =>
                              this.#options.operations.archiveSession(
                                  this.#options.context,
                                  this.#options.sessionId,
                              ),
                          cancelQuestion: (requestId) => this.#cancelQuestion(requestId),
                          method: request.method.slice(prefix.length),
                          params,
                      })
                    : { error: "Invalid request" };
            }
        } catch (error) {
            answer = { error: error instanceof Error ? error.message : "The request failed." };
        }
        callback(this.#encode(state, answer));
    }

    /**
     * Records an answer that came from the phone.
     *
     * The host validates the answer and refuses a malformed one, so the question
     * is remembered as settled only once it has actually been accepted. A refusal
     * goes back to the phone with the prompt still on screen.
     */
    async #answerQuestion(requestId: string, answers: Record<string, unknown>): Promise<void> {
        const request = await this.#pendingQuestion(requestId);
        if (request === undefined) return;
        const createdAt = this.#firstSeen(requestId);
        await this.#options.operations.answerQuestion(
            this.#options.context,
            this.#options.agentId,
            requestId,
            answers,
        );
        rememberHappyResolvedCommunication(this.#completedQuestions, requestId, {
            // Echoed back so every phone shows the same answer, including one
            // that is only now catching up with it.
            answers,
            communication: toHappyCommunication(request, createdAt),
            completedAt: Date.now(),
            status: "answered",
        });
        this.#questionFirstSeen.delete(requestId);
        this.kick();
    }

    async #cancelQuestion(requestId: string): Promise<void> {
        const request = await this.#pendingQuestion(requestId);
        if (request === undefined) return;
        const createdAt = this.#firstSeen(requestId);
        await this.#options.operations.cancelQuestion(
            this.#options.context,
            this.#options.agentId,
            requestId,
        );
        rememberHappyResolvedCommunication(this.#completedQuestions, requestId, {
            communication: toHappyCommunication(request, createdAt),
            completedAt: Date.now(),
            status: "cancelled",
        });
        this.#questionFirstSeen.delete(requestId);
        this.kick();
    }

    async #pendingQuestion(requestId: string): Promise<UserInputRequest | undefined> {
        const pending = await this.#options.operations.pendingQuestions(
            this.#options.context,
            this.#options.agentId,
        );
        return pending.find((request) => request.id === requestId);
    }

    async #syncMetadata(state: HappySyncSession, snapshot: HappySessionSnapshot): Promise<void> {
        if (this.#socket?.connected === false || this.#metadataVersion === undefined) return;
        const rigMetadata = this.#metadataFor(snapshot);
        // `activity` is dropped rather than merged forward: an older Happy Agent wrote a shape the
        // phone reserves for its own counters, and one key of the wrong shape fails the phone's
        // whole metadata parse.
        const base = { ...this.#metadataBase };
        delete base.activity;
        delete base.lastUserOrAgentTextMessageAt;
        let metadata: Record<string, unknown> = { ...base, ...rigMetadata };
        if (rigMetadata.git === undefined) delete metadata.git;
        if (rigMetadata.lastMeaningfulMessageAt === undefined) {
            delete metadata.lastMeaningfulMessageAt;
        }
        let serialized = JSON.stringify(metadata);
        if (serialized === this.#lastMetadata) return;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const answer = await this.#emitWithAck("update-metadata", {
                expectedVersion: this.#metadataVersion,
                metadata: this.#encode(state, metadata),
                sid: state.remoteSessionId,
            });
            if (!Value.Check(acknowledgementSchema, answer)) {
                throw new Error("Happy returned a metadata answer Happy Agent could not read.");
            }
            if (answer.result === "success" && answer.version !== undefined) {
                this.#metadataVersion = answer.version;
                this.#lastMetadata = serialized;
                this.#metadataBase = metadata;
                return;
            }
            // Somebody else wrote first. Take their version, put Happy Agent's own facts
            // back on top of it, and try again.
            if (answer.result === "version-mismatch" && answer.version !== undefined) {
                if (answer.metadata === undefined) {
                    throw new Error("Happy reported a metadata conflict without the metadata.");
                }
                const latest = this.#decode(state, answer.metadata);
                if (!Value.Check(recordSchema, latest)) {
                    throw new Error("Happy returned metadata Happy Agent could not read.");
                }
                this.#metadataVersion = answer.version;
                this.#metadataBase = latest;
                metadata = composeSessionMetadata(latest, rigMetadata);
                serialized = JSON.stringify(metadata);
                continue;
            }
            throw new Error("Happy refused the metadata update.");
        }
        throw new Error("Happy metadata kept changing underneath Happy Agent.");
    }

    /**
     * Publishes what this session is waiting to be told.
     *
     * Without this, a session that asks a question simply stops with nothing on
     * the phone to explain why.
     */
    async #syncAgentState(state: HappySyncSession): Promise<void> {
        if (this.#socket?.connected === false || this.#agentStateVersion === undefined) return;
        const pending = await this.#options.operations.pendingQuestions(
            this.#options.context,
            this.#options.agentId,
        );
        const pendingIds = new Set(pending.map((request) => request.id));
        for (const requestId of this.#questionFirstSeen.keys()) {
            if (!pendingIds.has(requestId)) this.#questionFirstSeen.delete(requestId);
        }
        const agentState = createHappyAgentState({
            completed: this.#completedQuestions,
            createdAt: (requestId) => this.#firstSeen(requestId),
            pending,
        });
        const serialized = JSON.stringify(agentState);
        if (serialized === this.#lastAgentState) return;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const answer = await this.#emitWithAck("update-state", {
                agentState: agentState === null ? null : this.#encode(state, agentState),
                expectedVersion: this.#agentStateVersion,
                sid: state.remoteSessionId,
            });
            if (!Value.Check(acknowledgementSchema, answer)) {
                throw new Error("Happy returned an agent state answer Happy Agent could not read.");
            }
            if (answer.result === "success" && answer.version !== undefined) {
                this.#agentStateVersion = answer.version;
                this.#lastAgentState = serialized;
                return;
            }
            // Happy owns the version, not the contents: Happy Agent is the only writer
            // of question state, so take the version and publish again.
            if (answer.result === "version-mismatch" && answer.version !== undefined) {
                this.#agentStateVersion = answer.version;
                continue;
            }
            throw new Error("Happy refused the agent state update.");
        }
        throw new Error("Happy agent state kept changing underneath Happy Agent.");
    }

    /** When a question was first published, held still so it does not republish forever. */
    #firstSeen(requestId: string): number {
        const existing = this.#questionFirstSeen.get(requestId);
        if (existing !== undefined) return existing;
        const now = Date.now();
        this.#questionFirstSeen.set(requestId, now);
        return now;
    }

    #sendKeepAlive(remoteSessionId: string, snapshot: HappySessionSnapshot): void {
        if (this.#archiving) return;
        this.#socket?.emit("session-alive", {
            sid: remoteSessionId,
            thinking: snapshot.working,
            time: Date.now(),
        });
    }

    async #sendSessionEnd(): Promise<void> {
        if (this.#sentSessionEnd || this.#socket === undefined) return;
        const remoteSessionId = await this.#remoteSessionId();
        if (remoteSessionId === undefined) return;
        this.#sentSessionEnd = true;
        this.#socket.emit("session-end", { sid: remoteSessionId, time: Date.now() });
    }

    async #remoteSessionId(): Promise<string | undefined> {
        const state = await this.#options.sync.readSession(
            this.#options.context,
            this.#options.agentId,
        );
        return state?.remoteSessionId;
    }

    async #metadata(): Promise<Record<string, unknown>> {
        return this.#metadataFor(await this.#session());
    }

    #metadataFor(session: HappySessionSnapshot): Record<string, unknown> {
        if (session.title !== this.#summaryTitle) {
            this.#summaryTitle = session.title;
            this.#summaryUpdatedAt = Date.now();
        }
        return {
            ...createHappySessionMetadata({
                configuration: this.#options.configuration,
                models: this.#options.operations.models(),
                session,
                summaryUpdatedAt: this.#summaryUpdatedAt,
                version: this.#options.version,
            }),
            ...(this.#archiving
                ? {
                      archiveReason: "The session was ended in Happy Agent.",
                      archivedBy: "rig",
                      lifecycleState: "archived",
                      lifecycleStateSince: Date.now(),
                  }
                : {}),
        } as Record<string, unknown>;
    }

    async #session(): Promise<HappySessionSnapshot> {
        const session = await this.#options.operations.session(
            this.#options.context,
            this.#options.agentId,
        );
        if (session === undefined) throw new Error("The session Happy is publishing has gone.");
        return session;
    }

    #emitWithAck(event: string, value: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const socket = this.#socket;
            if (socket === undefined) {
                reject(new Error("Happy is not connected."));
                return;
            }
            const finish = (settle: () => void) => {
                clearTimeout(timer);
                this.#closeController.signal.removeEventListener("abort", onAbort);
                settle();
            };
            const onAbort = () => finish(() => reject(new Error("Happy synchronization stopped.")));
            const timer = setTimeout(
                () => finish(() => reject(new Error("Happy did not answer in time."))),
                HTTP_TIMEOUT_MS,
            );
            timer.unref();
            this.#closeController.signal.addEventListener("abort", onAbort, { once: true });
            socket.emit(event, value, (answer: unknown) => finish(() => resolve(answer)));
        });
    }

    async #request(url: string, init: RequestInit = {}): Promise<Response> {
        const response = await (this.#options.fetch ?? fetch)(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.#options.configuration.credentials.token}`,
                "Content-Type": "application/json",
                "X-Happy-Client": `rig/${this.#options.version}`,
                ...init.headers,
            },
            signal: this.#signal(),
        });
        if (!response.ok) throw new Error(`Happy answered with HTTP ${String(response.status)}.`);
        return response;
    }

    #signal(): AbortSignal {
        return AbortSignal.any([
            AbortSignal.timeout(HTTP_TIMEOUT_MS),
            this.#closeController.signal,
        ]);
    }

    #encode(state: HappySyncSession, value: unknown): string {
        return Buffer.from(
            encryptHappyPayload(
                decodeKey(state.encryptionKeyBase64),
                state.encryptionVariant,
                value,
            ),
        ).toString("base64");
    }

    #decode(state: HappySyncSession, value: string): unknown {
        return decryptHappyPayload(
            decodeKey(state.encryptionKeyBase64),
            state.encryptionVariant,
            new Uint8Array(Buffer.from(value, "base64")),
        );
    }

    #scheduleRetry(): void {
        if (this.#closed || this.#archiving || this.#retryTimer !== undefined) return;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            this.kick();
        }, RETRY_DELAY_MS);
        this.#retryTimer.unref();
    }

    #clearRetry(): void {
        if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
        this.#retryTimer = undefined;
    }
}

function decodeKey(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * Puts this daemon's facts on top of whatever else the session metadata carries.
 *
 * `activity` is dropped rather than kept, because an older Happy Agent wrote a shape the phone
 * reserves for its own counters, and one key of the wrong shape fails the phone's whole metadata
 * parse. `git` and `lastMeaningfulMessageAt` are also daemon-owned: keeping older values when local
 * history and user input have none would make an empty session sort as though it still had that
 * activity, or show a diff the checkout no longer has. The immediately superseded field name is
 * removed instead of leaking into metadata.
 */
function composeSessionMetadata(
    base: Record<string, unknown>,
    rigMetadata: Record<string, unknown>,
): Record<string, unknown> {
    const kept = { ...base };
    delete kept.activity;
    delete kept.lastUserOrAgentTextMessageAt;
    const composed = { ...kept, ...rigMetadata };
    if (rigMetadata.git === undefined) delete composed.git;
    if (rigMetadata.lastMeaningfulMessageAt === undefined) {
        delete composed.lastMeaningfulMessageAt;
    }
    return composed;
}
