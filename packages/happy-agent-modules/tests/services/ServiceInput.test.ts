import { withAgentPermissionMode } from "@slopus/happy-agent-base";
import { withLifetime } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";
import {
    servicesHarness,
    ownerId,
    peerId,
    childId,
    workspaceId,
    definition,
} from "./support/servicesHarness.js";

const readNow = { waitMs: 0, maxOutputBytes: 65536 };
const reader = { kind: "api", principalId: "principal", readerId: "view" } as const;
async function started(f: Awaited<ReturnType<typeof servicesHarness>>) {
    const service = await f.services.start(f.ctx, ownerId, definition);
    await vi.waitFor(async () =>
        expect((await f.services.get(f.ctx, workspaceId, service.id)).status).toBe("running"),
    );
    return service.id;
}

describe("service process input and output", () => {
    it("uses one capture with independent peer, child, creator and desktop positions", async () => {
        const f = await servicesHarness();
        try {
            const id = await started(f);
            f.running[0]!.output.stdout = "ready";
            for (const agentId of [ownerId, peerId, childId]) {
                expect(await f.services.inputForAgent(f.ctx, agentId, id, readNow)).toMatchObject({
                    output: "ready",
                    truncated: false,
                });
                expect(await f.services.inputForAgent(f.ctx, agentId, id, readNow)).toMatchObject({
                    output: "",
                });
            }
            expect(await f.services.input(f.ctx, workspaceId, id, reader, readNow)).toMatchObject({
                output: "ready",
            });
            f.running[0]!.output.stdout += " again";
            const results = await Promise.all([
                f.services.inputForAgent(f.ctx, peerId, id, readNow),
                f.services.inputForAgent(f.ctx, peerId, id, readNow),
            ]);
            expect(results.map((result) => result.output).sort()).toEqual(["", " again"]);
            expect(f.start).toHaveBeenCalledTimes(1);
        } finally {
            await f.close();
        }
    });

    it("writes once under current permissions, never consuming another reader or emitting application bytes", async () => {
        const f = await servicesHarness();
        const events: unknown[] = [];
        f.services.onEvent((event) => {
            events.push(event);
        });
        try {
            const id = await started(f);
            f.running[0]!.output.stdout = "private output";
            expect(
                await f.services.inputForAgent(f.ctx, peerId, id, {
                    ...readNow,
                    chars: "private input\n",
                }),
            ).toMatchObject({ output: "private output" });
            expect(f.running[0]!.service.write).toHaveBeenCalledTimes(1);
            expect(f.running[0]!.service.write).toHaveBeenCalledWith(
                f.ctx,
                expect.objectContaining({ mode: "auto" }),
                "private input\n",
            );
            expect(JSON.stringify(events)).not.toContain("private input");
            expect(JSON.stringify(events)).not.toContain("private output");
            const restricted = withAgentPermissionMode(f.ctx, "workspace_write");
            await expect(
                f.services.inputForAgent(restricted, peerId, id, { ...readNow, chars: "more" }),
            ).rejects.toThrow("Auto or Full");
            expect(f.running[0]!.service.write).toHaveBeenCalledTimes(1);
            expect(await f.services.inputForAgent(restricted, ownerId, id, readNow)).toMatchObject({
                output: "private output",
            });
        } finally {
            await f.close();
        }
    });

    it("rejects invalid bytes, bounds and reader exhaustion before accepting input", async () => {
        const f = await servicesHarness();
        try {
            const id = await started(f);
            for (const options of [
                { ...readNow, chars: "🔥".repeat(16385) },
                { ...readNow, chars: "input", waitMs: 30001 },
                { ...readNow, maxOutputBytes: 262145 },
            ])
                await expect(
                    f.services.input(f.ctx, workspaceId, id, reader, options),
                ).rejects.toMatchObject({ code: "invalid_request" });
            for (let i = 0; i < 64; i += 1)
                await f.services.input(
                    f.ctx,
                    workspaceId,
                    id,
                    { ...reader, readerId: String(i) },
                    readNow,
                );
            await expect(
                f.services.input(f.ctx, workspaceId, id, reader, {
                    ...readNow,
                    chars: "never written",
                }),
            ).rejects.toMatchObject({ code: "reader_limit" });
            expect(f.running[0]!.service.write).not.toHaveBeenCalled();
            await expect(
                f.services.input(f.ctx, "otherworkspace", id, reader, readNow),
            ).rejects.toMatchObject({ code: "not_found" });
        } finally {
            await f.close();
        }
    });

    it("returns remaining output after termination, but refuses new input", async () => {
        const f = await servicesHarness();
        try {
            const id = await started(f);
            f.running[0]!.output.stdout = "last output";
            await f.services.stopAndWait(f.ctx, workspaceId, id);
            expect(
                await f.services.inputForAgent(f.ctx, peerId, id, { ...readNow, waitMs: 300000 }),
            ).toMatchObject({ service: { status: "killed" }, output: "last output" });
            expect(await f.services.inputForAgent(f.ctx, peerId, id, readNow)).toMatchObject({
                output: "",
            });
            await expect(
                f.services.inputForAgent(f.ctx, peerId, id, { ...readNow, chars: "x" }),
            ).rejects.toMatchObject({ code: "service_not_running" });
            expect(f.running[0]!.service.write).not.toHaveBeenCalled();
        } finally {
            await f.close();
        }
    });

    it("cancels only the caller's wait and leaves the owned runtime alive", async () => {
        const f = await servicesHarness();
        try {
            const id = await started(f);
            const controller = new AbortController();
            const waiting = f.services.inputForAgent(
                withLifetime(f.ctx, controller.signal),
                ownerId,
                id,
                { ...readNow, waitMs: 300000 },
            );
            const rejected = expect(waiting).rejects.toThrow();
            controller.abort();
            await rejected;
            expect((await f.services.get(f.ctx, workspaceId, id)).status).toBe("running");
            expect(f.running[0]!.service.stop).not.toHaveBeenCalled();
        } finally {
            await f.close();
        }
    });
});
