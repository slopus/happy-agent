import type { Context } from "@steve.kite/stdlib";

/** The signals a caller may send to a process it started. */
export type ComputeProcessSignal = "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGQUIT" | "SIGTERM";

/** What to start, where, and how it is attached. */
export interface ComputeProcessStartOptions {
    /** The program, found through the compute's `PATH` when it is not a path. */
    command: string;
    args?: readonly string[];
    /** Where it starts, relative to the compute's working directory. Defaults to that directory. */
    cwd?: string;
    /**
     * Changes to the compute's own environment for this process: a string sets a variable and
     * `null` removes it. Everything else is inherited from the machine the process runs on.
     */
    environment?: Readonly<Record<string, string | null>>;
    /** Run under a pseudo-terminal of this size instead of pipes. Output then arrives as stdout. */
    terminal?: { cols: number; rows: number; name?: string };
}

/** How a process ended. */
export interface ComputeProcessExit {
    exitCode: number | null;
    signal: string | null;
}

/**
 * One running program, wherever it really runs.
 *
 * Output a process wrote before anyone listened is held for the first listener. Holding too much
 * of it — or pausing — stops reading from the program, so its own writes block rather than the
 * caller's memory growing.
 */
export interface ComputeProcess {
    /** Receive stdout. Returns the function that stops listening. */
    onStdout(listener: (chunk: Uint8Array) => void): () => void;
    /** Receive stderr. Never called for a process under a terminal. */
    onStderr(listener: (chunk: Uint8Array) => void): () => void;
    /** Send input. Resolves once the input was accepted; returns false after the process ended. */
    write(data: string | Uint8Array): Promise<boolean>;
    /** Close stdin, or send end-of-file to a terminal. */
    endInput(): void;
    /** Change a terminal's size. Does nothing for a process on pipes. */
    resize(cols: number, rows: number): void;
    /** Signal the process and everything it started. */
    signal(signal: ComputeProcessSignal): void;
    /** Stop delivering output, so the process blocks once it has written enough. */
    pause(): void;
    resume(): void;
    /** Resolves once the process has ended and all its output has been delivered to listeners. */
    readonly exited: Promise<ComputeProcessExit>;
}

/**
 * The product's own programs: Git, a terminal a person opens, an MCP server they configured.
 *
 * These run as the compute's user with the same authority the product has on its own machine. The
 * agent sandbox does not apply, because these are not agent actions. A command an agent asked for
 * always goes through {@link ComputeShell}, which takes per-call permissions instead.
 *
 * Disposing the compute kills every process started here.
 */
export interface ComputeProcesses {
    start(ctx: Context, options: ComputeProcessStartOptions): Promise<ComputeProcess>;
}
