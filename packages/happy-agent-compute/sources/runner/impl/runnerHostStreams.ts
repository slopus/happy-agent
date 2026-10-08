import type { Duplex } from "node:stream";

import type { ComputeListener } from "../../ComputeNetwork.js";
import type { ComputeProcess, ComputeProcessSignal } from "../../ComputeProcesses.js";
import type { ComputeWatch, ComputeWatchBatch } from "../../ComputeWatcher.js";
import type { RunnerError } from "../runnerProtocol.js";
import type { RunnerStreamSender } from "./RunnerStreamSender.js";

const MAX_WATCH_BATCH_PATHS = 4096;
/** Accepted connections a listener holds for the daemon to attach. */
const MAX_PENDING_CONNECTIONS = 64;
/** How long an accepted connection waits for the daemon before it is dropped. */
const PENDING_CONNECTION_MS = 30_000;
const encoder = new TextEncoder();

/** What a stream on the runner writes to. */
export interface RunnerHostStreamOutput {
    readonly out: RunnerStreamSender;
    readonly err: RunnerStreamSender;
    /** Report the end. Ends both output channels first if they are still open. */
    exit(exit: { exitCode: number | null; signal: string | null; error?: RunnerError }): void;
}

/** How the runner drives a stream for the daemon. */
export interface RunnerHostStreamControl {
    /** Deliver input; resolves once it was accepted, which is when it is acknowledged. */
    input(chunk: Uint8Array): Promise<void>;
    endInput(): void;
    /** Stop now: kill the process, drop the connection, end the watch. */
    stop(): void;
    resize?(cols: number, rows: number): void;
    signal?(signal: ComputeProcessSignal): void;
    /** A listener's accepted connection, handed over once to be attached to its own stream. */
    take?(connection: number): Duplex | undefined;
}

/** Forward a process's output, pausing it while the daemon has not consumed enough. */
export function runnerHostProcessStream(
    started: ComputeProcess,
    output: RunnerHostStreamOutput,
): RunnerHostStreamControl {
    let paused = false;
    const update = () => {
        const full = output.out.full || output.err.full;
        if (full && !paused) {
            paused = true;
            started.pause();
        } else if (!full && paused) {
            paused = false;
            started.resume();
        }
    };
    output.out.onSpace(update);
    output.err.onSpace(update);
    started.onStdout((chunk) => {
        output.out.push(chunk);
        update();
    });
    started.onStderr((chunk) => {
        output.err.push(chunk);
        update();
    });
    void started.exited.then((exit) => output.exit(exit));
    return {
        async input(chunk) {
            await started.write(chunk);
        },
        endInput: () => started.endInput(),
        stop: () => started.signal("SIGKILL"),
        resize: (cols, rows) => started.resize(cols, rows),
        signal: (signal) => started.signal(signal),
    };
}

/**
 * Forward a watch as newline-delimited JSON batches. While the daemon is behind, batches merge into
 * one, so a busy tree costs one pending batch rather than an unbounded queue.
 */
export function runnerHostWatchStream(
    watch: ComputeWatch,
    output: RunnerHostStreamOutput,
): RunnerHostStreamControl {
    let pending: { paths: Set<string>; overflow: boolean } | undefined;
    const send = (batch: ComputeWatchBatch) =>
        output.out.push(encoder.encode(`${JSON.stringify(batch)}\n`));
    const flush = () => {
        if (pending === undefined || output.out.full) return;
        const batch = { paths: [...pending.paths], overflow: pending.overflow };
        pending = undefined;
        send(batch);
    };
    output.out.onSpace(flush);
    watch.onChange((batch) => {
        pending ??= { paths: new Set(), overflow: false };
        if (batch.overflow) pending.overflow = true;
        for (const path of batch.paths) pending.paths.add(path);
        if (pending.paths.size > MAX_WATCH_BATCH_PATHS) {
            pending.paths.clear();
            pending.overflow = true;
        }
        if (pending.overflow) pending.paths.clear();
        flush();
    });
    void watch.closed.then(({ reason }) => {
        flush();
        output.exit({
            exitCode: null,
            signal: null,
            ...(reason === undefined ? {} : { error: { name: "Error", message: reason } }),
        });
    });
    return {
        input: async () => undefined,
        endInput: () => undefined,
        stop: () => watch.close(),
    };
}

/** Forward a connection in both directions, pausing reads while the daemon is behind. */
export function runnerHostSocketStream(
    socket: Duplex,
    output: RunnerHostStreamOutput,
): RunnerHostStreamControl {
    output.out.onSpace(() => {
        if (!output.out.full) socket.resume();
    });
    socket.on("data", (chunk: Buffer) => {
        output.out.push(chunk);
        if (output.out.full) socket.pause();
    });
    socket.on("end", () => output.out.end());
    let failure: Error | undefined;
    socket.on("error", (error) => {
        failure = error;
    });
    socket.on("close", () => {
        output.exit({
            exitCode: null,
            signal: null,
            ...(failure === undefined
                ? {}
                : { error: { name: failure.name, message: failure.message } }),
        });
    });
    // An accepted connection arrives paused; nothing is read until the daemon has a stream for it.
    if (!output.out.full) socket.resume();
    return {
        input: (chunk) =>
            new Promise((resolve) => {
                if (socket.destroyed || socket.writableEnded) {
                    resolve();
                    return;
                }
                socket.write(chunk, () => resolve());
            }),
        endInput: () => socket.end(),
        stop: () => socket.destroy(),
    };
}

/**
 * Announce a listener's connections as newline-delimited JSON. Each waits, paused, until the daemon
 * attaches it to a stream of its own with `net.accept`, or is dropped when the daemon never does.
 */
export function runnerHostListenerStream(
    listener: ComputeListener,
    output: RunnerHostStreamOutput,
): RunnerHostStreamControl {
    const pending = new Map<number, { socket: Duplex; timer: ReturnType<typeof setTimeout> }>();
    let next = 1;
    const drop = (connection: number) => {
        const held = pending.get(connection);
        if (held === undefined) return;
        pending.delete(connection);
        clearTimeout(held.timer);
        held.socket.destroy();
    };
    listener.onConnection((socket) => {
        if (pending.size >= MAX_PENDING_CONNECTIONS || output.out.full) {
            socket.destroy();
            return;
        }
        const connection = next++;
        const timer = setTimeout(() => drop(connection), PENDING_CONNECTION_MS);
        timer.unref?.();
        socket.once("close", () => {
            if (pending.get(connection)?.socket === socket) drop(connection);
        });
        pending.set(connection, { socket, timer });
        output.out.push(encoder.encode(`${JSON.stringify({ connection })}\n`));
    });
    void listener.closed.then(() => {
        // A snapshot: dropping deletes from the map being walked.
        for (const connection of Array.from(pending.keys())) drop(connection);
        output.exit({ exitCode: null, signal: null });
    });
    return {
        input: async () => undefined,
        endInput: () => undefined,
        stop: () => listener.close(),
        take(connection) {
            const held = pending.get(connection);
            if (held === undefined) return undefined;
            pending.delete(connection);
            clearTimeout(held.timer);
            return held.socket;
        },
    };
}
