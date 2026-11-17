import type { ChildProcessByStdio } from "node:child_process";
import { spawnHidden } from "../../utils/hiddenChildProcess.js";
import type { Readable, Writable } from "node:stream";

import { RunnerLink, RunnerUnavailableError } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import { stdioRunnerChannel } from "../stdio.js";
import type { LocalRunnerCommand } from "./sudoRunnerCommand.js";

/** The last bytes of the runner's own diagnostics kept to explain a failed start. */
const DIAGNOSTIC_TAIL_BYTES = 4_096;
/** The longest single line of the runner's diagnostics written to the daemon's log. */
const LOG_LINE_CHARACTERS = 2_000;
/** A runner that would not start is not asked again sooner than this, however often work needs it. */
const FAILED_START_RETRY_MS = 5_000;
/** Restarting a runner that stopped after it was connected backs off from here... */
const FIRST_RESTART_MS = 500;
/** ...to here. */
const LAST_RESTART_MS = 30_000;
/** A connection that lasted this long was healthy, so the next stop restarts quickly again. */
const HEALTHY_CONNECTION_MS = 60_000;
/** How long a stopping runner has to exit by itself before it is killed. */
const STOP_GRACE_MS = 5_000;

type RunnerProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * The runner one Linux user's work runs in, started by this daemon on this machine.
 *
 * The daemon starts it with the command it is given — sudo, in production — and speaks the runner
 * protocol over the process's standard input and output. One `RunnerLink` serves every process
 * this user's runner is ever started as, so machines built on it are rebuilt in the same folder
 * after a restart, exactly as a remote runner's are.
 *
 * A runner that will not start is never replaced by anything: every call that needs it fails
 * with what went wrong, in words a person can act on, and work on this machine does not fall back
 * to running as the daemon's own user. A runner that stops after it was connected is started
 * again with backoff; one that never started is retried only when work asks for it again.
 */
export class LocalUserRunner {
    readonly user: string;
    readonly link: RunnerLink;
    readonly #ctx: Context;
    readonly #command: LocalRunnerCommand;
    #child: RunnerProcess | undefined;
    #starting: Promise<void> | undefined;
    #failure: { readonly error: RunnerUnavailableError; readonly at: number } | undefined;
    #restartTimer: NodeJS.Timeout | undefined;
    #restartDelay = FIRST_RESTART_MS;
    #closed = false;

    constructor(
        ctx: Context,
        options: {
            readonly user: string;
            readonly command: LocalRunnerCommand;
            readonly instanceId: string;
        },
    ) {
        this.user = options.user;
        this.#ctx = ctx;
        this.#command = options.command;
        this.link = new RunnerLink(ctx, {
            name: `for the Linux user ${options.user}`,
            instanceId: options.instanceId,
        });
    }

    /**
     * Wait until the runner is connected, starting it when it is not running. Rejects with why it
     * could not start; a start that failed moments ago is reported again rather than retried.
     */
    async ready(): Promise<void> {
        if (this.#closed) throw this.#closedError();
        if (this.link.status().state === "connected") return;
        if (this.#starting !== undefined) return await this.#starting;
        const failure = this.#failure;
        if (failure !== undefined && Date.now() - failure.at < FAILED_START_RETRY_MS) {
            throw failure.error;
        }
        const starting = this.#start().finally(() => {
            if (this.#starting === starting) this.#starting = undefined;
        });
        this.#starting = starting;
        return await starting;
    }

    /** Why the runner last failed to start, while that failure still stands. */
    get lastFailure(): string | undefined {
        return this.#failure?.error.message;
    }

    /** Release everything the runner holds and stop it. */
    async close(reason: string): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        clearTimeout(this.#restartTimer);
        // The goodbye releases every machine at once; the runner then exits by itself.
        this.link.close(reason);
        const child = this.#child;
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
        child.stdin.end();
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        const timer = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
        timer.unref?.();
        await exited;
        clearTimeout(timer);
    }

    async #start(): Promise<void> {
        let child: RunnerProcess;
        try {
            child = spawnHidden(this.#command.program, [...this.#command.args], {
                // The daemon's own working directory is private to the daemon's user; the runner
                // starts somewhere every user can stand and works in its own home from there.
                cwd: "/",
                env: { ...this.#command.environment },
                stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error) {
            throw this.#failed(error instanceof Error ? error.message : String(error), "");
        }
        this.#child = child;
        let tail = "";
        let partial = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (text: string) => {
            tail = (tail + text).slice(-DIAGNOSTIC_TAIL_BYTES);
            const lines = (partial + text).split("\n");
            partial = lines.pop() ?? "";
            for (const line of lines) this.#log(line);
        });
        const exited = new Promise<string>((resolve) => {
            child.once("error", (error) => resolve(error.message));
            child.once("exit", (code, signal) => {
                if (partial.length > 0) this.#log(partial);
                resolve(
                    signal === null
                        ? `it exited with status ${String(code ?? 1)}`
                        : `it was stopped by ${signal}`,
                );
            });
        });
        const startedAt = Date.now();
        const outcome = await Promise.race([
            this.link.accept(stdioRunnerChannel(child.stdout, child.stdin)).then(
                () => undefined,
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
            ),
            exited,
        ]);
        if (outcome !== undefined) {
            child.kill("SIGKILL");
            // The process's own account of how it ended says more than a closed pipe does.
            const how = await Promise.race([exited, delay(1_000).then(() => outcome)]);
            throw this.#failed(how, tail);
        }
        this.#failure = undefined;
        this.#ctx.log.info(`Agent work for the Linux user ${this.user} runs in its own runner.`);
        void exited.then((how) => {
            if (this.#child === child) this.#child = undefined;
            if (this.#closed) return;
            this.#ctx.log.warn(
                `The runner for the Linux user ${this.user} stopped: ${how}. It is starting again.`,
            );
            if (Date.now() - startedAt >= HEALTHY_CONNECTION_MS)
                this.#restartDelay = FIRST_RESTART_MS;
            this.#restartTimer = setTimeout(() => {
                this.#restartTimer = undefined;
                void this.ready().catch(() => undefined);
            }, this.#restartDelay);
            this.#restartTimer.unref?.();
            this.#restartDelay = Math.min(this.#restartDelay * 2, LAST_RESTART_MS);
        });
    }

    /** Remember and explain a start that did not reach a connected runner. */
    #failed(how: string, diagnostics: string): RunnerUnavailableError {
        this.#child = undefined;
        const error = new RunnerUnavailableError(
            explainStartFailure(this.user, this.#command, how, diagnostics),
        );
        this.#failure = { error, at: Date.now() };
        this.#ctx.log.error(error.message);
        return error;
    }

    #log(line: string): void {
        const text = line.trimEnd();
        if (text.length === 0) return;
        this.#ctx.log.info(`[runner ${this.user}] ${text.slice(0, LOG_LINE_CHARACTERS)}`);
    }

    #closedError(): RunnerUnavailableError {
        return new RunnerUnavailableError(
            `The runner for the Linux user ${this.user} has stopped because the daemon is shutting down.`,
        );
    }
}

/**
 * Why the runner for a user did not start, in words that say what to change. sudo's own refusals
 * are recognized by their text, since sudo reports every one of them with the same exit status.
 */
export function explainStartFailure(
    user: string,
    command: LocalRunnerCommand,
    how: string,
    diagnostics: string,
): string {
    const lead = `Agent work cannot run as the Linux user ${user}`;
    const said = lastLine(diagnostics);
    if (/\bENOENT\b/u.test(how)) {
        return `${lead}: ${command.program} is not installed on this machine.`;
    }
    if (/unknown user/iu.test(diagnostics)) {
        return `${lead}: there is no such user on this machine. Create it, or change execution.user in happy.toml.`;
    }
    if (
        /a password is required|not allowed to execute|not in the sudoers file|may not run sudo/iu.test(
            diagnostics,
        )
    ) {
        return `${lead}: sudo does not allow this daemon to start its runner as that user (${said}). Install the sudoers rule from the hardening recipe, which allows exactly "${command.args.slice(command.args.indexOf("--") + 1).join(" ")}" as ${user}.`;
    }
    return `${lead}: its runner stopped before it was ready (${how}${said.length === 0 ? "" : `: ${said}`}).`;
}

/**
 * The line of a process's diagnostics most worth showing: the last one naming an error, or else
 * the last one at all, leaving out stack frames and the runtime's closing version banner.
 */
function lastLine(text: string): string {
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !/^at\s|^Node\.js v\d/u.test(line));
    const error = lines.findLast((line) => /error/iu.test(line));
    return (error ?? lines.at(-1) ?? "").slice(0, 500);
}

async function delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref?.();
    });
}
