import { Value } from "@sinclair/typebox/value";
import { createWebSocketStream, WebSocket } from "ws";
import { ackSchema, helloSchema, rejectSchema, replySchema } from "./contracts.js";
import type { GuestStore } from "./persistence/GuestStore.js";

/** Text-only adapter for protocol 1. The bridge credential never crosses the HTTP boundary. */
export class ExportedBotBridge {
    online = false;
    private socket: WebSocket | undefined;
    private retry: ReturnType<typeof setTimeout> | undefined;
    private delay = 1_000;
    private stopped = false;
    private readonly inFlight = new Set<string>();
    private draining = false;
    private again = false;
    private receiveTail: Promise<void> = Promise.resolve();

    constructor(
        private readonly options: {
            connectUrl: string;
            token: string;
            botId: string;
            store: GuestStore;
            changed: () => void;
            fatal: (error: Error) => void;
        },
    ) {}

    start(): void {
        if (this.stopped) return;
        const socket = new WebSocket(this.options.connectUrl, {
            headers: { authorization: `Bearer ${this.options.token}` },
            maxPayload: 1_048_576,
        });
        this.socket = socket;
        socket.on("unexpected-response", (_request, response) => {
            response.resume();
            if (response.statusCode !== 503) {
                this.stopped = true;
                this.options.fatal(
                    new Error(
                        "The exported bot refused its bridge credential or protocol. Check the private bridge configuration.",
                    ),
                );
            }
            socket.terminate();
        });
        // The stream pauses the socket when its one-message buffer fills. This lets a full
        // daemon outbox replay without an unbounded promise queue or reconnecting every burst.
        const stream = createWebSocketStream(socket, {
            readableObjectMode: true,
            highWaterMark: 1,
        });
        this.receiveTail = (async () => {
            for await (const data of stream) {
                if (socket !== this.socket || this.stopped) break;
                const frame: unknown = JSON.parse(String(data));
                if (Value.Check(helloSchema, frame)) {
                    if (frame.bot.id !== this.options.botId)
                        throw new Error("The bridge is connected to the wrong bot.");
                    this.online = true;
                    this.delay = 1_000;
                    this.options.changed();
                    await this.flush();
                } else if (Value.Check(replySchema, frame)) {
                    await this.options.store.reply(this.options.botId, frame);
                    if (socket.readyState === WebSocket.OPEN)
                        socket.send(JSON.stringify({ type: "ack", seq: frame.seq }));
                    this.options.changed();
                } else if (Value.Check(ackSchema, frame)) {
                    await this.options.store.acknowledge(frame.id);
                    this.inFlight.delete(frame.id);
                    await this.flush();
                } else if (Value.Check(rejectSchema, frame)) {
                    // A reject is terminal. Never expose daemon diagnostics or paths to a guest.
                    if (frame.id !== undefined) {
                        await this.options.store.reject(frame.id);
                        this.inFlight.delete(frame.id);
                        this.options.changed();
                    }
                    await this.flush();
                }
            }
        })().catch(() => {
            if (this.stopped || socket !== this.socket || socket.readyState !== WebSocket.OPEN)
                return;
            socket.terminate();
            this.options.fatal(
                new Error("The invitation bridge could not safely process a bot response."),
            );
        });
        socket.on("error", () => {});
        socket.on("close", (code) => {
            this.online = false;
            this.inFlight.clear();
            this.options.changed();
            if (code === 4000) {
                this.stopped = true;
                this.options.fatal(
                    new Error(
                        "Another bridge owns this export. Use a dedicated export for invitations.",
                    ),
                );
            }
            if (this.stopped) return;
            this.retry = setTimeout(() => this.start(), code === 4001 ? 0 : this.delay);
            this.delay = Math.min(this.delay * 2, 60_000);
        });
    }

    async flush(): Promise<void> {
        if (this.draining) {
            this.again = true;
            return;
        }
        this.draining = true;
        try {
            do {
                this.again = false;
                const socket = this.socket;
                if (!this.online || socket?.readyState !== WebSocket.OPEN) return;
                const pending = await this.options.store.pending(this.options.botId);
                for (const message of pending) {
                    if (this.inFlight.size >= 32 || this.inFlight.has(message.id)) continue;
                    // Recheck persisted authorization immediately before handing work to the daemon.
                    if (
                        !this.online ||
                        socket !== this.socket ||
                        socket.readyState !== WebSocket.OPEN
                    )
                        return;
                    this.inFlight.add(message.id);
                    socket.send(
                        JSON.stringify({
                            type: "message",
                            id: message.id,
                            userId: message.userId,
                            chatId: message.userId,
                            name: message.name,
                            text: message.text,
                        }),
                    );
                }
            } while (this.again);
        } finally {
            this.draining = false;
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        clearTimeout(this.retry);
        this.online = false;
        this.socket?.terminate();
        await this.receiveTail;
    }
}
