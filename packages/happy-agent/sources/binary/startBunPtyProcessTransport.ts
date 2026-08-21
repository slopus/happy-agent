interface BunTerminal {
    readonly closed: boolean;
    close(): void;
    write(data: string | Uint8Array): number;
}

interface BunSubprocess {
    readonly exited: Promise<number>;
    readonly pid: number;
}

interface BunRuntime {
    Terminal: new (options: {
        cols: number;
        data: (terminal: BunTerminal, data: Uint8Array) => void;
        exit: (terminal: BunTerminal, exitCode: number, signal: string | null) => void;
        name: string;
        rows: number;
    }) => BunTerminal;
    spawn(
        command: string[],
        options: {
            cwd: string | undefined;
            env: Readonly<Record<string, string | undefined>>;
            terminal: BunTerminal;
        },
    ): BunSubprocess;
}

interface ProcessStartOptions {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
}

interface ProcessTransport {
    readonly kind: "pty";
    readonly pid: number;
    readonly separatesStderr: false;
    endInput(data?: string | Uint8Array): void;
    initialize(data: string | Uint8Array | undefined): Promise<void>;
    onError(listener: (error: Error) => void): void;
    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    onOutputEnd(listener: () => void): void;
    onStderr(listener: (chunk: Buffer) => void): void;
    onStdout(listener: (chunk: Buffer) => void): void;
    release(): void;
    write(data: string | Uint8Array): boolean;
}

const TERMINAL_ENVIRONMENT: NodeJS.ProcessEnv = {
    COLORTERM: "",
    GH_PAGER: "cat",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    PAGER: "cat",
    TERM: "dumb",
};

/** Bun-native PTY transport injected into the published compute package at binary build time. */
export function startBunPtyProcessTransport(
    executable: string,
    args: readonly string[],
    options: ProcessStartOptions,
): ProcessTransport {
    const bun = bunRuntime();
    const stdoutListeners = new Set<(chunk: Buffer) => void>();
    const exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
    const outputEndListeners = new Set<() => void>();
    let exited = false;
    let exitCode: number | null = null;
    let outputEnded = false;
    const terminal = new bun.Terminal({
        cols: 80,
        data(_terminal, data) {
            if (data.byteLength === 0) return;
            const chunk = Buffer.from(data);
            for (const listener of stdoutListeners) listener(chunk);
        },
        exit() {
            outputEnded = true;
            for (const listener of outputEndListeners) listener();
        },
        name: "dumb",
        rows: 24,
    });
    let subprocess: BunSubprocess;
    try {
        subprocess = bun.spawn([executable, ...args], {
            cwd: options.cwd,
            env: { ...(options.env ?? process.env), ...TERMINAL_ENVIRONMENT },
            terminal,
        });
    } catch (error) {
        terminal.close();
        throw error;
    }
    void subprocess.exited.then((code) => {
        exited = true;
        exitCode = Number.isInteger(code) ? code : null;
        for (const listener of exitListeners) listener(exitCode, null);
        if (!terminal.closed) terminal.close();
        if (!outputEnded) {
            outputEnded = true;
            for (const listener of outputEndListeners) listener();
        }
    });
    const write = (data: string | Uint8Array): boolean => {
        if (exited || terminal.closed) return false;
        terminal.write(data);
        return true;
    };
    return {
        endInput(data) {
            if (data !== undefined) write(data);
            if (!exited && !terminal.closed) terminal.write("\u0004");
        },
        async initialize(data) {
            if (data !== undefined && !write(data)) {
                throw new Error("Could not write trusted startup input to the command.");
            }
        },
        kind: "pty",
        onError() {
            // Bun.Terminal reports startup synchronously and later failures through process exit.
        },
        onExit(listener) {
            exitListeners.add(listener);
            if (exited) queueMicrotask(() => listener(exitCode, null));
        },
        onOutputEnd(listener) {
            outputEndListeners.add(listener);
            if (outputEnded) queueMicrotask(listener);
        },
        onStderr() {
            // A terminal merges stderr into the single stream.
        },
        onStdout(listener) {
            stdoutListeners.add(listener);
        },
        pid: subprocess.pid,
        release() {
            stdoutListeners.clear();
            exitListeners.clear();
            outputEndListeners.clear();
        },
        separatesStderr: false,
        write,
    };
}

function bunRuntime(): BunRuntime {
    const bun = (globalThis as { Bun?: unknown }).Bun;
    if (
        typeof bun !== "object" ||
        bun === null ||
        !("Terminal" in bun) ||
        typeof bun.Terminal !== "function" ||
        !("spawn" in bun) ||
        typeof bun.spawn !== "function"
    ) {
        throw new Error("The Bun terminal runtime is unavailable.");
    }
    return bun as BunRuntime;
}
