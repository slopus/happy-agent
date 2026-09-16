import { createId } from "@paralleldrive/cuid2";
import type { AgentModuleScope, AgentToolCall } from "@slopus/happy-agent-base";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import { serviceStartTool } from "../../sources/services/tools/service_start.js";
import { serviceInputTool } from "../../sources/services/tools/service_input.js";
import { serviceStopTool } from "../../sources/services/tools/service_stop.js";
import { listServicesTool } from "../../sources/services/tools/list_services.js";
import { ServiceRecords } from "../../sources/services/persistence/ServiceRecords.js";
import {
    servicesHarness,
    ownerId,
    peerId,
    workspaceId,
    definition,
} from "./support/servicesHarness.js";

const startArgs = {
    name: "Preview",
    cmd: "node server.js",
    port: 4187,
    sandbox: { inputs: ["server.js"] },
    yield_time_ms: 0,
};
function call<Result extends TSchema>(
    f: Awaited<ReturnType<typeof servicesHarness>>,
): AgentToolCall<Result> {
    return { id: "aatoolcall", kv: f.scope.sharedKV, commit: async (_ctx, result) => result };
}

describe("common workspace service tools", () => {
    it("mirrors shell wait defaults and caps output without sharing reader positions", async () => {
        const f = await servicesHarness();
        try {
            const created = await f.services.start(f.ctx, ownerId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, created.id)).status).toBe(
                    "running",
                ),
            );
            const input = serviceInputTool(f.services, peerId);
            const observed = vi.spyOn(f.services, "inputForAgent");
            f.running[0]!.output.stdout = "🔥".repeat(20000);
            const result = await input.execute(
                f.ctx,
                { service_id: created.id, max_output_tokens: 7 },
                call(f),
            );
            expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(7);
            expect(result.output).not.toContain("�");
            expect(result.truncated).toBe(true);
            expect(input.toLLM(result)[0]).toMatchObject({
                text: expect.stringContaining("truncated"),
            });
            expect(observed.mock.calls.at(-1)![3]).toMatchObject({
                waitMs: 5000,
                maxOutputBytes: 7,
            });
            f.running[0]!.output.stdout += "write response";
            await input.execute(
                f.ctx,
                { service_id: created.id, chars: "input", max_output_tokens: 100000 },
                call(f),
            );
            expect(observed.mock.calls.at(-1)![3]).toMatchObject({
                waitMs: 250,
                maxOutputBytes: 10000,
            });
            f.running[0]!.output.stdout += "next response";
            await input.execute(
                f.ctx,
                { service_id: created.id, chars: "input", yield_time_ms: 300000 },
                call(f),
            );
            expect(observed.mock.calls.at(-1)![3]).toMatchObject({ waitMs: 30000 });
            const owner = await serviceInputTool(f.services, ownerId).execute(
                f.ctx,
                { service_id: created.id, yield_time_ms: 0 },
                call(f),
            );
            expect(owner.output.length).toBeGreaterThan(100);
        } finally {
            await f.close();
        }
    });

    it("lets a peer stop the same process and inspect terminal metadata without replaying start", async () => {
        const f = await servicesHarness();
        try {
            const created = await f.services.start(f.ctx, ownerId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, created.id)).status).toBe(
                    "running",
                ),
            );
            const stop = serviceStopTool(f.services, peerId);
            expect(await stop.execute(f.ctx, { service_id: created.id }, call(f))).toMatchObject({
                stopped: true,
                service: { service_id: created.id, status: "killed" },
            });
            expect(await stop.execute(f.ctx, { service_id: created.id }, call(f))).toMatchObject({
                stopped: false,
            });
            const list = listServicesTool(f.services, peerId);
            expect((await list.execute(f.ctx, {}, call(f))).services).toEqual([]);
            expect(
                (await list.execute(f.ctx, { service_id: created.id }, call(f))).services,
            ).toHaveLength(1);
            expect(f.start).toHaveBeenCalledTimes(1);
        } finally {
            await f.close();
        }
    });

    it("returns the created service's durable failure when startup never obtains an output handle", async () => {
        const f = await servicesHarness();
        try {
            f.start.mockRejectedValueOnce(new Error("Scripted admission failure"));
            const tool = serviceStartTool(f.services, ownerId);
            const result = await tool.execute(
                f.ctx,
                { ...startArgs, yield_time_ms: 1000 },
                call(f),
            );
            expect(result.service).toMatchObject({
                status: "failed",
                error: { code: "startup_failed" },
            });
            expect(tool.isError!(result)).toBe(true);
            expect(f.start).toHaveBeenCalledTimes(1);
        } finally {
            await f.close();
        }
    });

    it("includes old active services and only the newest 256 stopped records, disclosing older history", async () => {
        const f = await servicesHarness();
        try {
            const active = await f.services.start(f.ctx, ownerId, definition);
            const records = new ServiceRecords(f.scope.sharedKV);
            await f.storage.transaction(f.ctx, async (ctx) => {
                for (let i = 0; i < 270; i += 1) {
                    const id = createId();
                    const created = await records.create(ctx, {
                        execution: { id, directory: `/scripted/${id}` },
                        service: { ...active, id, version: f.events.resourceVersion() },
                    });
                    await records.replace(
                        ctx,
                        {
                            ...created.service,
                            status: "failed",
                            endpointStatus: "unavailable",
                            endedAt: created.service.updatedAt,
                            version: f.events.resourceVersion(),
                        },
                        created.service.version,
                        true,
                    );
                }
            });
            const result = await listServicesTool(f.services, peerId).execute(
                f.ctx,
                { include_stopped: true },
                call(f),
            );
            expect(result.services).toHaveLength(257);
            expect(result.services.at(-1)!.service_id).toBe(active.id);
            expect(result.services.filter((service) => service.status === "failed")).toHaveLength(
                256,
            );
            expect(result.omitted_history).toBe(true);
        } finally {
            await f.close();
        }
    });
    it("installs one fixed surface for every provider and owns review without elevation or mutation replay", async () => {
        const f = await servicesHarness();
        try {
            for (const providerKind of ["codex", "claude", "grok", "gym"]) {
                const tools = await f.hooks.tools!(f.ctx, {
                    agent: { id: ownerId, providerKind },
                } as AgentModuleScope);
                expect(tools.map((tool) => tool.name)).toEqual([
                    "service_start",
                    "list_services",
                    "service_input",
                    "service_stop",
                ]);
                for (const tool of tools)
                    expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
                for (const tool of tools.filter((tool) => tool.name !== "list_services")) {
                    expect(tool.durable).toBe(false);
                    expect(tool.reloadable).toBe(false);
                }
            }
            const start = serviceStartTool(f.services, ownerId);
            const input = serviceInputTool(f.services, ownerId);
            const stop = serviceStopTool(f.services, ownerId);
            expect(await start.shouldReviewInAutoMode(startArgs, f.ctx)).toBe(true);
            expect(start.requiresAutoOrFullAccess).toBe(true);
            expect(stop.requiresAutoOrFullAccess).toBe(true);
            expect(await input.shouldReviewInAutoMode({ service_id: "aaservice" }, f.ctx)).toBe(
                false,
            );
            expect(
                await input.shouldReviewInAutoMode({ service_id: "aaservice", chars: "" }, f.ctx),
            ).toBe(false);
            expect(
                await input.shouldReviewInAutoMode(
                    { service_id: "aaservice", chars: "\u0003" },
                    f.ctx,
                ),
            ).toBe(true);
            expect(start.describeAutoPermissionAction!(startArgs, f.ctx)).toContain(
                "no public exposure or ambient credentials",
            );
            expect(start.describeAutoPermissionAction!(startArgs, f.ctx)).toContain("named pipes");
            expect(await stop.shouldReviewInAutoMode({ service_id: "aaservice" }, f.ctx)).toBe(
                true,
            );
        } finally {
            await f.close();
        }
    });

    it("validates the exact tool contract without exposing owner selection, credentials or elevation", async () => {
        const f = await servicesHarness();
        try {
            const schema = serviceStartTool(f.services, ownerId).parameters!;
            expect(Value.Check(schema, startArgs)).toBe(true);
            for (const invalid of [
                { ...startArgs, workspace_id: "otherworkspace" },
                { ...startArgs, agent_id: peerId },
                { ...startArgs, secrets: ["secret"] },
                { ...startArgs, sandbox_permissions: "require_escalated" },
                { ...startArgs, port: 80 },
                { ...startArgs, workdir: "../outside" },
                { ...startArgs, sandbox: { inputs: ["."] } },
                { ...startArgs, sandbox: { inputs: ["/outside"] } },
                { ...startArgs, sandbox: { inputs: ["server.js"], limits: { memory_mib: 2048 } } },
            ])
                expect(Value.Check(schema, invalid)).toBe(false);
        } finally {
            await f.close();
        }
    });

    it("starts one owned execution with normalized defaults and exposes the same identity to a peer", async () => {
        const f = await servicesHarness();
        try {
            const tool = serviceStartTool(f.services, ownerId);
            const result = await tool.execute(f.ctx, startArgs, call(f));
            expect(Value.Check(tool.returnType, result)).toBe(true);
            await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
            expect(f.start.mock.calls[0]![1]).toMatchObject({
                cwd: ".",
                tty: false,
                sandbox: {
                    inputs: ["server.js"],
                    scratch: [],
                    outbound: [],
                    limits: { memoryMiB: 1024, processes: 64 },
                },
                permissions: { mode: "auto" },
            });
            const list = listServicesTool(f.services, peerId);
            const discovered = await list.execute(f.ctx, {}, call(f));
            expect(discovered.services[0]!.service_id).toBe(result.service.service_id);
            expect(result.service.agent_id).toBe(ownerId);
            expect(result.service.workspace_id).toBe(workspaceId);
            expect(JSON.stringify(result)).not.toContain("execution");
            expect(JSON.stringify(result)).not.toContain("accessToken");
            expect(JSON.stringify(result)).not.toContain(f.config.configuration.paths.agentHome);
        } finally {
            await f.close();
        }
    });
});
