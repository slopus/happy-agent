import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentGym, GymHttpClient, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

async function updates(gym: AgentGym, after: string) {
    return (await gym.client.getEvents({ after, limit: 1000 })).events.filter(
        (event) => event.type === "config.updated",
    );
}

describe("node display configuration through the public API", () => {
    it.each(["ordinary agent", "non-admin bot"] as const)(
        "does not expose node administration to an %s",
        async (kind) => {
            const gym = await createAgentGym({
                config: '[node]\nname = "Studio"\n',
                permissionMode: "full_access",
                inference: [
                    {
                        content: [
                            {
                                type: "tool_call",
                                name: "set_node_name",
                                arguments: { name: "Unauthorized" },
                            },
                        ],
                    },
                    {
                        content: [
                            {
                                type: "tool_call",
                                name: "set_node_avatar",
                                arguments: { path: null },
                            },
                        ],
                    },
                    { content: [{ type: "text", text: "Those tools are unavailable." }] },
                ],
            });
            running.push(gym);
            const agentId =
                kind === "ordinary agent"
                    ? gym.defaultSessionId
                    : (await gym.client.createBot({ name: "Helper", isAdmin: false })).bot.agent.id;
            const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await gym.send(
                "Change this installation's name and remove its avatar if you have access.",
                { sessionId: agentId, permissionMode: "full_access" },
            );
            const offered = gym.inference.requests
                .filter((request) => request.sessionId === agentId)
                .flatMap((request) => request.tools.map((tool) => tool.name));
            expect(offered).not.toContain("set_node_name");
            expect(offered).not.toContain("set_node_avatar");
            expect((await gym.client.getConfig()).config.node).toEqual({
                name: "Studio",
                avatar: null,
            });
            expect(await updates(gym, cursor)).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
    );

    it("detects and persists an unconfigured installation name", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const node = (await gym.client.getConfig()).config.node!;
        expect(node.name.length).toBeGreaterThan(0);
        expect(node.avatar).toBeNull();
        await gym.waitUntil(async () => {
            const runtime = await readFile(join(gym.happyHome, "agent", "runtime.toml"), "utf8");
            return runtime.includes("[node]") ? true : undefined;
        }, "the detected name to be persisted");
        await gym.restart();
        expect((await gym.client.getConfig()).config.node).toEqual(node);
    });

    it.each(["read_only", "workspace_write", "auto-deny", "auto-allow"] as const)(
        "enforces %s on real admin-tool execution",
        async (mode) => {
            const permissionMode = mode.startsWith("auto")
                ? ("auto" as const)
                : (mode as "read_only" | "workspace_write");
            let adminId = "";
            let called = false;
            const reviews: string[] = [];
            const gym = await createAgentGym({
                config: '[node]\nname = "Studio"\n',
                permissionMode,
                inference(request) {
                    if (request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "<title>Admin</title>" }] };
                    if (request.sessionId !== adminId) {
                        reviews.push(JSON.stringify(request.messages));
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `<review><outcome>${mode === "auto-allow" ? "allow" : "deny"}</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted permission decision.</rationale></review>`,
                                },
                            ],
                        };
                    }
                    if (called) return { content: [{ type: "text", text: "Finished." }] };
                    called = true;
                    return {
                        content: [
                            {
                                type: "tool_call",
                                name: "set_node_name",
                                arguments: { name: "Reviewed Mac" },
                            },
                        ],
                    };
                },
            });
            running.push(gym);
            adminId = (await gym.client.listBots()).bots.find(
                (bot) => bot.isAdmin && bot.status === "active",
            )!.agent.id;
            const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            await gym.send("Rename this Happy Agent installation to Reviewed Mac.", {
                sessionId: adminId,
                permissionMode,
            });
            expect((await gym.client.getConfig()).config.node?.name).toBe(
                mode === "auto-allow" ? "Reviewed Mac" : "Studio",
            );
            expect(await updates(gym, cursor)).toHaveLength(mode === "auto-allow" ? 1 : 0);
            if (mode.startsWith("auto")) {
                expect(reviews).toHaveLength(1);
                expect(reviews[0]).toContain(
                    "Rename this Happy Agent installation to Reviewed Mac.",
                );
                expect(reviews[0]).toContain("installation-wide");
            } else expect(reviews).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
    );

    it("bootstraps independently of P2P, persists renames, and invalidates only effective changes", async () => {
        const gym = await createAgentGym({
            config: '[node]\nname = "Studio Mac"\n[p2p]\nname = "Peer label"\n',
        });
        running.push(gym);
        const initial = await gym.client.getDesktopBootstrap();
        expect(initial.config.node).toEqual({ name: "Studio Mac", avatar: null });
        expect(initial.config.p2p.name).toBe("Peer label");
        const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const stream = gym.stream("/v0/events/stream");
        try {
            await stream.opened();
            expect(
                (await gym.client.patchConfig({ node: { name: "Build Mac 🖥️" } })).config.node,
            ).toEqual({ name: "Build Mac 🖥️", avatar: null });
            await stream.waitFor((frame) => JSON.stringify(frame).includes("config.updated"));
            expect((await updates(gym, cursor)).map((event) => event.payload)).toEqual([{}]);
            await gym.client.patchConfig({ node: { name: "Build Mac 🖥️" } });
            await gym.client.patchConfig({ node: {} });
            for (const node of [
                { name: "" },
                { name: "x".repeat(129) },
                { name: "bad\nname" },
                { avatar: null },
                { hasAvatar: true },
            ]) {
                expect(await gym.raw.patch("/v0/config", { node })).toMatchObject({
                    status: 400,
                    body: { code: "invalid_request" },
                });
            }
            expect(await updates(gym, cursor)).toHaveLength(1);
            expect((await gym.client.getConfig()).config.p2p.name).toBe("Peer label");
            await gym.waitUntil(
                async () =>
                    (await readFile(join(gym.happyHome, "agent", "runtime.toml"), "utf8")).includes(
                        'name = "Build Mac 🖥️"',
                    )
                        ? true
                        : undefined,
                "the generated runtime name",
            );
        } finally {
            stream.close();
        }
        await gym.restart();
        expect((await gym.client.getDesktopBootstrap()).config.node).toEqual({
            name: "Build Mac 🖥️",
            avatar: null,
        });
        expect(gym.errors).toEqual([]);
    });

    it("provides an authenticated conditional image, retains it after source deletion and restart, and clears it through an admin tool", async () => {
        const commands: { name: string; arguments: Record<string, unknown> }[] = [];
        let call = 0;
        const gym = await createAgentGym({
            permissionMode: "full_access",
            config: '[node]\nname = "Studio"\n',
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Admin</title>" }] };
                const index = call++;
                return index % 2 === 0
                    ? { content: [{ type: "tool_call", ...commands[Math.floor(index / 2)]! }] }
                    : { content: [{ type: "text", text: "Configured." }] };
            },
        });
        running.push(gym);
        const chief = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!;
        if (chief.compute.type !== "host") throw new Error("Expected a local admin bot.");
        const path = join(chief.compute.path, "node.png");
        // A real, tiny PNG fixture; decoding and normalization run in the daemon.
        await writeFile(
            path,
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
            ),
        );
        commands.push(
            { name: "set_node_avatar", arguments: { path } },
            { name: "set_node_avatar", arguments: { path } },
            { name: "set_node_name", arguments: { name: "Admin's Mac" } },
            { name: "set_node_avatar", arguments: { path: null } },
            { name: "set_node_avatar", arguments: { path: null } },
        );
        const sendOptions = { sessionId: chief.agent.id, permissionMode: "full_access" as const };
        await expect(gym.client.getNodeAvatar()).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
        const unauthorized = new GymHttpClient({ socketPath: gym.socketPath, token: "wrong" });
        expect(await unauthorized.get("/v0/node/avatar")).toMatchObject({ status: 401 });
        const cursor = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        await gym.send(`Set this daemon's avatar from ${path}.`, sendOptions);
        const node = (await gym.client.getConfig()).config.node!;
        expect(node).toEqual({ name: "Studio", avatar: { thumbhash: expect.any(String) } });
        const image = (await gym.client.getNodeAvatar())!;
        expect(image.contentType).toBe("image/webp");
        expect(image.etag).toMatch(/^"[a-f0-9]{64}"$/);
        expect(image.data.byteLength).toBeGreaterThan(0);
        expect((await gym.raw.get("/v0/node/avatar")).headers).toMatchObject({
            "cache-control": "private, max-age=3600, stale-while-revalidate=86400",
            vary: "Authorization",
        });
        await expect(gym.client.getNodeAvatar({ ifNoneMatch: image.etag! })).resolves.toBeNull();
        await gym.send(`Set the same daemon avatar from ${path} again.`, sendOptions);
        expect(await updates(gym, cursor)).toHaveLength(1);
        await gym.send("Rename this daemon to Admin's Mac.", sendOptions);
        expect((await gym.client.getDesktopBootstrap()).config.node).toEqual({
            ...node,
            name: "Admin's Mac",
        });
        expect((await updates(gym, cursor)).map((event) => event.payload)).toEqual([{}, {}]);
        await unlink(path);
        await gym.restart();
        expect((await gym.client.getDesktopBootstrap()).config.node).toEqual({
            ...node,
            name: "Admin's Mac",
        });
        const retained = (await gym.client.getNodeAvatar())!;
        expect(retained.etag).toBe(image.etag);
        expect(new Uint8Array(retained.data)).toEqual(new Uint8Array(image.data));
        const afterRestart = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        await gym.send("Remove this daemon's avatar.", sendOptions);
        await gym.send("Remove this daemon's avatar again.", sendOptions);
        expect((await gym.client.getConfig()).config.node).toEqual({
            name: "Admin's Mac",
            avatar: null,
        });
        await expect(gym.client.getNodeAvatar({ ifNoneMatch: image.etag! })).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
        expect(await updates(gym, afterRestart)).toHaveLength(1);
        expect(await gym.raw.post("/v0/node/avatar", {})).toMatchObject({ status: 404 });
        expect(await gym.raw.delete("/v0/node/avatar")).toMatchObject({ status: 404 });
        expect(gym.errors).toEqual([]);
    });
});
