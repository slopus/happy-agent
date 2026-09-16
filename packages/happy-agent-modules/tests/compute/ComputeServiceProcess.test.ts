import { withAgentConfig } from "@slopus/happy-agent-base";
import {
    computePermissions,
    type ComputeService,
    type ComputeServiceExit,
    type ComputeServiceStartOptions,
} from "@slopus/happy-agent-compute";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { ComputeModule, type HostCompute } from "../../sources/compute/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { testConfig } from "../support/computeModule.js";
import { FakeCompute } from "./support/FakeCompute.js";

const ctx = createRootContext().named("compute-service-process-test");
const agentId = "service-agent";
const options: ComputeServiceStartOptions = {
    execution: { id: "a1234567890123456", directory: "/private/services/a1234567890123456" },
    command: "node server.js",
    cwd: ".",
    port: 4187,
    tty: false,
    permissions: computePermissions("auto"),
    sandbox: {
        inputs: ["server.js"],
        scratch: [],
        outbound: [],
        limits: { memoryMiB: 128, processes: 8 },
    },
};
const exited: ComputeServiceExit = { exitCode: null, killed: true, startupFailed: false };

function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture() {
    const finished = deferred<ComputeServiceExit>();
    const service: ComputeService = {
        execution: options.execution,
        processId: "process-1",
        admitted: Promise.resolve(true),
        completion: finished.promise,
        read: () => ({
            stdout: "",
            stderr: "",
            position: { stdout: 0, stderr: 0 },
            truncated: false,
        }),
        write: vi.fn(async () => true),
        connect: vi.fn(async () => {
            throw new Error("The test endpoint is not listening.");
        }),
        stop: vi.fn(async () => await finished.promise),
    };
    const fake = new FakeCompute();
    const start = vi.fn(async (_ctx: Context, _options: ComputeServiceStartOptions) => service);
    const dispose = vi.fn(async () => {
        await service.stop(ctx);
    });
    const compute = Object.assign(fake, {
        services: { start, reconcile: vi.fn(async () => {}), dispose },
        dispose,
    }) satisfies HostCompute;
    const module = ComputeModule.withProvider(testConfig, new SecretsModule(), {
        id: "host",
        create: async () => compute,
    });
    const agentCtx = withAgentConfig(ctx, { modules: { compute: { cwd: fake.cwd } } });
    return { module, compute, agentCtx, service, start, dispose, finished };
}

describe("services in the ordinary agent process catalog", () => {
    it("finalizes the public process when an independent reconciliation proves failed cleanup has completed", async () => {
        const f = fixture();
        try {
            const { process } = await f.module.startService(f.agentCtx, agentId, options);
            vi.mocked(f.service.stop).mockRejectedValueOnce(new Error("Cleanup is not confirmed."));
            await expect(f.module.stopProcess(ctx, agentId, process.id)).rejects.toThrow(
                "not confirmed",
            );
            await f.module.reconcileService(f.agentCtx, agentId, options.execution);
            expect((await f.module.listProcesses(ctx, agentId))[0]?.status).toBe("exited");
            expect(f.compute.services.reconcile).toHaveBeenCalledWith(
                f.agentCtx,
                options.execution,
            );
        } finally {
            f.finished.resolve(exited);
            await f.module.dispose(ctx);
        }
    });
    it("retains failed archive cleanup ownership, refuses new work, and permits a cleanup retry", async () => {
        const f = fixture();
        try {
            const { process } = await f.module.startService(f.agentCtx, agentId, options);
            f.dispose.mockRejectedValueOnce(new Error("Cleanup is not confirmed."));
            await expect(f.module.archiveAgent(ctx, agentId)).rejects.toThrow("not confirmed");
            expect((await f.module.listProcesses(ctx, agentId))[0]?.status).toBe("running");
            await expect(f.module.startService(f.agentCtx, agentId, options)).rejects.toThrow(
                /closing/i,
            );
            const retry = f.module.stopProcess(ctx, agentId, process.id);
            await vi.waitFor(() => expect(f.service.stop).toHaveBeenCalledTimes(1));
            f.finished.resolve(exited);
            await retry;
            await f.module.archiveAgent(ctx, agentId);
            expect(f.dispose).toHaveBeenCalledTimes(2);
        } finally {
            f.finished.resolve(exited);
            await f.module.dispose(ctx);
        }
    });

    it("refuses providers without the strict service capability without starting an ordinary shell", async () => {
        const compute = new FakeCompute();
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), {
            id: "host",
            create: async () => compute,
        });
        try {
            const agentCtx = withAgentConfig(ctx, { modules: { compute: { cwd: compute.cwd } } });
            await expect(module.startService(agentCtx, agentId, options)).rejects.toThrow(
                /sandboxed services/i,
            );
            expect(compute.sessions).toEqual([]);
        } finally {
            await module.dispose(ctx);
        }
    });
    it("does not pretend a failed teardown is an exited process", async () => {
        const f = fixture();
        try {
            const { process } = await f.module.startService(f.agentCtx, agentId, options);
            vi.mocked(f.service.stop).mockRejectedValueOnce(new Error("Cleanup is not confirmed."));
            await expect(f.module.stopProcess(ctx, agentId, process.id)).rejects.toThrow(
                "not confirmed",
            );
            expect((await f.module.listProcesses(ctx, agentId))[0]?.status).toBe("running");
            f.finished.resolve(exited);
            await vi.waitFor(async () =>
                expect((await f.module.listProcesses(ctx, agentId))[0]?.status).toBe("exited"),
            );
        } finally {
            f.finished.resolve(exited);
            await f.module.dispose(ctx);
        }
    });

    it("aborts the service without finalizing its process row before the sandbox barrier", async () => {
        const f = fixture();
        try {
            await f.module.startService(f.agentCtx, agentId, options);
            const killing = f.module.hardKillAgentProcesses(ctx, agentId);
            await vi.waitFor(() => expect(f.service.stop).toHaveBeenCalledTimes(1));
            expect((await f.module.listProcesses(ctx, agentId))[0]?.status).toBe("running");
            f.finished.resolve(exited);
            await killing;
            expect((await f.module.listProcesses(ctx, agentId))[0]?.status).toBe("exited");
        } finally {
            f.finished.resolve(exited);
            await f.module.dispose(ctx);
        }
    });

    it("stops a service whose startup crosses an owning-agent abort", async () => {
        const f = fixture();
        const starting = deferred<ComputeService>();
        f.start.mockImplementationOnce(async () => await starting.promise);
        try {
            const launched = f.module.startService(f.agentCtx, agentId, options);
            await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
            await f.module.hardKillAgentProcesses(ctx, agentId);
            starting.resolve(f.service);
            await vi.waitFor(() => expect(f.service.stop).toHaveBeenCalledTimes(1));
            f.finished.resolve(exited);
            await launched;
            expect((await f.module.listProcesses(ctx, agentId))[0]?.status).toBe("exited");
        } finally {
            starting.resolve(f.service);
            f.finished.resolve(exited);
            await f.module.dispose(ctx);
        }
    });
    it("uses one public process identity and waits for confirmed cleanup when stopped by that ID", async () => {
        const f = fixture();
        try {
            const started = await f.module.startService(f.agentCtx, agentId, options);
            const [process] = await f.module.listProcesses(ctx, agentId);
            expect(started.service).toBe(f.service);
            expect(started.process).toEqual(process);
            expect(process).toMatchObject({ command: options.command, status: "running" });
            expect(process!.id).not.toBe(f.service.processId);
            expect(f.compute.sessions).toEqual([]);
            expect(f.start).toHaveBeenCalledTimes(1);
            expect(f.start.mock.calls[0]?.[0]).not.toBe(f.agentCtx);
            await expect(
                f.module.stopProcess(ctx, "other-agent", process!.id),
            ).resolves.toBeUndefined();
            expect(f.service.stop).not.toHaveBeenCalled();
            const stopping = f.module.stopProcess(ctx, agentId, process!.id);
            await vi.waitFor(() => expect(f.service.stop).toHaveBeenCalledTimes(1));
            expect((await f.module.listProcesses(ctx, agentId))[0]?.status).toBe("running");
            f.finished.resolve(exited);
            await expect(stopping).resolves.toMatchObject({ id: process!.id, status: "exited" });
            await f.module.stopProcess(ctx, agentId, process!.id);
            expect(f.service.stop).toHaveBeenCalledTimes(1);
        } finally {
            f.finished.resolve(exited);
            await f.module.dispose(ctx);
        }
    });
});
