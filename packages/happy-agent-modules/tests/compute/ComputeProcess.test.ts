import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    MAX_RETAINED_EXITED_PROCESSES_PER_AGENT,
    type ComputeProcessEvent,
} from "../../sources/compute/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { FakeCompute } from "./support/FakeCompute.js";
import { computeToolset } from "./support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-compute-processes");
const AGENT_ID = "compute-agent";

describe("ComputeModule process lifecycle", () => {
    it("publishes stable process records and stops them by public ID", async () => {
        const compute = new FakeCompute();
        compute.script("pnpm dev", { chunks: ["listening\n"], keepRunning: true });
        const { module, tool, call } = await computeToolset(ctx, compute, {
            model: "anthropic/opus-5",
        });
        const events: ComputeProcessEvent[] = [];
        const unsubscribe = module.onProcessEvent((event) => {
            events.push(event);
        });
        // A broken optional observer cannot turn a successful process transition into a failure.
        module.onProcessEvent(() => {
            throw new Error("observer failed");
        });

        await tool("Bash").execute(ctx, { command: "pnpm dev", run_in_background: true }, call);

        const [running] = await module.listProcesses(ctx, AGENT_ID);
        expect(running).toMatchObject({
            agentId: AGENT_ID,
            command: "pnpm dev",
            endedAt: null,
            exitCode: null,
            status: "running",
        });
        expect(running?.id).toMatch(/^[a-z0-9]+$/);
        expect(running?.version).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(events).toEqual([
            {
                agentId: AGENT_ID,
                process: running,
                runningProcesses: 1,
                type: "process_started",
            },
        ]);

        const stopped = await module.stopProcess(ctx, AGENT_ID, running!.id);
        expect(stopped).toMatchObject({
            id: running?.id,
            status: "exited",
            exitCode: null,
        });
        expect(stopped?.version).not.toBe(running?.version);
        expect(events).toEqual([
            {
                agentId: AGENT_ID,
                process: running,
                runningProcesses: 1,
                type: "process_started",
            },
            {
                agentId: AGENT_ID,
                changes: {
                    endedAt: stopped?.endedAt,
                    exitCode: null,
                    status: "exited",
                },
                previousVersion: running?.version,
                processId: running?.id,
                runningProcesses: 0,
                type: "process_exited",
                version: stopped?.version,
            },
        ]);
        await expect(module.stopProcess(ctx, AGENT_ID, running!.id)).resolves.toEqual(stopped);
        await expect(
            module.stopProcess(ctx, "another-agent", running!.id),
        ).resolves.toBeUndefined();
        unsubscribe();
    });

    it("excludes foreground commands and observes a background exit once", async () => {
        const compute = new FakeCompute();
        compute.script("quick", { chunks: ["done\n"] });
        const build = { chunks: ["building\n"], exitCode: 7, keepRunning: true };
        compute.script("build", build);
        compute.script("server", { keepRunning: true });
        const { module, tool } = await computeToolset(ctx, compute, {
            model: "anthropic/opus-5",
        });
        const events: ComputeProcessEvent[] = [];
        module.onProcessEvent((event) => {
            events.push(event);
        });

        await tool("Bash").execute(ctx, { command: "quick" });
        await expect(module.listProcesses(ctx, AGENT_ID)).resolves.toEqual([]);

        await tool("Bash").execute(ctx, { command: "build", run_in_background: true });
        build.keepRunning = false;
        await module.readCommand(AGENT_ID, 2);
        // A later active-session notification must not rediscover the completed backend session.
        await tool("Bash").execute(ctx, { command: "server", run_in_background: true });

        await vi.waitFor(async () => {
            const processes = await module.listProcesses(ctx, AGENT_ID);
            expect(processes).toHaveLength(2);
            expect(processes[1]).toMatchObject({
                command: "build",
                exitCode: 7,
                status: "exited",
            });
        });
        expect(events.filter((event) => event.type === "process_started")).toHaveLength(2);
        expect(events.filter((event) => event.type === "process_exited")).toHaveLength(1);
    });

    it("reports the owner and exact running count after each transition", async () => {
        const compute = new FakeCompute();
        compute.script("first", { keepRunning: true });
        compute.script("second", { keepRunning: true });
        const { module, tool } = await computeToolset(ctx, compute, {
            model: "anthropic/opus-5",
        });
        const events: ComputeProcessEvent[] = [];
        module.onProcessEvent((event) => {
            events.push(event);
        });

        await tool("Bash").execute(ctx, { command: "first", run_in_background: true });
        await tool("Bash").execute(ctx, { command: "second", run_in_background: true });
        const first = (await module.listProcesses(ctx, AGENT_ID)).find(
            (process) => process.command === "first",
        );
        await module.stopProcess(ctx, AGENT_ID, first!.id);

        expect(
            events.map(({ agentId, runningProcesses, type }) => ({
                agentId,
                runningProcesses,
                type,
            })),
        ).toEqual([
            { agentId: AGENT_ID, runningProcesses: 1, type: "process_started" },
            { agentId: AGENT_ID, runningProcesses: 2, type: "process_started" },
            { agentId: AGENT_ID, runningProcesses: 1, type: "process_exited" },
        ]);
    });

    it("projects background processes without a backend detach hook", async () => {
        const compute = new FakeCompute();
        delete compute.shell.detachSession;
        compute.script("quick", { chunks: ["done\n"] });
        compute.script("watch", { keepRunning: true });
        const { module, tool, call } = await computeToolset(ctx, compute, {
            model: "anthropic/opus-5",
        });
        const events: ComputeProcessEvent[] = [];
        module.onProcessEvent((event) => {
            events.push(event);
        });

        await tool("Bash").execute(ctx, { command: "quick" }, call);
        await expect(module.listProcesses(ctx, AGENT_ID)).resolves.toEqual([]);

        await tool("Bash").execute(ctx, { command: "watch", run_in_background: true }, call);

        const [running] = await module.listProcesses(ctx, AGENT_ID);
        expect(running).toMatchObject({
            agentId: AGENT_ID,
            command: "watch",
            status: "running",
        });
        expect(events).toEqual([
            {
                agentId: AGENT_ID,
                process: running,
                runningProcesses: 1,
                type: "process_started",
            },
        ]);

        const stopped = await module.stopProcess(ctx, AGENT_ID, running!.id);
        expect(stopped).toMatchObject({
            id: running?.id,
            status: "exited",
        });
        expect(events.at(-1)).toMatchObject({
            previousVersion: running?.version,
            processId: running?.id,
            type: "process_exited",
            version: stopped?.version,
        });

        await module.dispose(ctx);
        expect(compute.shell.detachSession).toBeUndefined();
    });

    it("retains bounded exited history and finalizes running rows when an agent is archived", async () => {
        const compute = new FakeCompute();
        compute.script("done", { keepRunning: true });
        compute.script("watch", { keepRunning: true });
        const { module, tool } = await computeToolset(ctx, compute, {
            model: "anthropic/opus-5",
        });
        const startedIds: string[] = [];
        module.onProcessEvent((event) => {
            if (event.type === "process_started") startedIds.push(event.process.id);
        });

        for (let index = 0; index <= MAX_RETAINED_EXITED_PROCESSES_PER_AGENT; index += 1) {
            await tool("Bash").execute(ctx, { command: "done", run_in_background: true });
            const process = (await module.listProcesses(ctx, AGENT_ID))[0];
            await module.stopProcess(ctx, AGENT_ID, process!.id);
        }
        await vi.waitFor(async () => {
            const retained = await module.listProcesses(ctx, AGENT_ID);
            expect(retained).toHaveLength(MAX_RETAINED_EXITED_PROCESSES_PER_AGENT);
            expect(retained.every((process) => process.status === "exited")).toBe(true);
        });
        expect(
            (await module.listProcesses(ctx, AGENT_ID)).some(({ id }) => id === startedIds[0]),
        ).toBe(false);

        await tool("Bash").execute(ctx, { command: "watch", run_in_background: true });
        const running = (await module.listProcesses(ctx, AGENT_ID))[0];
        expect(running).toMatchObject({ command: "watch", status: "running" });

        const hooks = await resolveModuleHooks(ctx, module);
        await hooks.agentArchived?.(ctx, {} as never, {
            id: AGENT_ID,
            metadata: undefined,
        });

        const archived = (await module.listProcesses(ctx, AGENT_ID)).find(
            ({ id }) => id === running?.id,
        );
        expect(archived).toMatchObject({
            endedAt: expect.any(Number),
            exitCode: null,
            status: "exited",
        });
        expect(await module.runningCommands(AGENT_ID)).toEqual([]);
    });
});
