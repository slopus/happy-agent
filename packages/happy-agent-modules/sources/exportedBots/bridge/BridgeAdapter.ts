import { Value } from "@sinclair/typebox/value";
import { delay, isAbortedError, type Context } from "@steve.kite/stdlib";

import type {
    ExportedBotAdapter,
    ExportedBotConnection,
    ExportedBotEndpoint,
    ExportedBotListener,
    ExportedBotRecipient,
    ExportedBotReply,
    ExportedBotSocket,
    ExportedBotSocketBinding,
} from "../ExportedBotAdapter.js";
import {
    deleteOutbox,
    deleteOutboxReply,
    insertOutboxReply,
    queryOutboxReplies,
} from "../ExportedBotStore.js";
import type { ExportedBotsModule } from "../ExportedBotsModule.js";
import {
    ackFrameSchema,
    CLOSE_CHANGED,
    CLOSE_REPLACED,
    CLOSE_UNAVAILABLE,
    BRIDGE_PROTOCOL_VERSION,
    BRIDGE_PROTOCOLS,
    frameSchema,
    MAX_UNANSWERED_MESSAGES,
    MAX_WAITING_REPLIES,
    messageFrameSchema,
    PING_INTERVAL_MS,
} from "./BridgeProtocol.js";
import {
    BRIDGE_KIND,
    bridgeSettingsSchema,
    bridgeTokenAccount,
    bridgeTokenMatches,
    type BridgeSettings,
} from "./BridgeSettings.js";
import { setBridgeExportedBotTool } from "./set_bridge_exported_bot.js";
import { requireDurableCommit } from "../../impl/durableCommit.js";

/** A bridge falling this far behind waits before it is sent more. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Replies read from storage at a time while catching a bridge up. */
const REPLAY_PAGE = 50;

/** One bridge export that is running, with the bridge connected to it, if any. */
interface Session {
    readonly connection: ExportedBotConnection<BridgeSettings>;
    readonly ctx: Context;
    bridge: Bridge | undefined;
}

/**
 * An export served by a bridge: a program of the user's that talks to some chat service and
 * connects to Happy over one WebSocket. The daemon never reaches out; it waits for the bridge,
 * takes in its messages, and keeps every reply until the bridge confirms it, so a bridge that was
 * away loses nothing. The protocol is specified in `docs/exported-bot-protocol.md`.
 */
export class BridgeAdapter implements ExportedBotAdapter<BridgeSettings> {
    readonly kind = BRIDGE_KIND;
    readonly settingsSchema = bridgeSettingsSchema;
    readonly formattingInstructions =
        "The bridge decides how the reply is shown. Write plain conversational text, and use Markdown only where the content needs it.";
    readonly typing = {
        intervalMs: 4_000,
        show: async (
            _ctx: Context,
            endpoint: ExportedBotEndpoint<BridgeSettings>,
            to: ExportedBotRecipient,
        ): Promise<void> => {
            this.#sessions
                .get(endpoint.account)
                ?.bridge?.send({ type: "typing", userId: to.userId, chatId: to.chatId });
        },
    };
    readonly listener: ExportedBotListener<BridgeSettings> = {
        protocols: BRIDGE_PROTOCOLS,
        accountOf: (token) => bridgeTokenAccount(token),
        authenticate: (settings, token) => bridgeTokenMatches(settings, token),
        attach: (account, socket) => this.#attach(account, socket),
    };

    /** Running exports, by account. */
    readonly #sessions = new Map<string, Session>();

    names(settings: BridgeSettings) {
        return { service: settings.service, account: `${settings.service} bridge` };
    }

    /** A bridge's user IDs mean something only to that bridge, so its guests are its own. */
    guestScope(account: string): string {
        return account;
    }

    /** Wait for the bridge until the export stops, then close whatever bridge is attached. */
    async run(ctx: Context, connection: ExportedBotConnection<BridgeSettings>): Promise<void> {
        const session: Session = { connection, ctx, bridge: undefined };
        this.#sessions.set(connection.account, session);
        connection.waiting();
        try {
            await new Promise<void>((resolve) => {
                if (ctx.lifetime === undefined || ctx.lifetime.aborted) {
                    resolve();
                    return;
                }
                ctx.lifetime.addEventListener("abort", () => resolve(), { once: true });
            });
        } finally {
            if (this.#sessions.get(connection.account) === session) {
                this.#sessions.delete(connection.account);
            }
            const reason = connection.stopReason;
            session.bridge?.close(
                reason === "changed"
                    ? CLOSE_CHANGED
                    : reason === "unavailable"
                      ? CLOSE_UNAVAILABLE
                      : 1001,
                reason === "changed"
                    ? "The export was changed or removed."
                    : reason === "unavailable"
                      ? "The export was turned off or its bot archived."
                      : "Happy Agent is stopping.",
            );
        }
    }

    /** A reply is one piece: the bridge cuts it however its service needs. */
    split(reply: ExportedBotReply): readonly ExportedBotReply[] {
        return [reply];
    }

    /**
     * Keep the reply until the bridge confirms it, then offer it to the bridge if one is
     * connected. The key makes keeping it again after an interruption change nothing.
     */
    async send(
        ctx: Context,
        endpoint: ExportedBotEndpoint<BridgeSettings>,
        to: ExportedBotRecipient,
        piece: ExportedBotReply,
        key: string,
    ): Promise<void> {
        await ctx.inTx(async (txCtx) => {
            await insertOutboxReply(
                txCtx,
                {
                    kind: this.kind,
                    account: endpoint.account,
                    key,
                    userId: to.userId,
                    chatId: to.chatId,
                    payload: {
                        ...(piece.text === undefined ? {} : { text: piece.text }),
                        ...(piece.attachments === undefined
                            ? {}
                            : { attachments: [...piece.attachments] }),
                    },
                },
                MAX_WAITING_REPLIES,
            );
            // The bridge numbers what it delivers; a reply lost after delivery would let its
            // sequence be reused for another.
            await requireDurableCommit(txCtx);
        });
        this.#sessions.get(endpoint.account)?.bridge?.flush();
    }

    /** A removed export's waiting replies go with it. */
    async forget(ctx: Context, account: string): Promise<void> {
        await deleteOutbox(ctx, this.kind, account);
    }

    tools(exportedBots: ExportedBotsModule, actingAgentId: string) {
        return [setBridgeExportedBotTool(exportedBots, actingAgentId)];
    }

    #attach(account: string, socket: ExportedBotSocket): ExportedBotSocketBinding {
        const session = this.#sessions.get(account);
        if (session === undefined) {
            socket.close(CLOSE_UNAVAILABLE, "The export was turned off or its bot archived.");
            return { message: () => undefined, pong: () => undefined, closed: () => undefined };
        }
        session.bridge?.close(
            CLOSE_REPLACED,
            "Another connection with this token replaced this one.",
        );
        const bridge = new Bridge(this.kind, session, socket, () => {
            if (session.bridge === bridge) {
                session.bridge = undefined;
                session.connection.waiting();
            }
        });
        session.bridge = bridge;
        bridge.start();
        return bridge.binding;
    }
}

/**
 * One connected bridge. Messages are taken in one at a time, in the order they arrived, and each
 * gets exactly one answer; replies are sent in sequence order, from the oldest one the bridge has
 * not confirmed.
 */
class Bridge {
    readonly binding: ExportedBotSocketBinding;
    readonly #kind: string;
    readonly #session: Session;
    readonly #socket: ExportedBotSocket;
    readonly #onClosed: () => void;
    #closed = false;
    #alive = true;
    #pinger: ReturnType<typeof setInterval> | undefined;
    #lastSent = 0;
    #unanswered = 0;
    /** Inbound messages, taken in strictly one after another. */
    #inbound: Promise<void> = Promise.resolve();
    /** Reply sending, one pass at a time. */
    #outbound: Promise<void> = Promise.resolve();
    #flushAgain = false;

    constructor(kind: string, session: Session, socket: ExportedBotSocket, onClosed: () => void) {
        this.#kind = kind;
        this.#session = session;
        this.#socket = socket;
        this.#onClosed = onClosed;
        this.binding = {
            message: (text) => this.#message(text),
            pong: () => {
                this.#alive = true;
            },
            closed: () => this.#ended(),
        };
    }

    /** Say hello, then catch the bridge up on every reply it has not confirmed. */
    start(): void {
        const { connection, ctx } = this.#session;
        this.#inbound = (async () => {
            const name = await connection.botName(ctx);
            this.send({
                type: "hello",
                protocol: BRIDGE_PROTOCOL_VERSION,
                bot: { id: connection.botId, name },
            });
            connection.connected();
            this.flush();
        })().catch((error: unknown) => this.#failed(error));
        this.#pinger = setInterval(() => {
            if (!this.#alive) {
                this.#socket.terminate();
                return;
            }
            this.#alive = false;
            this.#socket.ping();
        }, PING_INTERVAL_MS);
        this.#pinger.unref?.();
    }

    send(frame: Readonly<Record<string, unknown>>): void {
        if (this.#closed) return;
        this.#socket.send(JSON.stringify(frame));
    }

    close(code: number, reason: string): void {
        if (this.#closed) return;
        this.#socket.close(code, reason);
        this.#ended();
    }

    /** Send every reply after the last one sent, until none is left. */
    flush(): void {
        if (this.#closed) return;
        this.#flushAgain = true;
        this.#outbound = this.#outbound.then(async () => {
            while (this.#flushAgain && !this.#closed) {
                this.#flushAgain = false;
                await this.#sendWaiting();
            }
        });
        this.#outbound.catch((error: unknown) => this.#failed(error));
    }

    async #sendWaiting(): Promise<void> {
        const { connection, ctx } = this.#session;
        for (;;) {
            const replies = await queryOutboxReplies(
                ctx,
                this.#kind,
                connection.account,
                this.#lastSent,
                REPLAY_PAGE,
            );
            if (replies.length === 0) return;
            for (const reply of replies) {
                while (this.#socket.bufferedAmount > MAX_BUFFERED_BYTES && !this.#closed) {
                    await delay(ctx, 250);
                }
                if (this.#closed) return;
                this.send({
                    type: "reply",
                    seq: reply.seq,
                    userId: reply.userId,
                    chatId: reply.chatId,
                    ...(reply.payload.text === undefined ? {} : { text: reply.payload.text }),
                    ...(reply.payload.attachments === undefined
                        ? {}
                        : {
                              attachments: reply.payload.attachments.map((attachment) => ({
                                  path: attachment.path,
                                  mimeType: attachment.mimeType,
                                  name: attachment.name,
                                  size: attachment.size,
                              })),
                          }),
                });
                this.#lastSent = reply.seq;
            }
        }
    }

    #message(text: string | undefined): void {
        if (this.#closed) return;
        if (text === undefined) {
            this.close(1003, "Binary frames are not part of this protocol.");
            return;
        }
        let frame: unknown;
        try {
            frame = JSON.parse(text);
        } catch {
            frame = undefined;
        }
        if (!Value.Check(frameSchema, frame)) {
            this.close(1007, "Every frame is a JSON object with a string type.");
            return;
        }
        if (frame.type === "ack") {
            if (!Value.Check(ackFrameSchema, frame)) return;
            const { connection, ctx } = this.#session;
            void deleteOutboxReply(ctx, this.#kind, connection.account, frame.seq).catch(
                (error: unknown) => this.#failed(error),
            );
            return;
        }
        if (frame.type !== "message") return;
        if (this.#unanswered >= MAX_UNANSWERED_MESSAGES) {
            this.close(1008, "Too many messages are waiting for an answer.");
            return;
        }
        this.#unanswered += 1;
        this.#inbound = this.#inbound
            .then(async () => await this.#take(frame))
            .catch((error: unknown) => this.#failed(error))
            .finally(() => {
                this.#unanswered -= 1;
            });
    }

    /** Take in one message and answer it with an `ack` or a `reject`. */
    async #take(frame: unknown): Promise<void> {
        if (this.#closed) return;
        const id =
            typeof frame === "object" &&
            frame !== null &&
            typeof (frame as { id?: unknown }).id === "string"
                ? (frame as { id: string }).id.slice(0, 256)
                : undefined;
        if (!Value.Check(messageFrameSchema, frame)) {
            this.send({
                type: "reject",
                ...(id === undefined ? {} : { id }),
                reason: "The message is invalid.",
            });
            return;
        }
        const attachments = frame.attachments ?? [];
        const text = frame.text ?? "";
        if (text.trim().length === 0 && attachments.length === 0) {
            this.send({
                type: "reject",
                id: frame.id,
                reason: "The message has no text and no attachments.",
            });
            return;
        }
        const { connection, ctx } = this.#session;
        const outcome = await connection.receive(ctx, {
            message: {
                id: frame.id,
                chatId: frame.chatId,
                direct: true,
                sender: {
                    id: frame.userId,
                    ...(frame.name === undefined ? {} : { name: frame.name }),
                    ...(frame.username === undefined ? {} : { username: frame.username }),
                    isBot: false,
                },
                text,
                ...(attachments.length === 0
                    ? {}
                    : {
                          attachments: attachments.map((attachment) => ({
                              path: attachment.path,
                              ...(attachment.mimeType === undefined
                                  ? {}
                                  : { mimeType: attachment.mimeType }),
                              ...(attachment.name === undefined ? {} : { name: attachment.name }),
                          })),
                      }),
            },
        });
        this.send(
            outcome.rejected === undefined
                ? { type: "ack", id: frame.id }
                : { type: "reject", id: frame.id, reason: outcome.rejected },
        );
    }

    #failed(error: unknown): void {
        if (this.#closed || isAbortedError(error)) return;
        this.#session.ctx.log.warn(
            "A bridge connection failed and was closed.",
            { botId: this.#session.connection.botId, kind: this.#kind },
            error,
        );
        this.close(1011, "Happy Agent could not handle the connection.");
    }

    #ended(): void {
        if (this.#closed) return;
        this.#closed = true;
        if (this.#pinger !== undefined) clearInterval(this.#pinger);
        this.#onClosed();
    }
}
