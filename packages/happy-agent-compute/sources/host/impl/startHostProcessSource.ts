import { spawn as spawnChildProcess } from "node:child_process";

import type { ComputeProcessExit, ComputeProcessSignal } from "../../ComputeProcesses.js";

/** A started program as the host sees it, before output delivery is layered on top. */
export interface HostProcessSource {
    onStdout(listener: (chunk: Uint8Array) => void): void;
    onStderr(listener: (chunk: Uint8Array) => void): void;
    /** Resolves after the program exited and its output streams closed. */
    readonly exited: Promise<ComputeProcessExit>;
    pause(): void;
    resume(): void;
    write(data: string | Uint8Array): Promise<boolean>;
    endInput(): void;
    resize(cols: number, rows: number): void;
    signal(signal: ComputeProcessSignal): void;
}

export interface HostProcessSourceOptions {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly terminal?: { cols: number; rows: number; name: string };
}

/**
 * Start a program on pipes or under a pseudo-terminal, failing if it cannot be started at all.
 *
 * Terminals use Bun's own, the runtime the Happy Agent binary — daemon and runner alike — runs on.
 * Under Node a terminal is refused rather than reaching for a native addon the binary does not
 * carry.
 */
export async function startHostProcessSource(
    options: HostProcessSourceOptions,
): Promise<HostProcessSource> {
    if (options.terminal === undefined) return await startPipes(options);
    return startBunTerminal(options, options.terminal);
}

async function startPipes(options: HostProcessSourceOptions): Promise<HostProcessSource> {
    const child = spawnChildProcess(options.command, [...options.args], {
        cwd: options.cwd,
        // Its own process group, so a signal reaches everything the program started.
        detached: process.platform !== "win32",
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    });
    child.stdin.on("error", () => undefined);
    const exited = new Promise<ComputeProcessExit>((resolve) => {
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    return {
        onStdout: (listener) => child.stdout.on("data", listener),
        onStderr: (listener) => child.stderr.on("data", listener),
        exited,
        pause() {
            child.stdout.pause();
            child.stderr.pause();
        },
        resume() {
            child.stdout.resume();
            child.stderr.resume();
        },
        write: (data) =>
            new Promise((resolve) => {
                if (child.stdin.destroyed || child.stdin.writableEnded) {
                    resolve(false);
                    return;
                }
                child.stdin.write(data, (error) => resolve(error == null));
            }),
        endInput() {
            if (!child.stdin.destroyed) child.stdin.end();
        },
        resize: () => undefined,
        signal: (signal) => signalGroup(child.pid, signal, () => child.kill(signal)),
    };
}

interface BunTerminal {
    readonly closed: boolean;
    close(): void;
    ref(): void;
    resize(cols: number, rows: number): void;
    write(data: string | Uint8Array): number;
}

interface BunSubprocess {
    readonly exited: Promise<number>;
    readonly pid: number;
    readonly signalCode: string | null;
    kill(signal?: number | string): void;
}

interface BunRuntime {
    Terminal: new (options: {
        cols: number;
        data: (terminal: BunTerminal, data: Uint8Array) => void;
        name: string;
        rows: number;
    }) => BunTerminal;
    spawn(
        command: string[],
        options: {
            cwd: string;
            env: Readonly<Record<string, string | undefined>>;
            terminal: BunTerminal;
        },
    ): BunSubprocess;
}

/** Bun's native pseudo-terminal. Bun cannot stop reading one, so pausing stops the program. */
function startBunTerminal(
    options: HostProcessSourceOptions,
    terminal: { cols: number; rows: number; name: string },
): HostProcessSource {
    const bun = (globalThis as { Bun?: BunRuntime }).Bun;
    if (bun === undefined) {
        throw Object.assign(new Error("Terminals need the Bun runtime that Happy Agent runs on."), {
            code: "ENOTSUP",
        });
    }
    const listeners: Array<(chunk: Uint8Array) => void> = [];
    const pty = new bun.Terminal({
        cols: terminal.cols,
        data(_terminal, data) {
            const chunk = Buffer.from(data);
            for (const listener of listeners) listener(chunk);
        },
        name: terminal.name,
        rows: terminal.rows,
    });
    let subprocess: BunSubprocess;
    try {
        subprocess = bun.spawn([options.command, ...options.args], {
            cwd: options.cwd,
            env: options.env,
            terminal: pty,
        });
        pty.ref();
    } catch (error) {
        pty.close();
        throw error;
    }
    let ended = false;
    let paused = false;
    const exited = subprocess.exited.then((exitCode) => {
        ended = true;
        pty.close();
        return subprocess.signalCode === null
            ? { exitCode: Number.isInteger(exitCode) ? exitCode : null, signal: null }
            : { exitCode: null, signal: subprocess.signalCode };
    });
    const send = (signal: string) => {
        if (ended) return;
        try {
            subprocess.kill(signal);
        } catch {
            // The program may have exited between the state check and the signal.
        }
    };
    return {
        onStdout: (listener) => listeners.push(listener),
        onStderr: () => undefined,
        exited,
        pause() {
            if (paused) return;
            paused = true;
            send("SIGSTOP");
        },
        resume() {
            if (!paused) return;
            paused = false;
            send("SIGCONT");
        },
        async write(data) {
            if (ended || pty.closed) return false;
            pty.write(data);
            return true;
        },
        endInput() {
            if (!ended && !pty.closed) pty.write("\u0004");
        },
        resize(cols, rows) {
            if (!ended && !pty.closed) pty.resize(cols, rows);
        },
        signal: (signal) => signalGroup(subprocess.pid, signal, () => send(signal)),
    };
}

/** Signal a whole process group where the platform has them, falling back to the one process. */
function signalGroup(
    pid: number | undefined,
    signal: ComputeProcessSignal,
    fallback: () => void,
): void {
    try {
        if (process.platform !== "win32" && pid !== undefined) {
            process.kill(-pid, signal);
            return;
        }
    } catch {
        // The group may already be gone, or the program may not lead one.
    }
    try {
        fallback();
    } catch {
        // A program that has already exited needs no signal.
    }
}
