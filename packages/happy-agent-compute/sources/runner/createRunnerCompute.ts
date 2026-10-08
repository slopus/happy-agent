import type { Context } from "@steve.kite/stdlib";

import type { Compute, ComputeKind } from "../Compute.js";
import type { ComputeFileStat, ComputeFileSystem } from "../ComputeFileSystem.js";
import type {
    ComputeRunOptions,
    ComputeSessionActivity,
    ComputeSessionExit,
    ComputeSessionSnapshot,
    ComputeShell,
} from "../ComputeShell.js";
import { RUNNER_COMPUTE_UNKNOWN } from "./RunnerErrors.js";
import {
    createRunnerNetwork,
    createRunnerProcesses,
    createRunnerWatcher,
    type RunnerStreamStarter,
} from "./impl/createRunnerStreamCapabilities.js";
import type {
    RunnerComputeHooks,
    RunnerConnection,
    RunnerLink,
    RunnerRequestOptions,
    RunnerResponse,
    RunnerStream,
} from "./RunnerLink.js";
import type {
    RunnerEvent,
    RunnerEventParams,
    RunnerMethod,
    RunnerMethodParams,
    RunnerMethodResult,
    RunnerDocker,
    RunnerProjectPolicy,
} from "./runnerProtocol.js";

export interface RunnerComputeOptions {
    readonly link: RunnerLink;
    /** Identifies this machine on the runner; unique among everything this daemon builds there. */
    readonly computeId: string;
    /** The working directory, in the runner's own paths. */
    readonly cwd: string;
    /** The project files the runner protects on this daemon's behalf. */
    readonly policy?: RunnerProjectPolicy;
    /**
     * Run agent work in a container of this image on the runner, with `cwd` mounted at the same
     * path. The machine's processes, watches, and connections still run on the runner itself.
     */
    readonly docker?: RunnerDocker;
    /** How long a call waits for a runner that is away before failing. Defaults to ten seconds. */
    readonly reconnectWaitMs?: number;
}

interface SessionRoute {
    readonly generation: number;
    readonly remoteId: number;
}

const DEFAULT_RECONNECT_WAIT_MS = 10_000;
const encoder = new TextEncoder();

/**
 * Build a compute whose files and commands live on a runner.
 *
 * Everything above it is unchanged: tools read and write files and run commands exactly as they do
 * on the host, under the same per-call permissions, and the runner enforces them with the same
 * native sandbox. The machine is created on the runner before this resolves, so a runner that is
 * not connected fails here, plainly, instead of on the agent's first command.
 *
 * Session IDs belong to this compute rather than to the runner. When the runner loses the machine —
 * it restarted, or the daemon stayed away longer than its lease — the commands it was running are
 * reported as killed, the next call builds a fresh machine in the same folder, and a new command
 * never reuses the ID of one that was lost.
 */
export async function createRunnerCompute(
    ctx: Context,
    options: RunnerComputeOptions,
): Promise<Compute> {
    const remote = new RunnerRemoteCompute(ctx, options);
    const created = await remote.start();
    return remote.compute(created);
}

class RunnerRemoteCompute implements RunnerComputeHooks {
    readonly #ctx: Context;
    readonly #link: RunnerLink;
    readonly #computeId: string;
    readonly #cwd: string;
    readonly #policy: RunnerProjectPolicy | undefined;
    readonly #docker: RunnerDocker | undefined;
    readonly #reconnectWaitMs: number;
    readonly #routes = new Map<number, SessionRoute>();
    #publicByRemote = new Map<number, number>();
    #nextPublicId = 1;
    #generation = 0;
    #remoteCwd = "";
    #readyOn: RunnerConnection | undefined;
    #creating: { connection: RunnerConnection; done: Promise<void> } | undefined;
    #active: ComputeSessionActivity[] = [];
    #onActiveSessionCount: ((count: number) => void) | undefined;
    #onSessionExit: ((exit: ComputeSessionExit) => void | Promise<void>) | undefined;
    #unregister: (() => void) | undefined;
    readonly #streams = new Set<RunnerStream>();
    #disposed = false;

    constructor(ctx: Context, options: RunnerComputeOptions) {
        this.#ctx = ctx;
        this.#link = options.link;
        this.#computeId = options.computeId;
        this.#cwd = options.cwd;
        this.#policy = options.policy;
        this.#docker = options.docker;
        this.#reconnectWaitMs = options.reconnectWaitMs ?? DEFAULT_RECONNECT_WAIT_MS;
    }

    async start(): Promise<RunnerMethodResult<"compute.create">> {
        this.#unregister = this.#link.register(this.#computeId, this);
        try {
            const connection = await this.#link.connection(this.#reconnectWaitMs);
            const { result } = await connection.request("compute.create", this.#createParams());
            this.#readyOn = connection;
            this.#remoteCwd = result.cwd;
            return result;
        } catch (error) {
            this.#unregister();
            throw error;
        }
    }

    attached(connection: RunnerConnection, retained: boolean): void {
        if (retained && this.#readyOn !== undefined) {
            this.#readyOn = connection;
            return;
        }
        this.#lose();
    }

    lost(): void {
        this.#lose();
    }

    event<Event extends RunnerEvent>(event: Event, params: RunnerEventParams<Event>): void {
        if (event === "shell.sessions") {
            const { sessions } = params as RunnerEventParams<"shell.sessions">;
            this.#setActive(
                sessions.map((session) => ({
                    command: session.command,
                    cwd: session.cwd,
                    sessionId: this.#publicId(session.sessionId),
                    status: "running" as const,
                })),
            );
            return;
        }
        if (event === "shell.exit") {
            const { exit } = params as RunnerEventParams<"shell.exit">;
            const sessionId = this.#publicId(exit.sessionId);
            this.#setActive(this.#active.filter((session) => session.sessionId !== sessionId));
            void this.#notifyExit({ ...exit, sessionId });
        }
    }

    compute(created: RunnerMethodResult<"compute.create">): Compute {
        const cwd = created.cwd;
        const kind: ComputeKind = created.kind;
        const fs = this.#fileSystem(cwd, created.home);
        const shell = this.#shell(cwd, created.supportsSessionInput);
        const starter = this.#streamStarter();
        return {
            id: "runner",
            kind,
            cwd,
            fs,
            shell,
            processes: createRunnerProcesses(starter),
            watcher: createRunnerWatcher(starter),
            network: createRunnerNetwork(starter),
            dispose: async (ctx) => this.#dispose(ctx),
        };
    }

    #streamStarter(): RunnerStreamStarter {
        return {
            start: async (method, params, handlers) => {
                for (let attempt = 0; ; attempt++) {
                    if (this.#disposed) throw new Error("This runner machine has been disposed.");
                    const connection = await this.#link.connection(this.#reconnectWaitMs);
                    await this.#ensureCreated(connection);
                    let stream!: RunnerStream;
                    const own = handlers(() => stream);
                    stream = this.#link.openStream({
                        data: own.data,
                        eof: own.eof,
                        exit: (exit) => {
                            this.#streams.delete(stream);
                            own.exit(exit);
                        },
                        lost: (reason) => {
                            this.#streams.delete(stream);
                            own.lost(reason);
                        },
                    });
                    let result: RunnerMethodResult<typeof method>;
                    try {
                        ({ result } = await connection.request(method, {
                            ...params,
                            computeId: this.#computeId,
                            stream: stream.id,
                        } as RunnerMethodParams<typeof method>));
                    } catch (error) {
                        stream.forget();
                        const unknown =
                            (error as NodeJS.ErrnoException).code === RUNNER_COMPUTE_UNKNOWN;
                        if (!unknown || attempt > 0) throw error;
                        this.#lose();
                        continue;
                    }
                    this.#streams.add(stream);
                    return { stream, result };
                }
            },
            resize: (stream, cols, rows) => {
                void this.#link
                    .connection(this.#reconnectWaitMs)
                    .then((connection) =>
                        connection.request("process.resize", { stream: stream.id, cols, rows }),
                    )
                    .catch((error: unknown) => this.#warn("resize-failed", error));
            },
            signal: (stream, signal) => {
                void this.#link
                    .connection(this.#reconnectWaitMs)
                    .then((connection) =>
                        connection.request("process.signal", { stream: stream.id, signal }),
                    )
                    .catch((error: unknown) => this.#warn("signal-failed", error));
            },
        };
    }

    #fileSystem(cwd: string, home: string | undefined): ComputeFileSystem {
        return {
            cwd,
            ...(home === undefined ? {} : { home }),
            chmod: async (permissions, path, mode) => {
                await this.#call("fs.chmod", { permissions, path, mode });
            },
            exists: async (permissions, path) =>
                (await this.#call("fs.exists", { permissions, path })).result.exists,
            lstat: async (permissions, path) =>
                (await this.#call("fs.lstat", { permissions, path })).result.stat,
            lstatMany: async (permissions, paths) => {
                const { stats } = (
                    await this.#call("fs.lstatMany", { permissions, paths: [...paths] })
                ).result;
                return stats.map((stat): ComputeFileStat | undefined => stat ?? undefined);
            },
            mkdir: async (permissions, path, options) => {
                await this.#call("fs.mkdir", {
                    permissions,
                    path,
                    ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
                });
            },
            move: async (permissions, source, destination) => {
                await this.#call("fs.move", { permissions, source, destination });
            },
            realpath: async (permissions, path) =>
                (await this.#call("fs.realpath", { permissions, path })).result.path,
            readFile: async (permissions, path) =>
                (await this.#call("fs.readFile", { permissions, path })).result.text,
            readFileBuffer: async (permissions, path, options) => {
                const response = await this.#call("fs.readFileBuffer", {
                    permissions,
                    path,
                    ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
                    ...(options?.noFollow === undefined ? {} : { noFollow: options.noFollow }),
                });
                return response.body ?? new Uint8Array(0);
            },
            readdir: async (permissions, path) =>
                (await this.#call("fs.readdir", { permissions, path })).result.entries,
            readdirPage: async (permissions, path, options) =>
                (
                    await this.#call("fs.readdirPage", {
                        permissions,
                        path,
                        limit: options.limit,
                        ...(options.after === undefined ? {} : { after: options.after }),
                    })
                ).result,
            rm: async (permissions, path, options) => {
                await this.#call("fs.rm", {
                    permissions,
                    path,
                    ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
                    ...(options?.force === undefined ? {} : { force: options.force }),
                });
            },
            setModificationTime: async (permissions, path, mtimeMs) => {
                await this.#call("fs.setModificationTime", { permissions, path, mtimeMs });
            },
            stat: async (permissions, path) =>
                (await this.#call("fs.stat", { permissions, path })).result.stat,
            writeFile: async (permissions, path, content) => {
                const text = typeof content === "string";
                await this.#call(
                    "fs.writeFile",
                    { permissions, path, encoding: text ? "text" : "bytes" },
                    { body: text ? encoder.encode(content) : content },
                );
            },
        };
    }

    #shell(cwd: string, supportsSessionInput: boolean): ComputeShell {
        return {
            cwd,
            supportsSessionInput,
            activeSessionCount: () => this.#active.length,
            activeSessions: () => [...this.#active],
            detachSession: (sessionId) => {
                const route = this.#route(sessionId);
                if (route === undefined) return;
                void this.#call("shell.detachSession", { sessionId: route.remoteId }).catch(
                    (error: unknown) => this.#warn("detach-failed", error),
                );
            },
            interruptSession: async (sessionId) => {
                const route = this.#route(sessionId);
                if (route === undefined) return false;
                const { interrupted } = (
                    await this.#call("shell.interruptSession", { sessionId: route.remoteId })
                ).result;
                return interrupted ?? undefined;
            },
            killAllSessions: async () =>
                (await this.#call("shell.killAllSessions", {})).result.killed,
            killSession: async (sessionId) => {
                const route = this.#route(sessionId);
                if (route === undefined) return undefined;
                const { snapshot } = (
                    await this.#call("shell.killSession", { sessionId: route.remoteId })
                ).result;
                return snapshot === null ? undefined : this.#snapshot(snapshot);
            },
            readSession: async (sessionId, options) => {
                const route = this.#route(sessionId);
                if (route === undefined) return undefined;
                const { snapshot } = (
                    await this.#call(
                        "shell.readSession",
                        {
                            sessionId: route.remoteId,
                            ...(options?.peek === undefined ? {} : { peek: options.peek }),
                            ...(options?.waitMs === undefined ? {} : { waitMs: options.waitMs }),
                        },
                        options?.signal === undefined ? {} : { signal: options.signal },
                    )
                ).result;
                return snapshot === null ? undefined : this.#snapshot(snapshot);
            },
            run: async (options) => {
                const { signal } = options;
                return (
                    await this.#call(
                        "shell.run",
                        { options: this.#runOptions(options) },
                        signal === undefined ? {} : { signal },
                    )
                ).result.result;
            },
            sessionUsesSecrets: () => false,
            setActiveSessionCountListener: (listener) => {
                this.#onActiveSessionCount = listener;
            },
            setSessionExitListener: (listener) => {
                this.#onSessionExit = listener;
            },
            startSession: async (options) => {
                const { sessionId } = (
                    await this.#call("shell.startSession", { options: this.#runOptions(options) })
                ).result;
                return this.#publicId(sessionId);
            },
            writeSession: async (permissions, sessionId, data) => {
                const route = this.#route(sessionId);
                if (route === undefined) return false;
                const text = typeof data === "string";
                const { written } = (
                    await this.#call(
                        "shell.writeSession",
                        {
                            permissions,
                            sessionId: route.remoteId,
                            encoding: text ? "text" : "bytes",
                        },
                        { body: text ? encoder.encode(data) : data },
                    )
                ).result;
                return written;
            },
        };
    }

    /**
     * Make one call against this machine, building it on the runner first when the current
     * connection does not have it yet.
     *
     * A runner that no longer holds the machine refuses the call before doing anything, so that one
     * refusal — and only that one — is safe to answer by rebuilding the machine and asking again.
     */
    async #call<
        Method extends Exclude<
            RunnerMethod,
            | "compute.create"
            | "compute.dispose"
            | "process.start"
            | "process.resize"
            | "process.signal"
            | "watch.start"
            | "net.connect"
        >,
    >(
        method: Method,
        params: Omit<RunnerMethodParams<Method>, "computeId">,
        options: RunnerRequestOptions = {},
    ): Promise<RunnerResponse<Method>> {
        if (this.#disposed) throw new Error("This runner machine has been disposed.");
        const connection = await this.#link.connection(this.#reconnectWaitMs, options.signal);
        const full = { ...params, computeId: this.#computeId } as RunnerMethodParams<Method>;
        await this.#ensureCreated(connection);
        try {
            return await connection.request(method, full, options);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== RUNNER_COMPUTE_UNKNOWN) throw error;
            this.#lose();
            await this.#ensureCreated(connection);
            return await connection.request(method, full, options);
        }
    }

    async #ensureCreated(connection: RunnerConnection): Promise<void> {
        if (this.#readyOn === connection) return;
        if (this.#creating?.connection === connection) {
            await this.#creating.done;
            return;
        }
        const done = (async () => {
            const { result } = await connection.request("compute.create", this.#createParams());
            if (result.cwd !== this.#remoteCwd) {
                throw new Error("The runner rebuilt this machine in a different folder.");
            }
            if (!result.retained) this.#lose();
            this.#readyOn = connection;
        })();
        this.#creating = { connection, done };
        try {
            await done;
        } finally {
            if (this.#creating?.done === done) this.#creating = undefined;
        }
    }

    /** The runner lost this machine: everything it was running is gone, and IDs start over. */
    #lose(): void {
        const lost = this.#active;
        this.#readyOn = undefined;
        this.#generation += 1;
        this.#publicByRemote = new Map();
        this.#setActive([]);
        for (const session of lost) {
            void this.#notifyExit({
                command: session.command,
                exitCode: null,
                sessionId: session.sessionId,
                status: "killed",
            });
        }
    }

    async #dispose(ctx: Context): Promise<void> {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#unregister?.();
        this.#onActiveSessionCount = undefined;
        this.#onSessionExit = undefined;
        this.#active = [];
        for (const stream of this.#streams) stream.close();
        this.#streams.clear();
        this.#link.dispose(this.#computeId);
        ctx.log.info(`runner:compute:disposed compute=${this.#computeId}`);
    }

    #createParams(): RunnerMethodParams<"compute.create"> {
        return {
            computeId: this.#computeId,
            cwd: this.#cwd,
            ...(this.#policy === undefined ? {} : { policy: this.#policy }),
            ...(this.#docker === undefined ? {} : { docker: { image: this.#docker.image } }),
        };
    }

    #runOptions(options: Omit<ComputeRunOptions, "signal">) {
        if (options.secrets !== undefined && options.secrets.length > 0) {
            throw new Error("Attached secrets are not available to commands on a runner yet.");
        }
        return {
            command: options.command,
            permissions: options.permissions,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.maxOutputBytes === undefined
                ? {}
                : { maxOutputBytes: options.maxOutputBytes }),
            ...(options.shell === undefined ? {} : { shell: options.shell }),
            ...(options.tty === undefined ? {} : { tty: options.tty }),
        };
    }

    #publicId(remoteId: number): number {
        const known = this.#publicByRemote.get(remoteId);
        if (known !== undefined) return known;
        const publicId = this.#nextPublicId++;
        this.#publicByRemote.set(remoteId, publicId);
        this.#routes.set(publicId, { generation: this.#generation, remoteId });
        return publicId;
    }

    /** Where a public session lives, or nothing when it belonged to a machine the runner lost. */
    #route(publicId: number): SessionRoute | undefined {
        const route = this.#routes.get(publicId);
        return route?.generation === this.#generation ? route : undefined;
    }

    #snapshot(snapshot: NonNullable<RunnerMethodResult<"shell.readSession">["snapshot"]>) {
        return {
            ...snapshot,
            sessionId: this.#publicId(snapshot.sessionId),
        } satisfies ComputeSessionSnapshot;
    }

    #setActive(sessions: ComputeSessionActivity[]): void {
        const changed = sessions.length !== this.#active.length;
        this.#active = sessions;
        if (changed) this.#onActiveSessionCount?.(sessions.length);
    }

    async #notifyExit(exit: ComputeSessionExit): Promise<void> {
        try {
            await this.#onSessionExit?.(exit);
        } catch (error) {
            this.#warn("exit-listener-failed", error);
        }
    }

    #warn(event: string, error: unknown): void {
        this.#ctx.log.warn(
            `runner:compute:${event} compute=${this.#computeId} error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`,
        );
    }
}
