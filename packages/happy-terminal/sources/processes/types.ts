export type ManagedProcessStatus = "running" | "exited" | "killed";

export interface ProcessStartOptions {
    args?: readonly string[];
    command: string;
    cwd: string;
    shell?: string;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
    /** Run the command under a pseudo-terminal instead of pipes. */
    tty?: boolean;
}

export interface ProcessRunOptions extends ProcessStartOptions {
    timeoutMs?: number;
    killGraceMs?: number;
    signal?: AbortSignal;
}

export interface ProcessKillOptions {
    forceAfterMs?: number;
    /** Also stop work deliberately left running in the background. */
    includeDetached?: boolean;
}

export interface ProcessSnapshot {
    id: string;
    pid: number | null;
    command: string;
    cwd: string;
    status: ManagedProcessStatus;
    stdout: string;
    stderr: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutOmittedBytes?: number;
    stderrOmittedBytes?: number;
}

export interface ProcessRunResult extends ProcessSnapshot {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    aborted: boolean;
    killed: boolean;
}
