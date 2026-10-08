import type { Compute } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

/** One finished program on another machine, with output bounded the way `execFile` bounds it. */
export interface MachineRunResult {
    readonly code: number;
    readonly stdout: Buffer;
    readonly stderr: string;
    /** Output past the bound was discarded and the program was stopped. */
    readonly truncated: boolean;
    readonly timedOut: boolean;
}

/**
 * Run one of the product's own programs, such as Git, on a machine and wait for it.
 *
 * Output past `maximumBytes` stops the program rather than growing memory. The deadline and the
 * caller's signal both stop it too; either way the result says what happened instead of throwing,
 * so a caller can read Git's own diagnostics.
 */
export async function runOnMachine(
    ctx: Context,
    machine: Compute,
    options: {
        readonly command: string;
        readonly args: readonly string[];
        readonly environment?: Readonly<Record<string, string | null>>;
        readonly maximumBytes: number;
        readonly timeoutMs: number;
        readonly signal?: AbortSignal;
    },
): Promise<MachineRunResult> {
    const processes = machine.processes;
    if (processes === undefined) {
        throw Object.assign(new Error("This machine cannot run the product's own programs."), {
            code: "ENOTSUP",
        });
    }
    options.signal?.throwIfAborted();
    const started = await processes.start(ctx, {
        command: options.command,
        args: options.args,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    const stop = () => started.signal("SIGKILL");
    started.onStdout((chunk) => {
        if (truncated) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > options.maximumBytes) {
            truncated = true;
            const room = chunk.byteLength - (stdoutBytes - options.maximumBytes);
            if (room > 0) stdout.push(Buffer.from(chunk.subarray(0, room)));
            stop();
            return;
        }
        stdout.push(Buffer.from(chunk));
    });
    started.onStderr((chunk) => {
        if (stderrBytes >= options.maximumBytes) return;
        stderrBytes += chunk.byteLength;
        stderr.push(Buffer.from(chunk));
    });
    started.endInput();
    const timer = setTimeout(() => {
        timedOut = true;
        stop();
    }, options.timeoutMs);
    const abort = () => started.signal("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
        const exit = await started.exited;
        return {
            code: exit.exitCode ?? 1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr).toString("utf8"),
            truncated,
            timedOut,
        };
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
    }
}
