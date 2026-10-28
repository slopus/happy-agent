import { spawn, type ChildProcess } from "node:child_process";

const MAX_TEXT = 64 * 1_024;
// Colors, cursor movement, and window titles; the programs print them even into pipes.
const TERMINAL_SEQUENCES =
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** A vendor program the daemon runs for as long as an install or sign-in takes. */
export interface ProviderCliProcess {
    /** Everything printed so far on either stream, without terminal sequences, capped at 64 KiB. */
    readonly text: () => string;
    /** Settles with the exit code, or `null` when the program could not start or was killed. */
    readonly exited: Promise<number | null>;
    write(input: string): void;
    kill(): void;
}

/**
 * Start a program with piped input and output and no window. `onOutput` hears each complete
 * line from either stream, already cleaned. Vendors print sign-in pages on stdout or stderr
 * depending on the program and the platform, so both are read the same way.
 */
export function startProviderCliProcess(
    command: string,
    args: readonly string[],
    env: Readonly<NodeJS.ProcessEnv>,
    onOutput: (line: string) => void,
): ProviderCliProcess {
    let text = "";
    const pending = { stdout: "", stderr: "" };
    let child: ChildProcess | undefined;
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
    });

    const receive = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const cleaned = chunk.toString("utf8").replace(TERMINAL_SEQUENCES, "");
        if (text.length < MAX_TEXT) text += cleaned.slice(0, MAX_TEXT - text.length);
        const lines = (pending[stream] + cleaned).split(/\r?\n|\r/);
        pending[stream] = lines.pop() ?? "";
        // A prompt such as "Paste code here >" waits without a newline; show it anyway.
        if (pending[stream].length > 200) {
            lines.push(pending[stream]);
            pending[stream] = "";
        }
        for (const line of lines) if (line.trim().length > 0) onOutput(line.trimEnd());
    };
    const flush = () => {
        for (const stream of ["stdout", "stderr"] as const) {
            if (pending[stream].trim().length > 0) onOutput(pending[stream].trimEnd());
            pending[stream] = "";
        }
    };

    try {
        // Windows starts batch files, such as npm's launchers, only through its shell.
        const batch = /\.(cmd|bat)$/i.test(command);
        child = spawn(batch ? `"${command}"` : command, args, {
            env: { ...env },
            shell: batch,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
    } catch {
        resolveExit(null);
    }
    if (child !== undefined) {
        child.stdout?.on("data", (chunk: Buffer) => receive("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => receive("stderr", chunk));
        child.stdin?.on("error", () => undefined);
        child.on("error", () => {
            flush();
            resolveExit(null);
        });
        // A browser the program opened may inherit its output pipes and hold them open, so the
        // program's own exit decides, after a moment for its last lines.
        child.on("exit", (code) => {
            setTimeout(() => {
                flush();
                resolveExit(code);
            }, 250).unref();
        });
    }

    return {
        text: () => text,
        exited,
        write: (input) => {
            if (child?.stdin?.writable === true) child.stdin.write(input);
        },
        kill: () => {
            if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
        },
    };
}

/** The last lines a client may show: at most 20, each at most 500 characters. */
export function appendOutputLine(output: readonly string[], line: string): string[] {
    return [...output, line.slice(0, 500)].slice(-20);
}
