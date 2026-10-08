import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../../Compute.js";
import type { ComputeFileStat } from "../../ComputeFileSystem.js";
import type { ComputeRunResult, ComputeSessionSnapshot } from "../../ComputeShell.js";
import {
    MAX_RUNNER_FRAME_BYTES,
    type RunnerMethod,
    type RunnerMethodParams,
    type RunnerMethodResult,
    type RunnerProjectPolicy,
    type RunnerDocker,
} from "../runnerProtocol.js";
import {
    runnerHostListenerStream,
    runnerHostProcessStream,
    runnerHostSocketStream,
    runnerHostWatchStream,
    type RunnerHostStreamControl,
    type RunnerHostStreamOutput,
} from "./runnerHostStreams.js";

/** What one request may reach on the runner while it is being answered. */
export interface RunnerHandlerScope {
    /** The connection's context: the work belongs to the daemon request that asked for it. */
    readonly ctx: Context;
    /** Aborted when the daemon cancels the request or the connection ends. */
    readonly signal: AbortSignal;
    /** The request's frame body; empty for methods that carry none. */
    readonly body: Uint8Array;
    /** The compute the request names, or a refusal when the runner no longer holds it. */
    compute(computeId: string): Compute;
    createCompute(
        computeId: string,
        cwd: string,
        policy: RunnerProjectPolicy,
        docker: RunnerDocker | undefined,
    ): Promise<{ compute: Compute; retained: boolean }>;
    disposeCompute(computeId: string): Promise<void>;
    /** Register a stream under the daemon's ID and start it on the compute's own lifetime. */
    openStream(
        computeId: string,
        streamId: number,
        start: (ctx: Context, output: RunnerHostStreamOutput) => Promise<RunnerHostStreamControl>,
    ): Promise<void>;
    /** The running stream the daemon named, or a refusal when there is none. */
    stream(streamId: number): RunnerHostStreamControl;
}

/** A handler's answer: the result, and for byte-returning methods the response body. */
export interface RunnerHandlerAnswer<Method extends RunnerMethod> {
    readonly result: RunnerMethodResult<Method>;
    readonly body?: Uint8Array;
}

type RunnerHandler<Method extends RunnerMethod> = (
    scope: RunnerHandlerScope,
    params: RunnerMethodParams<Method>,
) => Promise<RunnerHandlerAnswer<Method>>;

/**
 * The largest file a runner reads in one call, leaving room in the frame for its header.
 *
 * A read without a caller-chosen bound still gets this one, so a runner never buffers a file it
 * could not send.
 */
const MAX_RUNNER_FILE_READ_BYTES = MAX_RUNNER_FRAME_BYTES - 64 * 1024;
const decoder = new TextDecoder();

/** How a runner answers each request, by method. */
export const runnerHostHandlers: { readonly [Method in RunnerMethod]: RunnerHandler<Method> } = {
    async "compute.create"(scope, params) {
        const { compute, retained } = await scope.createCompute(
            params.computeId,
            params.cwd,
            params.policy ?? {},
            params.docker,
        );
        return {
            result: {
                cwd: compute.cwd,
                ...(compute.fs.home === undefined ? {} : { home: compute.fs.home }),
                kind: compute.kind,
                supportsSessionInput: compute.shell.supportsSessionInput,
                retained,
            },
        };
    },
    async "compute.dispose"(scope, params) {
        await scope.disposeCompute(params.computeId);
        return { result: {} };
    },
    async "fs.chmod"(scope, params) {
        await scope
            .compute(params.computeId)
            .fs.chmod(params.permissions, params.path, params.mode);
        return { result: {} };
    },
    async "fs.exists"(scope, params) {
        const exists = await scope
            .compute(params.computeId)
            .fs.exists(params.permissions, params.path);
        return { result: { exists } };
    },
    async "fs.lstat"(scope, params) {
        const stat = await scope
            .compute(params.computeId)
            .fs.lstat(params.permissions, params.path);
        return { result: { stat: fileStat(stat) } };
    },
    async "fs.lstatMany"(scope, params) {
        const stats = await scope
            .compute(params.computeId)
            .fs.lstatMany(params.permissions, params.paths);
        return {
            result: { stats: stats.map((stat) => (stat === undefined ? null : fileStat(stat))) },
        };
    },
    async "fs.mkdir"(scope, params) {
        await scope
            .compute(params.computeId)
            .fs.mkdir(
                params.permissions,
                params.path,
                params.recursive === undefined ? undefined : { recursive: params.recursive },
            );
        return { result: {} };
    },
    async "fs.move"(scope, params) {
        await scope
            .compute(params.computeId)
            .fs.move(params.permissions, params.source, params.destination);
        return { result: {} };
    },
    async "fs.realpath"(scope, params) {
        const path = await scope
            .compute(params.computeId)
            .fs.realpath(params.permissions, params.path);
        return { result: { path } };
    },
    async "fs.readFile"(scope, params) {
        const text = await scope
            .compute(params.computeId)
            .fs.readFile(params.permissions, params.path);
        return { result: { text } };
    },
    async "fs.readFileBuffer"(scope, params) {
        const maxBytes = Math.min(
            params.maxBytes ?? MAX_RUNNER_FILE_READ_BYTES,
            MAX_RUNNER_FILE_READ_BYTES,
        );
        const bytes = await scope
            .compute(params.computeId)
            .fs.readFileBuffer(params.permissions, params.path, {
                maxBytes,
                ...(params.noFollow === undefined ? {} : { noFollow: params.noFollow }),
            });
        return { result: {}, body: bytes };
    },
    async "fs.readdir"(scope, params) {
        const entries = await scope
            .compute(params.computeId)
            .fs.readdir(params.permissions, params.path);
        return { result: { entries: [...entries] } };
    },
    async "fs.readdirPage"(scope, params) {
        const page = await scope
            .compute(params.computeId)
            .fs.readdirPage(params.permissions, params.path, {
                limit: params.limit,
                ...(params.after === undefined ? {} : { after: params.after }),
            });
        return { result: { entries: [...page.entries], hasMore: page.hasMore } };
    },
    async "fs.rm"(scope, params) {
        await scope.compute(params.computeId).fs.rm(params.permissions, params.path, {
            ...(params.recursive === undefined ? {} : { recursive: params.recursive }),
            ...(params.force === undefined ? {} : { force: params.force }),
        });
        return { result: {} };
    },
    async "fs.setModificationTime"(scope, params) {
        await scope
            .compute(params.computeId)
            .fs.setModificationTime(params.permissions, params.path, params.mtimeMs);
        return { result: {} };
    },
    async "fs.stat"(scope, params) {
        const stat = await scope.compute(params.computeId).fs.stat(params.permissions, params.path);
        return { result: { stat: fileStat(stat) } };
    },
    async "fs.writeFile"(scope, params) {
        const content = params.encoding === "text" ? decoder.decode(scope.body) : scope.body;
        await scope
            .compute(params.computeId)
            .fs.writeFile(params.permissions, params.path, content);
        return { result: {} };
    },
    async "shell.run"(scope, params) {
        const result = await scope
            .compute(params.computeId)
            .shell.run({ ...params.options, signal: scope.signal });
        return { result: { result: runResult(result) } };
    },
    async "shell.startSession"(scope, params) {
        const sessionId = await scope.compute(params.computeId).shell.startSession(params.options);
        return { result: { sessionId } };
    },
    async "shell.readSession"(scope, params) {
        const snapshot = await scope.compute(params.computeId).shell.readSession(params.sessionId, {
            signal: scope.signal,
            ...(params.peek === undefined ? {} : { peek: params.peek }),
            ...(params.waitMs === undefined ? {} : { waitMs: params.waitMs }),
        });
        return { result: { snapshot: snapshot === undefined ? null : sessionSnapshot(snapshot) } };
    },
    async "shell.killSession"(scope, params) {
        const snapshot = await scope.compute(params.computeId).shell.killSession(params.sessionId);
        return { result: { snapshot: snapshot === undefined ? null : sessionSnapshot(snapshot) } };
    },
    async "shell.writeSession"(scope, params) {
        const data = params.encoding === "text" ? decoder.decode(scope.body) : scope.body;
        const written = await scope
            .compute(params.computeId)
            .shell.writeSession(params.permissions, params.sessionId, data);
        return { result: { written } };
    },
    async "shell.interruptSession"(scope, params) {
        const shell = scope.compute(params.computeId).shell;
        const interrupted = await shell.interruptSession?.(params.sessionId);
        return { result: { interrupted: interrupted ?? null } };
    },
    async "shell.killAllSessions"(scope, params) {
        const shell = scope.compute(params.computeId).shell;
        const killed = (await shell.killAllSessions?.()) ?? 0;
        return { result: { killed } };
    },
    async "shell.detachSession"(scope, params) {
        scope.compute(params.computeId).shell.detachSession?.(params.sessionId);
        return { result: {} };
    },
    async "process.start"(scope, params) {
        const processes =
            scope.compute(params.computeId).processes ?? unsupported("start programs");
        await scope.openStream(params.computeId, params.stream, async (ctx, output) => {
            const started = await processes.start(ctx, {
                command: params.command,
                args: params.args,
                ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
                ...(params.environment === undefined ? {} : { environment: params.environment }),
                ...(params.terminal === undefined
                    ? {}
                    : {
                          terminal: {
                              cols: params.terminal.cols,
                              rows: params.terminal.rows,
                              ...(params.terminal.name === undefined
                                  ? {}
                                  : { name: params.terminal.name }),
                          },
                      }),
            });
            return runnerHostProcessStream(started, output);
        });
        return { result: {} };
    },
    async "process.resize"(scope, params) {
        scope.stream(params.stream).resize?.(params.cols, params.rows);
        return { result: {} };
    },
    async "process.signal"(scope, params) {
        scope.stream(params.stream).signal?.(params.signal);
        return { result: {} };
    },
    async "watch.start"(scope, params) {
        const watcher = scope.compute(params.computeId).watcher ?? unsupported("watch files");
        await scope.openStream(params.computeId, params.stream, async (ctx, output) => {
            const watch = await watcher.watch(ctx, {
                path: params.path,
                ...(params.ignore === undefined ? {} : { ignore: params.ignore }),
            });
            return runnerHostWatchStream(watch, output);
        });
        return { result: {} };
    },
    async "net.listen"(scope, params) {
        const network = scope.compute(params.computeId).network;
        if (network?.listen === undefined) unsupported("listen for connections");
        const listen = network.listen.bind(network);
        let port = 0;
        await scope.openStream(params.computeId, params.stream, async (ctx, output) => {
            const listener = await listen(ctx);
            port = listener.port;
            return runnerHostListenerStream(listener, output);
        });
        return { result: { port } };
    },
    async "net.accept"(scope, params) {
        const socket = scope.stream(params.listener).take?.(params.connection);
        if (socket === undefined) {
            throw Object.assign(new Error("The runner no longer holds that connection."), {
                code: "ECONNRESET",
            });
        }
        try {
            await scope.openStream(params.computeId, params.stream, async (_ctx, output) =>
                runnerHostSocketStream(socket, output),
            );
        } catch (error) {
            socket.destroy();
            throw error;
        }
        return { result: {} };
    },
    async "net.connect"(scope, params) {
        const network =
            scope.compute(params.computeId).network ?? unsupported("open network connections");
        await scope.openStream(params.computeId, params.stream, async (ctx, output) => {
            const socket = await network.connect(ctx, { host: params.host, port: params.port });
            return runnerHostSocketStream(socket, output);
        });
        return { result: {} };
    },
};

function unsupported(capability: string): never {
    throw Object.assign(new Error(`This runner machine cannot ${capability}.`), {
        code: "ENOTSUP",
    });
}

/** Copy only the protocol's fields, so a backend's richer object never reaches the wire. */
function fileStat(stat: ComputeFileStat): RunnerMethodResult<"fs.stat">["stat"] {
    return {
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymbolicLink: stat.isSymbolicLink,
        ...(stat.mode === undefined ? {} : { mode: stat.mode }),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
    };
}

function runResult(result: ComputeRunResult): RunnerMethodResult<"shell.run">["result"] {
    return {
        stdout: result.stdout,
        stderr: result.stderr,
        ...optionalCounts(result, [
            "stdoutBytes",
            "stderrBytes",
            "stdoutOmittedBytes",
            "stderrOmittedBytes",
        ]),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
    };
}

function sessionSnapshot(
    snapshot: ComputeSessionSnapshot,
): NonNullable<RunnerMethodResult<"shell.readSession">["snapshot"]> {
    return {
        command: snapshot.command,
        cwd: snapshot.cwd,
        exitCode: snapshot.exitCode,
        sessionId: snapshot.sessionId,
        status: snapshot.status,
        stderr: snapshot.stderr,
        stderrDelta: snapshot.stderrDelta,
        stdout: snapshot.stdout,
        stdoutDelta: snapshot.stdoutDelta,
        ...optionalCounts(snapshot, [
            "stderrDeltaBytes",
            "stderrDeltaOmittedBytes",
            "stderrBytes",
            "stderrOmittedBytes",
            "stdoutDeltaBytes",
            "stdoutDeltaOmittedBytes",
            "stdoutBytes",
            "stdoutOmittedBytes",
        ]),
        timedOut: snapshot.timedOut,
    };
}

function optionalCounts<Source extends object, Key extends keyof Source & string>(
    source: Source,
    keys: readonly Key[],
): Partial<Record<Key, number>> {
    const counts: Partial<Record<Key, number>> = {};
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "number") counts[key] = value;
    }
    return counts;
}
