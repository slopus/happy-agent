import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";
import type { ComputeSessionExit } from "@slopus/happy-agent-compute";

import { createUuidV7Factory } from "../events/index.js";
import type { HostCompute } from "./ComputeModule.js";
import {
    computeProcessEventListenerSchema,
    computeProcessEventSchema,
    MAX_RETAINED_EXITED_PROCESSES,
    MAX_RETAINED_EXITED_PROCESSES_PER_AGENT,
    type ComputeProcess,
    type ComputeProcessEvent,
    type ComputeProcessEventListener,
    type ComputeProcessUnsubscribe,
} from "./ComputeProcess.js";

interface ProcessHandle {
    readonly agentId: string;
    readonly compute: HostCompute;
    readonly sessionId: number;
}

interface AgentProcesses {
    readonly records: Map<string, ComputeProcess>;
    readonly sessionIds: Map<HostCompute, Map<number, string>>;
}

/** Bounded, daemon-lifetime public state projected from private compute-shell sessions. */
export class ComputeProcessRegistry {
    readonly #listeners = new Set<ComputeProcessEventListener>();
    readonly #processes = new Map<string, AgentProcesses>();
    readonly #handles = new Map<string, ProcessHandle>();
    readonly #trackingCleanups = new Map<HostCompute, () => void>();
    readonly #exitedOrder: { readonly agentId: string; readonly processId: string }[] = [];
    readonly #nextVersion = createUuidV7Factory();
    readonly #operations = new Set<Promise<unknown>>();

    onEvent(listener: ComputeProcessEventListener): ComputeProcessUnsubscribe {
        if (!Value.Check(computeProcessEventListenerSchema, listener)) {
            throw new Error("A process subscriber must be a function.");
        }
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    list(agentId: string): readonly ComputeProcess[] {
        return [...(this.#processes.get(agentId)?.records.values() ?? [])]
            .reverse()
            .map((process) => structuredClone(process));
    }

    /** Observe detach, active-count, and exit callbacks before this compute reaches any tool. */
    attach(agentId: string, compute: HostCompute): void {
        const shell = compute.shell;
        const originalDetach = shell.detachSession;
        const trackedDetach = (sessionId: number): void => {
            originalDetach?.call(shell, sessionId);
            const session = shell
                .activeSessions?.()
                .find((candidate) => candidate.sessionId === sessionId);
            if (session !== undefined) {
                this.#start(agentId, compute, sessionId, session.command);
            }
        };
        shell.detachSession = trackedDetach;
        shell.setSessionExitListener?.((exit) => {
            this.#exitFromNotice(agentId, compute, exit);
        });
        shell.setActiveSessionCountListener?.(() => {
            const operation = this.#reconcile(agentId, compute);
            void this.#track(operation).catch(() => undefined);
        });
        this.#trackingCleanups.set(compute, () => {
            shell.setActiveSessionCountListener?.(undefined);
            shell.setSessionExitListener?.(undefined);
            if (shell.detachSession === trackedDetach) {
                if (originalDetach === undefined) {
                    delete shell.detachSession;
                } else {
                    shell.detachSession = originalDetach;
                }
            }
        });
    }

    detach(compute: HostCompute): void {
        this.#trackingCleanups.get(compute)?.();
        this.#trackingCleanups.delete(compute);
    }

    async drain(): Promise<void> {
        await Promise.allSettled([...this.#operations]);
    }

    clear(): void {
        this.#processes.clear();
        this.#handles.clear();
        this.#trackingCleanups.clear();
        this.#exitedOrder.splice(0);
        this.#listeners.clear();
    }

    exit(agentId: string, compute: HostCompute, sessionId: number, exitCode: number | null): void {
        const state = this.#processes.get(agentId);
        const processId = state?.sessionIds.get(compute)?.get(sessionId);
        const before = processId === undefined ? undefined : state?.records.get(processId);
        if (state === undefined || processId === undefined || before?.status !== "running") return;

        const version = this.#nextVersion();
        const endedAt = Date.now();
        const after: ComputeProcess = {
            ...before,
            endedAt,
            exitCode,
            status: "exited",
            version,
        };
        state.records.set(processId, after);
        this.#handles.delete(processId);
        this.#exitedOrder.push({ agentId, processId });
        this.#emit({
            agentId,
            changes: { endedAt, exitCode, status: "exited" },
            previousVersion: before.version,
            processId,
            runningProcesses: this.#runningProcesses(agentId),
            type: "process_exited",
            version,
        });
        this.#trim(agentId);
    }

    async stop(agentId: string, processId: string): Promise<ComputeProcess | undefined> {
        const existing = this.#processes.get(agentId)?.records.get(processId);
        if (existing === undefined) return undefined;
        if (existing.status === "exited") return structuredClone(existing);
        const handle = this.#handles.get(processId);
        if (handle === undefined || handle.agentId !== agentId) return undefined;
        const stopped = await handle.compute.shell.killSession(handle.sessionId);
        if (stopped === undefined) {
            this.exit(agentId, handle.compute, handle.sessionId, null);
        } else if (stopped.status !== "running") {
            this.exit(agentId, handle.compute, handle.sessionId, stopped.exitCode);
        }
        const process = this.#processes.get(agentId)?.records.get(processId);
        return process === undefined ? undefined : structuredClone(process);
    }

    exitAll(agentId: string, compute: HostCompute): void {
        const sessionIds = this.#processes.get(agentId)?.sessionIds.get(compute);
        if (sessionIds === undefined) return;
        for (const sessionId of sessionIds.keys()) this.exit(agentId, compute, sessionId, null);
    }

    async #reconcile(agentId: string, compute: HostCompute): Promise<void> {
        const activeIds = new Set(
            (compute.shell.activeSessions?.() ?? []).map((session) => session.sessionId),
        );
        const sessionIds = this.#processes.get(agentId)?.sessionIds.get(compute);
        if (sessionIds === undefined) return;
        const ended = [...sessionIds.entries()]
            .filter(
                ([sessionId, processId]) =>
                    !activeIds.has(sessionId) &&
                    this.#processes.get(agentId)?.records.get(processId)?.status === "running",
            )
            .map(([sessionId]) => sessionId);
        await Promise.all(
            ended.map(async (sessionId) => {
                const snapshot = await compute.shell.readSession(sessionId, { peek: true });
                if (snapshot?.status !== "running") {
                    this.exit(agentId, compute, sessionId, snapshot?.exitCode ?? null);
                }
            }),
        );
    }

    #start(
        agentId: string,
        compute: HostCompute,
        sessionId: number,
        command: string,
    ): ComputeProcess {
        const state = this.#agentProcesses(agentId);
        const sessionIds = this.#sessionIds(state, compute);
        const existingId = sessionIds.get(sessionId);
        const existing = existingId === undefined ? undefined : state.records.get(existingId);
        if (existing !== undefined) return existing;

        const process: ComputeProcess = {
            agentId,
            command,
            endedAt: null,
            exitCode: null,
            id: createId(),
            startedAt: Date.now(),
            status: "running",
            version: this.#nextVersion(),
        };
        sessionIds.set(sessionId, process.id);
        state.records.set(process.id, process);
        this.#handles.set(process.id, { agentId, compute, sessionId });
        this.#emit({
            agentId,
            process: structuredClone(process),
            runningProcesses: this.#runningProcesses(agentId),
            type: "process_started",
        });
        return process;
    }

    #exitFromNotice(agentId: string, compute: HostCompute, exit: ComputeSessionExit): void {
        this.exit(agentId, compute, exit.sessionId, exit.exitCode);
    }

    #trim(agentId: string): void {
        const state = this.#processes.get(agentId);
        if (state === undefined) return;
        const agentExited = [...state.records.values()].filter(
            (process) => process.status === "exited",
        );
        while (agentExited.length > MAX_RETAINED_EXITED_PROCESSES_PER_AGENT) {
            const oldest = agentExited.shift();
            if (oldest !== undefined) this.#remove(agentId, oldest.id);
        }
        while (this.#exitedOrder.length > MAX_RETAINED_EXITED_PROCESSES) {
            const oldest = this.#exitedOrder.shift();
            if (oldest !== undefined) this.#remove(oldest.agentId, oldest.processId);
        }
    }

    #remove(agentId: string, processId: string): void {
        const state = this.#processes.get(agentId);
        const process = state?.records.get(processId);
        if (state === undefined || process?.status !== "exited") return;
        state.records.delete(processId);
        for (const [compute, sessionIds] of state.sessionIds) {
            for (const [sessionId, candidate] of sessionIds) {
                if (candidate === processId) sessionIds.delete(sessionId);
            }
            if (sessionIds.size === 0) state.sessionIds.delete(compute);
        }
        const retained = this.#exitedOrder.filter(
            (entry) => entry.agentId !== agentId || entry.processId !== processId,
        );
        this.#exitedOrder.splice(0, this.#exitedOrder.length, ...retained);
        if (state.records.size === 0) this.#processes.delete(agentId);
    }

    #agentProcesses(agentId: string): AgentProcesses {
        let state = this.#processes.get(agentId);
        if (state === undefined) {
            state = { records: new Map(), sessionIds: new Map() };
            this.#processes.set(agentId, state);
        }
        return state;
    }

    #sessionIds(state: AgentProcesses, compute: HostCompute): Map<number, string> {
        let ids = state.sessionIds.get(compute);
        if (ids === undefined) {
            ids = new Map();
            state.sessionIds.set(compute, ids);
        }
        return ids;
    }

    #runningProcesses(agentId: string): number {
        let running = 0;
        for (const process of this.#processes.get(agentId)?.records.values() ?? []) {
            if (process.status === "running") running += 1;
        }
        return running;
    }

    #emit(event: ComputeProcessEvent): void {
        if (!Value.Check(computeProcessEventSchema, event)) {
            throw new Error("The compute module created an invalid process event.");
        }
        for (const listener of [...this.#listeners]) {
            try {
                void Promise.resolve(listener(structuredClone(event))).catch(() => undefined);
            } catch {
                // Process state already changed. Optional observation cannot undo its lifecycle.
            }
        }
    }

    async #track<Result>(operation: Promise<Result>): Promise<Result> {
        this.#operations.add(operation);
        try {
            return await operation;
        } finally {
            this.#operations.delete(operation);
        }
    }
}
