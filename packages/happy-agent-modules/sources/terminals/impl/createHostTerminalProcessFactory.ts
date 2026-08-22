import { basename } from "node:path";

import { spawn } from "@lydell/node-pty";

import type { TerminalProcess, TerminalProcessFactory } from "../TerminalProcess.js";
import { createBunTerminalProcessFactory } from "./createBunTerminalProcessFactory.js";

/** A real pseudo-terminal on this machine, with this machine's environment and filesystem. */
export function createHostTerminalProcessFactory(
    environment: NodeJS.ProcessEnv = process.env,
): TerminalProcessFactory {
    if ("bun" in process.versions) return createBunTerminalProcessFactory(environment);
    return {
        async start(options) {
            const shell = options.shell ?? defaultShell(environment);
            const args =
                options.command === undefined ? [] : commandArguments(shell, options.command);
            const pty = spawn(shell, args, {
                cols: options.cols,
                cwd: options.cwd,
                env: environment as Record<string, string>,
                name: "xterm-256color",
                rows: options.rows,
            });
            // A shell writes its prompt immediately, long before the emulator is wired up. Holding
            // those bytes until the first listener arrives is what keeps the first screen intact.
            const buffered: Uint8Array[] = [];
            let exited = false;
            let listening: ((data: Uint8Array) => void) | undefined;
            const subscription = pty.onData((data) => {
                const chunk = Buffer.from(data);
                if (listening === undefined) buffered.push(chunk);
                else listening(chunk);
            });
            const exit = new Promise<{ exitCode: number | null }>((resolve) => {
                pty.onExit(({ exitCode }) => {
                    exited = true;
                    subscription.dispose();
                    resolve({ exitCode });
                });
            });
            const process: TerminalProcess = {
                kill() {
                    pty.kill("SIGKILL");
                },
                onData(listener) {
                    listening = listener;
                    for (const data of buffered.splice(0)) listener(data);
                    return () => {
                        if (listening === listener) listening = undefined;
                    };
                },
                pause() {
                    pty.pause();
                },
                resize(cols, rows) {
                    if (exited) return;
                    pty.resize(cols, rows);
                },
                resume() {
                    pty.resume();
                },
                wait: () => exit,
                write(data) {
                    if (exited) return false;
                    pty.write(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
                    return true;
                },
            };
            return process;
        },
    };
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
