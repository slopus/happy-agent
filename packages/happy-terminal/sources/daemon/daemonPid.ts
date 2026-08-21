import { readFile, unlink } from "node:fs/promises";

import type { Context } from "@steve.kite/stdlib";

import { isTargetProcessAlive, waitForProcessExit } from "../processes/index.js";

const DAEMON_KILL_TIMEOUT_MS = 5_000;

export interface KillDaemonFromPidFileResult {
    readonly found: boolean;
    readonly killed: boolean;
    readonly pid?: number;
}

export async function readDaemonPid(pidPath: string): Promise<number | undefined> {
    let text: string;
    try {
        text = await readFile(pidPath, "utf8");
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
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

export async function removeDaemonPid(pidPath: string, expectedPid: number): Promise<boolean> {
    const recordedPid = await readDaemonPid(pidPath);
    if (recordedPid === undefined || recordedPid !== expectedPid) return false;
    try {
        await unlink(pidPath);
        return true;
    } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
    }
}

export async function killDaemonFromPidFile(
    ctx: Context,
    pidPath: string,
): Promise<KillDaemonFromPidFileResult> {
    const pid = await readDaemonPid(pidPath);
    if (pid === undefined) return { found: false, killed: false };
    const killed = await killDaemonProcess(ctx, pid);
    await removeDaemonPid(pidPath, pid);
    return { found: true, killed, pid };
}

/** Immediately kill one exact daemon PID and wait for the operating system to release it. */
export async function killDaemonProcess(
    ctx: Context,
    pid: number,
    timeoutMs: number = DAEMON_KILL_TIMEOUT_MS,
): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("A daemon PID must be a positive safe integer.");
    }
    if (pid === process.pid) {
        throw new Error("Refusing to kill the process running this daemon command.");
    }
    if (!isTargetProcessAlive(pid)) return false;
    try {
        process.kill(pid, "SIGKILL");
    } catch (error) {
        if (errorCode(error) !== "ESRCH") throw error;
    }
    if (!(await waitForProcessExit(ctx, pid, timeoutMs))) {
        throw new Error(`Daemon process ${String(pid)} did not exit after SIGKILL.`);
    }
    return true;
}

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
}
