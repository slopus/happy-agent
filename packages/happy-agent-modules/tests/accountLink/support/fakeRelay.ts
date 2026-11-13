import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer, type RawData } from "ws";

const REQ_BODY = 1;
const RES_BODY = 2;
const RES_FULL = 3;
const WS_TEXT = 4;
const WS_BINARY = 5;

type HeaderPairs = [string, string][];

export interface RelayResponse {
    readonly body: Buffer;
    readonly headers: HeaderPairs;
    readonly status: number;
    /** `aborted` when the computer cut the exchange instead of ending it. */
    readonly outcome: "ended" | "aborted";
}

export interface RelayExchange {
    readonly id: number;
    /** Resolves with the response head as soon as the computer sends it. */
    readonly head: Promise<{ status: number; headers: HeaderPairs }>;
    readonly done: Promise<RelayResponse>;
    received(): Buffer;
    /** The client went away. */
    abort(): void;
}

export interface RelayStream {
    readonly id: number;
    /** `accept`, or the ordinary response the computer refused the upgrade with. */
    readonly opened: Promise<
        { accepted: true; protocol?: string } | { accepted: false; response: RelayResponse }
    >;
    readonly messages: (string | Buffer)[];
    readonly closed: Promise<{ code: number; reason: string }>;
    send(message: string | Buffer): void;
    close(code: number, reason?: string): void;
}

interface Attachment {
    readonly authorization: string | undefined;
    readonly socket: WebSocket;
    pings: number;
}

/**
 * The relay's side of relay/PROTOCOL.md version 1, written from the spec: attach, `hello`, one
 * exchange per client request, per-frame credit, and the same closes the relay makes. It also
 * enforces the response body window, as the relay does by closing with 4002.
 */
export class FakeRelay {
    readonly attachments: Attachment[] = [];
    readonly closes: { code: number }[] = [];
    readonly #exchanges = new Map<number, (kind: string, payload: unknown) => void>();
    #nextId = 1;
    #server!: Server;
    #sockets!: WebSocketServer;
    /** Answer the next attaches with this HTTP status instead of upgrading. */
    refuseAttachWith: number | undefined;
    answerPings = true;
    autoCredit = true;
    window = 1_048_576;
    version = 1;
    /** Set when the computer sent more response body than its window allowed. */
    overrun = false;

    static async start(port = 0): Promise<FakeRelay> {
        const relay = new FakeRelay();
        relay.#server = createServer((_request, response) => {
            response.writeHead(404);
            response.end();
        });
        relay.#sockets = new WebSocketServer({ autoPong: false, noServer: true });
        relay.#server.on("upgrade", (request, socket, head) => {
            if (relay.refuseAttachWith !== undefined) {
                socket.end(
                    `HTTP/1.1 ${String(relay.refuseAttachWith)} Refused\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`,
                );
                relay.attachments.push({
                    authorization: request.headers.authorization,
                    pings: 0,
                    socket: undefined as never,
                });
                return;
            }
            relay.#sockets.handleUpgrade(request, socket, head, (webSocket) => {
                const eid = /^\/e\/([^/]+)\/attach$/u.exec(request.url ?? "")?.[1] ?? "";
                relay.#attach(webSocket, eid, request.headers.authorization);
            });
        });
        await new Promise<void>((resolve) => relay.#server.listen(port, "127.0.0.1", resolve));
        return relay;
    }

    get url(): string {
        return `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}`;
    }

    get current(): Attachment | undefined {
        const last = this.attachments.at(-1);
        return last?.socket?.readyState === WebSocket.OPEN ? last : undefined;
    }

    async close(): Promise<void> {
        for (const attachment of this.attachments) attachment.socket?.terminate();
        this.#server.closeAllConnections();
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }

    async waitForAttach(count = 1, timeoutMs = 10_000): Promise<Attachment> {
        const deadline = Date.now() + timeoutMs;
        while (this.attachments.length < count || this.current === undefined) {
            if (Date.now() > deadline) throw new Error("The computer did not attach.");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return this.current;
    }

    async waitForDetach(timeoutMs = 10_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (this.current !== undefined) {
            if (Date.now() > deadline) throw new Error("The computer stayed attached.");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    /** Another computer attached as the same endpoint: the relay closes this one with 4000. */
    replace(): void {
        this.current?.socket.close(4000, "replaced");
    }

    drop(): void {
        this.current?.socket.terminate();
    }

    /** Stop or resume reading from the computer, as a stalled client behind the relay would. */
    stall(stalled: boolean): void {
        const transport = (
            this.#requireSocket() as unknown as { _socket: { pause(): void; resume(): void } }
        )._socket;
        if (stalled) transport.pause();
        else transport.resume();
    }

    /** One client HTTP request, forwarded as the relay forwards it. */
    request(request: {
        readonly method?: string;
        readonly path: string;
        readonly headers?: HeaderPairs;
        readonly body?: Buffer;
    }): RelayExchange {
        const socket = this.#requireSocket();
        const id = this.#nextId++;
        const chunks: Buffer[] = [];
        let credit = this.window;
        let status = 0;
        let headers: HeaderPairs = [];
        let resolveHead!: (head: { status: number; headers: HeaderPairs }) => void;
        let resolveDone!: (response: RelayResponse) => void;
        const head = new Promise<{ status: number; headers: HeaderPairs }>((resolve) => {
            resolveHead = resolve;
        });
        const done = new Promise<RelayResponse>((resolve) => {
            resolveDone = resolve;
        });
        let bodyCredit = this.window;
        let wake: (() => void) | undefined;
        const finish = (outcome: "ended" | "aborted"): void => {
            this.#exchanges.delete(id);
            wake?.();
            resolveHead({ headers, status });
            resolveDone({ body: Buffer.concat(chunks), headers, outcome, status });
        };
        this.#exchanges.set(id, (kind, payload) => {
            if (kind === "res") {
                ({ s: status, h: headers } = payload as { s: number; h: HeaderPairs });
                resolveHead({ headers, status });
            } else if (kind === "body") {
                const bytes = payload as Buffer;
                credit -= bytes.byteLength;
                if (credit < 0 || bytes.byteLength > 65_536) {
                    this.overrun = true;
                    socket.close(4002, "protocol_error");
                    return;
                }
                chunks.push(bytes);
                if (this.autoCredit) {
                    credit += bytes.byteLength;
                    socket.send(JSON.stringify({ id, n: bytes.byteLength, t: "credit" }));
                }
            } else if (kind === "full") {
                const { head: whole, body } = payload as {
                    head: { s: number; h: HeaderPairs };
                    body: Buffer;
                };
                ({ s: status, h: headers } = whole);
                chunks.push(body);
                finish("ended");
            } else if (kind === "end") {
                finish("ended");
            } else if (kind === "abort" || kind === "gone") {
                finish("aborted");
            } else if (kind === "credit") {
                bodyCredit += payload as number;
                wake?.();
            } else if (kind === "granted") {
                credit += payload as number;
            }
        });
        socket.send(
            JSON.stringify({
                body: request.body !== undefined,
                h: request.headers ?? [],
                id,
                m: request.method ?? "GET",
                p: request.path,
                t: "req",
            }),
        );
        if (request.body !== undefined) {
            const body = request.body;
            void (async () => {
                for (let offset = 0; offset < body.byteLength; offset += 65_536) {
                    const piece = body.subarray(offset, offset + 65_536);
                    while (this.#exchanges.has(id) && bodyCredit < piece.byteLength) {
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                    }
                    if (!this.#exchanges.has(id)) return;
                    bodyCredit -= piece.byteLength;
                    socket.send(frame(REQ_BODY, id, piece));
                }
                if (this.#exchanges.has(id)) socket.send(JSON.stringify({ id, t: "reqend" }));
            })();
        }
        return {
            abort: () => {
                if (!this.#exchanges.has(id)) return;
                socket.send(JSON.stringify({ id, t: "abort" }));
                finish("aborted");
            },
            done,
            head,
            id,
            received: () => Buffer.concat(chunks),
        };
    }

    /** Grant response-body credit by hand when `autoCredit` is off. */
    grant(id: number, bytes: number): void {
        this.#exchanges.get(id)?.("granted", bytes);
        this.#requireSocket().send(JSON.stringify({ id, n: bytes, t: "credit" }));
    }

    /** One client WebSocket, opened as the relay opens it. */
    openStream(request: { readonly path: string; readonly headers?: HeaderPairs }): RelayStream {
        const socket = this.#requireSocket();
        const id = this.#nextId++;
        const messages: (string | Buffer)[] = [];
        let resolveOpened!: (value: Awaited<RelayStream["opened"]>) => void;
        let resolveClosed!: (value: { code: number; reason: string }) => void;
        const opened = new Promise<Awaited<RelayStream["opened"]>>((resolve) => {
            resolveOpened = resolve;
        });
        const closed = new Promise<{ code: number; reason: string }>((resolve) => {
            resolveClosed = resolve;
        });
        this.#exchanges.set(id, (kind, payload) => {
            if (kind === "accept") {
                const protocol = (payload as { protocol?: string }).protocol;
                resolveOpened({ accepted: true, ...(protocol === undefined ? {} : { protocol }) });
            } else if (kind === "full") {
                const { head, body } = payload as {
                    head: { s: number; h: HeaderPairs };
                    body: Buffer;
                };
                this.#exchanges.delete(id);
                resolveOpened({
                    accepted: false,
                    response: { body, headers: head.h, outcome: "ended", status: head.s },
                });
            } else if (kind === "text" || kind === "binary") {
                messages.push(payload as string | Buffer);
            } else if (kind === "close" || kind === "gone") {
                this.#exchanges.delete(id);
                const close = (payload ?? { code: 4503, reason: "endpoint_offline" }) as {
                    code: number;
                    reason: string;
                };
                resolveClosed({ code: close.code, reason: close.reason });
            }
        });
        socket.send(
            JSON.stringify({
                body: false,
                h: request.headers ?? [],
                id,
                m: "GET",
                p: request.path,
                t: "req",
                ws: true,
            }),
        );
        return {
            close: (code, reason = "") => {
                if (!this.#exchanges.delete(id)) return;
                socket.send(JSON.stringify({ code, id, reason, t: "close" }));
            },
            closed,
            id,
            messages,
            opened,
            send: (message) => {
                socket.send(
                    typeof message === "string"
                        ? frame(WS_TEXT, id, Buffer.from(message, "utf8"))
                        : frame(WS_BINARY, id, message),
                );
            },
        };
    }

    #requireSocket(): WebSocket {
        const socket = this.current?.socket;
        if (socket === undefined) throw new Error("No computer is attached.");
        return socket;
    }

    #attach(socket: WebSocket, eid: string, authorization: string | undefined): void {
        // One computer socket per endpoint: a new attach replaces the old one.
        this.current?.socket.close(4000, "replaced");
        const attachment: Attachment = { authorization, pings: 0, socket };
        this.attachments.push(attachment);
        socket.on("ping", (data) => {
            attachment.pings += 1;
            if (this.answerPings) socket.pong(data);
        });
        socket.on("close", (code) => {
            this.closes.push({ code });
            for (const deliver of this.#exchanges.values()) deliver("gone", undefined);
        });
        socket.on("message", (data: RawData, isBinary: boolean) => {
            const bytes = data as Buffer;
            if (!isBinary) {
                const message = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
                const deliver = this.#exchanges.get(message.id as number);
                if (message.t === "credit") deliver?.("credit", message.n);
                else if (message.t === "close") deliver?.("close", message);
                else deliver?.(message.t as string, message);
                return;
            }
            const type = bytes.readUInt8(0);
            const deliver = this.#exchanges.get(bytes.readUInt32BE(1));
            const payload = bytes.subarray(5);
            if (type === RES_BODY) deliver?.("body", payload);
            else if (type === WS_TEXT) deliver?.("text", payload.toString("utf8"));
            else if (type === WS_BINARY) deliver?.("binary", Buffer.from(payload));
            else if (type === RES_FULL) {
                const length = payload.readUInt32BE(0);
                deliver?.("full", {
                    body: Buffer.from(payload.subarray(4 + length)),
                    head: JSON.parse(payload.subarray(4, 4 + length).toString("utf8")) as unknown,
                });
            }
        });
        socket.send(JSON.stringify({ eid, t: "hello", v: this.version, window: this.window }));
    }
}

function frame(type: number, id: number, payload: Buffer): Buffer {
    const out = Buffer.allocUnsafe(5 + payload.byteLength);
    out.writeUInt8(type, 0);
    out.writeUInt32BE(id, 1);
    out.set(payload, 5);
    return out;
}
