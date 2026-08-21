import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const PROCESS_EXIT_POLL_INTERVAL_MS = 50;
const DAEMON_KILL_TIMEOUT_MS = 5_000;

export interface KillDaemonFromPidFileResult {
    readonly found: boolean;
    readonly killed: boolean;
    readonly pid?: number;
}

/** Read the exact positive process ID recorded by the daemon, when the file exists. */
export async function readDaemonPid(pidPath: string): Promise<number | undefined> {
    let text: string;
    try {
        text = await readFile(pidPath, "utf8");
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
    const normalized = text.trim();
    if (!/^[1-9][0-9]*$/.test(normalized)) {
        throw new Error(`The daemon PID file is invalid: ${pidPath}`);
    }
    const pid = Number(normalized);
    if (!Number.isSafeInteger(pid)) {
        throw new Error(`The daemon PID file is invalid: ${pidPath}`);
    }
    return pid;
}

/** Atomically publish one daemon process ID with private permissions. */
export async function writeDaemonPid(pidPath: string, pid: number = process.pid): Promise<void> {
    assertPid(pid);
    await mkdir(dirname(pidPath), { mode: 0o700, recursive: true });
    const temporaryPath = `${pidPath}.${String(pid)}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, `${String(pid)}\n`, { flag: "wx", mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, pidPath);
    } finally {
        await unlink(temporaryPath).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
        });
    }
}

/** Remove a PID file only while it still names the process performing the cleanup. */
export async function removeDaemonPid(pidPath: string, expectedPid: number): Promise<boolean> {
    assertPid(expectedPid);
    const recordedPid = await readDaemonPid(pidPath);
    if (recordedPid === undefined || recordedPid !== expectedPid) return false;
    try {
        await unlink(pidPath);
        return true;
    } catch (error) {
        if (isMissing(error)) return false;
        throw error;
    }
}

/** Best-effort synchronous cleanup for Node's process-exit event. */
export function removeDaemonPidSync(pidPath: string, expectedPid: number): void {
    if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) return;
    try {
        const recorded = readFileSync(pidPath, "utf8").trim();
        if (recorded !== String(expectedPid)) return;
        unlinkSync(pidPath);
    } catch {
        // Exit cleanup cannot recover or report a filesystem failure; a stale file is safe because
        // the next status or kill command verifies whether its PID is still alive.
    }
}

/** Whether the operating system still has a live, non-zombie process under this ID. */
export async function isDaemonProcessRunning(pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
    } catch (error) {
        return errorCode(error) === "EPERM";
    }
    if (process.platform !== "linux") return true;
    try {
        const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
        const commandEnd = stat.lastIndexOf(")");
        const state = commandEnd < 0 ? undefined : stat.slice(commandEnd + 2).split(" ", 1)[0];
        return state !== "Z";
    } catch (error) {
        const code = errorCode(error);
        return code !== "ENOENT" && code !== "ESRCH";
    }
}

/** Wait until one exact daemon PID exits, returning false at the bounded deadline. */
export async function waitForDaemonProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    assertPid(pid);
    const deadline = Date.now() + timeoutMs;
    while (await isDaemonProcessRunning(pid)) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return false;
        await delay(Math.min(PROCESS_EXIT_POLL_INTERVAL_MS, remainingMs));
    }
    return true;
}

/** Immediately kill the process named by the PID file and remove its stale ownership record. */
export async function killDaemonFromPidFile(
    pidPath: string,
    timeoutMs: number = DAEMON_KILL_TIMEOUT_MS,
): Promise<KillDaemonFromPidFileResult> {
    const pid = await readDaemonPid(pidPath);
    if (pid === undefined) return { found: false, killed: false };
    if (pid === process.pid) {
        throw new Error("Refusing to kill the process running this daemon command.");
    }
    if (!(await isDaemonProcessRunning(pid))) {
        await removeDaemonPid(pidPath, pid);
        return { found: true, killed: false, pid };
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch (error) {
        if (errorCode(error) !== "ESRCH") throw error;
    }
    if (!(await waitForDaemonProcessExit(pid, timeoutMs))) {
        throw new Error(`Daemon process ${String(pid)} did not exit after SIGKILL.`);
    }
    await removeDaemonPid(pidPath, pid);
    return { found: true, killed: true, pid };
}

function assertPid(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("A daemon PID must be a positive safe integer.");
    }
}

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
}

function isMissing(error: unknown): boolean {
    return errorCode(error) === "ENOENT";
}
