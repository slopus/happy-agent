import { resolve } from "node:path";

import type { Context } from "@steve.kite/stdlib";

import type {
    ComputeProcess,
    ComputeProcesses,
    ComputeProcessExit,
    ComputeProcessStartOptions,
} from "../ComputeProcesses.js";
import { ChunkDelivery } from "../processes/impl/ChunkDelivery.js";
import { startHostProcessSource, type HostProcessSource } from "./impl/startHostProcessSource.js";

export interface HostProcessesOptions {
    /** The directory relative `cwd` values resolve against. */
    readonly cwd: string;
    /** The environment processes inherit before their own changes. Defaults to this process's. */
    readonly environment?: NodeJS.ProcessEnv;
}

/** Held output per stream before the program is made to wait. */
const HOST_PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;
/** How long disposal waits for killed programs to be reaped. */
const HOST_PROCESS_DISPOSE_WAIT_MS = 2_000;

export interface HostProcesses extends ComputeProcesses {
    /** Kill every program still running and wait briefly for each to be reaped. */
    dispose(): Promise<void>;
}

/** The product's own programs on this machine. */
export function createHostProcesses(options: HostProcessesOptions): HostProcesses {
    const running = new Set<HostProcessSource>();
    let disposed = false;
    return {
        async start(_ctx: Context, start: ComputeProcessStartOptions): Promise<ComputeProcess> {
            if (disposed) throw new Error("This machine has been disposed.");
            const source = await startHostProcessSource({
                command: start.command,
                args: start.args ?? [],
                cwd: resolve(options.cwd, start.cwd ?? "."),
                env: mergeEnvironment(options.environment ?? process.env, start.environment),
                ...(start.terminal === undefined
                    ? {}
                    : {
                          terminal: {
                              cols: start.terminal.cols,
                              rows: start.terminal.rows,
                              name: start.terminal.name ?? "xterm-256color",
                          },
                      }),
            });
            running.add(source);
            void source.exited.finally(() => running.delete(source));
            return deliverHostProcess(source);
        },
        async dispose() {
            disposed = true;
            const sources = [...running];
            for (const source of sources) source.signal("SIGKILL");
            await Promise.race([
                Promise.allSettled(sources.map((source) => source.exited)),
                new Promise((resolve) => setTimeout(resolve, HOST_PROCESS_DISPOSE_WAIT_MS).unref()),
            ]);
        },
    };
}

/** Layer held, pausable output delivery over a started program. */
function deliverHostProcess(source: HostProcessSource): ComputeProcess {
    const stdout = new ChunkDelivery(HOST_PROCESS_OUTPUT_LIMIT_BYTES);
    const stderr = new ChunkDelivery(HOST_PROCESS_OUTPUT_LIMIT_BYTES);
    let sourcePaused = false;
    const update = () => {
        const full = stdout.full || stderr.full;
        if (full && !sourcePaused) {
            sourcePaused = true;
            source.pause();
        } else if (!full && sourcePaused) {
            sourcePaused = false;
            source.resume();
        }
    };
    stdout.onSpace(update);
    stderr.onSpace(update);
    source.onStdout((chunk) => {
        stdout.push(chunk);
        update();
    });
    source.onStderr((chunk) => {
        stderr.push(chunk);
        update();
    });
    const exited: Promise<ComputeProcessExit> = source.exited.then(async (exit) => {
        stdout.end();
        stderr.end();
        await Promise.all([stdout.drained(), stderr.drained()]);
        return exit;
    });
    return {
        onStdout: (listener) => stdout.listen(listener),
        onStderr: (listener) => stderr.listen(listener),
        write: (data) => source.write(data),
        endInput: () => source.endInput(),
        resize: (cols, rows) => source.resize(cols, rows),
        signal: (signal) => source.signal(signal),
        pause() {
            stdout.setPaused(true);
            stderr.setPaused(true);
        },
        resume() {
            stdout.setPaused(false);
            stderr.setPaused(false);
        },
        exited,
    };
}

function mergeEnvironment(
    base: NodeJS.ProcessEnv,
    changes: Readonly<Record<string, string | null>> | undefined,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...base };
    for (const [name, value] of Object.entries(changes ?? {})) {
        if (value === null) delete environment[name];
        else environment[name] = value;
    }
    return environment;
}
