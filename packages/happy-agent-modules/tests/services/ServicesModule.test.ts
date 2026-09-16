import { describe, expect, it, vi } from "vitest";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { ServicesModule, type ServiceEvent } from "../../sources/services/index.js";
import { pendingCallCount } from "../durableFunctions/support/durableFunctionsHarness.js";
import {
    servicesHarness,
    ownerId,
    peerId,
    childId,
    workspaceId,
    definition,
} from "./support/servicesHarness.js";

describe("workspace-owned service runtime", () => {
    it("projects an ordinary process stop as service revocation before cleanup finishes", async () => {
        const f = await servicesHarness();
        try {
            const created = await f.services.start(f.ctx, ownerId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, created.id)).status).toBe(
                    "running",
                ),
            );
            const running = await f.services.get(f.ctx, workspaceId, created.id);
            f.holdCleanup();
            const stopping = f.compute.stopProcess(f.ctx, ownerId, running.processId!);
            try {
                await vi.waitFor(async () =>
                    expect(await f.services.get(f.ctx, workspaceId, created.id)).toMatchObject({
                        status: "stopping",
                        endpointStatus: "unavailable",
                    }),
                );
            } finally {
                f.finishCleanup();
                await stopping;
            }
        } finally {
            await f.close();
        }
    });

    it("rolls back a transactional process stop without revoking or signaling the service", async () => {
        const f = await servicesHarness();
        try {
            const created = await f.services.start(f.ctx, ownerId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, created.id)).status).toBe(
                    "running",
                ),
            );
            const running = await f.services.get(f.ctx, workspaceId, created.id);
            await expect(
                f.storage.transaction(f.ctx, async (txCtx) => {
                    await f.compute.stopProcess(txCtx, ownerId, running.processId!);
                    throw new Error("rollback");
                }),
            ).rejects.toThrow("rollback");
            expect(f.running[0]!.service.stop).not.toHaveBeenCalled();
            expect((await f.services.get(f.ctx, workspaceId, created.id)).status).toBe("running");
        } finally {
            await f.close();
        }
    });
    it("reports endpoint reachability independently of process liveness", async () => {
        const f = await servicesHarness();
        try {
            const created = await f.services.start(f.ctx, ownerId, definition);
            await vi.waitFor(async () =>
                expect(await f.services.get(f.ctx, workspaceId, created.id)).toMatchObject({
                    status: "running",
                    endpointStatus: "waiting",
                }),
            );
            f.setEndpointReachable(true);
            await vi.waitFor(
                async () =>
                    expect(await f.services.get(f.ctx, workspaceId, created.id)).toMatchObject({
                        status: "running",
                        endpointStatus: "reachable",
                    }),
                { timeout: 3000 },
            );
            f.setEndpointReachable(false);
            await vi.waitFor(
                async () =>
                    expect(await f.services.get(f.ctx, workspaceId, created.id)).toMatchObject({
                        status: "running",
                        endpointStatus: "waiting",
                    }),
                { timeout: 3000 },
            );
        } finally {
            await f.close();
        }
    });
    it("retains a durable execution through a transient metadata read failure before spawn", async () => {
        const f = await servicesHarness(false);
        const invocation = vi.spyOn(f.durable, "invoke");
        try {
            await f.services.start(f.ctx, ownerId, definition);
            vi.spyOn(f.scope.sharedKV, "read").mockRejectedValueOnce(
                new Error("Temporary metadata read failure."),
            );
            await f.beginDispatch();
            await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
            expect(await pendingCallCount(f.ctx)).toBe(1);
        } finally {
            // When reproducing the missing delivery guarantee, recreate only the never-spawned
            // test intent so the fixture can perform its ordinary confirmed cleanup.
            if (f.start.mock.calls.length === 0 && (await pendingCallCount(f.ctx)) === 0) {
                await f.durable.invoke(f.ctx, invocation.mock.calls[0]![1]);
            }
            await f.close();
        }
    });
    it("starts once on a durable lifetime and exposes the same backing command to peer agents", async () => {
        const f = await servicesHarness();
        const events: ServiceEvent[] = [];
        f.services.onEvent((event) => {
            events.push(event);
        });
        try {
            const created = await f.services.start(f.ctx, ownerId, definition);
            expect(created).toMatchObject({
                workspaceId,
                agentId: ownerId,
                status: "starting",
                processId: null,
            });
            await vi.waitFor(async () =>
                expect(await f.services.get(f.ctx, workspaceId, created.id)).toMatchObject({
                    status: "running",
                    processId: expect.any(String),
                }),
            );
            const running = await f.services.get(f.ctx, workspaceId, created.id);
            expect(f.start).toHaveBeenCalledTimes(1);
            expect(f.start.mock.calls[0]?.[0]).not.toBe(f.ctx);
            expect((await f.compute.listProcesses(f.ctx, ownerId))[0]?.id).toBe(running.processId);
            expect((await f.services.workspaceForAgent(f.ctx, peerId)).workspaceId).toBe(
                workspaceId,
            );
            expect((await f.services.workspaceForAgent(f.ctx, childId)).workspaceId).toBe(
                workspaceId,
            );
            expect((await f.services.list(f.ctx, workspaceId)).services).toEqual([running]);
            await expect(
                f.services.get(f.ctx, "anotherworkspace", created.id),
            ).rejects.toMatchObject({ code: "not_found" });
            expect(events[0]).toEqual({ type: "service.created", service: created });
            const output = JSON.stringify(events);
            expect(output).not.toContain("accessToken");
            expect(output).not.toContain("execution");
            expect(output).not.toContain(f.config.configuration.paths.agentHome);
        } finally {
            await f.close();
        }
    });

    it("rolls back the command intent, catalog and notifications together", async () => {
        const f = await servicesHarness();
        const events: ServiceEvent[] = [];
        f.services.onEvent((event) => {
            events.push(event);
        });
        try {
            await expect(
                f.storage.transaction(f.ctx, async (txCtx) => {
                    await f.services.start(txCtx, ownerId, definition);
                    throw new Error("rollback");
                }),
            ).rejects.toThrow("rollback");
            expect(await pendingCallCount(f.ctx)).toBe(0);
            expect(
                (await f.services.list(f.ctx, workspaceId, { includeStopped: true })).services,
            ).toEqual([]);
            expect(f.start).not.toHaveBeenCalled();
            expect(events).toEqual([]);
        } finally {
            await f.close();
        }
    });

    it("keeps a stopped service nonterminal and invalidates access while native cleanup is pending", async () => {
        const f = await servicesHarness();
        try {
            const created = await f.services.start(f.ctx, ownerId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, created.id)).status).toBe(
                    "running",
                ),
            );
            const credential = await f.services.accessToken(
                f.ctx,
                "principal",
                workspaceId,
                created.id,
            );
            f.holdCleanup();
            expect(await f.services.stop(f.ctx, workspaceId, created.id)).toMatchObject({
                status: "stopping",
                endpointStatus: "unavailable",
                endedAt: null,
            });
            await expect(
                f.services.accessToken(f.ctx, "principal", workspaceId, created.id),
            ).rejects.toMatchObject({ code: "service_not_running" });
            await expect(
                f.services.connect(
                    f.ctx,
                    "principal",
                    workspaceId,
                    created.id,
                    credential.accessToken,
                ),
            ).rejects.toMatchObject({ code: "service_not_running" });
            expect((await f.services.list(f.ctx, workspaceId)).services).toHaveLength(1);
            f.finishCleanup();
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, created.id)).status).toBe(
                    "killed",
                ),
            );
            expect((await f.services.list(f.ctx, workspaceId)).services).toEqual([]);
            expect(
                (await f.services.list(f.ctx, workspaceId, { includeStopped: true })).services,
            ).toHaveLength(1);
            await expect(
                f.services.stopAndWait(f.ctx, workspaceId, created.id),
            ).resolves.toMatchObject({ stopped: false });
        } finally {
            await f.close();
        }
    });

    it("cancels a committed but not yet spawned service with its owner's abort decision", async () => {
        const f = await servicesHarness(false);
        try {
            const created = await f.services.start(f.ctx, ownerId, definition);
            await f.storage.transaction(f.ctx, async (txCtx) => {
                await f.compute.recordAbortNotice(txCtx, ownerId);
            });
            expect((await f.services.get(f.ctx, workspaceId, created.id)).status).toBe("stopping");
            await f.beginDispatch();
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, created.id)).status).toBe(
                    "failed",
                ),
            );
            expect(f.start).not.toHaveBeenCalled();
            expect(f.reconcile).toHaveBeenCalledTimes(1);
        } finally {
            await f.close();
        }
    });

    it("recovers a pending call by reconciliation without replaying the command", async () => {
        const f = await servicesHarness(false);
        const recoveredDurable = new DurableFunctionsModule();
        try {
            const created = await f.services.start(f.ctx, ownerId, definition);
            f.durable.stop();
            const recovered = new ServicesModule(
                f.config,
                f.compute,
                f.workspaces,
                f.projects,
                f.bots,
                recoveredDurable,
                f.events,
            );
            const durableHooks = recoveredDurable.beforeStart(f.ctx);
            const hooks = recovered.beforeStart(f.ctx, f.agents);
            await hooks.agentRestoredTransact!(f.ctx, f.scope, {
                id: ownerId,
                metadata: undefined,
            });
            await durableHooks.afterStart!(f.ctx, f.agents);
            await vi.waitFor(async () =>
                expect(await recovered.get(f.ctx, workspaceId, created.id)).toMatchObject({
                    status: "failed",
                    error: { code: "runtime_lost" },
                }),
            );
            expect(f.start).not.toHaveBeenCalled();
            expect(f.reconcile).toHaveBeenCalledTimes(1);
            await vi.waitFor(async () => expect(await pendingCallCount(f.ctx)).toBe(0));
        } finally {
            recoveredDurable.stop();
            await f.close();
        }
    });
});
