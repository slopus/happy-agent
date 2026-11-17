import { spawnHidden } from "./hiddenChildProcess.js";

import type { ExecuteWorkspaceCommandResponse } from "./types.js";
import { HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES } from "./types.js";
import { toPluginWorkspaceOperationError } from "./toPluginWorkspaceOperationError.js";

const FORCE_KILL_GRACE_MS = 250;

export function executePluginWorkspaceCommand(
    workspaceRoot: string,
    command: string,
    timeoutMs: number,
): Promise<ExecuteWorkspaceCommandResponse> {
    return new Promise<ExecuteWorkspaceCommandResponse>((resolve, reject) => {
        let child;
        try {
            child = spawnHidden("bash", ["-c", command], {
                cwd: workspaceRoot,
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (error) {
            reject(toPluginWorkspaceOperationError(error, "execute"));
            return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        let settled = false;
        let forceKill: NodeJS.Timeout | undefined;
        let timeout: NodeJS.Timeout | undefined;

        const clearTimers = () => {
            if (timeout !== undefined) clearTimeout(timeout);
            if (forceKill !== undefined) clearTimeout(forceKill);
        };
        const rejectOperation = (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimers();
            if (child.pid !== undefined) killProcessTree(child.pid, "SIGKILL");
            reject(toPluginWorkspaceOperationError(error, "execute"));
        };

        const append = (destination: Buffer[], chunk: Buffer, stream: "stderr" | "stdout") => {
            const writtenBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
            const accepted = Math.min(
                chunk.byteLength,
                HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES - writtenBytes,
            );
            if (accepted > 0) {
                destination.push(chunk.subarray(0, accepted));
                if (stream === "stdout") stdoutBytes += accepted;
                else stderrBytes += accepted;
            }
            if (accepted < chunk.byteLength) {
                if (stream === "stdout") stdoutTruncated = true;
                else stderrTruncated = true;
            }
        };

        child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
        child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
        child.stdout.once("error", rejectOperation);
        child.stderr.once("error", rejectOperation);

        timeout = setTimeout(() => {
            timedOut = true;
            if (child.pid === undefined) return;
            killProcessTree(child.pid, "SIGTERM");
            forceKill = setTimeout(() => {
                if (child.pid !== undefined) killProcessTree(child.pid, "SIGKILL");
            }, FORCE_KILL_GRACE_MS);
            forceKill.unref();
        }, timeoutMs);
        timeout.unref();

        child.once("error", rejectOperation);
        child.once("close", (exitCode) => {
            if (settled) return;
            settled = true;
            clearTimers();
            resolve({
                exitCode,
                stderrBase64: Buffer.concat(stderr).toString("base64"),
                stderrTruncated,
                stdoutBase64: Buffer.concat(stdout).toString("base64"),
                stdoutTruncated,
                timedOut,
            });
        });
    });
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
    if (process.platform === "win32") {
        try {
            const killer = spawnHidden(
                "taskkill",
                signal === "SIGKILL"
                    ? ["/F", "/T", "/PID", String(pid)]
                    : ["/T", "/PID", String(pid)],
                {
                    detached: true,
                    stdio: "ignore",
                },
            );
            killer.unref();
        } catch {
            // The process may already be gone.
        }
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // The process may already be gone.
        }
    }
}
