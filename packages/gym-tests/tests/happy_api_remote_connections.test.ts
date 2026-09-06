import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentGym, GymHttpClient, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("remote roster through the public Happy Agent API", () => {
    it("uses a fixed socket credential and returns a secret-free roster without contacting remotes", async () => {
        const token = "m".repeat(43);
        const remoteToken = "r".repeat(43);
        const gym = await createAgentGym({
            config: [
                "[api]",
                `token = "${token}"`,
                "[connections.builder]",
                'name = "Build Mac"',
                'address = "tcUnreachable"',
                `token = "${remoteToken}"`,
                "[connections.engineering]",
                'name = "Engineering"',
                'address = "tcTeam"',
                'workos_organization_id = "org_test"',
                "[connections.hidden]",
                "enabled = false",
            ].join("\n"),
        });
        running.push(gym);
        expect(gym.token).toBe(token);
        expect((await readFile(join(gym.happyHome, "agent", "token"), "utf8")).trim()).toBe(token);
        expect(await gym.client.listConnections()).toEqual({
            version: expect.any(String),
            connections: [
                { id: "builder", name: "Build Mac", authentication: "bearer" },
                {
                    id: "engineering",
                    name: "Engineering",
                    authentication: "workos",
                    organizationId: "org_test",
                },
            ],
        });
        const config = JSON.stringify(await gym.client.getConfig());
        expect(config).not.toContain(remoteToken);
        expect(config).not.toContain(token);
        expect(config).not.toContain("tcUnreachable");
        await expect(gym.client.connection("hidden").getHealth()).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
        await expect(gym.client.connection("missing").getHealth()).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
        const unauthorized = new GymHttpClient({ socketPath: gym.socketPath, token: "wrong" });
        expect(await unauthorized.get("/v0/connections")).toMatchObject({ status: 401 });
        expect(await unauthorized.get("/v0/connections/builder/api/v0/health")).toMatchObject({
            status: 401,
        });
        expect(
            await gym.raw.post("/v0/connections", { id: "unauthorized-mutation" }),
        ).toMatchObject({ status: 404 });
        expect((await gym.client.getHealth()).ready).toBe(true);
    });

    it("syncs complete versioned rosters from admin changes and preserves the version across restart", async () => {
        const standalone = { name: "Build Mac", address: "tcPrivate", token: "r".repeat(43) };
        const team = {
            name: "Engineering",
            address: "tcPrivateTeam",
            workos_organization_id: "org_test",
        };
        const commands = [
            { name: "set_remote_connection", arguments: { id: "remote", connection: standalone } },
            { name: "set_remote_connection", arguments: { id: "remote", connection: standalone } },
            {
                name: "set_remote_connection",
                arguments: { id: "remote", connection: { ...standalone, token: "s".repeat(43) } },
            },
            {
                name: "set_remote_connection",
                arguments: {
                    id: "remote",
                    connection: { ...standalone, token: "s".repeat(43), name: "Renamed Mac" },
                },
            },
            { name: "set_remote_connection", arguments: { id: "remote", connection: team } },
            { name: "remove_remote_connection", arguments: { id: "remote" } },
        ];
        const gym = await createAgentGym({
            permissionMode: "full_access",
            inference: commands.flatMap((command) => [
                { content: [{ type: "tool_call" as const, ...command }] },
                { content: [{ type: "text" as const, text: "Configured." }] },
            ]),
        });
        running.push(gym);
        const chief = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!;
        const sendOptions = { sessionId: chief.agent.id, permissionMode: "full_access" as const };
        const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const initial = await gym.client.listConnections();
        expect(initial).toEqual({ connections: [], version: expect.any(String) });
        const abort = new AbortController();
        const updates = gym.client.updates({
            after: cursor,
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
        });
        // Read through next() instead of closing the underlying generator between snapshots.
        const nextSnapshot = async () => {
            while (true) {
                const { value, done } = await updates.next();
                if (done) throw new Error("The connection update stream ended.");
                if (value.kind === "event" && value.event.type === "connections.updated")
                    return value.event.payload;
            }
        };
        try {
            await expect(updates.next()).resolves.toMatchObject({ value: { kind: "connected" } });
            await gym.send("Add the standalone remote.", sendOptions);
            const first = await nextSnapshot();
            expect(first).toEqual({
                connections: [{ id: "remote", name: "Build Mac", authentication: "bearer" }],
                version: expect.any(String),
            });
            expect(first.version > initial.version!).toBe(true);
            expect(await gym.client.listConnections()).toEqual(first);
            await gym.send("Apply the same settings.", sendOptions);
            await gym.send("Rotate only its private token.", sendOptions);
            expect(await gym.client.listConnections()).toEqual(first);
            await gym.send(
                "Rename the remote without changing its connection settings.",
                sendOptions,
            );
            const renamed = await nextSnapshot();
            expect(renamed).toEqual({
                connections: [{ id: "remote", name: "Renamed Mac", authentication: "bearer" }],
                version: expect.any(String),
            });
            expect(renamed.version > first.version).toBe(true);
            expect(await gym.client.listConnections()).toEqual(renamed);
            await gym.send("Switch to the team remote.", sendOptions);
            const second = await nextSnapshot();
            expect(second).toEqual({
                connections: [
                    {
                        id: "remote",
                        name: "Engineering",
                        authentication: "workos",
                        organizationId: "org_test",
                    },
                ],
                version: expect.any(String),
            });
            expect(second.version > renamed.version).toBe(true);
            await gym.send("Remove the remote.", sendOptions);
            const removed = await nextSnapshot();
            expect(removed).toEqual({ connections: [], version: expect.any(String) });
            expect(removed.version > second.version).toBe(true);
            const pulled = (
                await gym.client.getEvents({ after: cursor, limit: 1000 })
            ).events.filter((event) => event.type === "connections.updated");
            expect(pulled.map((event) => event.payload)).toEqual([first, renamed, second, removed]);
            expect(JSON.stringify(pulled)).not.toContain("tcPrivate");
            expect(JSON.stringify(pulled)).not.toContain(standalone.token);
            abort.abort();
            await updates.return(undefined);
            await gym.restart();
            expect(await gym.client.listConnections()).toEqual(removed);
            expect(gym.errors).toEqual([]);
        } finally {
            abort.abort();
            await updates.return(undefined);
        }
    });
});
