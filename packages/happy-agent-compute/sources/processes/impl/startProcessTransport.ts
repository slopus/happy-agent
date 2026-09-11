import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { shellCommandArgs } from "./shellCommandArgs.js";

import { spawn as spawnPty } from "@lydell/node-pty";
import type { Context } from "@steve.kite/stdlib";

import { resolveSystemShell } from "./resolveSystemShell.js";
import { killProcessTree } from "./killProcessTree.js";
import type { ProcessStartOptions } from "../types.js";

/**
 * How a running command is talked to.
 *
 * Pipes and a pseudo-terminal differ in ways the process bookkeeping should not
 * have to know about: a terminal merges the two output streams, echoes input,
 * and reports one exit rather than a separate stream close.
 */
export interface ProcessTransport {
    readonly kind: "pipe" | "pty";
    readonly pid: number | null;
    /** Whether stderr arrives separately. A terminal merges it into stdout. */
    readonly separatesStderr: boolean;
    endInput(data?: string | Uint8Array): void;
    initialize(data: string | Uint8Array | undefined): Promise<void>;
    onError(listener: (error: Error) => void): void;
    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    onOutputEnd(listener: () => void): void;
    onStderr(listener: (chunk: Buffer) => void): void;
    onStdout(listener: (chunk: Buffer) => void): void;
    /** Releases every listener; the command may still be running. */
    release(): void;
    write(data: string | Uint8Array): boolean;
}

/** The terminal attached to a command, and its current size. */
const PTY_COLUMNS = 80;
const PTY_ROWS = 24;

/**
 * Discourages terminal-shaped output from a command the model cannot watch.
 *
 * A pseudo-terminal invites full-screen redraws, colour, and pagers that wait
 * for a keypress. None of that survives being read as text, so the environment
 * asks programs not to produce it in the first place.
 */
export const NON_INTERACTIVE_TERMINAL_ENVIRONMENT: NodeJS.ProcessEnv = {
    COLORTERM: "",
    GH_PAGER: "cat",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    PAGER: "cat",
    TERM: "dumb",
};

export async function startProcessTransport<Result>(
    ctx: Context,
    options: ProcessStartOptions,
    started: (ctx: Context, transport: ProcessTransport) => Result | PromiseLike<Result>,
): Promise<Awaited<Result>> {
    return await ctx.span("compute.process.spawn", async (ctx) => {
        const executable =
            options.args === undefined ? (options.shell ?? resolveSystemShell()) : options.command;
        const args =
            options.args === undefined
                ? shellCommandArgs(executable, options.command)
                : [...options.args];
        const transport =
            options.tty === true
                ? startPtyTransport(executable, args, options)
                : startPipeTransport(executable, args, options);
        // Attach lifecycle listeners before the traced callback yields. A command may exit in the
        // first microtask after spawn, and observing it must not depend on tracing latency.
        let result: Result | PromiseLike<Result>;
        try {
            result = started(ctx, transport);
            await transport.initialize(options.initialStdin);
        } catch (error) {
            try {
                if (transport.pid !== null) {
                    await killProcessTree(ctx, transport.pid, "SIGKILL");
                }
            } finally {
                transport.release();
            }
            throw error;
        }
        return await result;
    });
}

function startPipeTransport(
    executable: string,
    args: readonly string[],
    options: ProcessStartOptions,
): ProcessTransport {
    const child: ChildProcess = spawnChildProcess(executable, [...args], {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    child.stdin?.on("error", () => undefined);
    const listeners: (() => void)[] = [];
    return {
        endInput(data) {
            if (child.stdin === null || child.stdin.destroyed) return;
            child.stdin.end(data);
        },
        async initialize(data) {
            if (data === undefined) return;
            if (child.stdin === null || child.stdin.destroyed) {
                throw new Error("Could not write trusted startup input to the command.");
            }
            // `false` is backpressure, not rejection: Node has accepted the whole chunk and will
            // flush it in order before later caller-owned input.
            child.stdin.write(data);
        },
        kind: "pipe",
        onError(listener) {
            child.once("error", listener);
            listeners.push(() => child.removeListener("error", listener));
        },
        onExit(listener) {
            // A pipe-backed command is only finished once its output streams
            // close, which is what `close` reports.
            child.once("close", listener);
            listeners.push(() => child.removeListener("close", listener));
        },
        onOutputEnd(listener) {
            let remaining = 2;
            const done = () => {
                remaining -= 1;
                if (remaining === 0) listener();
            };
            child.stdout?.once("end", done);
            child.stderr?.once("end", done);
            listeners.push(() => {
                child.stdout?.removeListener("end", done);
                child.stderr?.removeListener("end", done);
            });
        },
        onStderr(listener) {
            child.stderr?.on("data", listener);
            listeners.push(() => child.stderr?.removeListener("data", listener));
        },
        onStdout(listener) {
            child.stdout?.on("data", listener);
            listeners.push(() => child.stdout?.removeListener("data", listener));
        },
        pid: child.pid ?? null,
        release() {
            for (const remove of listeners.splice(0)) remove();
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.stdin?.destroy();
        },
        separatesStderr: true,
        write(data) {
            if (child.stdin === null || child.stdin.destroyed) return false;
            child.stdin.write(data);
            // Writable.write() returning false only asks the producer to pause; the bytes were
            // accepted. This API reports whether input was delivered, not stream backpressure.
            return true;
        },
    };
}

function startPtyTransport(
    executable: string,
    args: readonly string[],
    options: ProcessStartOptions,
): ProcessTransport {
    const pty = spawnPty(executable, [...args], {
        cols: PTY_COLUMNS,
        cwd: options.cwd,
        env: {
            ...(options.env ?? process.env),
            ...NON_INTERACTIVE_TERMINAL_ENVIRONMENT,
        } as Record<string, string>,
        name: "dumb",
        rows: PTY_ROWS,
    });
    const stdoutListeners = new Set<(chunk: Buffer) => void>();
    const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
    const outputEndListeners = new Set<() => void>();
    let exited = false;
    let exitCode: number | null = null;
    const emitStdout = (data: string) => {
        if (data.length === 0) return;
        const chunk = Buffer.from(data);
        for (const listener of stdoutListeners) listener(chunk);
    };
    const dataDisposable = pty.onData((data) => {
        emitStdout(data);
    });
    const exitDisposable = pty.onExit(({ exitCode: code }) => {
        exited = true;
        exitCode = code;
        for (const listener of exitListeners) listener(code, null);
        for (const listener of outputEndListeners) listener();
    });
    const write = (data: string | Uint8Array): boolean => {
        if (exited) return false;
        pty.write(toPtyInput(data));
        return true;
    };
    return {
        endInput(data) {
            if (data !== undefined) this.write(data);
            // A terminal has no half-close; end-of-file is a character.
            if (!exited) pty.write("\u0004");
        },
        async initialize(data) {
            if (data !== undefined && !write(data)) {
                throw new Error("Could not write trusted startup input to the command.");
            }
        },
        kind: "pty",
        onError() {
            // A pseudo-terminal reports failures as an exit, not an error event.
        },
        onExit(listener) {
            exitListeners.add(listener);
            if (exited) queueMicrotask(() => listener(exitCode, null));
        },
        onOutputEnd(listener) {
            // The terminal closes with the command, so its exit is also the end
            // of its output.
            outputEndListeners.add(listener);
            if (exited) queueMicrotask(listener);
        },
        onStderr() {
            // A terminal merges stderr into the single stream.
        },
        onStdout(listener) {
            stdoutListeners.add(listener);
        },
        pid: pty.pid,
        release() {
            dataDisposable.dispose();
            exitDisposable.dispose();
            stdoutListeners.clear();
            exitListeners.clear();
            outputEndListeners.clear();
        },
        separatesStderr: false,
        write,
    };
}

function toPtyInput(data: string | Uint8Array): string {
    return typeof data === "string" ? data : Buffer.from(data).toString("utf8");
}
