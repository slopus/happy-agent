import { spawn, type ChildProcess } from "node:child_process";

import { delay, isAbortedError, type Context } from "@steve.kite/stdlib";

/** How long an exited app's error output is given to arrive before the run is reported. */
const STDERR_DRAIN_MS = 100;

export interface MenuBarAppOptions {
    /** A run shorter than this is a failure to start rather than an app that ran and stopped. */
    readonly startupWindowMs?: number;
    /** Consecutive failures to start before the app is left alone for good. */
    readonly maxFailedStarts?: number;
    readonly restartDelayMs?: number;
    /** How long the app is given to leave on its own before it is stopped outright. */
    readonly stopGraceMs?: number;
}

/** Why supervision ended, which is worth knowing in a test and worth logging nowhere else. */
export type MenuBarAppOutcome = "stopped" | "unavailable" | "abandoned";

/**
 * One menu bar app, kept running for as long as it should be.
 *
 * The app exits cleanly when the machine has no menu bar to join, so a zero exit code ends
 * supervision quietly rather than being retried. Anything else is a crash: it is restarted, and
 * repeated failures to even start stop the attempt for this daemon's life.
 */
export class MenuBarApp {
    readonly #app: string;
    readonly #args: readonly string[];
    readonly #startupWindowMs: number;
    readonly #maxFailedStarts: number;
    readonly #restartDelayMs: number;
    readonly #stopGraceMs: number;
    #child: ChildProcess | undefined;
    #stopped = false;

    constructor(app: string, args: readonly string[], options: MenuBarAppOptions = {}) {
        this.#app = app;
        this.#args = args;
        this.#startupWindowMs = options.startupWindowMs ?? 30_000;
        this.#maxFailedStarts = options.maxFailedStarts ?? 3;
        this.#restartDelayMs = options.restartDelayMs ?? 2_000;
        this.#stopGraceMs = options.stopGraceMs ?? 2_000;
    }

    /** Runs the app until it should not run again. Resolves once nothing is left running. */
    async supervise(ctx: Context): Promise<MenuBarAppOutcome> {
        let failedStarts = 0;
        while (!this.#stopped) {
            const startedAt = Date.now();
            const exit = await this.#run(ctx);
            if (this.#stopped) return "stopped";
            const ranFor = Date.now() - startedAt;
            if (exit.code === 0) {
                ctx.log.debug(`menu-bar:unavailable reason=${exit.stderr || "clean-exit"}`);
                return "unavailable";
            }
            failedStarts = ranFor >= this.#startupWindowMs ? 0 : failedStarts + 1;
            ctx.log.warn(
                `menu-bar:exited code=${String(exit.code)} signal=${exit.signal ?? "none"} ranForMs=${String(ranFor)} failedStarts=${String(failedStarts)}${exit.stderr === "" ? "" : ` stderr=${exit.stderr}`}`,
            );
            if (failedStarts >= this.#maxFailedStarts) {
                ctx.log.warn("menu-bar:abandoned reason=repeated-startup-failures");
                return "abandoned";
            }
            try {
                await delay(ctx, this.#restartDelayMs);
            } catch (error: unknown) {
                if (isAbortedError(error)) return "stopped";
                throw error;
            }
        }
        return "stopped";
    }

    /** Ends the app and keeps it ended. Supervision settles shortly afterwards. */
    stop(): void {
        this.#stopped = true;
        const child = this.#child;
        if (child === undefined || child.exitCode !== null) return;
        this.#child = undefined;
        child.stdin?.end();
        child.kill("SIGTERM");
        const forceStop = setTimeout(() => child.kill("SIGKILL"), this.#stopGraceMs);
        forceStop.unref();
        child.once("exit", () => clearTimeout(forceStop));
    }

    /** One run of the app, from spawn to exit. */
    async #run(ctx: Context): Promise<{
        code: number | null;
        signal: string | null;
        stderr: string;
    }> {
        // Standard input stays open and carries nothing: closing it is how the app learns the
        // daemon is gone even when the daemon had no chance to stop it.
        const child = spawn(this.#app, [...this.#args], { stdio: ["pipe", "ignore", "pipe"] });
        this.#child = child;
        ctx.log.debug(`menu-bar:started pid=${String(child.pid ?? 0)}`);
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            stderr = `${stderr}${chunk}`.slice(-2_000);
        });
        return await new Promise((resolve) => {
            let settled = false;
            const finish = (code: number | null, signal: string | null, message: string) => {
                if (settled) return;
                settled = true;
                if (this.#child === child) this.#child = undefined;
                resolve({ code, signal, stderr: message.trim() });
            };
            child.once("error", (error: Error) => finish(null, null, error.message));
            // Waiting for the streams to close would wait on anything the app left behind holding
            // its error pipe, so the exit is what ends the run and the pipe is only given a moment.
            child.once("exit", (code, signal) => {
                const errors = child.stderr;
                if (errors === null || errors.readableEnded) {
                    finish(code, signal, stderr);
                    return;
                }
                const grace = setTimeout(() => finish(code, signal, stderr), STDERR_DRAIN_MS);
                grace.unref();
                errors.once("end", () => {
                    clearTimeout(grace);
                    finish(code, signal, stderr);
                });
            });
        });
    }
}
