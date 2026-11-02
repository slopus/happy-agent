import type { ComputePermissions } from "./ComputePermissions.js";

/** What to run, how patiently, and inside which boundary. */
export interface ComputeRunOptions {
    command: string;
    /**
     * The boundary this one command runs inside.
     *
     * A command is the unit permission is decided for: one reviewed command may run with full
     * access while the next in the same session does not. Passing it here rather than reading it
     * from the machine also closes the window where a mode changed between planning a command and
     * spawning it, because the value that was checked is the value that is used.
     */
    permissions: ComputePermissions;
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    /** IDs of the secret bundles this command's environment is built from. */
    secrets?: readonly string[];
    /**
     * Variables this one command gets on top of the shell's own environment, and removes where
     * the value is `null`. The agent layer sets it from attached secrets it resolved, and only
     * that layer: it is never taken from a model. A shell that cannot apply it refuses the command
     * rather than run it without them.
     */
    environment?: Readonly<Record<string, string | null>>;
    shell?: string;
    signal?: AbortSignal;
    /** Run the command under a pseudo-terminal instead of pipes. */
    tty?: boolean;
}

/** How a command that ran to completion ended. */
export interface ComputeRunResult {
    stdout: string;
    stderr: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutOmittedBytes?: number;
    stderrOmittedBytes?: number;
    exitCode: number | null;
    timedOut: boolean;
}

/** Whether a command is still going, finished on its own, or was stopped. */
export type ComputeSessionStatus = "completed" | "killed" | "running";

/** A command's state and output, including what is new since it was last read. */
export interface ComputeSessionSnapshot {
    command: string;
    cwd: string;
    exitCode: number | null;
    sessionId: number;
    status: ComputeSessionStatus;
    stderr: string;
    stderrDelta: string;
    stderrDeltaBytes?: number;
    stderrDeltaOmittedBytes?: number;
    stderrBytes?: number;
    stderrOmittedBytes?: number;
    stdout: string;
    stdoutDelta: string;
    stdoutDeltaBytes?: number;
    stdoutDeltaOmittedBytes?: number;
    stdoutBytes?: number;
    stdoutOmittedBytes?: number;
    timedOut: boolean;
}

/** How to read a running command. */
export interface ComputeSessionReadOptions {
    /**
     * Look without consuming. The delta cursor belongs to the agent, so observers such as a
     * terminal viewer must not advance it.
     */
    peek?: boolean;
    signal?: AbortSignal;
    waitMs?: number;
}

/** A command that ended, as the agent is told about it. */
export interface ComputeSessionExit {
    command: string;
    exitCode: number | null;
    sessionId: number;
    status: "completed" | "killed";
}

/** A command that is still running, as a person listing them sees it. */
export interface ComputeSessionActivity {
    command: string;
    cwd: string;
    sessionId: number;
    status: "running";
}

/**
 * A shell an agent runs commands in, whichever machine it is really on.
 *
 * A command either runs to completion within its timeout or becomes a session the agent comes
 * back to: reaching the timeout backgrounds a command, it never kills it. A session keeps
 * running past the end of the tool call and past the end of the turn, and belongs to the compute
 * that started it — disposing that compute is what ends it.
 *
 * Starting a command carries permissions because that is where the boundary is decided. Reading
 * and stopping a running session do not: those act on a command whose boundary was fixed when it
 * started, and re-deciding it afterwards could only disagree with the process already there.
 * Writing to a session is the exception — input is new instruction reaching a process that may
 * hold credentials, so it is checked against the permissions in force when it is sent.
 */
export interface ComputeShell {
    /** The directory commands run in by default. */
    cwd: string;
    /** How many commands are running right now. */
    activeSessionCount?(): number;
    /** The commands running right now, for a person looking at them. */
    activeSessions?(): readonly ComputeSessionActivity[];
    /**
     * Mark a session as work the agent means to leave running, so interrupting the turn no
     * longer stops it.
     */
    detachSession?(sessionId: number): void;
    interruptSession?(sessionId: number): Promise<boolean | undefined>;
    killAllSessions?(): Promise<number>;
    killSession(sessionId: number): Promise<ComputeSessionSnapshot | undefined>;
    readSession(
        sessionId: number,
        options?: ComputeSessionReadOptions,
    ): Promise<ComputeSessionSnapshot | undefined>;
    run(options: ComputeRunOptions): Promise<ComputeRunResult>;
    sessionUsesSecrets?(sessionId: number): boolean;
    setActiveSessionCountListener?(listener: ((count: number) => void) | undefined): void;
    /** Reports commands that ended without anyone waiting to hear about it. */
    setSessionExitListener?(
        listener: ((exit: ComputeSessionExit) => void | Promise<void>) | undefined,
    ): void;
    startSession(options: Omit<ComputeRunOptions, "signal">): Promise<number>;
    /** Whether characters can be sent to a running command's input. */
    supportsSessionInput: boolean;
    writeSession(
        permissions: ComputePermissions,
        sessionId: number,
        data: string | Uint8Array,
    ): Promise<boolean>;
}
