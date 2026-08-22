import { basename } from "node:path";

import type { TerminalProcess, TerminalProcessFactory } from "../TerminalProcess.js";

interface BunTerminal {
    readonly closed: boolean;
    close(): void;
    ref(): void;
    resize(cols: number, rows: number): void;
    write(data: string | Uint8Array): number;
}

interface BunSubprocess {
    readonly exited: Promise<number>;
    kill(signal?: number | string): void;
}

interface BunRuntime {
    Terminal: new (options: {
        cols: number;
        data: (terminal: BunTerminal, data: Uint8Array) => void;
        name: string;
        rows: number;
    }) => BunTerminal;
    spawn(
        command: string[],
        options: {
            cwd: string;
            env: Readonly<Record<string, string | undefined>>;
            terminal: BunTerminal;
        },
    ): BunSubprocess;
}

/** A real pseudo-terminal using Bun's native PTY rather than Node stream compatibility. */
export function createBunTerminalProcessFactory(
    environment: NodeJS.ProcessEnv = process.env,
): TerminalProcessFactory {
    const bun = bunRuntime();
    return {
        async start(options) {
            const shell = options.shell ?? defaultShell(environment);
            const args =
                options.command === undefined ? [] : commandArguments(shell, options.command);
            const buffered: Uint8Array[] = [];
            let exited = false;
            let listening: ((data: Uint8Array) => void) | undefined;
            let paused = false;
            const terminal = new bun.Terminal({
                cols: options.cols,
                data(_terminal, data) {
                    const chunk = Buffer.from(data);
                    if (listening === undefined) buffered.push(chunk);
                    else listening(chunk);
                },
                name: "xterm-256color",
                rows: options.rows,
            });
            let subprocess: BunSubprocess;
            try {
                subprocess = bun.spawn([shell, ...args], {
                    cwd: options.cwd,
                    env: terminalEnvironment(environment, options.cwd),
                    terminal,
                });
                terminal.ref();
            } catch (error) {
                terminal.close();
                throw error;
            }
            const exit = subprocess.exited.then((exitCode) => {
                exited = true;
                terminal.close();
                return { exitCode: Number.isInteger(exitCode) ? exitCode : null };
            });
            const process: TerminalProcess = {
                kill() {
                    if (exited) return;
                    try {
                        subprocess.kill("SIGKILL");
                    } catch {
                        // The child may have exited between the state check and the signal.
                    }
                },
                onData(listener) {
                    listening = listener;
                    for (const data of buffered.splice(0)) listener(data);
                    return () => {
                        if (listening === listener) listening = undefined;
                    };
                },
                pause() {
                    if (exited || paused) return;
                    paused = true;
                    try {
                        subprocess.kill("SIGSTOP");
                    } catch {
                        // An exiting child needs no backpressure signal.
                    }
                },
                resize(cols, rows) {
                    if (!exited && !terminal.closed) terminal.resize(cols, rows);
                },
                resume() {
                    if (exited || !paused) return;
                    paused = false;
                    try {
                        subprocess.kill("SIGCONT");
                    } catch {
                        // An exiting child needs no resume signal.
                    }
                },
                wait: () => exit,
                write(data) {
                    if (exited || terminal.closed) return false;
                    terminal.write(data);
                    return true;
                },
            };
            return process;
        },
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

function terminalEnvironment(
    environment: NodeJS.ProcessEnv,
    cwd: string,
): Readonly<Record<string, string | undefined>> {
    const values: Record<string, string | undefined> = {
        ...environment,
        PWD: cwd,
        TERM: "xterm-256color",
    };
    for (const name of [
        "COLUMNS",
        "LINES",
        "STY",
        "TERMCAP",
        "TMUX",
        "TMUX_PANE",
        "WINDOW",
        "WINDOWID",
    ]) {
        delete values[name];
    }
    return values;
}

function defaultShell(environment: NodeJS.ProcessEnv): string {
    if (process.platform === "win32") return environment.ComSpec ?? "cmd.exe";
    return environment.SHELL ?? "/bin/sh";
}

function commandArguments(shell: string, command: string): string[] {
    if (process.platform === "win32") {
        const name = basename(shell).toLowerCase();
        if (name === "cmd" || name === "cmd.exe") return ["/d", "/s", "/c", command];
    }
    return ["-lc", command];
}
