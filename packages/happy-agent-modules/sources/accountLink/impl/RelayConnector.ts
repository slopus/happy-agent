import type { Context } from "@steve.kite/stdlib";
import WebSocket, { type RawData } from "ws";

import type { AccountLinkRelayState } from "../AccountLink.js";
import type { AuthorizeForwarded, LocalApi } from "./forwardToLocalApi.js";
import { RelaySession } from "./RelaySession.js";

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** An attach that lasted this long was healthy, so the next failure starts the backoff over. */
const BACKOFF_RESET_AFTER_MS = 60_000;
/** The relay's close code when another socket attached as this endpoint. */
const REPLACED_CLOSE_CODE = 4000;
const MAX_RELAY_MESSAGE_BYTES = 1_048_576 + 5;
/**
 * After being replaced, wait at least this long. Two daemons holding the same link would
 * otherwise evict each other on every reconnect, forever.
 */
const REPLACED_BACKOFF_MS = 30_000;

export interface RelayConnectorTiming {
    readonly backoffFirstMs: number;
    readonly backoffMaxMs: number;
    readonly pingIntervalMs: number;
    readonly pongTimeoutMs: number;
    readonly replacedBackoffMs: number;
}

export interface RelayConnectorOptions {
    /** `ws(s)://<relay>/e/<eid>/attach`. */
    readonly attachUrl: string;
    readonly authorize: AuthorizeForwarded;
    /** Runs with the endpoint token before every attach; a failure delays the attach. */
    readonly beforeAttach: (endpointToken: string) => Promise<void>;
    /** `fresh` asks for a newly issued token, after the relay refused the last one. */
    readonly endpointToken: (fresh: boolean) => Promise<string>;
    readonly localApi: LocalApi;
    readonly onAttached: (endpointToken: string) => void;
    /** Timers only, so tests need not wait out the real ones. */
    readonly timing?: Partial<RelayConnectorTiming>;
}

type AttachEnd =
    | { readonly kind: "closed"; readonly code: number }
    | { readonly kind: "refused"; readonly status: number };

/**
 * Keeps exactly one outbound WebSocket to the relay for as long as it lives: attach, serve
 * forwarded requests, ping every thirty seconds, and reconnect with backoff when it drops.
 * Closing it is the only way the relay path ends: the relay never drops an attached socket
 * because its token expired or its link was revoked.
 */
export class RelayConnector {
    /** The protocol's own numbers. */
    static readonly defaultTiming: RelayConnectorTiming = {
        backoffFirstMs: BACKOFF_FIRST_MS,
        backoffMaxMs: BACKOFF_MAX_MS,
        pingIntervalMs: PING_INTERVAL_MS,
        pongTimeoutMs: PONG_TIMEOUT_MS,
        replacedBackoffMs: REPLACED_BACKOFF_MS,
    };

    readonly #ctx: Context;
    readonly #options: RelayConnectorOptions;
    readonly #run: Promise<void>;
    readonly #stop = new AbortController();
    readonly #timing: RelayConnectorTiming;
    #error: string | undefined;
    #settle: (() => void) | undefined;
    #socket: WebSocket | undefined;
    #state: Exclude<AccountLinkRelayState, "off"> = "connecting";

    constructor(ctx: Context, options: RelayConnectorOptions) {
        this.#ctx = ctx;
        this.#options = options;
        this.#timing = { ...RelayConnector.defaultTiming, ...options.timing };
        this.#run = this.#supervise();
    }

    get state(): Exclude<AccountLinkRelayState, "off"> {
        return this.#state;
    }

    /** Why the last attach failed or ended, until the next one succeeds. */
    get error(): string | undefined {
        return this.#error;
    }

    /** Resolves once the first attach succeeded or failed, or after `timeoutMs`. */
    async settled(timeoutMs: number): Promise<void> {
        if (this.#state === "attached" || this.#error !== undefined) return;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            this.#settle = () => {
                clearTimeout(timer);
                resolve();
            };
        });
    }

    async close(): Promise<void> {
        this.#stop.abort();
        this.#socket?.terminate();
        await this.#run;
    }

    async #supervise(): Promise<void> {
        let backoff = this.#timing.backoffFirstMs;
        let fresh = false;
        while (!this.#stop.signal.aborted) {
            const startedAt = Date.now();
            let wait = backoff;
            try {
                const end = await this.#attachOnce(fresh);
                fresh = false;
                if (end.kind === "refused") {
                    this.#error = `The Happy Relay refused this computer (HTTP ${String(end.status)}).`;
                    // 401: the token is stale, so the next attempt gets a new one. 403: the relay
                    // will not change its mind soon, so do not hammer it.
                    if (end.status === 401) fresh = true;
                    if (end.status === 403) wait = backoff = this.#timing.backoffMaxMs;
                } else if (end.code === REPLACED_CLOSE_CODE) {
                    this.#error =
                        "Another Happy Agent attached to the Happy Relay as this computer. Only one can be reachable at a time.";
                    wait = Math.max(backoff, this.#timing.replacedBackoffMs);
                } else if (Date.now() - startedAt >= BACKOFF_RESET_AFTER_MS) {
                    wait = backoff = this.#timing.backoffFirstMs;
                }
            } catch (error: unknown) {
                if (this.#stop.signal.aborted) return;
                this.#error = `The Happy Relay connection failed: ${error instanceof Error ? error.message : String(error)}`;
                this.#ctx.log.warn("account-link:relay:failed", {}, error);
            }
            this.#state = "connecting";
            this.#settle?.();
            // Jitter keeps a fleet that lost the relay together from returning together.
            await delay(wait + Math.random() * (wait / 4), this.#stop.signal);
            backoff = Math.min(backoff * 2, this.#timing.backoffMaxMs);
        }
    }

    /** One attach, from the token to the socket closing. Rejects when it never attached. */
    async #attachOnce(fresh: boolean): Promise<AttachEnd> {
        const token = await this.#options.endpointToken(fresh);
        await this.#options.beforeAttach(token);
        if (this.#stop.signal.aborted) return { code: 1000, kind: "closed" };
        const socket = new WebSocket(this.#options.attachUrl, {
            handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
            headers: { authorization: `Bearer ${token}` },
            // The protocol's largest message is a 1 MiB payload behind a five-byte header.
            maxPayload: MAX_RELAY_MESSAGE_BYTES,
            perMessageDeflate: false,
        });
        this.#socket = socket;
        const session = new RelaySession(
            (data, flushed) => {
                if (socket.readyState === WebSocket.OPEN) socket.send(data, flushed);
            },
            this.#options.authorize,
            this.#options.localApi,
            (reason) => {
                this.#ctx.log.warn(`account-link:relay:protocol ${reason}`);
                socket.close(1002, "unsupported protocol version");
            },
        );
        let ping: NodeJS.Timeout | undefined;
        let pong: NodeJS.Timeout | undefined;
        try {
            return await new Promise<AttachEnd>((resolve, reject) => {
                socket.once("open", () => {
                    this.#state = "attached";
                    this.#error = undefined;
                    this.#settle?.();
                    this.#ctx.log.info("account-link:relay:attached");
                    this.#options.onAttached(token);
                    ping = setInterval(() => {
                        socket.ping();
                        // No pong: the path is dead even if TCP has not noticed yet.
                        pong ??= setTimeout(() => socket.terminate(), this.#timing.pongTimeoutMs);
                    }, this.#timing.pingIntervalMs);
                });
                socket.on("pong", () => {
                    clearTimeout(pong);
                    pong = undefined;
                });
                socket.on("message", (data: RawData, isBinary: boolean) => {
                    try {
                        session.receive(data, isBinary);
                    } catch (error: unknown) {
                        // Whatever the relay sent, it must not take the daemon down with it.
                        this.#ctx.log.warn("account-link:relay:message", {}, error);
                        socket.terminate();
                    }
                });
                socket.once("unexpected-response", (_request, response) => {
                    response.resume();
                    resolve({ kind: "refused", status: response.statusCode ?? 0 });
                    socket.terminate();
                });
                socket.once("error", reject);
                socket.once("close", (code) => {
                    if (this.#state !== "attached") {
                        reject(new Error(`the socket closed before attaching (${String(code)})`));
                        return;
                    }
                    this.#ctx.log.info(`account-link:relay:closed code=${String(code)}`);
                    resolve({ code, kind: "closed" });
                });
            });
        } finally {
            clearInterval(ping);
            clearTimeout(pong);
            // Whatever was in flight ends with the socket: its caller can no longer hear the answer.
            session.close();
            socket.removeAllListeners("error");
            socket.on("error", () => undefined);
            socket.terminate();
            if (this.#socket === socket) this.#socket = undefined;
        }
    }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
    });
}
