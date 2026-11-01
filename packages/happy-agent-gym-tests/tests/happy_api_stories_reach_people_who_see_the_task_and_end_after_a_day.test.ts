import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import type { HappyAgentClient } from "@slopus/happy-agent-client";
import { runGymSql, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

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
const CLIP = Buffer.from(Array.from({ length: 64 }, (_, index) => index));

interface Story {
    readonly id: string;
    readonly taskId: string | null;
    readonly botId: string | null;
    readonly caption: string | null;
    readonly media: { readonly kind: string; readonly mimeType: string };
    readonly seen: boolean;
    readonly expiresAt: number;
    readonly postedAt: number;
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
        await writeFile(join(folder, "empty.png"), "");
        await mkdir(join(folder, "folder.mp4"));
    }
    let count = 0;
    /** Alice asks the task's agent to call one tool; returns its result and the tools offered. */
    async function call(name: string, args: Record<string, unknown>, agentId = task.agent.id) {
        const callId = `story_call_${String(++count)}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "auto",
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
    async function api(subject: string, method: string, path: string) {
        const response = await fetch(new URL(path, gym.daemon.httpUrl), {
            method,
            headers: { authorization: `Bearer ${tokenFor(subject)}` },
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
