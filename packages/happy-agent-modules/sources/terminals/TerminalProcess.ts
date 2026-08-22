/**
 * The one process behind a terminal.
 *
 * It is a pseudo-terminal rather than a pipe, because everything a person expects from a shell —
 * job control, line editing, the alternate screen, a program that asks how wide the window is —
 * only exists when the program on the far end believes it is talking to a terminal.
 */
export interface TerminalProcess {
    /**
     * End the process now. This is a kill, not a hangup: closing a terminal is immediate, and
     * nothing waits on a shell deciding whether to take the hint.
     */
    kill(): Promise<void> | void;
    /**
     * Start receiving output. Whatever the process wrote before the first listener arrived is
     * delivered to it, so no bytes are lost between spawning and attaching the emulator.
     */
    onData(listener: (data: Uint8Array) => void): () => void;
    /** Stop reading, so the emulator's back pressure reaches the process itself. */
    pause(): void;
    resize(cols: number, rows: number): Promise<void> | void;
    resume(): void;
    wait(): Promise<{ readonly exitCode: number | null }>;
    write(data: string | Uint8Array): Promise<boolean> | boolean;
}

export interface TerminalProcessOptions {
    readonly cols: number;
    /** Run this instead of an interactive shell, hosted by that same shell. */
    readonly command?: string;
    readonly cwd: string;
    readonly rows: number;
    readonly shell?: string;
}

export interface TerminalProcessFactory {
    start(options: TerminalProcessOptions): Promise<TerminalProcess>;
}
