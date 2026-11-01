import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { crc32, deflateSync } from "node:zlib";

import type { HappyAgentClient } from "@slopus/happy-agent-client";
import {
    createAgentGym,
    createUnixSocketFetch,
    runGymSql,
    type AgentGym,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** A real, decodable RGBA PNG, so the daemon measures it as a picture. */
function png(width: number, height: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.byteLength);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const rows = Buffer.alloc((width * 4 + 1) * height);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const SHOT = png(6, 4);
/** A 2×2 AVIF, encoded once from the same kind of generated image fixture. */
const AVIF = Buffer.from(
    "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACQAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAsbWRhdBIACgc4ADaQENBpMhcZQmMEwAA0AATFtc4qV1mot0eXsk+PYA==",
    "base64",
);
function box(type: string, ...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts),
        header = Buffer.alloc(8);
    header.writeUInt32BE(8 + body.length);
    header.write(type, 4, "latin1");
    return Buffer.concat([header, body]);
}
/** A real box hierarchy with an H.264 sample entry; no frames are decoded by the gate. */
const CLIP = Buffer.concat([
    box("ftyp", Buffer.from("isom\0\0\0\0isom")),
    box(
        "moov",
        box(
            "trak",
            box(
                "mdia",
                box(
                    "minf",
                    box(
                        "stbl",
                        box(
                            "stsd",
                            Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
                            box("avc1", Buffer.alloc(78)),
                        ),
                    ),
                ),
            ),
        ),
    ),
]);

interface Story {
    readonly id: string;
    readonly taskId: string | null;
    readonly botId: string | null;
    readonly caption: string | null;
    readonly media: { readonly kind: string; readonly mimeType: string };
    readonly seen: boolean;
    readonly expiresAt: number;
    readonly postedAt: number;
    readonly replyCount: number;
    readonly canDelete: boolean;
}

/** A team with a task whose agent posts exactly the tool calls a scenario asks for. */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const team = await surfaceTeamClients({
        timeoutMs: 20_000,
        inference: (request) => {
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    const { gym, alice, tokenFor } = team;
    running.add(gym);
    const task = (await alice.createTask({ name: "Launch page" })).task;
    const bot = (await alice.createBot({ name: "Release bot" })).bot;
    const publicHome = join(
        dirname(gym.happyHome),
        process.platform === "darwin" ? "Happy" : "happy",
    );
    for (const folder of [
        join(publicHome, "Tasks", task.folderName),
        join(publicHome, "Bots", bot.username),
    ]) {
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "shot.png"), SHOT);
        await writeFile(join(folder, "clip.mp4"), CLIP);
        await writeFile(join(folder, "clip.mov"), CLIP);
        await writeFile(join(folder, "clip.m4v"), CLIP);
        await writeFile(join(folder, "invalid.mp4"), "this is not an MP4");
        await writeFile(join(folder, "empty.png"), "");
        await mkdir(join(folder, "folder.mp4"));
    }
    let count = 0;
    /** Alice asks the task's agent to call one tool; returns its result and the tools offered. */
    async function call(
        name: string,
        args: Record<string, unknown>,
        agentId = task.agent.id,
        permissionMode: "auto" | "full_access" = "auto",
    ) {
        const callId = `story_call_${String(++count)}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode,
        });
        const offered = gym.inference.requests
            .filter((request) => request.sessionId === agentId)
            .at(-1)
            ?.tools.map((tool) => tool.name);
        const result = await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
        return { result, offered: offered ?? [] };
    }
    async function api(subject: string, method: string, path: string, json?: unknown) {
        const response = await fetch(new URL(path, gym.daemon.httpUrl), {
            method,
            headers: {
                authorization: `Bearer ${tokenFor(subject)}`,
                ...(json === undefined || json instanceof FormData
                    ? {}
                    : { "content-type": "application/json" }),
            },
            ...(json === undefined
                ? {}
                : { body: json instanceof FormData ? json : JSON.stringify(json) }),
        });
        return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
    }
    async function feed(subject: string): Promise<readonly Story[]> {
        const { status, body } = await api(subject, "GET", "/v0/stories");
        expect(status).toBe(200);
        return (JSON.parse(body.toString()) as { stories: Story[] }).stories;
    }
    return { ...team, task, bot, call, api, feed };
}

async function storyEvents(client: HappyAgentClient, after: string) {
    return (await client.getEvents({ after })).events
        .filter((event) => (event.type as string) === "story.changed")
        .map((event) => (event.payload as { story: Story }).story);
}

async function removedEvents(client: HappyAgentClient, after: string) {
    return (await client.getEvents({ after })).events
        .filter((event) => (event.type as string) === "story.removed")
        .map((event) => (event.payload as { storyId: string }).storyId);
}

describe("stories", () => {
    it("stay off until a person turns them on, and an agent of a person with them off cannot post", async () => {
        const { gym, alice, call, feed } = await harness();
        const health = (await alice.getHealth()) as { capabilities?: Record<string, unknown> };
        expect(health.capabilities?.["storyFeed"]).toBe(true);

        const off = await call("post_story", { path: "shot.png", caption: "Too early" });
        expect(off.offered).not.toContain("post_story");
        expect(off.offered).not.toContain("set_status");
        expect(off.result.text).not.toContain("Posted the story");
        expect(await feed("alice")).toEqual([]);

        await alice.saveUserSetting("stories", { value: true });
        const on = await call("post_story", { path: "shot.png", caption: "Ready to try" });
        expect(on.offered).toContain("post_story");
        expect(on.result.text).toContain("Posted the story");
        expect(await feed("alice")).toHaveLength(1);
        expect(gym.errors).toEqual([]);
    });

    it("reach only members of the task with stories on, each with their own seen state", async () => {
        const { gym, alice, bob, task, call, api, feed, clientFor, onboard } = await harness();
        const carol = clientFor("carol");
        await onboard(carol, "Carol");
        await carol.leaveTask(task.id);
        await alice.saveUserSetting("stories", { value: true });
        await carol.saveUserSetting("stories", { value: true });
        const before = (await alice.getEvents()).latestCursor;

        await call("post_story", { path: "shot.png", caption: "Ready to try" });
        const video = await call("post_story", { path: "clip.mp4" });
        expect(video.result.text).toContain("Posted the story");
        const mov = await call("post_story", { path: "clip.mov" });
        expect(mov.result.text).toContain("H.264 .mp4");

        const [image, clip] = await feed("alice");
        expect(image).toMatchObject({
            taskId: task.id,
            botId: null,
            caption: "Ready to try",
            media: { kind: "image", mimeType: "image/png", size: SHOT.byteLength },
            seen: false,
        });
        expect(image!.expiresAt - image!.postedAt).toBe(24 * 60 * 60 * 1000);
        expect(clip).toMatchObject({ media: { kind: "video", mimeType: "video/mp4" } });
        expect(await feed("alice")).toHaveLength(2);
        // Bob is a member but has stories off; Carol has them on but left the task.
        expect(await feed("bob")).toEqual([]);
        expect(await feed("carol")).toEqual([]);
        for (const subject of ["bob", "carol"]) {
            expect((await api(subject, "GET", `/v0/stories/${image!.id}/media`)).status).toBe(404);
            expect((await api(subject, "POST", `/v0/stories/${image!.id}/seen`)).status).toBe(404);
        }
        expect(await storyEvents(bob, before)).toEqual([]);
        expect(await storyEvents(carol, before)).toEqual([]);

        await bob.saveUserSetting("stories", { value: true });
        expect((await feed("bob")).map((story) => story.id)).toEqual([image!.id, clip!.id]);
        const media = await api("bob", "GET", `/v0/stories/${image!.id}/media`);
        expect(media.status).toBe(200);
        expect(media.body.equals(SHOT)).toBe(true);
        const bobBefore = (await bob.getEvents()).latestCursor;
        const seen = await api("bob", "POST", `/v0/stories/${image!.id}/seen`);
        expect(JSON.parse(seen.body.toString())).toMatchObject({ story: { seen: true } });
        expect((await feed("bob"))[0]).toMatchObject({ id: image!.id, seen: true });
        expect((await feed("alice"))[0]).toMatchObject({ id: image!.id, seen: false });
        expect(await storyEvents(bob, bobBefore)).toEqual([
            expect.objectContaining({ id: image!.id, seen: true }),
        ]);
        expect((await storyEvents(alice, before)).map((story) => [story.id, story.seen])).toEqual([
            [image!.id, false],
            [clip!.id, false],
        ]);
        expect(gym.errors).toEqual([]);
    });

    it("refuse anything but a non-empty image or .mp4 file before reading or keeping it", async () => {
        const { gym, alice, call, feed } = await harness();
        await alice.saveUserSetting("stories", { value: true });
        const media = join(gym.happyHome, "agent", "media");
        const kept = async () => (await readdir(media, { recursive: true }).catch(() => [])).length;
        const before = await kept();
        for (const [path, error] of [
            ["clip.m4v", "H.264 .mp4"],
            ["clip.mov", "H.264 .mp4"],
            ["invalid.mp4", "not an H.264 MP4 video"],
            ["empty.png", "not a file a story can show"],
            ["folder.mp4", "not a file a story can show"],
        ] as const) {
            expect((await call("post_story", { path })).result.text).toContain(error);
        }
        expect(await kept()).toBe(before);
        expect(await feed("alice")).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("from a bot reach every member with stories on", async () => {
        const { gym, alice, bob, bot, call, feed } = await harness();
        await alice.saveUserSetting("stories", { value: true });
        await bob.saveUserSetting("stories", { value: true });
        await call("post_story", { path: "shot.png", caption: "Released" }, bot.agent.id);
        const [story] = await feed("bob");
        expect(story).toMatchObject({ botId: bot.id, taskId: null, caption: "Released" });
        expect(gym.errors).toEqual([]);
    });

    it("keep posts, seen state, and the setting across a restart, and end after a day", async () => {
        const { gym, alice, call, feed, api } = await harness();
        await alice.saveUserSetting("stories", { value: true });
        await call("post_story", { path: "shot.png" });
        const [story] = await feed("alice");
        await api("alice", "POST", `/v0/stories/${story!.id}/seen`);

        await gym.restart();
        expect((await alice.getUserSetting("stories")).setting.value).toBe(true);
        expect(await feed("alice")).toEqual([{ ...story, seen: true }]);

        await gym.restart({
            whileStopped: async () =>
                await runGymSql(gym.happyHome, [
                    `UPDATE happy_agent_module_stories SET expires_at = ${String(Date.now() - 1)}`,
                ]),
        });
        expect(await feed("alice")).toEqual([]);
        expect((await api("alice", "GET", `/v0/stories/${story!.id}/media`)).status).toBe(404);
        expect(gym.errors).toEqual([]);
    });
});

describe("story replies, reposts, and deletes", () => {
    it("sniffs an uploaded image independently of its image subtype", async () => {
        const { gym, alice, api, feed } = await harness();
        await alice.saveUserSetting("stories", { value: true });
        for (const type of ["image/x-gallery-photo", "image/jpeg"]) {
            const form = new FormData();
            form.set("media", new Blob([SHOT], { type }), "gallery");
            const response = await api("alice", "POST", "/v0/stories", form);
            expect(response.status, response.body.toString()).toBe(200);
            expect(JSON.parse(response.body.toString()).story.media.mimeType).toBe("image/png");
        }
        expect(await feed("alice")).toHaveLength(2);
        // Bun's bundled image backend lacks AVIF decoding; Node's Sharp decoder supports it.
        if (process.versions.bun === undefined) {
            const avif = new FormData();
            avif.set("media", new Blob([AVIF], { type: "image/avif" }), "gallery");
            const response = await api("alice", "POST", "/v0/stories", avif);
            expect(response.status, response.body.toString()).toBe(200);
            expect(JSON.parse(response.body.toString()).story.media.mimeType).toBe("image/avif");
            expect(await feed("alice")).toHaveLength(3);
        }
        expect(gym.errors).toEqual([]);
    });

    it("refuses a non-multipart upload before reading its body", async () => {
        const { gym, alice, tokenFor } = await harness();
        await alice.saveUserSetting("stories", { value: true });
        await new Promise<void>((resolve, reject) => {
            const request = httpRequest(
                new URL("/v0/stories", gym.daemon.httpUrl),
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${tokenFor("alice")}`,
                        "content-type": "application/octet-stream",
                        "content-length": "1000000",
                    },
                },
                (response) => {
                    response.resume();
                    response.once("end", () => {
                        request.destroy();
                        try {
                            expect(response.statusCode).toBe(400);
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                    });
                },
            );
            request.setTimeout(3000, () =>
                request.destroy(new Error("The upload waited for a non-multipart body.")),
            );
            request.once("error", reject);
            request.write("x"); // Start the streaming hop, but never finish the promised body.
        });
        expect(gym.errors).toEqual([]);
    });

    it("bounds a repost's entire multipart body to its round limit plus overhead", async () => {
        const { gym, alice, bob, call, api, feed } = await harness();
        for (const person of [alice, bob]) await person.saveUserSetting("stories", { value: true });
        await call("post_story", { path: "shot.png" });
        const [story] = await feed("bob");
        const form = new FormData();
        form.set("metadata", JSON.stringify(" ".repeat(16 * 1024 * 1024 + 65536)));
        expect((await api("bob", "POST", `/v0/stories/${story!.id}/repost`, form)).status).toBe(
            413,
        );
        expect(await feed("bob")).toHaveLength(1);
        expect(gym.errors).toEqual([]);
    });

    it("lets the standalone person upload and delete a story with no agent or user ID", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        await gym.client.saveUserSetting("stories", { value: true });
        const form = new FormData();
        form.set("media", new Blob([SHOT], { type: "image/png" }), "gallery");
        const encoded = new Response(form);
        const contentType = encoded.headers.get("content-type")!;
        const response = await createUnixSocketFetch(gym.socketPath)(
            "http://happy-agent.gym/v0/stories",
            {
                method: "POST",
                headers: { authorization: `Bearer ${gym.token}`, "content-type": contentType },
                body: await encoded.arrayBuffer(),
            },
        );
        expect(response.status).toBe(200);
        const { story } = (await response.json()) as { story: { id: string } };
        expect(story).toMatchObject({
            agentId: null,
            userId: null,
            poster: "person",
            canDelete: true,
        });
        expect((await gym.http.get(`/v0/stories/${story.id}/media`)).status).toBe(200);
        expect((await gym.http.delete(`/v0/stories/${story.id}`)).status).toBe(200);
        expect((await gym.http.get<{ stories: unknown[] }>("/v0/stories")).body.stories).toEqual(
            [],
        );
        expect(gym.errors).toEqual([]);
    });

    it("keeps person stories out of an exported bot guest's transport", async () => {
        const { gym, alice, bot, call, api, feed } = await harness();
        await alice.saveUserSetting("stories", { value: true });
        const chief = (await alice.listBots()).bots.find(
            (item) => item.username === "chief_of_staff",
        )!;
        const exported = await call(
            "set_bridge_exported_bot",
            {
                botId: bot.id,
                service: "Test chat",
                tokenFile: "guest.token",
                allowedUsers: ["outside"],
            },
            chief.agent.id,
            "full_access",
        );
        const tokenPath = /written to (\S+), readable/.exec(exported.result.text)?.[1];
        expect(tokenPath).toBeDefined();
        const token = (await readFile(tokenPath!, "utf8")).trim();
        const socket = new WebSocket(
            new URL("/v0/exported-bots/connect", gym.daemon.httpUrl).href.replace(/^http/, "ws"),
            {
                headers: { authorization: `Bearer ${token}` },
            },
        );
        const frames: Record<string, unknown>[] = [];
        socket.on("message", (data) => {
            const frame = JSON.parse(String(data));
            frames.push(frame);
            if (frame.type === "reply")
                socket.send(JSON.stringify({ type: "ack", seq: frame.seq }));
        });
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once("open", resolve);
                socket.once("error", reject);
            });
            socket.send(
                JSON.stringify({
                    type: "message",
                    id: "hello",
                    userId: "outside",
                    chatId: "outside",
                    name: "Outside person",
                    text: "Hello",
                }),
            );
            await gym.waitUntil(
                () => frames.find((frame) => frame.type === "reply"),
                "the guest's ordinary reply",
            );
            const child = (await alice.getAgentActivity(bot.agent.id)).subagents[0]!;
            const message = (await alice.getMessages(child.id)).runs
                .flatMap((run) => run.messages)
                .find((item) => item.role === "user")!;
            expect((await alice.getUsers([message.metadata.userId!])).users).toEqual([
                expect.objectContaining({ kind: "guest", canLogIn: false }),
            ]);
            const form = new FormData();
            form.set("media", new Blob([SHOT], { type: "image/png" }), "gallery");
            expect((await api("alice", "POST", "/v0/stories", form)).status).toBe(200);
            const [story] = await feed("alice");
            for (const [method, path] of [
                ["GET", "/v0/stories"],
                ["GET", `/v0/stories/${story!.id}/media`],
                ["POST", "/v0/stories"],
            ] as const) {
                const response = await fetch(new URL(path, gym.daemon.httpUrl), {
                    method,
                    headers: { authorization: `Bearer ${token}` },
                });
                expect(response.status).toBe(401);
                await response.arrayBuffer();
            }
            expect(frames.some((frame) => String(frame.type).startsWith("story."))).toBe(false);
        } finally {
            socket.terminate();
        }
        expect(gym.errors).toEqual([]);
    });

    it("keeps emoji text and round centers separate from a repost's media, including after restart", async () => {
        const { gym, alice, bob, task, call, api, feed } = await harness();
        for (const person of [alice, bob]) await person.saveUserSetting("stories", { value: true });
        await call("post_story", { path: "shot.png" });
        const [original] = await feed("alice");
        const path = `/v0/stories/${original!.id}/repost`;
        const layers = { text: { text: "Shipped 🚀", x: 0.7, y: 0.9 }, round: { x: 0.2, y: 0.3 } };
        const form = new FormData();
        form.set("metadata", JSON.stringify({ layers }));
        form.set("round", new Blob([CLIP], { type: "video/mp4" }), "selfie.mp4");
        const response = await api("bob", "POST", path, form);
        expect(response.status).toBe(200);
        const { story } = JSON.parse(response.body.toString());
        expect(story).toMatchObject({ layers, agentId: task.agent.id, repostOf: original!.id });
        expect((await api("alice", "GET", `/v0/stories/${story.id}/round`)).body.equals(CLIP)).toBe(
            true,
        );
        expect(
            JSON.parse((await api("bob", "POST", path, {})).body.toString()).story,
        ).toMatchObject({ caption: null, round: null });
        const textOnly = { text: { text: "👋", x: 0, y: 1 } };
        expect(
            JSON.parse((await api("bob", "POST", path, { layers: textOnly })).body.toString()).story
                .layers,
        ).toEqual(textOnly);
        for (const invalid of [
            { text: { text: "", x: 0.5, y: 0.5 } },
            { text: { text: "x".repeat(201), x: 0.5, y: 0.5 } },
            { text: { text: "Hi", x: -0.1, y: 0.5 } },
            { round: { x: 0.5, y: 1.01 } },
            { text: { text: "Hi", x: 0.5, y: 0.5, bold: true } },
            { round: { x: 0.2, y: 0.3 } }, // No round file.
        ])
            expect((await api("bob", "POST", path, { layers: invalid })).status).toBe(400);
        await gym.restart();
        expect((await feed("alice")).find((item) => item.id === story.id)).toMatchObject({
            layers,
            agentId: task.agent.id,
        });
        expect(gym.errors).toEqual([]);
    });

    it("shows a person's binary photo and video to teammates without a chat target, and only the poster deletes", async () => {
        const { gym, alice, bob, aliceId, task, api, feed, clientFor, onboard } = await harness();
        const carol = clientFor("carol");
        await onboard(carol, "Carol");
        await bob.leaveTask(task.id);
        for (const person of [alice, bob]) await person.saveUserSetting("stories", { value: true });
        const before = (await alice.getEvents()).latestCursor;
        const layers = {
            text: { text: "A day out 🌅", x: 0.4, y: 0.8 },
            round: { x: 0.3, y: 0.2 },
        };
        const ids: string[] = [];
        for (const [bytes, type] of [
            [SHOT, "image/png"],
            [CLIP, "video/mp4"],
        ] as const) {
            const form = new FormData();
            form.set("media", new Blob([bytes], { type }), "gallery");
            form.set("round", new Blob([CLIP], { type: "video/mp4" }), "selfie.mp4");
            form.set("metadata", JSON.stringify({ caption: "Today", layers }));
            const posted = await api("alice", "POST", "/v0/stories", form);
            expect(posted.status, posted.body.toString()).toBe(200);
            const { story } = JSON.parse(posted.body.toString());
            expect(story).toMatchObject({
                poster: "person",
                userId: aliceId,
                agentId: null,
                taskId: null,
                botId: null,
                repostOf: null,
                canDelete: true,
                layers,
            });
            ids.push(story.id);
            expect(
                (await api("bob", "GET", `/v0/stories/${story.id}/media`)).body.equals(bytes),
            ).toBe(true);
            expect(
                (await api("bob", "GET", `/v0/stories/${story.id}/round`)).body.equals(CLIP),
            ).toBe(true);
            expect((await api("bob", "POST", `/v0/stories/${story.id}/repost`, {})).status).toBe(
                404,
            );
            expect((await api("bob", "DELETE", `/v0/stories/${story.id}`)).status).toBe(403);
        }
        expect(await feed("bob")).toHaveLength(2);
        expect(await feed("carol")).toEqual([]);
        expect(await storyEvents(carol, before)).toEqual([]);
        expect(await storyEvents(bob, before)).toHaveLength(2);
        expect((await api("carol", "GET", `/v0/stories/${ids[0]}/media`)).status).toBe(404);
        await carol.saveUserSetting("stories", { value: true });
        expect(await feed("carol")).toHaveLength(2);
        const inferenceCount = gym.inference.requests.length;
        expect(
            (await api("bob", "POST", `/v0/stories/${ids[0]}/replies`, { text: "Great view" }))
                .status,
        ).toBe(200);
        expect((await feed("alice"))[0]).toMatchObject({
            replyCount: 1,
            replies: [{ text: "Great view" }],
        });
        expect(gym.inference.requests.length).toBe(inferenceCount);
        expect(JSON.stringify((await alice.getMessages(task.agent.id)).runs)).not.toContain(
            "Great view",
        );
        await gym.restart();
        expect((await feed("bob"))[0]).toMatchObject({ layers, agentId: null, replyCount: 1 });
        for (const id of ids) {
            expect((await api("alice", "DELETE", `/v0/stories/${id}`)).status).toBe(200);
            for (const route of ["media", "round", "replies"])
                expect((await api("bob", "GET", `/v0/stories/${id}/${route}`)).status).toBe(404);
            expect((await api("bob", "POST", `/v0/stories/${id}/seen`)).status).toBe(404);
        }
        expect(await feed("bob")).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("refuses malformed or oversized person uploads and requires stories on", async () => {
        const { gym, alice, api, feed } = await harness();
        const form = (bytes: Uint8Array, type: string) => {
            const result = new FormData();
            result.set("media", new Blob([bytes], { type }), "gallery");
            return result;
        };
        expect((await api("alice", "POST", "/v0/stories", form(SHOT, "image/png"))).status).toBe(
            404,
        );
        await alice.saveUserSetting("stories", { value: true });
        for (const [bytes, type] of [
            [new Uint8Array(), "image/png"],
            [Buffer.from("bad"), "image/png"],
            [Buffer.from("bad"), "video/mp4"],
            [CLIP, "video/quicktime"],
            [SHOT, "text/plain"],
        ] as const) {
            const response = await api("alice", "POST", "/v0/stories", form(bytes, type));
            expect(response.status, `${type}: ${response.body.toString()}`).toBe(400);
        }
        const oversized = form(new Uint8Array(32 * 1024 * 1024 + 1), "image/png");
        expect((await api("alice", "POST", "/v0/stories", oversized)).status).toBe(413);
        const bigRound = form(SHOT, "image/png");
        bigRound.set(
            "round",
            new Blob([new Uint8Array(16 * 1024 * 1024 + 1)], { type: "video/mp4" }),
            "round.mp4",
        );
        expect((await api("alice", "POST", "/v0/stories", bigRound)).status).toBe(413);
        for (const modify of [
            (value: FormData) => value.append("media", new Blob([SHOT], { type: "image/png" })),
            (value: FormData) => value.set("metadata", "not JSON"),
            (value: FormData) => value.set("metadata", '{"surprise":true}'),
            (value: FormData) => value.set("metadata", '{"layers":{"round":{"x":0.1,"y":0.2}}}'),
            (value: FormData) => value.set("round", new Blob([CLIP], { type: "video/quicktime" })),
            (value: FormData) => value.set("round", new Blob(["bad"], { type: "video/mp4" })),
            (value: FormData) => value.set("unexpected", "value"),
            (value: FormData) => value.delete("media"),
        ]) {
            const upload = form(SHOT, "image/png");
            modify(upload);
            expect((await api("alice", "POST", "/v0/stories", upload)).status).toBe(400);
        }
        expect((await api("alice", "POST", "/v0/stories", {})).status).toBe(400);
        expect(await feed("alice")).toEqual([]);
        const plain = await api("alice", "POST", "/v0/stories", form(SHOT, "image/png"));
        expect(plain.status).toBe(200);
        expect(JSON.parse(plain.body.toString()).story).toMatchObject({
            caption: null,
            round: null,
        });
        expect(gym.errors).toEqual([]);
    });

    it.each([false, true])(
        "send a reply to the story's agent as the person's message, readable by everyone who sees it (restart: %s)",
        async (restart) => {
            const { gym, alice, bob, bobId, task, call, api, feed, clientFor, onboard } =
                await harness();
            const carol = clientFor("carol");
            await onboard(carol, "Carol");
            await carol.leaveTask(task.id);
            for (const person of [alice, bob, carol])
                await person.saveUserSetting("stories", { value: true });
            await call("post_story", { path: "shot.png", caption: "Ready to try" });
            if (restart) await gym.restart();
            const [story] = await feed("alice");
            const before = (await alice.getEvents()).latestCursor;

            const replied = await api("bob", "POST", `/v0/stories/${story!.id}/replies`, {
                text: "Looks great",
            });
            expect(replied.status).toBe(200);
            expect(JSON.parse(replied.body.toString())).toMatchObject({
                reply: { storyId: story!.id, userId: bobId, text: "Looks great" },
            });
            const quote = `> Replying to your story “Ready to try” (story ${story!.id})\n\nLooks great`;
            await gym.waitUntil(
                async () =>
                    JSON.stringify((await alice.getMessages(task.agent.id)).runs).includes(
                        JSON.stringify(quote).slice(1, -1),
                    ) || undefined,
                "the reply in the agent's chat",
            );
            await gym.waitUntil(
                async () =>
                    gym.inference.requests.some(
                        (request) =>
                            request.sessionId === task.agent.id &&
                            JSON.stringify(request.messages).includes("Looks great"),
                    ) || undefined,
                "the agent to read the reply",
            );
            expect((await feed("alice"))[0]).toMatchObject({
                replyCount: 1,
                replies: [{ userId: bobId, text: "Looks great" }],
            });
            const all = await api("alice", "GET", `/v0/stories/${story!.id}/replies`);
            expect(JSON.parse(all.body.toString())).toMatchObject({
                replies: [{ text: "Looks great" }],
            });
            expect(await storyEvents(alice, before)).toEqual([
                expect.objectContaining({ replyCount: 1 }),
            ]);
            // Carol left the task, so for her the story and its replies do not exist.
            expect((await api("carol", "GET", `/v0/stories/${story!.id}/replies`)).status).toBe(
                404,
            );
            const outsider = await api("carol", "POST", `/v0/stories/${story!.id}/replies`, {
                text: "Hi",
            });
            expect(outsider.status).toBe(404);
            const empty = await api("bob", "POST", `/v0/stories/${story!.id}/replies`, {
                text: "",
            });
            expect(empty.status).toBe(400);
            expect(gym.errors).toEqual([]);
        },
    );

    it("repost an agent story with a caption and round video to exactly who sees the original", async () => {
        const { gym, alice, bob, bobId, task, call, api, feed, clientFor, onboard } =
            await harness();
        const carol = clientFor("carol");
        await onboard(carol, "Carol");
        await carol.leaveTask(task.id);
        for (const person of [alice, bob, carol])
            await person.saveUserSetting("stories", { value: true });
        await call("post_story", { path: "shot.png", caption: "Ready to try" });
        const [original] = await feed("bob");
        const round = { data: CLIP.toString("base64") };

        const reposted = await api("bob", "POST", `/v0/stories/${original!.id}/repost`, {
            caption: "Look at this",
            round,
        });
        expect(reposted.status).toBe(200);
        const { story } = JSON.parse(reposted.body.toString()) as { story: Story & { id: string } };
        expect(story).toMatchObject({
            poster: "person",
            userId: bobId,
            repostOf: original!.id,
            taskId: task.id,
            caption: "Look at this",
            media: { kind: "image", size: SHOT.byteLength },
            round: { mimeType: "video/mp4", size: CLIP.byteLength },
            canDelete: true,
        });
        expect((await feed("alice")).map((item) => [item.id, item.canDelete])).toEqual([
            [original!.id, true],
            [story.id, false],
        ]);
        expect((await api("alice", "GET", `/v0/stories/${story.id}/round`)).body.equals(CLIP)).toBe(
            true,
        );
        expect((await api("alice", "GET", `/v0/stories/${story.id}/media`)).body.equals(SHOT)).toBe(
            true,
        );
        expect(await feed("carol")).toEqual([]);
        expect((await api("carol", "POST", `/v0/stories/${original!.id}/repost`, {})).status).toBe(
            404,
        );
        expect((await api("alice", "POST", `/v0/stories/${story.id}/repost`, {})).status).toBe(404);
        const bad = await api("alice", "POST", `/v0/stories/${original!.id}/repost`, {
            round: { data: Buffer.from("not a video").toString("base64") },
        });
        expect(bad.status).toBe(400);
        const plain = await api("alice", "POST", `/v0/stories/${original!.id}/repost`, {});
        const plainStory = (JSON.parse(plain.body.toString()) as { story: Story }).story;
        expect(plainStory).toMatchObject({ caption: null, round: null });
        expect((await api("bob", "GET", `/v0/stories/${plainStory.id}/round`)).status).toBe(404);
        expect(gym.errors).toEqual([]);
    });

    it("are deleted by the agent's tool, the reposter, and the task's owner, and by nobody else", async () => {
        const { gym, alice, bob, call, api, feed } = await harness();
        await alice.saveUserSetting("stories", { value: true });
        await bob.saveUserSetting("stories", { value: true });
        for (const caption of ["Kept", "By owner", "By tool"])
            await call("post_story", { path: "shot.png", caption });
        const [kept, byOwner, byTool] = await feed("bob");
        expect([kept!.canDelete, (await feed("alice"))[0]!.canDelete]).toEqual([false, true]);
        const repost = async (id: string) =>
            (
                JSON.parse(
                    (await api("bob", "POST", `/v0/stories/${id}/repost`, {})).body.toString(),
                ) as { story: Story }
            ).story;
        const own = await repost(kept!.id);
        const ofToolStory = await repost(byTool!.id);
        const before = (await alice.getEvents()).latestCursor;

        expect((await api("bob", "DELETE", `/v0/stories/${kept!.id}`)).status).toBe(403);
        expect((await api("alice", "DELETE", `/v0/stories/${own.id}`)).status).toBe(403);
        expect((await api("bob", "DELETE", `/v0/stories/${own.id}`)).status).toBe(200);
        expect((await api("alice", "DELETE", `/v0/stories/${byOwner!.id}`)).status).toBe(200);
        const tool = await call("delete_story", { id: byTool!.id });
        expect(tool.result.text).toContain("Deleted the story.");
        expect((await call("delete_story", { id: own.id })).result.text).toContain("no live story");

        expect((await feed("bob")).map((story) => story.id)).toEqual([kept!.id]);
        expect(await removedEvents(alice, before)).toEqual([
            own.id,
            byOwner!.id,
            byTool!.id,
            ofToolStory.id,
        ]);
        expect(await removedEvents(bob, before)).toEqual([
            own.id,
            byOwner!.id,
            byTool!.id,
            ofToolStory.id,
        ]);
        for (const id of [own.id, byOwner!.id, byTool!.id, ofToolStory.id]) {
            expect((await api("alice", "GET", `/v0/stories/${id}/media`)).status).toBe(404);
            expect((await api("alice", "POST", `/v0/stories/${id}/seen`)).status).toBe(404);
            expect((await api("alice", "GET", `/v0/stories/${id}/replies`)).status).toBe(404);
            expect((await api("alice", "DELETE", `/v0/stories/${id}`)).status).toBe(404);
        }
        expect(gym.errors).toEqual([]);
    });

    it("are listed to their agent with who saw them and the replies, and no tools while off", async () => {
        const { gym, alice, bob, call, api, feed } = await harness();
        const off = await call("list_stories", {});
        expect(off.offered).not.toContain("list_stories");
        expect(off.offered).not.toContain("delete_story");

        await alice.saveUserSetting("stories", { value: true });
        await bob.saveUserSetting("stories", { value: true });
        await call("post_story", { path: "shot.png", caption: "Ready to try" });
        const [story] = await feed("bob");
        await api("bob", "POST", `/v0/stories/${story!.id}/seen`);
        await api("bob", "POST", `/v0/stories/${story!.id}/replies`, { text: "Nice" });
        await api("bob", "POST", `/v0/stories/${story!.id}/repost`, {});

        const listed = await call("list_stories", {});
        expect(listed.offered).toEqual(
            expect.arrayContaining(["post_story", "delete_story", "list_stories"]),
        );
        const stories = JSON.parse(listed.result.text) as Record<string, unknown>[];
        expect(stories).toEqual([
            expect.objectContaining({
                id: story!.id,
                caption: "Ready to try",
                seenCount: 1,
                replyCount: 1,
                replies: [expect.objectContaining({ text: "Nice" })],
            }),
            expect.objectContaining({ repostOf: story!.id, seenCount: 0, replyCount: 0 }),
        ]);
        expect(gym.errors).toEqual([]);
    });

    it("refuse an oversized or unexpected body, and take a round only from someone who sees the story", async () => {
        const { gym, alice, bob, task, call, api, feed, clientFor, onboard } = await harness();
        const carol = clientFor("carol");
        await onboard(carol, "Carol");
        await carol.leaveTask(task.id);
        for (const person of [alice, bob, carol])
            await person.saveUserSetting("stories", { value: true });
        await call("post_story", { path: "shot.png" });
        const [story] = await feed("bob");
        const path = `/v0/stories/${story!.id}`;
        const oversized = { round: { data: "A".repeat(22_369_628) } };
        expect((await api("bob", "POST", `${path}/repost`, oversized)).status).toBe(400);
        expect(
            (await api("bob", "POST", `${path}/repost`, { round: { data: "AAAA", x: 1 } })).status,
        ).toBe(400);
        expect((await api("bob", "POST", `${path}/repost`, { shout: true })).status).toBe(400);
        expect(
            (await api("bob", "POST", `${path}/replies`, { text: "Hi", shout: true })).status,
        ).toBe(400);
        // Someone who cannot see the story learns nothing about their round, valid or not.
        const notAVideo = { round: { data: Buffer.from("not a video").toString("base64") } };
        expect((await api("carol", "POST", `${path}/repost`, notAVideo)).status).toBe(404);
        expect(await feed("alice")).toHaveLength(1);
        expect(gym.errors).toEqual([]);
    });

    it("of an archived task are gone, so a reply cannot wake its archived agent", async () => {
        const { gym, alice, bob, task, call, api, feed } = await harness();
        await alice.saveUserSetting("stories", { value: true });
        await bob.saveUserSetting("stories", { value: true });
        await call("post_story", { path: "shot.png" });
        const [story] = await feed("bob");
        const { version } = (await alice.getTask(task.id)).task;
        await alice.archiveTask(task.id, { ifMatch: version });
        const requests = gym.inference.requests.length;

        expect(await feed("bob")).toEqual([]);
        const reply = await api("bob", "POST", `/v0/stories/${story!.id}/replies`, { text: "Hi" });
        expect(reply.status).toBe(404);
        expect((await api("bob", "POST", `/v0/stories/${story!.id}/repost`, {})).status).toBe(404);
        expect((await api("bob", "GET", `/v0/stories/${story!.id}/media`)).status).toBe(404);
        expect(JSON.stringify((await alice.getMessages(task.agent.id)).runs)).not.toContain(
            "Replying to",
        );
        expect(gym.inference.requests.length).toBe(requests);
        expect(gym.errors).toEqual([]);
    });
});
