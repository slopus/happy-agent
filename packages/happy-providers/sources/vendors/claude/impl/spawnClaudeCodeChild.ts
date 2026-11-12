import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Claude Code allows its token request 30 s; a stop may wait that long and a little more. */
const STOP_WAIT_MS = 32_000;
/** Claude Code touches a held refresh lock every 5 s, so an older one has no live holder. */
const ABANDONED_LOCK_MS = 10_000;
const LOCK_POLL_MS = 100;

/** What Claude Code records about the process holding the refresh lock it just took. */
const lockOwnerSchema = Type.Object({ pid: Type.Integer(), lockBirthtimeMs: Type.Number() });

export interface ClaudeCodeChildSettings {
    /** Starts the child in a process group of its own. */
    detached?: boolean;
    /** Receives Claude Code's diagnostics; without it they are drained and dropped. */
    onStderr?: (chunk: string) => void;
    stopWaitMs?: number;
    lockPollMs?: number;
}

interface PendingStop {
    storageDirectory: string;
    stopWaitMs: number;
    lockPollMs: number;
    deadline?: number;
    timer?: NodeJS.Timeout | undefined;
    stops: (() => void)[];
}

const pendingStops = new WeakMap<ChildProcess, PendingStop>();

/**
 * Spawns a Claude Code child whose stops never cut a sign-in renewal short.
 *
 * Claude Code renews a stored sign-in by spending the refresh token at the token endpoint and
 * then saving the new pair. A child stopped between those two steps leaves the store holding a
 * refresh token the server has already spent. The next renewal by any process is refused, and
 * Claude Code then clears the shared sign-in, so every session on that account fails until the
 * person signs in again. Every stop of this child therefore waits while the child holds the
 * sign-in's refresh lock, for at most as long as Claude Code allows the renewal.
 */
export function spawnClaudeCodeChild(
    options: SpawnOptions,
    settings: ClaudeCodeChildSettings = {},
) {
    const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: settings.detached ?? false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    if (settings.onStderr === undefined) {
        // A full pipe would stall Claude Code.
        child.stderr.resume();
    } else {
        const onStderr = settings.onStderr;
        child.stderr.on("data", (chunk: Buffer) => onStderr(chunk.toString("utf8")));
    }
    pendingStops.set(child, {
        storageDirectory: claudeCodeStorageDirectory(options.env),
        stopWaitMs: settings.stopWaitMs ?? STOP_WAIT_MS,
        lockPollMs: settings.lockPollMs ?? LOCK_POLL_MS,
        stops: [],
    });

    const sendSignal = child.kill.bind(child);
    let requested: NodeJS.Signals | undefined;
    child.kill = (signal?: NodeJS.Signals | number): boolean => {
        if (exited(child)) return false;
        const name = typeof signal === "string" ? signal : "SIGTERM";
        const queued = requested !== undefined;
        if (requested !== "SIGKILL") requested = name;
        if (queued) return true;
        afterClaudeCodeRenewal(child, () => {
            const stop = requested;
            requested = undefined;
            if (stop !== undefined) sendSignal(stop);
        });
        return true;
    };
    child.once("exit", () => {
        const pending = pendingStops.get(child);
        clearTimeout(pending?.timer);
        if (pending !== undefined) pending.stops = [];
    });
    // The SDK aborts this signal once its graceful close has run out.
    options.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    return child;
}

/**
 * Runs `stop` once no renewal of the child's sign-in is in progress. Every stop of one child
 * shares a single wait, so a child is never held longer than that in total.
 */
export function afterClaudeCodeRenewal(child: ChildProcess, stop: () => void): void {
    const pending = pendingStops.get(child);
    if (pending === undefined) {
        stop();
        return;
    }
    if (exited(child)) return;
    pending.deadline ??= Date.now() + pending.stopWaitMs;
    pending.stops.push(stop);
    settle(child, pending);
}

function settle(child: ChildProcess, pending: PendingStop): void {
    if (pending.timer !== undefined || exited(child)) return;
    if (Date.now() < (pending.deadline ?? 0) && renewing(child, pending.storageDirectory)) {
        pending.timer = setTimeout(() => {
            pending.timer = undefined;
            settle(child, pending);
        }, pending.lockPollMs);
        pending.timer.unref();
        return;
    }
    for (const stop of pending.stops.splice(0)) stop();
}

function exited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

/** Where Claude Code keeps the sign-in and its refresh lock for a child with this environment. */
function claudeCodeStorageDirectory(env: SpawnOptions["env"]): string {
    const fallback = join(env.HOME?.trim() || homedir(), ".claude");
    const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    if (secure !== undefined) return (secure || fallback).normalize("NFC");
    return (env.CLAUDE_CONFIG_DIR?.trim() || fallback).normalize("NFC");
}

/**
 * Whether this child may be renewing the sign-in kept in `storageDirectory`. Claude Code names the
 * holder of a fresh refresh lock in an owner record written just after taking it; until that
 * record matches the lock, or for a release that only takes the older sibling lock, the holder is
 * unknown and is assumed to be this child.
 */
function renewing(child: ChildProcess, storageDirectory: string): boolean {
    const lock = freshLock(join(storageDirectory, ".oauth_refresh.lock"));
    if (lock === undefined)
        return freshLock(`${resolvedPath(storageDirectory)}.lock`) !== undefined;
    const owner = lockOwner(join(storageDirectory, ".oauth_refresh.lock.owner"));
    if (owner === undefined || owner.lockBirthtimeMs !== lock.birthtimeMs) return true;
    return owner.pid === child.pid;
}

function freshLock(path: string): { birthtimeMs: number } | undefined {
    try {
        const stats = lstatSync(path);
        return Date.now() - stats.mtimeMs < ABANDONED_LOCK_MS ? stats : undefined;
    } catch {
        return undefined;
    }
}

function lockOwner(path: string): { pid: number; lockBirthtimeMs: number } | undefined {
    try {
        const owner: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Value.Check(lockOwnerSchema, owner) ? owner : undefined;
    } catch {
        return undefined;
    }
}

function resolvedPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}
