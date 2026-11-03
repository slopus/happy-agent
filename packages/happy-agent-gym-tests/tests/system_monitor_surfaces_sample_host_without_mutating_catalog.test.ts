import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemMonitorSnapshot } from "@slopus/happy-agent-client";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});
async function start() {
    const gym = await createAgentGym({ permissionMode: "read_only", timeoutMs: 20000 });
    running.push(gym);
    return gym;
}
function expectSnapshot(snapshot: SystemMonitorSnapshot) {
    expect(snapshot.intervalMs).toBe(1000);
    expect(snapshot.sampledAt).toBeGreaterThan(0);
    expect(snapshot.host.hostname.length).toBeGreaterThan(0);
    expect(snapshot.host.platform.length).toBeGreaterThan(0);
    expect(snapshot.cpu.logicalCores).toBeGreaterThan(0);
    if (snapshot.cpu.usagePercent !== null) {
        expect(snapshot.cpu.usagePercent).toBeGreaterThanOrEqual(0);
        expect(snapshot.cpu.usagePercent).toBeLessThanOrEqual(100);
    }
    expect(snapshot.memory.totalBytes).toBeGreaterThan(0);
    expect(snapshot.memory.usedBytes + snapshot.memory.availableBytes).toBe(
        snapshot.memory.totalBytes,
    );
    expect(snapshot.history.length).toBeGreaterThan(0);
    expect(snapshot.history.length).toBeLessThanOrEqual(300);
    expect(snapshot.history.map((p) => p.sampledAt)).toEqual(
        snapshot.history.map((p) => p.sampledAt).sort((a, b) => a - b),
    );
    if (snapshot.processes !== null) {
        expect(snapshot.processes.total).toBeGreaterThanOrEqual(snapshot.processes.items.length);
        expect(snapshot.processes.items.length).toBeLessThanOrEqual(100);
        expect(new Set(snapshot.processes.items.map((p) => p.pid)).size).toBe(
            snapshot.processes.items.length,
        );
        for (const row of snapshot.processes.items) {
            expect(Object.keys(row).sort()).toEqual([
                "cpuPercent",
                "memoryBytes",
                "name",
                "parentPid",
                "pid",
                "startedAt",
                "state",
                "threads",
                "user",
            ]);
            expect(row.name).not.toMatch(/^[\\/]|^[A-Za-z]:[\\/]/);
            expect(row.memoryBytes).toBeGreaterThanOrEqual(0);
            if (row.cpuPercent !== null) {
                expect(row.cpuPercent).toBeGreaterThanOrEqual(0);
                expect(row.cpuPercent).toBeLessThanOrEqual(100);
            }
        }
    }
}

describe("System Monitor Surfaces through the real daemon", () => {
    it("advertises support, creates and replays the catalog entry, and shares telemetry across instances without mutations", async () => {
        const gym = await start(),
            client = gym.client;
        expect((await client.getHealth()).capabilities?.systemMonitorSurfaces).toBe(true);
        const one = (
            await client.createSurface({
                type: "system_monitor",
                name: "System Monitor",
                mutationId: "monitor-create",
            })
        ).surface;
        const two = (await client.createSurface({ type: "system_monitor", name: "Host" })).surface;
        expect(one).toMatchObject({
            type: "system_monitor",
            name: "System Monitor",
            creatorUserId: null,
            chatAgentId: null,
            members: [{ userId: null }],
        });
        expect(
            (await client.createSurface({ type: "system_monitor", id: one.id, name: "Ignored" }))
                .surface,
        ).toEqual(one);
        const event = await gym.waitUntil(
            async () =>
                (await client.getEvents({ limit: 1000 })).events.find(
                    (e) => e.type === "surface.created" && e.payload.surface.id === one.id,
                ),
            "Surface creation to reach the journal",
        );
        expect(event.payload).toEqual({ surface: one, mutationId: "monitor-create" });
        await client.leaveSurface(one.id);
        const before = (await client.listSurfaces()).surfaces;
        const [a, b] = await Promise.all([
            client.getSystemMonitor(one.id),
            client.getSystemMonitor(two.id),
        ]);
        expectSnapshot(a);
        expectSnapshot(b);
        expect(a).toEqual(b);
        const next = await gym.waitUntil(async () => {
            const value = await client.getSystemMonitor(one.id);
            return value.sampledAt > a.sampledAt ? value : undefined;
        }, "the next sampler observation");
        expectSnapshot(next);
        expect((await client.listSurfaces()).surfaces).toEqual(before);
        expect((await client.getDesktopBootstrap()).surfaces).toEqual(before);
        const events = (await client.getEvents({ after: event.cursor, limit: 1000 })).events;
        expect(
            events.filter((e) => e.type === "surface.updated" && e.payload.surfaceId === one.id),
        ).toHaveLength(1); // leave only
        expect(gym.errors).toEqual([]);
    });
    it("returns not found for malformed, missing, and differently typed Surfaces and preserves the sampler after failures", async () => {
        const gym = await start(),
            client = gym.client;
        const todo = (await client.createSurface({ type: "todo", name: "Todos" })).surface;
        const document = (await client.createSurface({ type: "document", name: "Document" }))
            .surface;
        const calendar = (await client.createSurface({ type: "calendar", name: "Calendar" }))
            .surface;
        for (const id of ["todo", "invalid/id", "a".repeat(24), todo.id, document.id, calendar.id])
            await expect(client.getSystemMonitor(id)).rejects.toMatchObject({
                status: 404,
                code: "not_found",
            });
        const monitor = (await client.createSurface({ type: "system_monitor", name: "Monitor" }))
            .surface;
        expectSnapshot(await client.getSystemMonitor(monitor.id));
        await expect(client.listTodos(monitor.id)).rejects.toMatchObject({ status: 404 });
        await expect(client.getSurfaceDocument(monitor.id)).rejects.toMatchObject({ status: 404 });
        expect(gym.errors).toEqual([]);
    });
    it("keeps the Surface durable across restart while resetting ephemeral history", async () => {
        const gym = await start(),
            client = gym.client;
        const monitor = (await client.createSurface({ type: "system_monitor", name: "Monitor" }))
            .surface;
        const old = await client.getSystemMonitor(monitor.id);
        await gym.restart();
        const restartedAt = Date.now();
        const snapshot = await client.getSystemMonitor(monitor.id);
        expectSnapshot(snapshot);
        expect(snapshot.history.every((point) => point.sampledAt >= restartedAt)).toBe(true);
        expect(snapshot.history.every((point) => point.sampledAt > old.sampledAt)).toBe(true);
        expect((await client.listSurfaces()).surfaces).toEqual([monitor]);
        expect(gym.errors).toEqual([]);
    });
    it("gives shared chat its ordinary read tool in read only mode and creates monitors only for admin bots", async () => {
        let chatId = "",
            surfaceId = "",
            adminId = "";
        const called = new Set<string>();
        const gym = await createAgentGym({
            permissionMode: "read_only",
            timeoutMs: 20000,
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>System Monitor</title>" }] };
                if (!called.has(request.sessionId)) {
                    called.add(request.sessionId);
                    if (request.sessionId === chatId)
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    name: "read_system_monitor",
                                    arguments: { tabId: surfaceId },
                                },
                            ],
                        };
                    return {
                        content: [
                            {
                                type: "tool_call",
                                name: "create_system_monitor_tab",
                                arguments: {
                                    name:
                                        request.sessionId === adminId ? "Admin Monitor" : "Denied",
                                    creatorUserId: null,
                                },
                            },
                        ],
                    };
                }
                return { content: [{ type: "text", text: "Done." }] };
            },
        });
        running.push(gym);
        const monitor = (
            await gym.client.createSurface({ type: "system_monitor", name: "Monitor" })
        ).surface;
        surfaceId = monitor.id;
        await gym.client.leaveSurface(surfaceId);
        const [a, b] = await Promise.all([
            gym.client.ensureSurfaceChat(surfaceId),
            gym.client.ensureSurfaceChat(surfaceId),
        ]);
        expect(a.agent.id).toBe(b.agent.id);
        chatId = a.agent.id;
        await gym.send("Read current system usage.", {
            sessionId: chatId,
            permissionMode: "read_only",
        });
        const requests = gym.inference.requests.filter((r) => r.sessionId === chatId);
        expect(requests[0]!.instructions).toContain("System Monitor");
        expect(requests[0]!.instructions).toContain(surfaceId);
        expect(requests[0]!.tools.map((t) => t.name)).toContain("read_system_monitor");
        expect(requests[0]!.tools.map((t) => t.name)).not.toContain("create_system_monitor_tab");
        expect(JSON.stringify(requests.at(-1)!.messages)).toContain("Memory:");
        expect((await gym.client.listSurfaces()).surfaces[0]?.members).toEqual([]);
        await gym.send("Try creating a monitor.", { permissionMode: "full_access" });
        expect((await gym.client.listSurfaces()).surfaces).toHaveLength(1);
        adminId = (await gym.client.createBot({ name: "Admin", isAdmin: true })).bot.agent.id;
        await gym.send("Create Admin Monitor.", {
            sessionId: adminId,
            permissionMode: "full_access",
        });
        expect(
            (await gym.client.listSurfaces()).surfaces.find((s) => s.name === "Admin Monitor"),
        ).toMatchObject({
            type: "system_monitor",
            creatorUserId: null,
            members: [{ userId: null }],
        });
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
