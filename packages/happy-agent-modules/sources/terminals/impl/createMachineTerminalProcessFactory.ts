import type { Compute } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

import type { TerminalProcess, TerminalProcessFactory } from "../TerminalProcess.js";

/**
 * A real pseudo-terminal on a folder's machine — this one or a runner — started as one of that
 * machine's product programs. The machine is resolved per terminal, so a runner that reconnected
 * since the folder's first terminal is reached through its current link.
 */
export function createMachineTerminalProcessFactory(options: {
    readonly ctx: Context;
    readonly machine: () => Promise<Compute>;
    readonly platform: () => NodeJS.Platform | undefined;
}): TerminalProcessFactory {
    return {
        async start(start) {
            const machine = await options.machine();
            if (machine.processes === undefined) {
                throw new Error("This folder's machine cannot open terminals.");
            }
            const launch = shellLaunch(options.platform(), start.shell, start.command);
            const child = await machine.processes.start(options.ctx, {
                ...launch,
                cwd: start.cwd,
                environment: terminalEnvironment(start.cwd),
                terminal: { cols: start.cols, rows: start.rows, name: "xterm-256color" },
            });
            let exited = false;
            const exit = child.exited.then(({ exitCode }) => {
                exited = true;
                return { exitCode };
            });
            const process: TerminalProcess = {
                kill() {
                    if (exited) return;
                    try {
                        child.signal("SIGKILL");
                    } catch {
                        // The child may have exited between the state check and the signal.
                    }
                },
                onData: (listener) => child.onStdout(listener),
                pause: () => child.pause(),
                resize(cols, rows) {
                    if (!exited) child.resize(cols, rows);
                },
                resume: () => child.resume(),
                wait: () => exit,
                write: async (data) => (exited ? false : await child.write(data)),
            };
            return process;
        },
    };
}

/**
 * The program that hosts a terminal. Without a named shell, a POSIX machine starts its own
 * `$SHELL`, which only that machine knows, so `/bin/sh` looks it up there.
 */
function shellLaunch(
    platform: NodeJS.Platform | undefined,
    shell: string | undefined,
    command: string | undefined,
): { command: string; args: string[] } {
    if (platform === "win32") {
        const program = shell ?? "cmd.exe";
        if (command === undefined) return { command: program, args: [] };
        const name = program.toLowerCase().split(/[\\/]/u).at(-1);
        return {
            command: program,
            args:
                name === "cmd" || name === "cmd.exe"
                    ? ["/d", "/s", "/c", command]
                    : ["-lc", command],
        };
    }
    if (shell !== undefined) {
        return { command: shell, args: command === undefined ? [] : ["-lc", command] };
    }
    return command === undefined
        ? { command: "/bin/sh", args: ["-c", 'exec "${SHELL:-/bin/sh}"'] }
        : { command: "/bin/sh", args: ["-c", 'exec "${SHELL:-/bin/sh}" -lc "$1"', "sh", command] };
}

/** The terminal's own identity, without whatever multiplexer the machine's process runs inside. */
function terminalEnvironment(cwd: string): Record<string, string | null> {
    return {
        PWD: cwd,
        TERM: "xterm-256color",
        COLUMNS: null,
        LINES: null,
        STY: null,
        TERMCAP: null,
        TMUX: null,
        TMUX_PANE: null,
        WINDOW: null,
        WINDOWID: null,
    };
}
