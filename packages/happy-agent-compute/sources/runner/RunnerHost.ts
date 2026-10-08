import { randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import { detach, type Context } from "@steve.kite/stdlib";

import type { Compute } from "../Compute.js";
import type { ComputeSessionExit } from "../ComputeShell.js";
import type { RunnerChannel } from "./RunnerChannel.js";
import {
    RunnerBusyError,
    RunnerComputeUnknownError,
    RunnerProtocolError,
    RunnerUnavailableError,
} from "./RunnerErrors.js";
import type { RunnerFrame } from "./impl/runnerFrameCodec.js";
import { runnerErrorFromException } from "./impl/runnerErrorTransfer.js";
import { runnerHostHandlers, type RunnerHandlerScope } from "./impl/runnerHostHandlers.js";
import type { RunnerHostStreamControl, RunnerHostStreamOutput } from "./impl/runnerHostStreams.js";
import { RunnerPeer } from "./impl/RunnerPeer.js";
import { RunnerStreamReceiver } from "./impl/RunnerStreamReceiver.js";
import { RunnerStreamSender } from "./impl/RunnerStreamSender.js";
import {
    MAX_RUNNER_COMPUTES,
    MAX_RUNNER_IN_FLIGHT_REQUESTS,
    MAX_RUNNER_RETAINED_EVENTS,
    MAX_RUNNER_STREAMS,
    MIN_RUNNER_PROTOCOL_VERSION,
    RUNNER_PROTOCOL_VERSION,
    runnerMethods,
    type RunnerEvent,
    type RunnerEventParams,
    type RunnerFrameHeader,
    type RunnerIdentity,
    type RunnerMethod,
    type RunnerDocker,
    type RunnerProjectPolicy,
    type RunnerStreamChannel,
} from "./runnerProtocol.js";

/** What a runner is asked to build when a daemon wants a machine in a folder. */
export interface RunnerComputeRequest {
    readonly cwd: string;
    readonly policy: RunnerProjectPolicy;
    /** Run agent work in a container of this image, with `cwd` mounted at the same path. */
    readonly docker?: RunnerDocker;
}

export interface RunnerHostOptions {
    /**
     * The runner process's own context. Every connection and every compute derives a separately
     * named lifetime from it, so nothing a daemon starts is owned by the request that started it.
     */
    readonly ctx: Context;
    readonly identity: RunnerIdentity;
    /** Build one machine. On a real runner this is the host compute with the runner's own policy. */
    readonly createCompute: (ctx: Context, request: RunnerComputeRequest) => Promise<Compute>;
    /** How long a daemon has to answer the runner's hello. */
    readonly handshakeTimeoutMs?: number;
    readonly pingIntervalMs?: number;
    readonly idleTimeoutMs?: number;
}

interface HostedCompute {
    readonly compute: Compute;
    readonly cwd: string;
    readonly image: string | undefined;
    readonly ctx: Context;
}

type ExitFrame = Extract<RunnerFrameHeader, { type: "exit" }>;

/**
 * One process, watch, or connection the runner holds for the daemon. It belongs to the daemon
 * process rather than to a connection, so it survives a reconnect within the lease: unacknowledged
 * output is sent again, and the exit is kept until the daemon releases the stream.
 */
interface HostedStream {
    readonly id: number;
    readonly computeId: string;
    readonly out: RunnerStreamSender;
    readonly err: RunnerStreamSender;
    readonly input: RunnerStreamReceiver;
    readonly started: Promise<RunnerHostStreamControl | undefined>;
    control: RunnerHostStreamControl | undefined;
    inputChain: Promise<void>;
    outEnded: boolean;
    errEnded: boolean;
    exit: ExitFrame | undefined;
    exitSent: boolean;
    stopped: boolean;
}

interface RetainedEvent {
    readonly seq: number;
    readonly event: RunnerEvent;
    readonly params: unknown;
}

interface Connection {
    readonly peer: RunnerPeer;
    readonly ctx: Context;
    readonly inFlight: Map<number, AbortController>;
    released: boolean;
}

/**
 * Everything one daemon process holds on this runner.
 *
 * It outlives any single connection: a daemon whose link drops and comes back within its lease
 * finds its computes, its running commands, and the exits it has not heard about yet exactly where
 * it left them. It does not outlive the daemon process — a new process, or one that stayed away
 * longer than its lease, finds nothing, because the plan is that nothing a daemon started survives
 * it.
 */
interface Owner {
    readonly instanceId: string;
    readonly epoch: string;
    readonly computes: Map<string, HostedCompute>;
    readonly creating: Map<string, Promise<HostedCompute>>;
    readonly streams: Map<number, HostedStream>;
    readonly events: RetainedEvent[];
    nextSeq: number;
    connection: Connection | undefined;
    leaseTimer: NodeJS.Timeout | undefined;
    leaseGraceMs: number;
    released: boolean;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * The runner side of the runner protocol: serves one daemon's computes over whatever connection
 * the daemon reached it by.
 *
 * A runner belongs to exactly one daemon at a time, and to that daemon's current process. A
 * connection from a new process of the daemon releases everything the previous one held before
 * anything else happens. A connection from the same process replaces a stale one and carries on.
 * A connection that ends unannounced starts the lease; one that ends with a goodbye releases at
 * once.
 */
export class RunnerHost {
    readonly #ctx: Context;
    readonly #options: RunnerHostOptions;
    readonly #pending = new Set<Promise<void>>();
    #owner: Owner | undefined;
    #disposed = false;

    constructor(options: RunnerHostOptions) {
        this.#ctx = options.ctx;
        this.#options = options;
    }

    /** How many computes the runner holds right now. */
    computeCount(): number {
        return this.#owner?.computes.size ?? 0;
    }

    /** Whether the current daemon process holds a live connection. */
    connected(): boolean {
        return this.#owner?.connection !== undefined;
    }

    /**
     * Serve one connection from the daemon until it ends, and resolve with why it ended.
     *
     * The runner speaks first, then waits for the daemon's welcome; nothing else is accepted until
     * the handshake completes.
     */
    serve(channel: RunnerChannel): Promise<string> {
        if (this.#disposed) {
            channel.close("The runner is shutting down.");
            return Promise.resolve("The runner is shutting down.");
        }
        return new Promise((resolve) => {
            const ctx = detach(this.#ctx).named("runner-connection");
            let connection: Connection | undefined;
            let owner: Owner | undefined;
            const handshakeTimer = setTimeout(
                () => peer.close("The daemon did not finish the handshake in time."),
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
                    if (connection !== undefined && owner !== undefined) {
                        this.#receive(owner, connection, frame);
                        return;
                    }
                    if (frame.header.type !== "welcome") {
                        throw new RunnerProtocolError(
                            "The daemon must answer the runner's hello with a welcome.",
                        );
                    }
                    clearTimeout(handshakeTimer);
                    const { protocol, instanceId, leaseGraceMs } = frame.header;
                    if (
                        protocol < MIN_RUNNER_PROTOCOL_VERSION ||
                        protocol > RUNNER_PROTOCOL_VERSION
                    ) {
                        peer.close(
                            `The daemon chose runner protocol ${String(protocol)}, which this runner does not speak.`,
                            { goodbye: true },
                        );
                        return;
                    }
                    connection = { peer, ctx, inFlight: new Map(), released: false };
                    owner = this.#adopt(instanceId, leaseGraceMs, connection);
                },
                onClose: (reason) => {
                    clearTimeout(handshakeTimer);
                    if (connection !== undefined && owner !== undefined) {
                        this.#disconnected(owner, connection, reason);
                    }
                    resolve(reason);
                },
            });
            peer.send({
                type: "hello",
                protocol: { min: MIN_RUNNER_PROTOCOL_VERSION, max: RUNNER_PROTOCOL_VERSION },
                runner: this.#options.identity,
            });
        });
    }

    /** Close the connection and stop every compute, waiting until each one is gone. */
    async dispose(ctx: Context): Promise<void> {
        this.#disposed = true;
        if (this.#owner !== undefined) this.#release(this.#owner, "The runner is shutting down.");
        while (this.#pending.size > 0) {
            await Promise.allSettled(this.#pending);
        }
        ctx.log.info("runner:host:disposed");
    }

    #adopt(instanceId: string, leaseGraceMs: number, connection: Connection): Owner {
        let owner = this.#owner;
        if (owner !== undefined && owner.instanceId !== instanceId) {
            this.#release(owner, "A new daemon process connected to the runner.");
            owner = undefined;
        }
        if (owner === undefined) {
            owner = {
                instanceId,
                epoch: randomUUID(),
                computes: new Map(),
                creating: new Map(),
                streams: new Map(),
                events: [],
                nextSeq: 1,
                connection: undefined,
                leaseTimer: undefined,
                leaseGraceMs,
                released: false,
            };
            this.#owner = owner;
        }
        clearTimeout(owner.leaseTimer);
        owner.leaseTimer = undefined;
        owner.leaseGraceMs = leaseGraceMs;
        const previous = owner.connection;
        owner.connection = connection;
        previous?.peer.close("A newer connection from the same daemon replaced this one.");
        connection.ctx.log.info(
            `runner:host:connected computes=${String(owner.computes.size)} events=${String(owner.events.length)}`,
        );
        connection.peer.send({
            type: "ready",
            epoch: owner.epoch,
            computes: [...owner.computes.keys()],
            streams: [...owner.streams.keys()],
        });
        for (const computeId of owner.computes.keys()) this.#sendSessions(owner, computeId);
        for (const retained of owner.events) {
            connection.peer.send({
                type: "event",
                seq: retained.seq,
                event: retained.event,
                params: retained.params,
            });
        }
        for (const stream of owner.streams.values()) {
            stream.out.resend();
            stream.err.resend();
            if (stream.exitSent && stream.exit !== undefined) connection.peer.send(stream.exit);
            connection.peer.send({
                type: "flow",
                stream: stream.id,
                channel: "in",
                consumed: stream.input.consumed,
            });
        }
        return owner;
    }

    #receive(owner: Owner, connection: Connection, frame: RunnerFrame): void {
        const { header } = frame;
        switch (header.type) {
            case "request":
                void this.#answer(
                    owner,
                    connection,
                    header.id,
                    header.method,
                    header.params,
                    frame.body,
                );
                return;
            case "cancel":
                connection.inFlight.get(header.id)?.abort();
                return;
            case "ack": {
                const keep = owner.events.filter((event) => event.seq > header.seq);
                owner.events.splice(0, owner.events.length, ...keep);
                return;
            }
            case "goodbye":
                connection.released = true;
                connection.peer.close(header.reason);
                return;
            case "data": {
                const stream = owner.streams.get(header.stream);
                if (stream === undefined) return;
                if (header.channel !== "in") throw this.#wrongChannel(header.type);
                const fresh = stream.input.accept(header.offset, frame.body ?? new Uint8Array(0));
                if (fresh.byteLength === 0) return;
                stream.inputChain = stream.inputChain
                    .then(() => stream.control?.input(fresh))
                    .catch(() => undefined)
                    .then(() => {
                        const consumed = stream.input.consume(fresh.byteLength);
                        owner.connection?.peer.send({
                            type: "flow",
                            stream: stream.id,
                            channel: "in",
                            consumed,
                        });
                    });
                return;
            }
            case "eof": {
                const stream = owner.streams.get(header.stream);
                if (stream === undefined) return;
                if (header.channel !== "in") throw this.#wrongChannel(header.type);
                if (!stream.input.acceptEnd(header.offset)) return;
                stream.inputChain = stream.inputChain.then(() => stream.control?.endInput());
                return;
            }
            case "flow": {
                const stream = owner.streams.get(header.stream);
                if (stream === undefined) return;
                if (header.channel === "in") throw this.#wrongChannel(header.type);
                try {
                    (header.channel === "out" ? stream.out : stream.err).acknowledge(
                        header.consumed,
                    );
                } catch (error) {
                    throw new RunnerProtocolError(
                        error instanceof Error ? error.message : String(error),
                    );
                }
                return;
            }
            case "close": {
                const stream = owner.streams.get(header.stream);
                if (stream !== undefined) this.#stopStream(stream);
                return;
            }
            case "release": {
                const stream = owner.streams.get(header.stream);
                if (stream === undefined) return;
                owner.streams.delete(stream.id);
                if (stream.exit === undefined) this.#stopStream(stream);
                return;
            }
            default:
                throw new RunnerProtocolError(
                    `The daemon sent a ${header.type} frame, which only a runner may send.`,
                );
        }
    }

    #wrongChannel(type: string): RunnerProtocolError {
        return new RunnerProtocolError(`The daemon sent a ${type} frame on the wrong channel.`);
    }

    /**
     * Register a stream before starting it, so output produced while it starts is already routed,
     * then start it with the compute's own lifetime rather than the request's.
     */
    async #openStream(
        owner: Owner,
        computeId: string,
        id: number,
        start: (ctx: Context, output: RunnerHostStreamOutput) => Promise<RunnerHostStreamControl>,
    ): Promise<void> {
        const hosted = owner.released ? undefined : owner.computes.get(computeId);
        if (hosted === undefined) throw new RunnerComputeUnknownError();
        if (owner.streams.has(id)) {
            throw new RunnerProtocolError("The daemon reused a stream that is still open.");
        }
        if (owner.streams.size >= MAX_RUNNER_STREAMS) {
            throw new RunnerBusyError(
                "The runner already holds as many programs, watches, and connections as it allows.",
            );
        }
        let resolveStarted!: (control: RunnerHostStreamControl | undefined) => void;
        const started = new Promise<RunnerHostStreamControl | undefined>((resolve) => {
            resolveStarted = resolve;
        });
        const transmit = (channel: RunnerStreamChannel) => ({
            data: (offset: number, chunk: Uint8Array) => {
                owner.connection?.peer.send({ type: "data", stream: id, channel, offset }, chunk);
            },
            eof: (offset: number) => {
                owner.connection?.peer.send({ type: "eof", stream: id, channel, offset });
                if (channel === "out") stream.outEnded = true;
                else stream.errEnded = true;
                this.#sendStreamExit(owner, stream);
            },
        });
        const stream: HostedStream = {
            id,
            computeId,
            out: new RunnerStreamSender(transmit("out")),
            err: new RunnerStreamSender(transmit("err")),
            input: new RunnerStreamReceiver(),
            started,
            control: undefined,
            inputChain: started.then(() => undefined),
            outEnded: false,
            errEnded: false,
            exit: undefined,
            exitSent: false,
            stopped: false,
        };
        owner.streams.set(id, stream);
        const output: RunnerHostStreamOutput = {
            out: stream.out,
            err: stream.err,
            exit: (exit) => {
                if (stream.exit !== undefined) return;
                stream.exit = {
                    type: "exit",
                    stream: id,
                    exitCode: exit.exitCode,
                    signal: exit.signal,
                    ...(exit.error === undefined ? {} : { error: exit.error }),
                };
                stream.out.end();
                stream.err.end();
                this.#sendStreamExit(owner, stream);
            },
        };
        try {
            stream.control = await start(hosted.ctx, output);
            resolveStarted(stream.control);
            if (stream.stopped) stream.control.stop();
        } catch (error) {
            resolveStarted(undefined);
            if (owner.streams.get(id) === stream) owner.streams.delete(id);
            throw error;
        }
    }

    #sendStreamExit(owner: Owner, stream: HostedStream): void {
        if (stream.exitSent || stream.exit === undefined) return;
        if (!stream.outEnded || !stream.errEnded) return;
        stream.exitSent = true;
        owner.connection?.peer.send(stream.exit);
    }

    #stopStream(stream: HostedStream): void {
        stream.stopped = true;
        stream.control?.stop();
    }

    async #answer(
        owner: Owner,
        connection: Connection,
        id: number,
        method: string,
        params: unknown,
        body: Uint8Array | undefined,
    ): Promise<void> {
        const respondWithError = (error: unknown) =>
            connection.peer.send({ type: "response", id, error: runnerErrorFromException(error) });
        if (connection.inFlight.size >= MAX_RUNNER_IN_FLIGHT_REQUESTS) {
            respondWithError(
                new RunnerBusyError(
                    "The runner is already handling as many requests as it accepts.",
                ),
            );
            return;
        }
        if (!Object.hasOwn(runnerMethods, method)) {
            respondWithError(
                new RunnerProtocolError(`The runner does not know the request ${method}.`),
            );
            return;
        }
        const known = method as RunnerMethod;
        if (!Value.Check(runnerMethods[known].params, params)) {
            respondWithError(
                new RunnerProtocolError(`The daemon sent invalid parameters for ${known}.`),
            );
            return;
        }
        const controller = new AbortController();
        connection.inFlight.set(id, controller);
        try {
            const scope = this.#scope(owner, connection, controller.signal, body);
            const handler = runnerHostHandlers[known] as (
                scope: RunnerHandlerScope,
                params: unknown,
            ) => Promise<{ result: unknown; body?: Uint8Array }>;
            const answer = await handler(scope, params);
            try {
                connection.peer.send({ type: "response", id, result: answer.result }, answer.body);
            } catch (error) {
                respondWithError(error);
            }
        } catch (error) {
            respondWithError(error);
        } finally {
            connection.inFlight.delete(id);
        }
    }

    #scope(
        owner: Owner,
        connection: Connection,
        signal: AbortSignal,
        body: Uint8Array | undefined,
    ): RunnerHandlerScope {
        return {
            ctx: connection.ctx,
            signal,
            body: body ?? new Uint8Array(0),
            compute: (computeId) => {
                const hosted = owner.released ? undefined : owner.computes.get(computeId);
                if (hosted === undefined) throw new RunnerComputeUnknownError();
                return hosted.compute;
            },
            createCompute: (computeId, cwd, policy, docker) =>
                this.#createCompute(owner, computeId, cwd, policy, docker),
            openStream: (computeId, id, start) => this.#openStream(owner, computeId, id, start),
            stream: (id) => {
                const control = owner.streams.get(id)?.control;
                if (control === undefined) {
                    throw Object.assign(new Error("The runner is not running that program."), {
                        code: "ESRCH",
                    });
                }
                return control;
            },
            disposeCompute: async (computeId) => {
                const hosted = owner.computes.get(computeId);
                if (hosted === undefined) return;
                for (const stream of owner.streams.values()) {
                    if (stream.computeId === computeId) this.#stopStream(stream);
                }
                owner.computes.delete(computeId);
                this.#silence(hosted.compute);
                await hosted.compute.dispose(connection.ctx);
            },
        };
    }

    async #createCompute(
        owner: Owner,
        computeId: string,
        cwd: string,
        policy: RunnerProjectPolicy,
        docker: RunnerDocker | undefined,
    ): Promise<{ compute: Compute; retained: boolean }> {
        const existing = owner.computes.get(computeId) ?? (await owner.creating.get(computeId));
        if (existing !== undefined) {
            if (existing.cwd !== cwd || existing.image !== docker?.image) {
                throw Object.assign(
                    new Error("The runner already holds this machine in a different folder."),
                    { code: "EEXIST" },
                );
            }
            return { compute: existing.compute, retained: true };
        }
        if (owner.computes.size + owner.creating.size >= MAX_RUNNER_COMPUTES) {
            throw new RunnerBusyError("The runner already holds as many machines as it allows.");
        }
        const creating = this.#buildCompute(owner, computeId, cwd, policy, docker);
        owner.creating.set(computeId, creating);
        try {
            const hosted = await creating;
            return { compute: hosted.compute, retained: false };
        } finally {
            owner.creating.delete(computeId);
        }
    }

    async #buildCompute(
        owner: Owner,
        computeId: string,
        cwd: string,
        policy: RunnerProjectPolicy,
        docker: RunnerDocker | undefined,
    ): Promise<HostedCompute> {
        const ctx = detach(this.#ctx).named("runner-compute");
        const compute = await this.#options.createCompute(ctx, {
            cwd,
            policy,
            ...(docker === undefined ? {} : { docker }),
        });
        if (owner.released || this.#disposed) {
            await compute.dispose(ctx);
            throw new RunnerUnavailableError(
                "The runner released this daemon's machines while one was being created.",
            );
        }
        const hosted: HostedCompute = { compute, cwd, image: docker?.image, ctx };
        owner.computes.set(computeId, hosted);
        compute.shell.setActiveSessionCountListener?.(() => this.#sendSessions(owner, computeId));
        compute.shell.setSessionExitListener?.((exit) => this.#emitExit(owner, computeId, exit));
        return hosted;
    }

    #sendSessions(owner: Owner, computeId: string): void {
        const hosted = owner.computes.get(computeId);
        if (hosted === undefined || owner.released) return;
        const shell = hosted.compute.shell;
        const sessions = (shell.activeSessions?.() ?? []).slice(0, 4096).map((session) => ({
            command: session.command,
            cwd: session.cwd,
            sessionId: session.sessionId,
            status: session.status,
            ...(shell.sessionUsesSecrets?.(session.sessionId) === true
                ? { usesSecrets: true }
                : {}),
        }));
        this.#sendEvent(owner, "shell.sessions", { computeId, sessions });
    }

    #emitExit(owner: Owner, computeId: string, exit: ComputeSessionExit): void {
        if (owner.released || !owner.computes.has(computeId)) return;
        const retained: RetainedEvent = {
            seq: owner.nextSeq++,
            event: "shell.exit",
            params: {
                computeId,
                exit: {
                    command: exit.command,
                    exitCode: exit.exitCode,
                    sessionId: exit.sessionId,
                    status: exit.status,
                },
            } satisfies RunnerEventParams<"shell.exit">,
        };
        owner.events.push(retained);
        if (owner.events.length > MAX_RUNNER_RETAINED_EVENTS) owner.events.shift();
        owner.connection?.peer.send({
            type: "event",
            seq: retained.seq,
            event: retained.event,
            params: retained.params,
        });
    }

    #sendEvent<Event extends RunnerEvent>(
        owner: Owner,
        event: Event,
        params: RunnerEventParams<Event>,
    ): void {
        owner.connection?.peer.send({ type: "event", event, params });
    }

    #disconnected(owner: Owner, connection: Connection, reason: string): void {
        for (const controller of connection.inFlight.values()) controller.abort();
        connection.inFlight.clear();
        if (owner.connection !== connection) return;
        owner.connection = undefined;
        connection.ctx.log.info(`runner:host:disconnected reason=${JSON.stringify(reason)}`);
        if (owner.released) return;
        if (connection.released || this.#disposed) {
            this.#release(owner, "The daemon released its machines.");
            return;
        }
        owner.leaseTimer = setTimeout(() => {
            if (owner.connection === undefined) {
                this.#release(owner, "The daemon did not come back before its lease ran out.");
            }
        }, owner.leaseGraceMs);
        owner.leaseTimer.unref?.();
    }

    /** Stop everything a daemon process holds here. Disposal runs on the runner's own lifetime. */
    #release(owner: Owner, reason: string): void {
        if (owner.released) return;
        owner.released = true;
        clearTimeout(owner.leaseTimer);
        if (this.#owner === owner) this.#owner = undefined;
        owner.connection?.peer.close(reason, { goodbye: true });
        const hosted = [...owner.computes.values()];
        owner.computes.clear();
        owner.events.length = 0;
        for (const stream of owner.streams.values()) {
            this.#stopStream(stream);
            stream.out.fail();
            stream.err.fail();
        }
        owner.streams.clear();
        this.#ctx.log.info(
            `runner:host:released computes=${String(hosted.length)} reason=${JSON.stringify(reason)}`,
        );
        for (const { compute, ctx } of hosted) {
            this.#silence(compute);
            this.#track(
                compute.dispose(ctx).catch((error: unknown) => {
                    ctx.log.warn(
                        `runner:host:dispose-failed error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
                    );
                }),
            );
        }
    }

    #silence(compute: Compute): void {
        compute.shell.setActiveSessionCountListener?.(undefined);
        compute.shell.setSessionExitListener?.(undefined);
    }

    #track(work: Promise<void>): void {
        this.#pending.add(work);
        void work.finally(() => this.#pending.delete(work));
    }
}
