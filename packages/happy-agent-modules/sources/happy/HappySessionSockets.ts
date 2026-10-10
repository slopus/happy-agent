import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { connectHappySocket } from "./connectHappySocket.js";
import type { HappyConnectionConfiguration } from "./HappyCredentials.js";
import type { HappySocket } from "./HappySessionClient.js";

/** How long a server is given to answer the first subscription before it is taken as older. */
const SUBSCRIBE_PROBE_TIMEOUT_MS = 5_000;
/** The most sessions Happy accepts in one subscription. */
const MAX_SUBSCRIBE_BATCH = 500;
/** How long a subscription Happy could not apply waits before it is asked again. */
const SUBSCRIBE_RETRY_MS = 2_000;

/**
 * How session traffic travels: over the machine's own connection, or, against a Happy server that
 * cannot carry sessions on it, over one session-scoped connection per session.
 */
export type HappySessionTransport = "multiplexed" | "dedicated";

const subscribeAnswerSchema = Type.Union([
    Type.Object(
        {
            missing: Type.Array(Type.String()),
            result: Type.Literal("success"),
            subscribed: Type.Array(Type.String()),
        },
        { additionalProperties: true },
    ),
    Type.Object(
        { reason: Type.String(), result: Type.Literal("error") },
        { additionalProperties: true },
    ),
]);

const sessionUpdateSchema = Type.Object(
    {
        body: Type.Object(
            {
                id: Type.Optional(Type.String()),
                sid: Type.Optional(Type.String()),
                t: Type.String(),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);

const rpcRequestSchema = Type.Object({ method: Type.String() }, { additionalProperties: true });

export interface HappySessionSocketsOptions {
    readonly configuration: HappyConnectionConfiguration;
    readonly context: Context;
    /**
     * Happy changed how sessions travel after the first decision, as when a reconnect reaches a
     * server of another version. Sessions moving onto sockets of their own wait for this to settle,
     * so the owner can bring them within the cap those sockets have before any of them opens.
     */
    readonly onTransportChanged?: (transport: HappySessionTransport) => Promise<void>;
    /** Only a test supplies this; left out, a dedicated session socket connects to Happy. */
    readonly socketFactory?: (url: string, options: Record<string, unknown>) => HappySocket;
    readonly version: string;
}

/**
 * Carries every published session over the machine's one connection to Happy.
 *
 * A session client is handed a socket shaped like the one it always had, but that socket is a
 * view of the machine connection: its writes go out on the machine socket, and the updates and
 * requests Happy addresses to its session are routed back to it. Happy joins the machine socket to
 * a session's room when asked with `session-subscribe`. Rooms belong to one connection, so every
 * reconnect subscribes everything again, and each session then hears `connect`, exactly as its
 * own socket used to after reconnecting, which forces the metadata compare-and-swap that recovers
 * whatever changed meanwhile.
 *
 * Whether Happy can do this is decided once per machine connection: the first subscription is the
 * question. A server too old to have the handler never answers, so after a short wait every
 * session falls back to a session-scoped socket of its own, which is how all of them used to
 * connect. Exactly one of the two carries a session at a time.
 */
export class HappySessionSockets {
    readonly #options: HappySessionSocketsOptions;
    readonly #links = new Map<string, HappySessionLink>();
    /**
     * Sessions waiting for the next subscription batch. Answers are matched to the links that
     * asked, never to a session id alone: a session reopened after leaving asks again for itself.
     */
    readonly #pending = new Set<HappySessionLink>();
    /** The machine socket while it is connected. */
    #socket: HappySocket | undefined;
    /** Counts machine connections, so an answer meant for an earlier one is ignored. */
    #epoch = 0;
    /** How the current machine connection carries sessions; undefined until Happy answers. */
    #transport: HappySessionTransport | undefined;
    /** The latest decision, kept across reconnects so capacity does not flap while one probes. */
    #decided: HappySessionTransport | undefined;
    /**
     * The owner is still letting go of sessions beyond the cap of sockets of their own. It outlives
     * reconnects: no session socket opens until it has finished, however many connections decide.
     */
    #contraction: Promise<void> | undefined;
    #flushScheduled = false;
    #closed = false;
    #settleFirstTransport!: (transport: HappySessionTransport | undefined) => void;
    readonly #firstTransport = new Promise<HappySessionTransport | undefined>((resolve) => {
        this.#settleFirstTransport = resolve;
    });

    constructor(options: HappySessionSocketsOptions) {
        this.#options = options;
    }

    /** Whether sessions travel on the machine connection, by the latest answer from Happy. */
    get multiplexed(): boolean {
        return this.#decided === "multiplexed";
    }

    /** Settles with the first connection's transport, or undefined if closed before one. */
    async firstTransport(): Promise<HappySessionTransport | undefined> {
        return await this.#firstTransport;
    }

    /** A socket for one published session; it starts travelling when its owner connects it. */
    open(remoteSessionId: string): HappySocket {
        return new HappySessionLink(this, remoteSessionId);
    }

    /** The machine socket connected, or reconnected: ask whether it can carry sessions. */
    connected(socket: HappySocket): void {
        if (this.#closed) return;
        const epoch = ++this.#epoch;
        this.#socket = socket;
        this.#transport = undefined;
        this.#pending.clear();
        const first = [...this.#links.values()].slice(0, MAX_SUBSCRIBE_BATCH);
        let answered = false;
        const timer = setTimeout(() => {
            if (answered || epoch !== this.#epoch) return;
            answered = true;
            this.#decide("dedicated", []);
        }, SUBSCRIBE_PROBE_TIMEOUT_MS);
        timer.unref();
        const sids = first.map((link) => link.remoteSessionId);
        socket.emit("session-subscribe", { sids }, (answer: unknown) => {
            if (answered || epoch !== this.#epoch) return;
            answered = true;
            clearTimeout(timer);
            // Any answer in the contract means the handler exists: an empty first question is
            // answered `invalid`. Only a refused client type, or something outside the contract,
            // leaves sessions on their own sockets.
            const supported =
                Value.Check(subscribeAnswerSchema, answer) &&
                !(answer.result === "error" && answer.reason === "unsupported-client");
            if (!supported) {
                this.#decide("dedicated", []);
                return;
            }
            this.#decide("multiplexed", first);
            if (answer.result === "success") this.#joined(first, answer.subscribed);
            else if (answer.reason === "internal") this.#retry(first, epoch);
        });
    }

    /** The machine socket is gone; nothing travels on it until it connects again. */
    disconnected(): void {
        this.#epoch += 1;
        this.#socket = undefined;
        this.#transport = undefined;
        this.#pending.clear();
        for (const link of this.#links.values()) link.leaveMachine();
    }

    /** Hands a session update to the session it names. Session deletions never reach a room. */
    route(update: unknown): boolean {
        if (!Value.Check(sessionUpdateSchema, update)) return false;
        const { body } = update;
        const sessionId =
            body.t === "update-session" ? body.id : body.t === "new-message" ? body.sid : undefined;
        const link = sessionId === undefined ? undefined : this.#links.get(sessionId);
        if (link === undefined || !link.subscribed) return false;
        link.fire("update", update);
        return true;
    }

    /** Hands a session RPC to the session whose method it names. */
    rpc(request: unknown, callback: (response: string) => void): boolean {
        if (!Value.Check(rpcRequestSchema, request)) return false;
        const separator = request.method.indexOf(":");
        const link =
            separator < 0 ? undefined : this.#links.get(request.method.slice(0, separator));
        if (link === undefined || !link.subscribed) return false;
        link.fire("rpc-request", request, callback);
        return true;
    }

    /** Stops carrying sessions, closing every dedicated socket still open. */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#settleFirstTransport(undefined);
        this.disconnected();
        for (const link of [...this.#links.values()]) link.disconnect();
    }

    /** @internal A session started: carry it the way this connection decided. */
    activate(link: HappySessionLink): void {
        if (this.#closed) return;
        this.#links.set(link.remoteSessionId, link);
        if (this.#transport === "dedicated") {
            if (this.#contraction === undefined) link.useDedicated();
        } else if (this.#transport === "multiplexed") this.#enqueue([link]);
    }

    /**
     * @internal A session stopped: leave its room. Happy applies one socket's subscriptions in
     * order, so leaving also wins over a subscription still in flight, including the first
     * question of a connection that has not been answered yet.
     */
    release(link: HappySessionLink, methods: readonly string[]): void {
        if (this.#links.get(link.remoteSessionId) !== link) return;
        this.#links.delete(link.remoteSessionId);
        this.#pending.delete(link);
        const socket = this.#socket;
        if (socket === undefined || this.#transport === "dedicated") return;
        socket.emit("session-unsubscribe", { sids: [link.remoteSessionId] });
        for (const method of methods) socket.emit("rpc-unregister", { method });
    }

    /**
     * @internal Sends a session's write on the machine socket, which Happy accepts for any session
     * of the account whether or not the socket is in its room. Nothing is sent before Happy has
     * said it carries sessions here: a session that ends up on its own socket must never have
     * registered its requests on both.
     */
    emit(event: string, values: unknown[]): boolean {
        const socket = this.#socket;
        if (socket === undefined || this.#transport !== "multiplexed") return false;
        socket.emit(event, ...values);
        return true;
    }

    /** @internal Opens the session-scoped socket a session uses against an older server. */
    openDedicated(remoteSessionId: string): HappySocket {
        const { configuration, socketFactory, version } = this.#options;
        return (socketFactory ?? connectHappySocket)(configuration.serverUrl, {
            auth: {
                clientType: "session-scoped",
                happyClient: `rig/${version}`,
                sessionId: remoteSessionId,
                token: configuration.credentials.token,
            },
            autoConnect: false,
            path: "/v1/updates",
            reconnection: true,
            transports: ["websocket"],
            withCredentials: true,
        });
    }

    #decide(transport: HappySessionTransport, asked: readonly HappySessionLink[]): void {
        const previous = this.#decided;
        this.#transport = transport;
        this.#decided = transport;
        this.#settleFirstTransport(transport);
        this.#options.context.log.debug("Happy chose how sessions travel.", { transport });
        const changed = previous !== undefined && previous !== transport;
        if (transport === "multiplexed") {
            const alreadyAsked = new Set(asked);
            const unasked: HappySessionLink[] = [];
            for (const link of this.#links.values()) {
                link.leaveDedicated();
                if (!alreadyAsked.has(link)) unasked.push(link);
            }
            if (unasked.length > 0) this.#enqueue(unasked);
            if (changed) void this.#announce(transport);
            return;
        }
        // Sessions had no cap on the machine connection, and sockets of their own do: none opens
        // until the owner has let go of the sessions beyond it.
        if (changed) {
            const contraction = this.#announce(transport).finally(() => {
                if (this.#contraction === contraction) this.#contraction = undefined;
            });
            this.#contraction = contraction;
        }
        const contraction = this.#contraction;
        if (contraction === undefined) {
            this.#carryDedicated();
            return;
        }
        const epoch = this.#epoch;
        void contraction.then(() => {
            if (epoch === this.#epoch) this.#carryDedicated();
        });
    }

    async #announce(transport: HappySessionTransport): Promise<void> {
        try {
            await this.#options.onTransportChanged?.(transport);
        } catch (error) {
            this.#options.context.log.debug(
                "Happy Agent could not adjust to how sessions travel.",
                { transport },
                error,
            );
        }
    }

    #carryDedicated(): void {
        for (const link of this.#links.values()) link.useDedicated();
    }

    #enqueue(links: readonly HappySessionLink[]): void {
        for (const link of links) this.#pending.add(link);
        if (this.#flushScheduled) return;
        this.#flushScheduled = true;
        // Sessions started in one turn of the event loop share one subscription.
        queueMicrotask(() => {
            this.#flushScheduled = false;
            this.#flush();
        });
    }

    #flush(): void {
        const socket = this.#socket;
        if (socket === undefined || this.#transport !== "multiplexed") return;
        const epoch = this.#epoch;
        const links = [...this.#pending];
        this.#pending.clear();
        for (let start = 0; start < links.length; start += MAX_SUBSCRIBE_BATCH) {
            const batch = links.slice(start, start + MAX_SUBSCRIBE_BATCH);
            const sids = batch.map((link) => link.remoteSessionId);
            socket.emit("session-subscribe", { sids }, (answer: unknown) => {
                if (epoch !== this.#epoch) return;
                if (!Value.Check(subscribeAnswerSchema, answer)) return;
                if (answer.result === "success") this.#joined(batch, answer.subscribed);
                else if (answer.reason === "internal") this.#retry(batch, epoch);
            });
        }
    }

    /** Happy could not apply a subscription this time; it is asked again shortly. */
    #retry(links: readonly HappySessionLink[], epoch: number): void {
        const timer = setTimeout(() => {
            if (epoch !== this.#epoch) return;
            this.#enqueue(links.filter((link) => this.#links.get(link.remoteSessionId) === link));
        }, SUBSCRIBE_RETRY_MS);
        timer.unref();
    }

    /**
     * Happy joined these rooms for the links that asked. One that stopped meanwhile already left
     * again, and a session reopened since then is a new link that asked on its own.
     */
    #joined(asked: readonly HappySessionLink[], subscribed: readonly string[]): void {
        const joined = new Set(subscribed);
        for (const link of asked) {
            if (joined.has(link.remoteSessionId)) link.joinMachine();
        }
    }
}

const FORWARDED_EVENTS = ["connect", "update", "rpc-request"] as const;

/** One session's view of its transport, shaped like the socket a session client expects. */
class HappySessionLink implements HappySocket {
    readonly remoteSessionId: string;
    readonly #owner: HappySessionSockets;
    readonly #listeners = new Map<string, (...values: any[]) => void>();
    /** RPC methods registered on the machine socket, which outlive this session's room. */
    readonly #rpcMethods = new Set<string>();
    #dedicated: HappySocket | undefined;
    #subscribed = false;
    #started = false;
    #closed = false;

    constructor(owner: HappySessionSockets, remoteSessionId: string) {
        this.#owner = owner;
        this.remoteSessionId = remoteSessionId;
    }

    get connected(): boolean {
        return this.#dedicated === undefined
            ? this.#subscribed
            : this.#dedicated.connected !== false;
    }

    /** Whether the machine socket is in this session's room. */
    get subscribed(): boolean {
        return this.#subscribed;
    }

    connect(): void {
        if (this.#started || this.#closed) return;
        this.#started = true;
        this.#owner.activate(this);
    }

    disconnect(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#owner.release(this, [...this.#rpcMethods]);
        this.#subscribed = false;
        this.#rpcMethods.clear();
        this.leaveDedicated();
    }

    emit(event: string, ...values: unknown[]): void {
        if (this.#closed) return;
        if (this.#dedicated !== undefined) {
            this.#dedicated.emit(event, ...values);
            return;
        }
        if (!this.#owner.emit(event, values)) return;
        const method = (values[0] as { method?: unknown } | undefined)?.method;
        if (event === "rpc-register" && typeof method === "string") this.#rpcMethods.add(method);
    }

    on(event: string, listener: (...values: any[]) => void): void {
        this.#listeners.set(event, listener);
    }

    fire(event: string, ...values: unknown[]): void {
        this.#listeners.get(event)?.(...values);
    }

    joinMachine(): void {
        if (this.#closed || this.#subscribed || this.#dedicated !== undefined) return;
        this.#subscribed = true;
        this.fire("connect");
    }

    leaveMachine(): void {
        this.#subscribed = false;
        this.#rpcMethods.clear();
    }

    useDedicated(): void {
        if (this.#closed || this.#dedicated !== undefined) return;
        this.leaveMachine();
        const socket = this.#owner.openDedicated(this.remoteSessionId);
        for (const event of FORWARDED_EVENTS) {
            socket.on(event, (...values: unknown[]) => {
                if (this.#dedicated === socket) this.fire(event, ...values);
            });
        }
        this.#dedicated = socket;
        socket.connect();
    }

    leaveDedicated(): void {
        const socket = this.#dedicated;
        this.#dedicated = undefined;
        socket?.disconnect();
    }
}
