export type ManagedProcessStatus = "running" | "exited" | "killed";

export interface ProcessStartOptions {
    args?: readonly string[];
    command: string;
    cwd: string;
    shell?: string;
    env?: NodeJS.ProcessEnv;
    /** Bytes written to stdin immediately after spawn, before caller-owned input. */
    initialStdin?: string | Uint8Array;
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

/** Only newly requested output, without copying a process's complete retained snapshot. */
export interface ProcessOutputDelta {
    stderrDelta: string;
    stderrDeltaBytes: number;
    stderrDeltaOmittedBytes: number;
    stderrOffset: number;
    stdoutDelta: string;
    stdoutDeltaBytes: number;
    stdoutDeltaOmittedBytes: number;
    stdoutOffset: number;
}

export interface ProcessRunResult extends ProcessSnapshot {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    aborted: boolean;
    killed: boolean;
}
