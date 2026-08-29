import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computePermissions } from "@slopus/happy-agent-compute";
import {
    AgentKV,
    withAgentConfig,
    type AgentModuleScope,
    type AgentModuleSystemScope,
} from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { ComputeModule, type ComputeProcessEvent } from "../../sources/compute/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { testConfig } from "../support/computeModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { FakeCompute } from "./support/FakeCompute.js";

const ctx = createRootContext().named("compute-abort-test");
const permissions = computePermissions("full_access");

describe("ComputeModule abort cleanup", () => {
    it("marks process state exited and sends SIGKILL to the complete process group", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "compute-abort-"));
        const module = new ComputeModule(testConfig, new SecretsModule());
        const agentId = "abort-agent";
        const agentCtx = withAgentConfig(ctx, {
            modules: { compute: { cwd } },
        });
        const events: ComputeProcessEvent[] = [];
        module.onProcessEvent((event) => {
            events.push(event);
        });

        try {
            const compute = await module.resolve(agentCtx, agentId);
            expect(compute).toBeDefined();
            const childScript = [
                "trap 'printf child-term > child.term' TERM",
                "printf '%s' \"$$\" > child.pid",
                "while :; do sleep 60; done",
            ].join("\n");
            const command = [
                "trap 'printf parent-term > parent.term' TERM",
                `sh -c ${shellQuote(childScript)} &`,
                "printf '%s' \"$$\" > parent.pid",
                "wait",
            ].join("\n");
            const sessionId = await compute!.shell.startSession({ command, permissions });
            compute!.shell.detachSession?.(sessionId);

            const [parentPid, childPid] = await vi.waitFor(async () => {
                const pids = await Promise.all([
                    readPid(join(cwd, "parent.pid")),
                    readPid(join(cwd, "child.pid")),
                ]);
                expect(pids.every((pid) => pid > 1)).toBe(true);
                return pids;
            });
            expect(module.abortSnapshot(agentId)).toMatchObject({
                processGroups: 1,
                sessions: [{ command, sessionId, status: "running" }],
            });

            await module.hardKillAgentProcesses(agentCtx, agentId);

            const [process] = await module.listProcesses(agentCtx, agentId);
            expect(process).toMatchObject({ exitCode: null, status: "exited" });
            expect(events.at(-1)).toMatchObject({
                changes: { exitCode: null, status: "exited" },
                processId: process?.id,
                type: "process_exited",
            });
            await vi.waitFor(() => {
                expect(processAlive(parentPid)).toBe(false);
                expect(processAlive(childPid)).toBe(false);
            });
            await expect(access(join(cwd, "parent.term"))).rejects.toThrow();
            await expect(access(join(cwd, "child.term"))).rejects.toThrow();
        } finally {
            await module.dispose(agentCtx);
            await rm(cwd, { force: true, recursive: true });
        }
    });

    it("kills a session whose spawn finishes after the abort snapshot", async () => {
        const compute = new FakeCompute();
        compute.script("late server", { keepRunning: true });
        const originalStart = compute.shell.startSession;
        let releaseStart: (() => void) | undefined;
        compute.shell.startSession = async (options) =>
            await new Promise<number>((resolve, reject) => {
                releaseStart = () => {
                    void originalStart.call(compute.shell, options).then(resolve, reject);
                };
            });
        let killAllCalls = 0;
        compute.shell.killAllSessions = async () => {
            killAllCalls += 1;
            const sessions = [...(compute.shell.activeSessions?.() ?? [])];
            await Promise.all(
                sessions.map(async ({ sessionId }) => {
                    await compute.shell.killSession(sessionId);
                }),
            );
            return sessions.length;
        };
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), {
            id: "host",
            create: async () => compute,
        });
        const agentId = "racing-agent";
        const agentCtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: compute.cwd } },
        });
        const persistence = new InMemoryPersistence();
        const kv = new AgentKV(persistence, "racing-compute.agent.");
        const sharedKV = new AgentKV(persistence, "racing-compute.shared.");
        const scope = {
            agent: { id: agentId, model: "openai/gpt-5.6-sol" },
            kv,
            sharedKV,
        } as AgentModuleScope;
        const hooks = await resolveModuleHooks(agentCtx, module);

        try {
            await hooks.tools!(agentCtx, scope);
            const resolved = await module.resolve(agentCtx, agentId);
            const starting = resolved!.shell.startSession({
                command: "late server",
                permissions,
            });
            expect(module.abortSnapshot(agentId)).toEqual({ processGroups: 0, sessions: [] });

            await module.hardKillAgentProcesses(agentCtx, agentId);
            releaseStart?.();
            await starting;

            expect(killAllCalls).toBe(2);
            expect(resolved!.shell.activeSessions?.()).toEqual([]);
            await expect(hooks.instructions!(agentCtx, scope)).resolves.toContain(
                'shell session 1: "late server"',
            );
        } finally {
            await module.dispose(agentCtx);
        }
    });

    it("stores one-shot kill notices in Compute's shared KV and prepends them from the instructions hook", async () => {
        const compute = new FakeCompute();
        compute.script("pnpm dev", { keepRunning: true });
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), {
            id: "host",
            create: async () => compute,
        });
        const agentId = "notice-agent";
        const agentCtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: compute.cwd } },
        });
        const persistence = new InMemoryPersistence();
        const kv = new AgentKV(persistence, "compute-notice.agent.");
        const sharedKV = new AgentKV(persistence, "compute-notice.shared.");
        const scope = {
            agent: { id: agentId, model: "openai/gpt-5.6-sol" },
            kv,
            sharedKV,
        } as AgentModuleScope;
        const hooks = await resolveModuleHooks(agentCtx, module);

        try {
            const systemScope = { sharedKV } as AgentModuleSystemScope;
            const lifecycleAgent = { id: agentId, metadata: undefined };
            await hooks.agentCreatedTransact!(agentCtx, systemScope, lifecycleAgent);
            const resolved = await module.resolve(agentCtx, agentId);
            const sessionId = await resolved!.shell.startSession({
                command: "pnpm dev",
                permissions,
            });
            resolved!.shell.detachSession?.(sessionId);

            await module.recordAbortNotice(agentCtx, agentId);

            expect(await kv.list(agentCtx)).toEqual([]);
            expect((await sharedKV.list(agentCtx)).map(({ key }) => key)).toContain(
                `abort-notices.${agentId}.pending`,
            );
            const first = await hooks.instructions!(agentCtx, scope);
            expect(first).toMatch(/^The previous abort hard-killed 1 background process tree/);
            expect(first).toContain(`shell session ${String(sessionId)}: "pnpm dev"`);

            await hooks.beforeInferenceTransact!(agentCtx, scope, {
                inferenceId: "inference",
                loopId: "loop",
                turnId: "turn",
                contextTokens: undefined,
            });

            expect(await sharedKV.list(agentCtx)).toEqual([]);
            const second = await hooks.instructions!(agentCtx, scope);
            expect(second).not.toContain("The previous abort hard-killed");

            await module.recordAbortNotice(agentCtx, agentId);
            expect(await sharedKV.list(agentCtx)).not.toEqual([]);
            await hooks.agentArchivedTransact!(agentCtx, systemScope, lifecycleAgent);
            expect(await sharedKV.list(agentCtx)).toEqual([]);
        } finally {
            await module.dispose(agentCtx);
        }
    });
});

async function readPid(path: string): Promise<number> {
    try {
        return Number.parseInt(await readFile(path, "utf8"), 10);
    } catch {
        return 0;
    }
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
