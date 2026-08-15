import type { SessionTerminalHeartbeatRequest } from "../protocol/index.js";
import { isTargetProcessAlive } from "../processes/isTargetProcessAlive.js";

const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_TERMINAL_TIMEOUT_MS = 20_000;

interface SessionTerminalConnection {
    focused: boolean;
    lastHeartbeatAt: number;
    targetPid: number;
}

export class SessionTerminalTracker {
    readonly #connections = new Map<string, Map<string, SessionTerminalConnection>>();
    readonly #isTargetAlive: (pid: number) => boolean;
    readonly #now: () => number;
    readonly #terminalTimeoutMs: number;
    readonly #timer: ReturnType<typeof setInterval>;

    constructor(
        options: {
            isTargetAlive?: (pid: number) => boolean;
            now?: () => number;
            sweepIntervalMs?: number;
            terminalTimeoutMs?: number;
        } = {},
    ) {
        this.#isTargetAlive = options.isTargetAlive ?? isTargetProcessAlive;
        this.#now = options.now ?? Date.now;
        this.#terminalTimeoutMs = options.terminalTimeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS;
        this.#timer = setInterval(
            () => this.sweep(),
            options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
        );
        this.#timer.unref?.();
    }

    disconnect(sessionId: string, connectionId: string): boolean {
        const terminals = this.#connections.get(sessionId);
        if (terminals === undefined) return false;
        const disconnected = terminals.delete(connectionId);
        if (terminals.size === 0) this.#connections.delete(sessionId);
        return disconnected;
    }

    dispose(): void {
        clearInterval(this.#timer);
        this.#connections.clear();
    }

    hasConnectedTerminal(sessionId: string): boolean {
        this.#sweepSession(sessionId, this.#now());
        return (this.#connections.get(sessionId)?.size ?? 0) > 0;
    }

    hasFocusedTerminal(sessionId: string): boolean {
        this.#sweepSession(sessionId, this.#now());
        return [...(this.#connections.get(sessionId)?.values() ?? [])].some(
            (connection) => connection.focused,
        );
    }

    heartbeat(sessionId: string, request: SessionTerminalHeartbeatRequest): void {
        validateHeartbeat(request);
        const terminals = this.#connections.get(sessionId) ?? new Map();
        terminals.set(request.connectionId, {
            focused: request.focused,
            lastHeartbeatAt: this.#now(),
            targetPid: request.targetPid,
        });
        this.#connections.set(sessionId, terminals);
    }

    sweep(): void {
        const now = this.#now();
        for (const sessionId of this.#connections.keys()) this.#sweepSession(sessionId, now);
    }

    #sweepSession(sessionId: string, now: number): void {
        const terminals = this.#connections.get(sessionId);
        if (terminals === undefined) return;
        for (const [connectionId, connection] of terminals) {
            const timedOut = now - connection.lastHeartbeatAt > this.#terminalTimeoutMs;
            if (timedOut || !this.#isTargetAlive(connection.targetPid)) {
                terminals.delete(connectionId);
            }
        }
        if (terminals.size === 0) this.#connections.delete(sessionId);
    }
}

function validateHeartbeat(request: SessionTerminalHeartbeatRequest): void {
    if (
        typeof request.connectionId !== "string" ||
        request.connectionId.length === 0 ||
        request.connectionId.length > 128
    ) {
        throw new Error("The terminal connection ID must contain between 1 and 128 characters.");
    }
    if (!Number.isSafeInteger(request.targetPid) || request.targetPid <= 0) {
        throw new Error("The terminal process ID must be a positive integer.");
    }
    if (typeof request.focused !== "boolean") {
        throw new Error("The terminal focus state must be a boolean.");
    }
}
