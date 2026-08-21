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
    if (pid === process.pid) {
        throw new Error("Refusing to kill the process running this daemon command.");
    }
    if (!isTargetProcessAlive(pid)) {
        await removeDaemonPid(pidPath, pid);
        return { found: true, killed: false, pid };
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch (error) {
        if (errorCode(error) !== "ESRCH") throw error;
    }
    if (!(await waitForProcessExit(ctx, pid, DAEMON_KILL_TIMEOUT_MS))) {
        throw new Error(`Daemon process ${String(pid)} did not exit after SIGKILL.`);
    }
    await removeDaemonPid(pidPath, pid);
    return { found: true, killed: true, pid };
}

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
}
