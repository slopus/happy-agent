import { connect } from "node:net";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import WebSocket, { type RawData } from "ws";

import {
    admitForwardedRequest,
    type AuthorizeForwarded,
    type ForwardedRequestHead,
    type HeaderPairs,
    type LocalApi,
    type RefusedForward,
} from "./forwardToLocalApi.js";
import {
    dataFrame,
    MAX_BODY_FRAME_BYTES,
    MAX_WS_MESSAGE_BYTES,
    REQ_BODY,
    RES_BODY,
    wholeResponseFrame,
    WS_BINARY,
    WS_TEXT,
} from "./relayFrames.js";

const PROTOCOL_VERSION = 1;
/** A response with a known length up to this goes out as one message, which the relay bills once. */
const WHOLE_RESPONSE_MAX_BYTES = 256 * 1_024;
/** Sent to a client stream that is still open when the relay token that opened it expires. */
const TOKEN_EXPIRED_CLOSE = { code: 4401, reason: "token_expired" } as const;
/**
 * The relay protocol has no flow control for WebSocket messages, so the daemon bounds what one
 * stream may have queued in either direction and closes a stream that falls this far behind.
 */
const MAX_STREAM_QUEUED_BYTES = 8 * 1_048_576;
const SLOW_STREAM_CLOSE = { code: 4408, reason: "stream_too_slow" } as const;
/** A relay that opens more exchanges than this at once is refused the rest. */
const MAX_LIVE_EXCHANGES = 1_024;
const MAX_TIMER_MS = 2_147_483_647;

const idSchema = Type.Integer({ maximum: 4_294_967_295, minimum: 1 });
const helloSchema = Type.Object({
    t: Type.Literal("hello"),
    v: Type.Integer(),
    window: Type.Integer({ minimum: 1 }),
});
const requestSchema = Type.Object({
    body: Type.Optional(Type.Boolean()),
    h: Type.Array(Type.Tuple([Type.String(), Type.String()]), { maxItems: 512 }),
    id: idSchema,
    m: Type.String({ maxLength: 32, minLength: 1 }),
    p: Type.String({ maxLength: 65_536, minLength: 1 }),
    t: Type.Literal("req"),
    ws: Type.Optional(Type.Boolean()),
});
const exchangeMessageSchema = Type.Object({
    code: Type.Optional(Type.Integer()),
    id: idSchema,
    n: Type.Optional(Type.Integer({ minimum: 1 })),
    reason: Type.Optional(Type.String()),
    t: Type.String(),
});
type RelayRequest = Static<typeof requestSchema>;

interface HttpExchange {
    readonly kind: "http";
    /** Request body frames that arrived while the relay token was still being verified. */
    readonly early: Buffer[];
    /** Request body bytes received from the relay and not yet taken by the local API. */
    held: number;
    earlyEnded: boolean;
    expiry: NodeJS.Timeout | undefined;
    request: ClientRequest | undefined;
    response: IncomingMessage | undefined;
    /** Request body bytes written to the local API and not yet credited back to the relay. */
    consumed: number;
    /** Response body bytes the relay will still take. */
    credit: number;
    wake: (() => void) | undefined;
}

interface StreamExchange {
    readonly kind: "stream";
    accepted: boolean;
    expiry: NodeJS.Timeout | undefined;
    local: WebSocket | undefined;
    /** Bytes handed to the relay socket for this stream that have not left the process yet. */
    queued: number;
}

type Exchange = HttpExchange | StreamExchange;

/**
 * One attach's worth of the relay protocol: every forwarded request and client WebSocket between
 * a `hello` and the socket closing. Each exchange is admitted on its own relay token before any
 * local connection opens, and ends no later than that token expires.
 */
export class RelaySession {
    readonly #authorize: AuthorizeForwarded;
    readonly #exchanges = new Map<number, Exchange>();
    readonly #fail: (reason: string) => void;
    readonly #localApi: LocalApi;
    readonly #send: (data: string | Buffer, flushed?: () => void) => void;
    #closed = false;
    #window = 0;

    constructor(
        send: (data: string | Buffer, flushed?: () => void) => void,
        authorize: AuthorizeForwarded,
        localApi: LocalApi,
        fail: (reason: string) => void,
    ) {
        this.#authorize = authorize;
        this.#fail = fail;
        this.#localApi = localApi;
        this.#send = send;
    }

    receive(data: RawData, isBinary: boolean): void {
        if (this.#closed) return;
        const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : data;
        if (isBinary) {
            if (bytes.byteLength >= 5) {
                this.#data(bytes.readUInt8(0), bytes.readUInt32BE(1), bytes.subarray(5));
            }
            return;
        }
        let message: unknown;
        try {
            message = JSON.parse(bytes.toString("utf8"));
        } catch {
            // `pong` is the one text message that is not JSON.
            return;
        }
        if (Value.Check(helloSchema, message)) {
            if (message.v !== PROTOCOL_VERSION) {
                this.#fail(`The Happy Relay speaks protocol version ${String(message.v)}.`);
                return;
            }
            this.#window = message.window;
            return;
        }
        // Nothing is served before `hello`: the body window is not known yet.
        if (this.#window === 0) return;
        if (Value.Check(requestSchema, message)) {
            if (this.#exchanges.has(message.id)) return;
            if (this.#exchanges.size >= MAX_LIVE_EXCHANGES) {
                this.#refuse(message.id, { code: "too_many_requests", status: 503 });
                return;
            }
            if (message.ws === true) void this.#openStream(message);
            else void this.#serve(message);
            return;
        }
        if (Value.Check(exchangeMessageSchema, message)) this.#control(message);
    }

    /** The socket is gone: every exchange dies with it, and nothing more is sent. */
    close(): void {
        this.#closed = true;
        for (const id of this.#exchanges.keys()) this.#drop(id);
    }

    #control(message: Static<typeof exchangeMessageSchema>): void {
        const exchange = this.#exchanges.get(message.id);
        if (exchange === undefined) return;
        if (exchange.kind === "stream") {
            if (message.t !== "close" && message.t !== "abort") return;
            const local = exchange.local;
            this.#exchanges.delete(message.id);
            clearTimeout(exchange.expiry);
            exchange.local = undefined;
            if (local === undefined) return;
            const code = message.code ?? 1006;
            if (code === 1000 || (code >= 3000 && code <= 4999)) {
                closeLocal(local, code, message.reason ?? "");
            } else {
                // The client's connection dropped; the local side has nobody to close politely for.
                local.terminate();
            }
            return;
        }
        if (message.t === "reqend") {
            if (exchange.request === undefined) exchange.earlyEnded = true;
            else exchange.request.end();
        } else if (message.t === "credit") {
            exchange.credit += message.n ?? 0;
            exchange.wake?.();
        } else if (message.t === "abort") {
            this.#drop(message.id);
        }
    }

    #data(type: number, id: number, payload: Buffer): void {
        const exchange = this.#exchanges.get(id);
        if (exchange === undefined) return;
        if (exchange.kind === "stream") {
            if (!exchange.accepted || exchange.local?.readyState !== WebSocket.OPEN) return;
            if (exchange.local.bufferedAmount > MAX_STREAM_QUEUED_BYTES) {
                this.#closeStream(id, SLOW_STREAM_CLOSE);
                return;
            }
            if (type === WS_TEXT) exchange.local.send(payload, { binary: false });
            else if (type === WS_BINARY) exchange.local.send(payload, { binary: true });
            return;
        }
        if (type !== REQ_BODY) return;
        // Credit is granted only for bytes the local API took, so an honest relay never has more
        // than one window outstanding. One that does is not buffered for.
        exchange.held += payload.byteLength;
        if (exchange.held > this.#window) this.#abort(id);
        else if (exchange.request === undefined) exchange.early.push(payload);
        else this.#writeBody(id, exchange, payload);
    }

    /** Credit is granted only for bytes the local API has taken, in batches the relay bills less for. */
    #writeBody(id: number, exchange: HttpExchange, payload: Buffer): void {
        exchange.request?.write(payload, () => {
            if (this.#exchanges.get(id) !== exchange) return;
            exchange.held -= payload.byteLength;
            exchange.consumed += payload.byteLength;
            if (exchange.consumed >= this.#window / 4) {
                this.#sendControl({ id, n: exchange.consumed, t: "credit" });
                exchange.consumed = 0;
            }
        });
    }

    async #serve(message: RelayRequest): Promise<void> {
        const id = message.id;
        const exchange: HttpExchange = {
            consumed: 0,
            credit: this.#window,
            early: [],
            held: 0,
            earlyEnded: false,
            expiry: undefined,
            kind: "http",
            request: undefined,
            response: undefined,
            wake: undefined,
        };
        this.#exchanges.set(id, exchange);
        const live = (): boolean => this.#exchanges.get(id) === exchange;
        try {
            const admission = await admitForwardedRequest(
                requestHead(message),
                this.#authorize,
                this.#localApi,
            );
            if (!live()) return;
            if (!admission.admitted) {
                this.#refuse(id, admission.refusal);
                return;
            }
            exchange.expiry = this.#expireAt(admission.expiresAt, () => {
                if (!live()) return;
                // Before a response the caller learns why; after it, the body is simply cut.
                if (exchange.response === undefined) this.#refuse(id, UNAUTHORIZED);
                else this.#abort(id);
            });
            const request = httpRequest({
                // One connection per forwarded request: nothing admitted is ever reused.
                agent: false,
                headers: admission.headers,
                method: message.m,
                path: message.p,
                socketPath: this.#localApi.socketPath,
            });
            exchange.request = request;
            // A dropped exchange destroys its request, and a late socket error must not be fatal.
            request.on("error", () => undefined);
            const answered = new Promise<IncomingMessage>((resolve, reject) => {
                request.once("response", resolve);
                request.once("error", reject);
            });
            for (const chunk of exchange.early.splice(0)) this.#writeBody(id, exchange, chunk);
            if (message.body !== true || exchange.earlyEnded) request.end();
            let response: IncomingMessage;
            try {
                response = await answered;
            } catch {
                if (live()) this.#refuse(id, LOCAL_API_UNAVAILABLE);
                return;
            }
            if (!live()) {
                response.destroy();
                return;
            }
            exchange.response = response;
            await this.#respond(id, exchange, message.m, response, live);
        } catch {
            if (live()) this.#abort(id);
        }
    }

    async #respond(
        id: number,
        exchange: HttpExchange,
        method: string,
        response: IncomingMessage,
        live: () => boolean,
    ): Promise<void> {
        const head = { h: headerPairs(response.rawHeaders), s: response.statusCode ?? 502 };
        const length = Number(response.headers["content-length"] ?? Number.NaN);
        const bodiless =
            method.toUpperCase() === "HEAD" || head.s === 204 || head.s === 205 || head.s === 304;
        if (bodiless || (Number.isFinite(length) && length <= WHOLE_RESPONSE_MAX_BYTES)) {
            const chunks: Buffer[] = [];
            if (!bodiless) for await (const chunk of response) chunks.push(chunk as Buffer);
            if (!live()) return;
            this.#send(wholeResponseFrame(id, head, Buffer.concat(chunks)));
            this.#finish(id);
            if (bodiless) response.destroy();
            return;
        }
        this.#sendControl({ h: head.h, id, s: head.s, t: "res" });
        for await (const chunk of response) {
            const bytes = chunk as Buffer;
            for (let offset = 0; offset < bytes.byteLength; offset += MAX_BODY_FRAME_BYTES) {
                const piece = bytes.subarray(offset, offset + MAX_BODY_FRAME_BYTES);
                // Overrunning the window makes the relay drop the whole computer socket.
                while (live() && exchange.credit < piece.byteLength) {
                    await new Promise<void>((resolve) => {
                        exchange.wake = resolve;
                    });
                }
                if (!live()) return;
                exchange.credit -= piece.byteLength;
                this.#send(dataFrame(RES_BODY, id, piece));
            }
        }
        if (!live()) return;
        this.#sendControl({ id, t: "end" });
        this.#finish(id);
    }

    async #openStream(message: RelayRequest): Promise<void> {
        const id = message.id;
        const exchange: StreamExchange = {
            accepted: false,
            expiry: undefined,
            kind: "stream",
            local: undefined,
            queued: 0,
        };
        this.#exchanges.set(id, exchange);
        const live = (): boolean => this.#exchanges.get(id) === exchange;
        const admission = await admitForwardedRequest(
            requestHead(message),
            this.#authorize,
            this.#localApi,
        ).catch(() => undefined);
        if (!live()) return;
        if (admission === undefined || !admission.admitted) {
            this.#refuse(id, admission?.refusal ?? LOCAL_API_UNAVAILABLE);
            return;
        }
        const { "sec-websocket-protocol": offered, ...headers } = admission.headers;
        const protocols = [offered ?? []]
            .flat()
            .flatMap((value) => value.split(","))
            .map((value) => value.trim())
            .filter((value) => value !== "");
        let local: WebSocket;
        try {
            // The path is the relay's, so it never takes part in choosing where to connect: a
            // `ws+unix://<socket>:<path>` URL would let `/../other.sock:/x` name another socket.
            local = new WebSocket(`ws://localhost${message.p}`, protocols, {
                createConnection: () => connect({ path: this.#localApi.socketPath }),
                headers,
                maxPayload: MAX_WS_MESSAGE_BYTES,
                perMessageDeflate: false,
            });
        } catch {
            this.#refuse(id, { code: "bad_request", status: 400 });
            return;
        }
        exchange.local = local;
        exchange.expiry = this.#expireAt(admission.expiresAt, () => {
            if (!live()) return;
            if (exchange.accepted) this.#closeStream(id, TOKEN_EXPIRED_CLOSE);
            else this.#refuse(id, UNAUTHORIZED);
        });
        local.once("open", () => {
            if (!live()) return;
            exchange.accepted = true;
            this.#sendControl({
                id,
                ...(local.protocol === "" ? {} : { protocol: local.protocol }),
                t: "accept",
            });
        });
        local.on("message", (data: RawData, isBinary: boolean) => {
            if (!live() || !exchange.accepted) return;
            const bytes = Array.isArray(data)
                ? Buffer.concat(data)
                : data instanceof ArrayBuffer
                  ? Buffer.from(data)
                  : data;
            exchange.queued += bytes.byteLength;
            if (exchange.queued > MAX_STREAM_QUEUED_BYTES) {
                this.#closeStream(id, SLOW_STREAM_CLOSE);
                return;
            }
            this.#send(dataFrame(isBinary ? WS_BINARY : WS_TEXT, id, bytes), () => {
                exchange.queued -= bytes.byteLength;
            });
        });
        // The local API answered the upgrade with an ordinary response: the client gets it as is.
        local.once("unexpected-response", (_request, response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
                if (!live()) return;
                const head = { h: headerPairs(response.rawHeaders), s: response.statusCode ?? 502 };
                this.#send(wholeResponseFrame(id, head, Buffer.concat(chunks)));
                this.#finish(id);
            });
            response.once("error", () => {
                if (live()) this.#refuse(id, LOCAL_API_UNAVAILABLE);
            });
        });
        local.once("close", (code: number, reason: Buffer) => {
            if (!live()) return;
            if (!exchange.accepted) {
                this.#refuse(id, LOCAL_API_UNAVAILABLE);
                return;
            }
            // The relay takes 1000 or an application code; anything else was not a clean close.
            const relayed = code === 1000 || (code >= 3000 && code <= 4999) ? code : 4500;
            this.#closeStream(id, { code: relayed, reason: closeReason(reason.toString("utf8")) });
        });
        local.on("error", () => undefined);
    }

    #closeStream(id: number, close: { readonly code: number; readonly reason: string }): void {
        this.#sendControl({ ...close, id, t: "close" });
        this.#drop(id);
    }

    #refuse(id: number, refusal: RefusedForward): void {
        const body = Buffer.from(JSON.stringify({ code: refusal.code }), "utf8");
        this.#send(
            wholeResponseFrame(
                id,
                {
                    h: [
                        ["content-type", "application/json"],
                        ["content-length", String(body.byteLength)],
                        ["cache-control", "no-store"],
                    ],
                    s: refusal.status,
                },
                body,
            ),
        );
        this.#drop(id);
    }

    #abort(id: number): void {
        this.#sendControl({ id, t: "abort" });
        this.#drop(id);
    }

    /** The exchange ended normally; its local connection finishes on its own. */
    #finish(id: number): void {
        const exchange = this.#exchanges.get(id);
        this.#exchanges.delete(id);
        clearTimeout(exchange?.expiry);
    }

    /** Forget the exchange and tear down whatever it holds locally. */
    #drop(id: number): void {
        const exchange = this.#exchanges.get(id);
        if (exchange === undefined) return;
        this.#exchanges.delete(id);
        clearTimeout(exchange.expiry);
        if (exchange.kind === "stream") {
            exchange.local?.terminate();
            return;
        }
        exchange.request?.destroy();
        exchange.response?.destroy();
        exchange.wake?.();
    }

    #expireAt(expiresAt: number, expire: () => void): NodeJS.Timeout {
        const timer = setTimeout(
            expire,
            Math.min(Math.max(expiresAt - Date.now(), 0), MAX_TIMER_MS),
        );
        timer.unref();
        return timer;
    }

    #sendControl(message: Record<string, unknown>): void {
        if (!this.#closed) this.#send(JSON.stringify(message));
    }
}

const UNAUTHORIZED: RefusedForward = { code: "unauthorized", status: 401 };
const LOCAL_API_UNAVAILABLE: RefusedForward = { code: "local_api_unavailable", status: 502 };

/** A WebSocket close reason may be at most 123 bytes, and must not end inside a character. */
function closeReason(reason: string): string {
    let bytes = 0;
    let end = 0;
    for (const character of reason) {
        bytes += Buffer.byteLength(character, "utf8");
        if (bytes > 120) break;
        end += character.length;
    }
    return reason.slice(0, end);
}

function closeLocal(local: WebSocket, code: number, reason: string): void {
    try {
        local.close(code, closeReason(reason));
    } catch {
        local.terminate();
    }
}

function requestHead(message: RelayRequest): ForwardedRequestHead {
    return { headers: message.h, method: message.m, path: message.p };
}

function headerPairs(rawHeaders: readonly string[]): HeaderPairs {
    const pairs: [string, string][] = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        pairs.push([(rawHeaders[index] ?? "").toLowerCase(), rawHeaders[index + 1] ?? ""]);
    }
    return pairs;
}
