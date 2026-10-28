import { spawn } from "node:child_process";

const MAX_OUTPUT = 64 * 1_024;

export interface ProviderCliCommandResult {
    /** The exit code, or `null` when the program could not start, was killed, or timed out. */
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * Run one short local command of a vendor program with no input, no window, and a hard time
 * bound. Output is capped; the result never throws.
 */
export async function runProviderCliCommand(
    command: string,
    args: readonly string[],
    env: Readonly<NodeJS.ProcessEnv>,
    timeoutMs: number,
): Promise<ProviderCliCommandResult> {
    return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        };
        let child: ReturnType<typeof spawn>;
        try {
            // Windows starts batch files, such as npm's launchers, only through its shell.
            const batch = /\.(cmd|bat)$/i.test(command);
            child = spawn(batch ? `"${command}"` : command, args, {
                env: { ...env },
                shell: batch,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch {
            resolve({ code: null, stdout, stderr });
            return;
        }
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(null);
        }, timeoutMs);
        timer.unref();
        child.stdout?.on("data", (chunk: Buffer) => {
            if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
        });
        child.on("error", () => finish(null));
        // A browser the program started may inherit its output pipes and keep them open long
        // after the program has finished, so `exit` only waits briefly for the rest of the output.
        let exitCode: number | null = null;
        child.on("exit", (code) => {
            exitCode = code;
            setTimeout(() => finish(code), 250).unref();
        });
        child.on("close", (code) => finish(code ?? exitCode));
    });
}
