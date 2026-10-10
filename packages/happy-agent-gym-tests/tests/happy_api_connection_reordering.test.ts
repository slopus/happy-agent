import { createAgentGym, GymHttpClient, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

async function fixture(options: Parameters<typeof createAgentGym>[0] = {}) {
    const gym = await createAgentGym({
        config:
            ["zebra", "alpha", "middle"]
                .map(
                    (id) =>
                        `[connections.${id}]\nname = "${id}"\naddress = "tcUnavailable"\ntoken = "${"r".repeat(43)}"`,
                )
                .join("\n") + "\n[connections.hidden]\nenabled = false\n",
        ...options,
    });
    running.push(gym);
    return gym;
}

describe("connection reordering through the public API", () => {
    it("moves only the selected key, echoes the complete roster, and survives restart", async () => {
        const gym = await fixture();
        const initial = await gym.client.listConnections();
        expect(initial.connections.map((connection) => connection.id)).toEqual([
            "alpha",
            "middle",
            "zebra",
        ]);
        expect(
            initial.connections.every((connection) => typeof connection.orderKey === "string"),
        ).toBe(true);
        const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const moved = await gym.client.reorderConnection(
            "zebra",
            { afterId: null, mutationId: "move-first" },
            { ifMatch: initial.version! },
        );
        expect(moved.connections.map((connection) => connection.id)).toEqual([
            "zebra",
            "alpha",
            "middle",
        ]);
        expect(moved.version > initial.version!).toBe(true);
        expect(moved.connections[0]!.orderKey < moved.connections[1]!.orderKey).toBe(true);
        expect(moved.connections.slice(1)).toEqual(initial.connections.slice(0, 2));
        expect(await gym.client.listConnections()).toEqual(moved);
        const events = (await gym.client.getEvents({ after: cursor })).events.filter(
            (event) => event.type === "connections.updated",
        );
        expect(events.map((event) => event.payload)).toEqual([
            { ...moved, mutationId: "move-first" },
        ]);
        const noOpCursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        expect(
            await gym.client.reorderConnection(
                "alpha",
                { afterId: "zebra" },
                { ifMatch: moved.version },
            ),
        ).toEqual(moved);
        expect(
            (await gym.client.getEvents({ after: noOpCursor })).events.filter(
                (event) => event.type === "connections.updated",
            ),
        ).toEqual([]);
        const last = await gym.client.reorderConnection(
            "zebra",
            { afterId: "middle", mutationId: "move-first" },
            { ifMatch: moved.version },
        );
        expect(last.connections.map((connection) => connection.id)).toEqual([
            "alpha",
            "middle",
            "zebra",
        ]);
        expect(last.version > moved.version).toBe(true);
        await gym.restart();
        expect(await gym.client.listConnections()).toEqual(last);
        expect(gym.errors).toEqual([]);
    });

    it("rejects invalid, stale, and unauthenticated moves without changing the roster", async () => {
        const gym = await fixture();
        const initial = await gym.client.listConnections();
        const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        for (const [id, afterId, status, code] of [
            ["missing", null, 404, "not_found"],
            ["hidden", null, 404, "not_found"],
            ["alpha", "missing", 404, "not_found"],
            ["alpha", "hidden", 404, "not_found"],
            ["alpha", "alpha", 400, "invalid_request"],
        ] as const) {
            await expect(
                gym.client.reorderConnection(id, { afterId }, { ifMatch: initial.version! }),
            ).rejects.toMatchObject({ status, code });
        }
        for (const ifMatch of ["", "invalid"]) {
            await expect(
                gym.client.reorderConnection("alpha", { afterId: null }, { ifMatch }),
            ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        }
        await expect(
            gym.client.reorderConnection(
                "alpha",
                { afterId: null },
                { ifMatch: "01900000-0000-7000-8000-000000000001" },
            ),
        ).rejects.toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: initial.version, connections: initial.connections },
        });
        const unauthorized = new GymHttpClient({ socketPath: gym.socketPath, token: "wrong" });
        expect(
            await unauthorized.post("/v0/connections/alpha/reorder", { afterId: null }),
        ).toMatchObject({ status: 401 });
        expect(
            await gym.raw.post("/v0/connections/alpha/reorder", { afterId: null }),
        ).toMatchObject({
            status: 400,
            body: { code: "invalid_request" },
        });
        for (const body of [{}, { afterId: "../invalid" }, { afterId: 42 }]) {
            await expect(
                gym.client.reorderConnection("alpha", body as never, { ifMatch: initial.version! }),
            ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        }
        expect(await gym.client.listConnections()).toEqual(initial);
        expect(
            (await gym.client.getEvents({ after: cursor })).events.filter(
                (event) => event.type === "connections.updated",
            ),
        ).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("appends admin-created and re-enabled connections after the user-chosen order", async () => {
        const connection = {
            name: "New connection",
            address: "tcUnavailable",
            token: "r".repeat(43),
        };
        const commands = [
            { name: "set_remote_connection", arguments: { id: "aardvark", connection } },
            { name: "remove_remote_connection", arguments: { id: "alpha" } },
            { name: "set_remote_connection", arguments: { id: "alpha", connection } },
        ];
        const gym = await fixture({
            permissionMode: "full_access",
            inference: commands.flatMap((command) => [
                { content: [{ type: "tool_call" as const, ...command }] },
                { content: [{ type: "text" as const, text: "Configured." }] },
            ]),
        });
        const initial = await gym.client.listConnections();
        const moved = await gym.client.reorderConnection(
            "zebra",
            { afterId: null },
            { ifMatch: initial.version! },
        );
        const chief = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!;
        const sendOptions = { sessionId: chief.agent.id, permissionMode: "full_access" as const };
        await gym.send("Add the new connection.", sendOptions);
        const appended = await gym.client.listConnections();
        expect(appended.connections.map((item) => item.id)).toEqual([
            "zebra",
            "alpha",
            "middle",
            "aardvark",
        ]);
        expect(appended.connections.slice(0, 3)).toEqual(moved.connections);
        await gym.send("Remove alpha.", sendOptions);
        await gym.send("Re-enable alpha.", sendOptions);
        const restored = await gym.client.listConnections();
        expect(restored.connections.map((item) => item.id)).toEqual([
            "zebra",
            "middle",
            "aardvark",
            "alpha",
        ]);
        expect(restored.connections.at(-1)!.orderKey > restored.connections.at(-2)!.orderKey).toBe(
            true,
        );
        await gym.restart();
        expect(await gym.client.listConnections()).toEqual(restored);
        expect(gym.errors).toEqual([]);
    });

    it("delivers the reordered snapshot and mutation echo over the existing event stream", async () => {
        const gym = await fixture();
        const initial = await gym.client.listConnections();
        const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const abort = new AbortController();
        const updates = gym.client.updates({
            after: cursor,
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
        });
        try {
            await expect(updates.next()).resolves.toMatchObject({ value: { kind: "connected" } });
            const moved = await gym.client.reorderConnection(
                "alpha",
                { afterId: "middle", mutationId: "stream-move" },
                { ifMatch: initial.version! },
            );
            while (true) {
                const { value, done } = await updates.next();
                if (done)
                    throw new Error("The connection stream ended before the reorder arrived.");
                if (value.kind === "event" && value.event.type === "connections.updated") {
                    expect(value.event.payload).toEqual({ ...moved, mutationId: "stream-move" });
                    break;
                }
            }
            expect(await gym.client.listConnections()).toEqual(moved);
        } finally {
            abort.abort();
            await updates.return(undefined);
        }
        expect(gym.errors).toEqual([]);
    });

    it("serializes two moves guarded by the same roster version", async () => {
        const gym = await fixture();
        const initial = await gym.client.listConnections();
        const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const outcomes = await Promise.allSettled([
            gym.client.reorderConnection("zebra", { afterId: null }, { ifMatch: initial.version! }),
            gym.client.reorderConnection(
                "alpha",
                { afterId: "middle" },
                { ifMatch: initial.version! },
            ),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        const rejected = outcomes.find((outcome) => outcome.status === "rejected");
        expect(rejected).toMatchObject({ reason: { status: 409, code: "conflict" } });
        const current = await gym.client.listConnections();
        expect(rejected).toMatchObject({
            reason: { body: { currentVersion: current.version, connections: current.connections } },
        });
        expect(
            (await gym.client.getEvents({ after: cursor })).events.filter(
                (event) => event.type === "connections.updated",
            ),
        ).toHaveLength(1);
        expect(gym.errors).toEqual([]);
    });
});
