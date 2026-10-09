import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { RunnerChannel } from "./RunnerChannel.js";
import {
    RunnerDisconnectedError,
    RunnerIncompatibleError,
    RunnerProtocolError,
    RunnerUnavailableError,
} from "./RunnerErrors.js";
import type { RunnerFrame } from "./impl/runnerFrameCodec.js";
import { runnerErrorToException } from "./impl/runnerErrorTransfer.js";
import { RunnerPeer } from "./impl/RunnerPeer.js";
import { RunnerStreamReceiver } from "./impl/RunnerStreamReceiver.js";
import { RunnerStreamSender } from "./impl/RunnerStreamSender.js";
import {
    DEFAULT_RUNNER_LEASE_GRACE_MS,
    MIN_RUNNER_PROTOCOL_VERSION,
    RUNNER_PROTOCOL_VERSION,
    runnerEvents,
    runnerMethods,
    type RunnerEvent,
    type RunnerEventParams,
    type RunnerIdentity,
    type RunnerMethod,
    type RunnerMethodParams,
    type RunnerMethodResult,
} from "./runnerProtocol.js";

/** What a stream's owner is told as the runner reports on it. */
export interface RunnerStreamHandlers {
    /** New bytes on an output channel, never a duplicate. Report them consumed once handled. */
    data(channel: "out" | "err", chunk: Uint8Array): void;
    /** An output channel ended. */
    eof(channel: "out" | "err"): void;
    /** The stream ended, after both output channels. */
    exit(exit: { exitCode: number | null; signal: string | null; error?: Error }): void;
    /** The runner no longer holds the stream: it restarted, or this daemon stayed away too long. */
    lost(reason: string): void;
}

/** The daemon's handle on one process, watch, or connection on a runner. */
export interface RunnerStream {
    readonly id: number;
    /** Send input, resolving once it fits in the window. Survives reconnects within the lease. */
    write(chunk: Uint8Array): Promise<void>;
    /** End the input channel once everything written has been sent. */
    end(): void;
    /** Bytes of an output channel handed to their consumer, freeing the runner to send more. */
    consumed(channel: "out" | "err", bytes: number): void;
    /** Ask the runner to stop the stream now. Its exit still arrives. */
    close(): void;
    /** Stop routing the stream and tell the runner to forget it, stopping it if it still runs. */
    forget(): void;
}

interface LinkStream {
    readonly id: number;
    readonly handlers: RunnerStreamHandlers;
    readonly input: RunnerStreamSender;
    readonly out: RunnerStreamReceiver;
    readonly err: RunnerStreamReceiver;
    closeRequested: boolean;
}

/** Extra time the daemon gives a runner beyond the lease before treating its streams as gone. */
const RUNNER_LEASE_MARGIN_MS = 5_000;

export interface RunnerLinkOptions {
    /** How people know this runner, used in every message about it. */
    readonly name: string;
    /**
     * Identifies the daemon process. It must change every time the daemon starts: a runner releases
     * everything a previous process held as soon as a new one connects.
     */
    readonly instanceId: string;
    /** How long the runner keeps this daemon's machines while the connection is down. */
    readonly leaseGraceMs?: number;
    readonly handshakeTimeoutMs?: number;
    readonly pingIntervalMs?: number;
    readonly idleTimeoutMs?: number;
}

/** Whether a runner is reachable right now, and what it said about itself when it last was. */
export interface RunnerLinkStatus {
    readonly state: "connected" | "disconnected" | "closed";
    readonly runner?: RunnerIdentity;
    readonly protocol?: number;
    /** When the current connection completed its handshake, or the last one ended. */
    readonly since: number;
    /** Why the last connection ended, in words a person can read. */
    readonly reason?: string;
}

/** How a call is made on one live connection. */
export interface RunnerRequestOptions {
    readonly body?: Uint8Array;
    readonly signal?: AbortSignal;
}

/** What a call returns: its validated result and, for byte-returning methods, the body. */
export interface RunnerResponse<Method extends RunnerMethod> {
    readonly result: RunnerMethodResult<Method>;
    readonly body?: Uint8Array;
}

/** One live connection to a runner, as a compute sees it. */
export interface RunnerConnection {
    readonly runner: RunnerIdentity;
    readonly protocol: number;
    request<Method extends RunnerMethod>(
        method: Method,
        params: RunnerMethodParams<Method>,
        options?: RunnerRequestOptions,
    ): Promise<RunnerResponse<Method>>;
}

/** What a compute on the runner is told about its connection. */
export interface RunnerComputeHooks {
    /** A connection completed its handshake; `retained` says whether the runner still holds it. */
    attached(connection: RunnerConnection, retained: boolean): void;
    /** Something the runner reported about this compute. */
    event<Event extends RunnerEvent>(event: Event, params: RunnerEventParams<Event>): void;
    /** The runner has certainly released this compute: it stayed away longer than the lease. */
    lost(reason: string): void;
}

interface PendingRequest {
    readonly method: RunnerMethod;
    readonly resolve: (response: RunnerResponse<RunnerMethod>) => void;
    readonly reject: (error: unknown) => void;
}

interface Session extends RunnerConnection {
    readonly peer: RunnerPeer;
    readonly pending: Map<number, PendingRequest>;
    nextId: number;
}

interface Waiter {
    readonly resolve: (connection: RunnerConnection) => void;
    readonly reject: (error: unknown) => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * The daemon's side of one registered runner, across every connection it makes.
 *
 * A runner dials the daemon, so the link does not connect anywhere: whoever authenticates the
 * runner's transport hands the channel to {@link accept}. A newer connection replaces an older
 * one. Computes built on the link survive a reconnect within the runner's lease and are rebuilt on
 * the next call after one that did not, with the commands they lost reported as killed.
 *
 * Nothing is replayed. A request in flight when a connection ends fails with an unknown outcome,
 * and the caller decides what to do — a command that may have run must never run twice because a
 * network link dropped.
 */
export class RunnerLink {
    readonly #ctx: Context;
    readonly #options: RunnerLinkOptions;
    readonly #computes = new Map<string, RunnerComputeHooks>();
    readonly #streams = new Map<number, LinkStream>();
    #nextStreamId = 1;
    #leaseTimer: NodeJS.Timeout | undefined;
    readonly #pendingDisposals = new Set<string>();
    readonly #waiters = new Set<Waiter>();
    readonly #statusListeners = new Set<(status: RunnerLinkStatus) => void>();
    #session: Session | undefined;
    #status: RunnerLinkStatus = { state: "disconnected", since: Date.now() };
    #epoch: string | undefined;
    #lastSeq = 0;
    #closed = false;

    constructor(ctx: Context, options: RunnerLinkOptions) {
        this.#ctx = ctx;
        this.#options = options;
    }

    get name(): string {
        return this.#options.name;
    }

    status(): RunnerLinkStatus {
        return this.#status;
    }

    /** Hear every status change. Returns the function that stops listening. */
    onStatus(listener: (status: RunnerLinkStatus) => void): () => void {
        this.#statusListeners.add(listener);
        return () => this.#statusListeners.delete(listener);
    }

    /**
     * Speak the protocol over a channel the runner opened, and make it the current connection once
     * the handshake completes. Resolves with the new status; rejects when the handshake fails.
     */
    accept(channel: RunnerChannel): Promise<RunnerLinkStatus> {
        if (this.#closed) {
            channel.close(`The runner ${this.#options.name} has been removed.`);
            return Promise.reject(this.#unavailable());
        }
        return new Promise((resolve, reject) => {
            let stage: "hello" | "ready" | "open" = "hello";
            let session: Session | undefined;
            let runner: RunnerIdentity | undefined;
            let protocol = 0;
            const handshakeTimer = setTimeout(
                () => peer.close("The runner did not finish the handshake in time."),
                this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
            );
            handshakeTimer.unref?.();
            const peer: RunnerPeer = new RunnerPeer({
                channel,
                ...(this.#options.pingIntervalMs === undefined
                    ? {}
                    : { pingIntervalMs: this.#options.pingIntervalMs }),
                ...(this.#options.idleTimeoutMs === undefined
                    ? {}
                    : { idleTimeoutMs: this.#options.idleTimeoutMs }),
                onFrame: (frame) => {
                    if (stage === "open" && session !== undefined) {
                        this.#receive(session, frame);
                        return;
                    }
                    const { header } = frame;
                    if (stage === "hello" && header.type === "hello") {
                        protocol = Math.min(header.protocol.max, RUNNER_PROTOCOL_VERSION);
                        if (protocol < Math.max(header.protocol.min, MIN_RUNNER_PROTOCOL_VERSION)) {
                            const error = new RunnerIncompatibleError(
                                `The runner ${this.#options.name} speaks runner protocol ` +
                                    `${String(header.protocol.min)}–${String(header.protocol.max)}, but this ` +
                                    `daemon speaks ${String(MIN_RUNNER_PROTOCOL_VERSION)}–` +
                                    `${String(RUNNER_PROTOCOL_VERSION)}. Upgrade the older of the two.`,
                            );
                            // Reject first: closing reports the handshake as merely interrupted.
                            reject(error);
                            peer.close(error.message, { goodbye: true });
                            return;
                        }
                        runner = header.runner;
                        stage = "ready";
                        peer.send({
                            type: "welcome",
                            protocol,
                            instanceId: this.#options.instanceId,
                            leaseGraceMs:
                                this.#options.leaseGraceMs ?? DEFAULT_RUNNER_LEASE_GRACE_MS,
                        });
                        return;
                    }
                    if (stage === "ready" && header.type === "ready" && runner !== undefined) {
                        clearTimeout(handshakeTimer);
                        session = this.#openSession(peer, runner, protocol);
                        stage = "open";
                        this.#install(session, header.epoch, header.computes, header.streams);
                        resolve(this.#status);
                        return;
                    }
                    throw new RunnerProtocolError(
                        `The runner sent a ${header.type} frame before finishing its handshake.`,
                    );
                },
                onClose: (reason) => {
                    clearTimeout(handshakeTimer);
                    if (session === undefined) {
                        reject(
                            new RunnerUnavailableError(
                                `The runner ${this.#options.name} disconnected during its handshake: ${reason}`,
                            ),
                        );
                        return;
                    }
                    this.#lost(session, reason);
                },
            });
        });
    }

    /**
     * The current connection, waiting for the runner to come back until `waitMs` after it went
     * away. The window is counted from the drop, not from each call: it bridges a brief drop,
     * while a runner that has been away longer fails every call at once instead of making each
     * one wait in turn. A runner that does not come back in time is an error that says so;
     * nothing was sent.
     */
    connection(waitMs: number, signal?: AbortSignal): Promise<RunnerConnection> {
        if (this.#session !== undefined) return Promise.resolve(this.#session);
        const remainingMs = this.#status.since + waitMs - Date.now();
        if (this.#closed || remainingMs <= 0) return Promise.reject(this.#unavailable());
        return new Promise((resolve, reject) => {
            const finish = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                this.#waiters.delete(waiter);
            };
            const waiter: Waiter = {
                resolve: (connection) => {
                    finish();
                    resolve(connection);
                },
                reject: (error) => {
                    finish();
                    reject(error);
                },
            };
            const onAbort = () => waiter.reject(signal?.reason);
            const timer = setTimeout(() => waiter.reject(this.#unavailable()), remainingMs);
            timer.unref?.();
            if (signal?.aborted === true) {
                waiter.reject(signal.reason);
                return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
            this.#waiters.add(waiter);
        });
    }

    /** Route a compute's reports to it. Returns the function that stops routing them. */
    register(computeId: string, hooks: RunnerComputeHooks): () => void {
        this.#computes.set(computeId, hooks);
        return () => {
            if (this.#computes.get(computeId) === hooks) this.#computes.delete(computeId);
        };
    }

    /**
     * Release a compute the runner may still hold. Sent now when connected; otherwise on the next
     * connection, so a machine disposed during an outage does not linger for the rest of the lease.
     */
    dispose(computeId: string): void {
        const session = this.#session;
        if (session === undefined) {
            this.#pendingDisposals.add(computeId);
            return;
        }
        this.#sendDispose(session, computeId);
    }

    /**
     * Stop using this runner. The runner is told to release everything this daemon holds at once,
     * rather than after its lease, and no later connection is accepted.
     */
    close(reason: string): void {
        if (this.#closed) return;
        this.#closed = true;
        clearTimeout(this.#leaseTimer);
        this.#session?.peer.close(reason, { goodbye: true });
        for (const waiter of this.#waiters) waiter.reject(this.#unavailable());
        this.#loseStreams(`The runner ${this.#options.name} has been removed.`);
        this.#setStatus({ state: "closed", since: Date.now(), reason });
    }

    /**
     * Register a stream and return its handle. The caller then asks the runner to start it under
     * this ID; output that arrives before the start is answered is already routed here.
     */
    openStream(handlers: RunnerStreamHandlers): RunnerStream {
        const id = this.#nextStreamId++;
        const send = (header: Parameters<RunnerPeer["send"]>[0], body?: Uint8Array) => {
            this.#session?.peer.send(header, body);
        };
        const stream: LinkStream = {
            id,
            handlers,
            input: new RunnerStreamSender({
                data: (offset, chunk) =>
                    send({ type: "data", stream: id, channel: "in", offset }, chunk),
                eof: (offset) => send({ type: "eof", stream: id, channel: "in", offset }),
            }),
            out: new RunnerStreamReceiver(),
            err: new RunnerStreamReceiver(),
            closeRequested: false,
        };
        this.#streams.set(id, stream);
        return {
            id,
            write: (chunk) => stream.input.write(chunk),
            end: () => stream.input.end(),
            consumed: (channel, bytes) => {
                if (this.#streams.get(id) !== stream) return;
                const receiver = channel === "out" ? stream.out : stream.err;
                send({ type: "flow", stream: id, channel, consumed: receiver.consume(bytes) });
            },
            close: () => {
                stream.closeRequested = true;
                send({ type: "close", stream: id });
            },
            forget: () => {
                if (this.#streams.get(id) !== stream) return;
                this.#streams.delete(id);
                stream.input.fail();
                send({ type: "release", stream: id });
            },
        };
    }

    #openSession(peer: RunnerPeer, runner: RunnerIdentity, protocol: number): Session {
        const session: Session = {
            peer,
            runner,
            protocol,
            pending: new Map(),
            nextId: 1,
            request: (method, params, options) => this.#request(session, method, params, options),
        };
        return session;
    }

    #install(
        session: Session,
        epoch: string,
        retainedComputes: readonly string[],
        retainedStreams: readonly number[],
    ): void {
        const previous = this.#session;
        this.#session = session;
        clearTimeout(this.#leaseTimer);
        this.#leaseTimer = undefined;
        previous?.peer.close("A newer connection from the runner replaced this one.");
        if (epoch !== this.#epoch) {
            this.#epoch = epoch;
            this.#lastSeq = 0;
        }
        this.#ctx.log.info(
            `runner:link:connected name=${JSON.stringify(this.#options.name)} protocol=${String(session.protocol)} retained=${String(retainedComputes.length)}`,
        );
        this.#setStatus({
            state: "connected",
            runner: session.runner,
            protocol: session.protocol,
            since: Date.now(),
        });
        const retained = new Set(retainedComputes);
        for (const [computeId, hooks] of this.#computes) {
            hooks.attached(session, retained.has(computeId));
        }
        const survivors = new Set(retainedStreams);
        // A snapshot: an owner told its stream is lost may open a new one, which is not a survivor.
        for (const stream of Array.from(this.#streams.values())) {
            if (!survivors.has(stream.id)) {
                this.#loseStream(
                    stream,
                    `The runner ${this.#options.name} no longer has this program: it restarted or released this daemon.`,
                );
                continue;
            }
            stream.input.resend();
            for (const channel of ["out", "err"] as const) {
                const consumed = (channel === "out" ? stream.out : stream.err).consumed;
                session.peer.send({ type: "flow", stream: stream.id, channel, consumed });
            }
            if (stream.closeRequested) session.peer.send({ type: "close", stream: stream.id });
        }
        for (const id of survivors) {
            if (this.#streams.has(id)) continue;
            // A stream this daemon gave up on, such as one whose start answer was lost.
            session.peer.send({ type: "close", stream: id });
            session.peer.send({ type: "release", stream: id });
        }
        for (const computeId of this.#pendingDisposals) this.#sendDispose(session, computeId);
        this.#pendingDisposals.clear();
        for (const waiter of this.#waiters) waiter.resolve(session);
    }

    #receiveStream(session: Session, frame: RunnerFrame): void {
        const { header } = frame;
        if (
            header.type !== "data" &&
            header.type !== "eof" &&
            header.type !== "flow" &&
            header.type !== "exit"
        ) {
            return;
        }
        const stream = this.#streams.get(header.stream);
        if (stream === undefined) {
            // Output from a stream already released or never known; an exit still deserves a
            // release so the runner can forget it.
            if (header.type === "exit")
                session.peer.send({ type: "release", stream: header.stream });
            return;
        }
        if (header.type === "exit") {
            this.#streams.delete(stream.id);
            stream.input.fail();
            session.peer.send({ type: "release", stream: stream.id });
            stream.handlers.exit({
                exitCode: header.exitCode,
                signal: header.signal,
                ...(header.error === undefined
                    ? {}
                    : { error: runnerErrorToException(header.error) }),
            });
            return;
        }
        if (header.type === "flow") {
            if (header.channel !== "in") throw this.#wrongChannel(header.type);
            try {
                stream.input.acknowledge(header.consumed);
            } catch (error) {
                throw new RunnerProtocolError(
                    error instanceof Error ? error.message : String(error),
                );
            }
            return;
        }
        if (header.channel === "in") throw this.#wrongChannel(header.type);
        const receiver = header.channel === "out" ? stream.out : stream.err;
        if (header.type === "eof") {
            if (receiver.acceptEnd(header.offset)) stream.handlers.eof(header.channel);
            return;
        }
        const fresh = receiver.accept(header.offset, frame.body ?? new Uint8Array(0));
        if (fresh.byteLength > 0) stream.handlers.data(header.channel, fresh);
    }

    #wrongChannel(type: string): RunnerProtocolError {
        return new RunnerProtocolError(`The runner sent a ${type} frame on the wrong channel.`);
    }

    #loseStream(stream: LinkStream, reason: string): void {
        this.#streams.delete(stream.id);
        stream.input.fail(new RunnerUnavailableError(reason));
        try {
            stream.handlers.lost(reason);
        } catch (error) {
            this.#ctx.log.warn(
                `runner:link:stream-lost-failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
            );
        }
    }

    #loseStreams(reason: string): void {
        // A snapshot: an owner told its stream is lost may already open a new one.
        for (const stream of Array.from(this.#streams.values())) this.#loseStream(stream, reason);
    }

    #receive(session: Session, frame: RunnerFrame): void {
        const { header } = frame;
        switch (header.type) {
            case "response": {
                const pending = session.pending.get(header.id);
                if (pending === undefined) return;
                session.pending.delete(header.id);
                if (header.error !== undefined) {
                    pending.reject(runnerErrorToException(header.error));
                    return;
                }
                const result = header.result ?? {};
                if (!Value.Check(runnerMethods[pending.method].result, result)) {
                    pending.reject(
                        new RunnerProtocolError(
                            `The runner ${this.#options.name} answered ${pending.method} with an invalid result.`,
                        ),
                    );
                    return;
                }
                pending.resolve({
                    result: result as RunnerMethodResult<RunnerMethod>,
                    ...(frame.body === undefined ? {} : { body: frame.body }),
                });
                return;
            }
            case "event": {
                if (header.seq !== undefined) {
                    if (header.seq <= this.#lastSeq) {
                        session.peer.send({ type: "ack", seq: header.seq });
                        return;
                    }
                    this.#lastSeq = header.seq;
                }
                this.#deliver(header.event, header.params);
                if (header.seq !== undefined) session.peer.send({ type: "ack", seq: header.seq });
                return;
            }
            case "goodbye":
                session.peer.close(header.reason);
                return;
            case "data":
            case "eof":
            case "flow":
            case "exit":
                this.#receiveStream(session, frame);
                return;
            default:
                throw new RunnerProtocolError(
                    `The runner sent a ${header.type} frame, which only a daemon may send.`,
                );
        }
    }

    /** Hand an event to its compute. Events this daemon does not understand are ignored. */
    #deliver(event: string, params: unknown): void {
        if (!Object.hasOwn(runnerEvents, event)) return;
        const known = event as RunnerEvent;
        if (!Value.Check(runnerEvents[known], params)) {
            throw new RunnerProtocolError(`The runner sent an invalid ${known} event.`);
        }
        const typed = params as RunnerEventParams<RunnerEvent>;
        const hooks = this.#computes.get(typed.computeId);
        try {
            hooks?.event(known, typed);
        } catch (error) {
            this.#ctx.log.warn(
                `runner:link:event-failed event=${known} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
            );
        }
    }

    #request<Method extends RunnerMethod>(
        session: Session,
        method: Method,
        params: RunnerMethodParams<Method>,
        options: RunnerRequestOptions = {},
    ): Promise<RunnerResponse<Method>> {
        if (session.peer.closed) return Promise.reject(this.#unavailable());
        const { signal } = options;
        if (signal?.aborted === true) return Promise.reject(signal.reason);
        const id = session.nextId++;
        return new Promise<RunnerResponse<Method>>((resolve, reject) => {
            const onAbort = () => {
                if (!session.pending.delete(id)) return;
                session.peer.send({ type: "cancel", id });
                reject(signal?.reason);
            };
            const settle = () => signal?.removeEventListener("abort", onAbort);
            session.pending.set(id, {
                method,
                resolve: (response) => {
                    settle();
                    resolve(response as RunnerResponse<Method>);
                },
                reject: (error) => {
                    settle();
                    reject(error);
                },
            });
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
                session.peer.send({ type: "request", id, method, params }, options.body);
            } catch (error) {
                session.pending.delete(id);
                settle();
                reject(error);
            }
        });
    }

    #sendDispose(session: Session, computeId: string): void {
        void this.#request(session, "compute.dispose", { computeId }).catch((error: unknown) => {
            this.#ctx.log.warn(
                `runner:link:dispose-failed name=${JSON.stringify(this.#options.name)} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
            );
        });
    }

    #lost(session: Session, reason: string): void {
        const pending = [...session.pending.values()];
        session.pending.clear();
        for (const request of pending) {
            request.reject(
                new RunnerDisconnectedError(
                    `The connection to the runner ${this.#options.name} ended before it answered, ` +
                        `so it is unknown whether the work happened: ${reason}`,
                ),
            );
        }
        if (this.#session !== session) return;
        this.#session = undefined;
        this.#ctx.log.info(
            `runner:link:disconnected name=${JSON.stringify(this.#options.name)} reason=${JSON.stringify(reason)}`,
        );
        if (this.#closed) return;
        this.#setStatus({ state: "disconnected", since: Date.now(), reason });
        // The runner releases everything once the lease runs out; stop pretending otherwise.
        this.#leaseTimer = setTimeout(
            () => {
                if (this.#session !== undefined) return;
                const expired = `The runner ${this.#options.name} stayed away longer than its lease, so everything it ran for this daemon was stopped.`;
                this.#loseStreams(expired);
                for (const hooks of this.#computes.values()) hooks.lost(expired);
            },
            (this.#options.leaseGraceMs ?? DEFAULT_RUNNER_LEASE_GRACE_MS) + RUNNER_LEASE_MARGIN_MS,
        );
        this.#leaseTimer.unref?.();
    }

    #unavailable(): RunnerUnavailableError {
        return new RunnerUnavailableError(
            this.#closed
                ? `The runner ${this.#options.name} has been removed.`
                : `The runner ${this.#options.name} is not connected.`,
        );
    }

    #setStatus(status: RunnerLinkStatus): void {
        this.#status = status;
        for (const listener of this.#statusListeners) {
            try {
                listener(status);
            } catch (error) {
                this.#ctx.log.warn(
                    `runner:link:status-listener-failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
                );
            }
        }
    }
}
