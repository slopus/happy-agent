import type {
    Compute,
    ComputeFileStat,
    ComputeFileSystem,
    ComputeRunOptions,
    ComputeSessionActivity,
    ComputeSessionExit,
    ComputeSessionReadOptions,
    ComputeSessionSnapshot,
    ComputeSessionStatus,
    ComputeShell,
} from "../../../sources/compute/index.js";
import type { Context } from "@steve.kite/stdlib";

/** How one command behaves when the tools run it. */
export interface ScriptedCommand {
    /** Output handed back one piece per read, so a second read can return something new. */
    readonly chunks?: readonly string[];
    /** The code it ends with once its output has run out. */
    readonly exitCode?: number;
    /** Keep running after the output runs out, the way a server does. */
    readonly keepRunning?: boolean;
    /** What it prints in answer to what is typed into it. */
    readonly answer?: (input: string) => string;
}

/** One command the fake shell is running or has run. */
interface FakeSession {
    readonly command: string;
    readonly cwd: string;
    readonly script: ScriptedCommand;
    readonly sessionId: number;
    readonly usesSecrets: boolean;
    /** Output produced but not yet read. */
    pending: string;
    /** Complete stdout captured so far, matching the published session snapshot. */
    stdout: string;
    /** Output still to be produced, one piece per read. */
    remaining: string[];
    status: ComputeSessionStatus;
    exitCode: number | null;
}

/** What one file holds, and when it last changed. */
interface FakeFile {
    content: string;
    bytes?: Uint8Array;
    mtimeMs: number;
}

/**
 * A machine made of a few maps: files in memory, and commands that produce exactly what a test
 * says they produce.
 *
 * It implements the published compute contract without a filesystem, a shell, or a container
 * anywhere near the test.
 */
export class FakeCompute implements Compute {
    readonly id = "host";
    readonly kind = "host" as const;
    readonly cwd: string;
    readonly fs: ComputeFileSystem;
    readonly shell: ComputeShell;

    /** Every file, by absolute path. */
    readonly files = new Map<string, FakeFile>();
    /** Every directory, by absolute path. */
    readonly directories = new Set<string>();
    /** Where a symbolic link really leads, by absolute path. */
    readonly links = new Map<string, string>();
    /** What each command does, by the exact command line. */
    readonly commands = new Map<string, ScriptedCommand>();
    /** Every command the shell has run. */
    readonly sessions: FakeSession[] = [];
    /** Exact options passed when each test command starts. */
    readonly startedOptions: Omit<ComputeRunOptions, "signal">[] = [];
    /** Optional failure injected into the next move attempt. */
    moveFailure: Error | undefined;
    /** Commands the tools asked to keep running past the end of a turn. */
    readonly detached = new Set<number>();
    /** Whether the machine refuses to change anything at all. */
    readOnly = false;
    /** Optional test-controlled work that must finish before disposal completes. */
    disposeWait: Promise<void> | undefined;
    disposeCount = 0;

    /** Modification times come from a counter, so "changed since read" is exact. */
    #clock = 1_000;

    constructor(cwd = "/workspace") {
        this.cwd = cwd;
        this.directories.add(cwd);
        this.fs = this.#createFileSystem();
        this.shell = this.#createShell();
    }

    async dispose(_ctx: Context): Promise<void> {
        await this.disposeWait;
        this.disposeCount += 1;
    }

    /** Put a file on the machine, as though somebody else had written it. */
    write(path: string, content: string): void {
        this.#clock += 1_000;
        this.files.set(path, { content, mtimeMs: this.#clock });
        this.ensureParentDirectories(path);
    }

    /** Put exact bytes on the machine for image and binary-file tests. */
    writeBuffer(path: string, bytes: Uint8Array): void {
        this.#clock += 1_000;
        this.files.set(path, { content: "", bytes: bytes.slice(), mtimeMs: this.#clock });
        this.ensureParentDirectories(path);
    }

    private ensureParentDirectories(path: string): void {
        let directory = parent(path);
        while (directory !== "" && !this.directories.has(directory)) {
            this.directories.add(directory);
            directory = parent(directory);
        }
    }

    /** Teach the shell one command. */
    script(command: string, script: ScriptedCommand): void {
        this.commands.set(command, script);
    }

    #createFileSystem(): ComputeFileSystem {
        const resolveLinkPath = (path: string): string => {
            const seen = new Set<string>();
            let current = path;
            while (this.links.has(current) && !seen.has(current)) {
                seen.add(current);
                current = this.links.get(current)!;
            }
            return current;
        };
        // Named here rather than through the published `readdir`, so a test that replaces one
        // listing call to prove the other is used does not silently disable both.
        const namesIn = (path: string): string[] => {
            const prefix = path.endsWith("/") ? path : `${path}/`;
            const names = new Set<string>();
            for (const candidate of [
                ...this.files.keys(),
                ...this.directories,
                ...this.links.keys(),
            ]) {
                if (!candidate.startsWith(prefix) || candidate === path) continue;
                names.add(candidate.slice(prefix.length).split("/")[0] ?? "");
            }
            return [...names];
        };
        const statOf = (path: string): ComputeFileStat | undefined => {
            const file = this.files.get(path);
            if (file !== undefined) {
                return {
                    isFile: true,
                    isDirectory: false,
                    isSymbolicLink: false,
                    size: file.bytes?.byteLength ?? file.content.length,
                    mtimeMs: file.mtimeMs,
                };
            }
            if (this.directories.has(path)) {
                return {
                    isFile: false,
                    isDirectory: true,
                    isSymbolicLink: false,
                    size: 0,
                    mtimeMs: 0,
                };
            }
            if (this.links.has(path)) {
                return {
                    isFile: false,
                    isDirectory: false,
                    isSymbolicLink: true,
                    size: 0,
                    mtimeMs: 0,
                };
            }
            return undefined;
        };
        return {
            cwd: this.cwd,
            home: "/home/agent",
            chmod: async (_permissions, _path, _mode) => {},
            exists: (_permissions, path) => Promise.resolve(statOf(path) !== undefined),
            lstat: (_permissions, path) => {
                const stat = statOf(path);
                return stat === undefined
                    ? Promise.reject(new Error(`No such path: ${path}`))
                    : Promise.resolve(stat);
            },
            lstatMany: (_permissions, paths) => Promise.resolve(paths.map((path) => statOf(path))),
            mkdir: (_permissions, path) => {
                let directory = path;
                while (directory !== "" && !this.directories.has(directory)) {
                    this.directories.add(directory);
                    directory = parent(directory);
                }
                return Promise.resolve();
            },
            move: async (_permissions, source, destination) => {
                if (this.moveFailure !== undefined) throw this.moveFailure;
                const file = this.files.get(source);
                if (file === undefined) throw new Error(`No such file: ${source}`);
                this.files.set(destination, file);
                this.files.delete(source);
            },
            readFile: (_permissions, path) => {
                const file = this.files.get(path);
                return file === undefined
                    ? Promise.reject(new Error(`No such file: ${path}`))
                    : Promise.resolve(file.content);
            },
            readFileBuffer: async (_permissions, path) => {
                const file = this.files.get(path);
                if (file === undefined) throw new Error(`No such file: ${path}`);
                return file.bytes?.slice() ?? new TextEncoder().encode(file.content);
            },
            readdir: (_permissions, path) => {
                if (!this.directories.has(path)) {
                    return Promise.reject(new Error(`No such directory: ${path}`));
                }
                return Promise.resolve(namesIn(path));
            },
            readdirPage: (_permissions, path, options) => {
                if (!this.directories.has(path)) {
                    return Promise.reject(new Error(`No such directory: ${path}`));
                }
                const names = namesIn(path)
                    .sort()
                    .filter((name) => options.after === undefined || name > options.after);
                return Promise.resolve({
                    entries: names.slice(0, options.limit),
                    hasMore: names.length > options.limit,
                });
            },
            realpath: (_permissions, path) => {
                const target = resolveLinkPath(path);
                if (target !== path) return Promise.resolve(target);
                return statOf(path) === undefined
                    ? Promise.reject(new Error(`No such path: ${path}`))
                    : Promise.resolve(path);
            },
            rm: async (_permissions, path) => {
                this.files.delete(path);
                this.directories.delete(path);
            },
            setModificationTime: async (_permissions, path, mtimeMs) => {
                const file = this.files.get(path);
                if (file !== undefined) this.files.set(path, { ...file, mtimeMs });
            },
            stat: (_permissions, path) => {
                const stat = statOf(resolveLinkPath(path));
                return stat === undefined
                    ? Promise.reject(new Error(`No such path: ${path}`))
                    : Promise.resolve(stat);
            },
            writeFile: (_permissions, path, content) => {
                if (this.readOnly) {
                    return Promise.reject(
                        new Error("This machine is read-only: nothing may be changed."),
                    );
                }
                this.write(
                    path,
                    typeof content === "string" ? content : new TextDecoder().decode(content),
                );
                return Promise.resolve();
            },
        };
    }

    #createShell(): ComputeShell {
        let activeSessionCountListener: ((count: number) => void) | undefined;
        let sessionExitListener: ((exit: ComputeSessionExit) => void | Promise<void>) | undefined;
        const sessionOf = (sessionId: number): FakeSession | undefined =>
            this.sessions.find((session) => session.sessionId === sessionId);
        const activeSessions = (): readonly ComputeSessionActivity[] =>
            this.sessions
                .filter((session) => session.status === "running")
                .map((session) => ({
                    command: session.command,
                    cwd: session.cwd,
                    sessionId: session.sessionId,
                    status: "running" as const,
                }));
        const notifyActive = (): void => {
            activeSessionCountListener?.(activeSessions().length);
        };
        const snapshotOf = (session: FakeSession, delta: string): ComputeSessionSnapshot => ({
            command: session.command,
            cwd: session.cwd,
            exitCode: session.status === "running" ? null : session.exitCode,
            sessionId: session.sessionId,
            status: session.status,
            stderr: "",
            stderrDelta: "",
            stdout: session.stdout,
            stdoutDelta: delta,
            timedOut: false,
        });
        return {
            cwd: this.cwd,
            activeSessions,
            detachSession: (sessionId) => {
                this.detached.add(sessionId);
            },
            killSession: (sessionId) => {
                const session = sessionOf(sessionId);
                if (session === undefined) return Promise.resolve(undefined);
                session.status = "killed";
                session.exitCode = null;
                notifyActive();
                return Promise.resolve(snapshotOf(session, session.pending));
            },
            readSession: (sessionId: number, options?: ComputeSessionReadOptions) => {
                const session = sessionOf(sessionId);
                if (session === undefined) return Promise.resolve(undefined);
                let exited = false;
                if (session.status === "running") {
                    const next = session.remaining.shift();
                    if (next !== undefined) {
                        session.pending += next;
                        session.stdout += next;
                    }
                    if (session.remaining.length === 0 && session.script.keepRunning !== true) {
                        session.status = "completed";
                        session.exitCode = session.script.exitCode ?? 0;
                        exited = true;
                    }
                }
                const delta = session.pending;
                if (options?.peek !== true) session.pending = "";
                if (exited) {
                    notifyActive();
                    void sessionExitListener?.({
                        command: session.command,
                        exitCode: session.exitCode,
                        sessionId,
                        status: "completed",
                    });
                }
                return Promise.resolve(snapshotOf(session, delta));
            },
            run: async (_options) => ({
                stdout: "",
                stderr: "",
                exitCode: 0,
                timedOut: false,
            }),
            sessionUsesSecrets: (sessionId) => sessionOf(sessionId)?.usesSecrets === true,
            startSession: (options: Omit<ComputeRunOptions, "signal">) => {
                this.startedOptions.push(options);
                const script = this.commands.get(options.command);
                if (script === undefined) {
                    return Promise.reject(
                        new Error(`This test never scripted the command: ${options.command}`),
                    );
                }
                const session: FakeSession = {
                    command: options.command,
                    cwd: options.cwd ?? this.cwd,
                    script,
                    sessionId: this.sessions.length + 1,
                    pending: "",
                    stdout: "",
                    remaining: [...(script.chunks ?? [])],
                    status: "running",
                    exitCode: null,
                    usesSecrets: (options.secrets?.length ?? 0) > 0,
                };
                this.sessions.push(session);
                notifyActive();
                return Promise.resolve(session.sessionId);
            },
            setActiveSessionCountListener(listener) {
                activeSessionCountListener = listener;
                listener?.(activeSessions().length);
            },
            setSessionExitListener(listener) {
                sessionExitListener = listener;
            },
            supportsSessionInput: true,
            writeSession: (_permissions, sessionId, data) => {
                const session = sessionOf(sessionId);
                if (session === undefined || session.status !== "running") {
                    return Promise.resolve(false);
                }
                const input = typeof data === "string" ? data : new TextDecoder().decode(data);
                session.remaining.push(session.script.answer?.(input) ?? input);
                return Promise.resolve(true);
            },
        };
    }
}

/** The directory holding a path, in the fake machine's own flat namespace. */
function parent(path: string): string {
    const cut = path.lastIndexOf("/");
    return cut <= 0 ? "" : path.slice(0, cut);
}
