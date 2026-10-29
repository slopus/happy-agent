import { crc32, deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { HappyAgentApiError, type Story } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const STORIES = "happy-desktop.experiments.stories";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

/** A decodable 8 × 8 PNG. */
function png(): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.byteLength);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(8, 0);
    header.writeUInt32BE(8, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const rows = Buffer.alloc((8 * 4 + 1) * 8);
    for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) rows.set([0, 128, 0, 255], y * 33 + 1 + x * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** A few bytes named like a WebM recording; round videos are never decoded by the daemon. */
const RECORDING = Buffer.from("1a45dfa3 round video bytes");

async function raw(gym: AgentGym, path: string): Promise<{ status: number; body: Buffer }> {
    return await new Promise((resolve, reject) => {
        const call = httpRequest(
            {
                headers: { authorization: `Bearer ${gym.http.token}` },
                method: "GET",
                path,
                socketPath: gym.http.socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () =>
                    resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
                );
            },
        );
        call.on("error", reject);
        call.end();
    });
}

/** A gym whose model makes the tool call a message names, in the conversation it was sent to. */
async function harness() {
    const commands = new Map<string, { marker: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        files: { "out/result.png": png() },
        inference: (request) => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ type: "text", text: "Ring work" }] };
            }
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.marker)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    running.push(gym);
    let count = 0;
    async function call(
        agentId: string,
        name: string,
        args: Record<string, unknown>,
        permissionMode: "auto" | "read_only" = "auto",
    ) {
        const marker = `ring_step_${String(++count)}`;
        commands.set(agentId, {
            marker,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId: marker }] },
        });
        await gym.send(`Please do the next step, ${marker}.`, {
            sessionId: agentId,
            permissionMode,
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === marker),
            `the ${name} result`,
        );
    }
    /** A bot whose own folder holds `out/result.png`, ready to present. */
    async function makeBot(name: string) {
        const created = (await gym.client.createBot({ name })).bot;
        const folder = join(gym.publicHomePath, "Bots", created.username, "out");
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, "result.png"), png());
        return created;
    }
    return { gym, call, makeBot };
}

async function status(promise: Promise<unknown>): Promise<number> {
    try {
        await promise;
        return 200;
    } catch (error) {
        if (error instanceof HappyAgentApiError) return error.status;
        throw error;
    }
}

async function storyEvents(gym: AgentGym, cursor: string) {
    return (await gym.client.getEvents({ after: cursor, limit: 1_000 })).events.filter((event) =>
        event.type.startsWith("story."),
    );
}

function storyIdIn(text: string): string {
    const match = /Posted story ([a-z0-9]+)/.exec(text);
    if (match === null) throw new Error(`No story ID in: ${text}`);
    return match[1]!;
}

describe("agents post stories to their own ring", () => {
    it("posts, supersedes, withdraws, and ends on archive, visible only to its person", async () => {
        const { gym, call, makeBot } = await harness();
        await gym.client.saveUserSetting(STORIES, { value: true });
        const bot = await makeBot("Shipper");
        const agentId = bot.agent.id;

        await call(agentId, "present_files", { filepaths: ["out/result.png"] });
        const start = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const first = await call(agentId, "post_story", { caption: "Your chart is live" });
        expect(first.text).toContain("to this task's ring");
        const firstId = storyIdIn(first.text);

        const { story } = await gym.client.getStory(firstId);
        expect(story).toMatchObject({
            status: "posted",
            author: { kind: "agent", agentId },
            createdBy: { kind: "agent", agentId },
            ringAgentId: agentId,
            supersedes: [],
            endedAt: null,
            endReason: null,
            repostOf: null,
            expiresAt: null,
            seen: false,
            viewCount: null,
        });
        expect((await storyEvents(gym, start)).map((event) => event.type)).toEqual([
            "story.posted",
        ]);

        // The ring holds it; the people row never does, and it is not one of the person's own.
        let feed = await gym.client.getStoryFeed();
        expect(feed.rings).toEqual([
            {
                agentId,
                storyIds: [firstId],
                unseenCount: 1,
                latestPostedAt: story.postedAt,
            },
        ]);
        expect(feed.authors[0]!.storyIds).toEqual([]);
        expect((await gym.client.listStories()).stories).toEqual([]);

        // Watching marks the ring seen.
        const beforeSeen = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        expect((await gym.client.markStorySeen(firstId)).story.seen).toBe(true);
        const seen = await storyEvents(gym, beforeSeen);
        expect(seen.map((event) => event.payload)).toEqual([
            { authorUserId: null, storyId: firstId, ringAgentId: agentId },
        ]);
        expect((await gym.client.getStoryFeed()).rings![0]!.unseenCount).toBe(0);

        // Nobody edits an agent's story.
        expect(
            await status(
                gym.client.updateStory(
                    firstId,
                    { caption: "Mine now" },
                    { ifMatch: story.version },
                ),
            ),
        ).toBe(403);

        // Posting again supersedes the stale story in the same change.
        const beforeSecond = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const second = await call(agentId, "post_story", {
            caption: "Charts now update every hour",
            supersedes: [firstId],
        });
        const secondId = storyIdIn(second.text);
        expect(second.text).toContain(`It superseded ${firstId}.`);
        const afterSecond = await storyEvents(gym, beforeSecond);
        expect(afterSecond.map((event) => event.type)).toEqual(["story.posted", "story.ended"]);
        expect(afterSecond[1]!.payload).toMatchObject({
            storyId: firstId,
            ringAgentId: agentId,
            endReason: "superseded",
            story: { id: firstId, status: "posted", endReason: "superseded" },
        });
        feed = await gym.client.getStoryFeed();
        expect(feed.rings!.map((ring) => ring.storyIds)).toEqual([[secondId]]);
        expect((await gym.client.getStory(firstId)).story.endedAt).not.toBeNull();

        // A story outside the ring cannot be superseded, and nothing is posted.
        const refused = await call(agentId, "post_story", {
            caption: "Again",
            supersedes: [firstId],
        });
        expect(refused.text).toContain("is not a live story in this ring");
        expect((await gym.client.getStoryFeed()).rings![0]!.storyIds).toEqual([secondId]);

        // The agent sees what is live and withdraws what went stale.
        const listed = await call(agentId, "list_stories", {});
        expect(listed.text).toContain(secondId);
        expect(listed.text).toContain("by you");
        const withdrawn = await call(agentId, "withdraw_story", { storyIds: [secondId] });
        expect(withdrawn.text).toContain(`Withdrew ${secondId}.`);
        expect(withdrawn.text).toContain("The ring is empty now.");
        expect((await gym.client.getStoryFeed()).rings).toEqual([]);
        expect((await gym.client.getStory(secondId)).story.endReason).toBe("withdrawn");

        // Read only posts nothing.
        const blocked = await call(agentId, "post_story", { caption: "No" }, "read_only");
        expect(blocked.text).toContain("Read only mode cannot post a story.");

        // Archiving the bot ends what is left in its ring.
        const third = storyIdIn((await call(agentId, "post_story", { caption: "Last one" })).text);
        const beforeArchive = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const { bot: current } = await gym.client.getBot(bot.id);
        await gym.client.archiveBot(bot.id, { ifMatch: current.version });
        await gym.waitUntil(
            async () =>
                (await storyEvents(gym, beforeArchive)).find(
                    (event) => event.type === "story.ended",
                ),
            "the archived ring's story to end",
        );
        expect((await gym.client.getStory(third)).story.endReason).toBe("archived");
        expect((await gym.client.getStoryFeed()).rings).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 90_000);

    it("shows an artifact live, takes feedback, sets a status line, and reposts with a round video", async () => {
        const { gym, call, makeBot } = await harness();
        await gym.client.saveUserSetting(STORIES, { value: true });
        const bot = await makeBot("Publisher");
        const agentId = bot.agent.id;

        await call(agentId, "create_artifact", { type: "html", title: "Try the new sidebar" });
        const artifact = (await gym.client.listArtifacts()).artifacts.find(
            (item) => item.title === "Try the new sidebar",
        )!;
        const posted = await call(agentId, "post_story", {
            frames: [{ artifactId: artifact.id }],
            caption: "The new sidebar, ready to try",
            overlays: [
                [
                    { type: "text", text: "Tap around" },
                    { type: "artifact", artifactId: artifact.id, version: 1 },
                ],
            ],
        });
        const storyId = storyIdIn(posted.text);
        const { story } = await gym.client.getStory(storyId);
        expect(story.frames[0]).toMatchObject({
            kind: "artifact",
            asset: { type: "artifact", artifactId: artifact.id },
            available: true,
            width: null,
            background: ["#000000", "#000000"],
        });
        expect(story.frames[0]!.overlays[1]).toMatchObject({
            type: "artifact",
            artifactId: artifact.id,
            version: 1,
            aspectRatio: 0.8,
        });
        // A live page is read through the artifact routes, never as a frame's bytes.
        expect(
            (await raw(gym, `/v0/stories/${storyId}/frames/${story.frames[0]!.id}`)).status,
        ).toBe(404);

        // An artifact the conversation never showed is refused.
        const other = (
            await gym.client.createArtifact({
                type: "markdown",
                title: "Elsewhere",
                files: [{ path: "index.md", text: "# Elsewhere" }],
            })
        ).artifact;
        const unseen = await call(agentId, "post_story", { frames: [{ artifactId: other.id }] });
        expect(unseen.text).toContain("was not shown in this conversation");

        // Feedback is a message to the agent, quoting the frame.
        const feedback = await gym.client.sendStoryFeedback(storyId, {
            frameId: story.frames[0]!.id,
            text: "Make the archive button red",
        });
        expect(feedback.agentId).toBe(agentId);
        await gym.waitUntil(
            async () =>
                gym.inference
                    .userTexts()
                    .find((text) =>
                        text.includes(
                            `> Feedback on your story "The new sidebar, ready to try" (${storyId}), frame 1 of 1\nMake the archive button red`,
                        ),
                    ),
            "the feedback to reach the agent",
        );

        // The status line is the row's second line, announced on the agent.
        const beforeStatus = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const statusResult = await call(agentId, "set_status", { text: "Ready for you to try" });
        expect(statusResult.text).toContain("Ready for you to try");
        const updated = await gym.waitUntil(
            async () =>
                (await gym.client.getEvents({ after: beforeStatus, limit: 1_000 })).events.find(
                    (event) =>
                        event.type === "agent.updated" &&
                        (event.payload as { changes: Record<string, unknown> }).changes[
                            "statusLine"
                        ] !== undefined,
                ),
            "the status line to change",
        );
        expect(
            (updated.payload as { changes: { statusLine: unknown } }).changes.statusLine,
        ).toMatchObject({ text: "Ready for you to try" });
        expect((await gym.client.getAgent(agentId)).agent.statusLine).toMatchObject({
            text: "Ready for you to try",
        });

        // Reposting makes the person's own draft, which takes a round video and posts as theirs.
        const repost = (await gym.client.repostStory(storyId, { id: "rp1x2c3v4b5n6m7q8w9e0r1t" }))
            .story;
        expect(repost).toMatchObject({
            id: "rp1x2c3v4b5n6m7q8w9e0r1t",
            status: "draft",
            author: { kind: "user", userId: null },
            createdBy: { kind: "user", userId: null },
            ringAgentId: null,
            source: null,
            caption: "The new sidebar, ready to try",
            repostOf: { storyId, agentId, title: "Publisher", canOpen: true },
        });
        expect(repost.frames[0]!.asset).toEqual(story.frames[0]!.asset);
        expect(repost.frames[0]!.id).not.toBe(story.frames[0]!.id);
        const again = await gym.client.repostStory(storyId, { id: "rp1x2c3v4b5n6m7q8w9e0r1t" });
        expect(again.story.version).toBe(repost.version);

        const upload = await gym.client.uploadArtifactFile({ data: new Uint8Array(RECORDING) });
        const overlayId = "ov1x2c3v4b5n6m7q8w9e0r1t";
        const edited = (
            await gym.client.updateStory(
                repost.id,
                {
                    frames: [
                        {
                            id: repost.frames[0]!.id,
                            overlays: [
                                ...repost.frames[0]!.overlays,
                                {
                                    id: overlayId,
                                    type: "round_video",
                                    media: {
                                        type: "upload",
                                        uploadId: upload.upload.id,
                                        name: "circle.webm",
                                    },
                                    durationMs: 3_000,
                                    mirrored: true,
                                    transform: { x: 0.2, y: 0.8, scale: 0.3, rotation: 0 },
                                },
                            ],
                        },
                    ],
                },
                { ifMatch: repost.version },
            )
        ).story;
        const round = edited.frames[0]!.overlays.find((overlay) => overlay.id === overlayId);
        expect(round).toMatchObject({
            type: "round_video",
            media: {
                type: "artifact_file",
                artifactId: repost.id,
                version: 2,
                path: `media/${overlayId}.webm`,
            },
            durationMs: 3_000,
            mirrored: true,
        });
        const media = await raw(gym, `/v0/stories/${repost.id}/overlays/${overlayId}/media`);
        expect(media.status).toBe(200);
        expect(media.body).toEqual(RECORDING);

        // Editing the caption keeps the recording it already holds.
        const kept = (
            await gym.client.updateStory(
                repost.id,
                { caption: "Look what my agent shipped" },
                { ifMatch: edited.version },
            )
        ).story;
        expect(kept.repostOf?.storyId).toBe(storyId);
        expect(
            (await raw(gym, `/v0/stories/${repost.id}/overlays/${overlayId}/media`)).status,
        ).toBe(200);

        const shared = (await gym.client.postStory(repost.id, { artifactVersion: 3 })).story;
        expect(shared).toMatchObject({ status: "posted", author: { kind: "user" } });
        expect(shared.expiresAt).toBe(shared.postedAt! + 24 * 60 * 60 * 1000);
        const feed = await gym.client.getStoryFeed();
        expect(feed.authors[0]!.storyIds).toEqual([repost.id]);
        expect(feed.rings!.map((ring) => ring.storyIds)).toEqual([[storyId]]);
        expect((feed.stories[storyId] as Story).author).toEqual({ kind: "agent", agentId });
        expect(gym.errors).toEqual([]);
    }, 90_000);

    it("rolls a subtask's story up into its bot's ring", async () => {
        const { gym, call, makeBot } = await harness();
        await gym.client.saveUserSetting(STORIES, { value: true });
        const bot = await makeBot("Coordinator");
        const created = await call(bot.agent.id, "create_subtask", {
            title: "Chart helper",
            text: "Work on the chart.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
        });
        expect(created.text).toContain("Created subtask");
        const subtask = (await gym.client.getAgentActivity(bot.agent.id)).subagents.find(
            (child) => child.title === "Chart helper",
        )!;

        await call(subtask.id, "present_files", { filepaths: ["out/result.png"] });
        const posted = await call(subtask.id, "post_story", { caption: "Chart helper shipped" });
        const storyId = storyIdIn(posted.text);
        expect((await gym.client.getStory(storyId)).story).toMatchObject({
            author: { kind: "agent", agentId: subtask.id },
            ringAgentId: bot.agent.id,
        });
        expect((await gym.client.getStoryFeed()).rings).toEqual([
            expect.objectContaining({ agentId: bot.agent.id, storyIds: [storyId] }),
        ]);

        // The bot supersedes its subtask's story: a ring holds only the freshest.
        await call(bot.agent.id, "present_files", { filepaths: ["out/result.png"] });
        const fresher = storyIdIn(
            (
                await call(bot.agent.id, "post_story", {
                    caption: "Everything shipped",
                    supersedes: [storyId],
                })
            ).text,
        );
        expect((await gym.client.getStoryFeed()).rings![0]!.storyIds).toEqual([fresher]);
        expect(gym.errors).toEqual([]);
    }, 90_000);

    it("keeps set_status loaded for a bot's and a task's own agent, and accepts a long status", async () => {
        const { gym, call, makeBot } = await harness();
        await gym.client.saveUserSetting(STORIES, { value: true });
        const bot = await makeBot("Status keeper");
        const { task } = await gym.client.createTask({ name: "Status task" });

        // Loaded with the conversation's tools rather than found through tool search, and the
        // instructions ask for it.
        for (const agentId of [bot.agent.id, task.agent.id]) {
            await gym.send("Hello.", { sessionId: agentId });
            const request = gym.inference.requests
                .filter((item) => item.sessionId === agentId)
                .at(-1)!;
            const tool = request.tools.find((item) => item.name === "set_status");
            expect(tool).toBeDefined();
            expect(tool!.defer).not.toBe(true);
            expect(tool!.description).toContain("keep it to a short phrase, about 40 characters");
            expect(request.instructions).toContain(
                "Keep this conversation's sidebar status current with set_status",
            );
        }
        const agentId = bot.agent.id;

        // Length is only guidance: a long status is written as it is.
        const long = "Visualization ready and the export finished, waiting on review";
        expect(long.length).toBeGreaterThan(60);
        const accepted = await call(agentId, "set_status", { text: long });
        expect(accepted.text).toContain(long);
        await gym.waitUntil(
            async () => (await gym.client.getAgent(agentId)).agent.statusLine?.text === long,
            "the long status",
        );

        // A short status and a stage cue are written too.
        await call(agentId, "set_status", { text: "Visualization ready" });
        await gym.waitUntil(
            async () =>
                (await gym.client.getAgent(agentId)).agent.statusLine?.text ===
                "Visualization ready",
            "the short status",
        );
        await call(agentId, "set_status", { text: "● ● [●] ○ Testing payments" });
        await gym.waitUntil(
            async () =>
                (await gym.client.getAgent(agentId)).agent.statusLine?.text ===
                "● ● [●] ○ Testing payments",
            "the stage cue",
        );
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("offers set_status to no subtask, worker, or project session", async () => {
        const { gym, call, makeBot } = await harness();
        await gym.client.saveUserSetting(STORIES, { value: true });
        const bot = await makeBot("Delegator");
        const model = {
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
        };
        const children: string[] = [];
        for (const [name, title] of [
            ["create_subtask", "Status subtask"],
            ["create_agent", "Status worker"],
        ] as const) {
            const created = await call(bot.agent.id, name, {
                ...model,
                title,
                text: `Work on ${title}.`,
            });
            const id = /Created (?:collaborator|subtask) ([a-z0-9]+)/.exec(created.text)?.[1];
            expect(id, created.text).toBeDefined();
            children.push(id!);
        }
        await gym.send("Hello.");

        for (const agentId of [...children, gym.defaultSessionId]) {
            const request = await gym.waitUntil(
                async () => gym.inference.requests.find((item) => item.sessionId === agentId),
                "the conversation's first inference",
            );
            const tools = request.tools.map((item) => item.name);
            expect(tools).not.toContain("set_status");
            expect(request.instructions).not.toContain("set_status");
        }
        // A subtask still posts to its bot's ring.
        const subtaskRequest = gym.inference.requests.find(
            (item) => item.sessionId === children[0],
        )!;
        expect(subtaskRequest.tools.map((item) => item.name)).toContain("post_story");
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("offers none of it to a person with Stories off", async () => {
        const { gym } = await harness();
        await gym.send("Hello.");
        const tools = gym.inference.requests
            .filter((request) => !request.sessionId.startsWith("naming:"))
            .flatMap((request) => (request.tools ?? []).map((tool) => tool.name));
        for (const name of ["post_story", "withdraw_story", "list_stories", "set_status"]) {
            expect(tools).not.toContain(name);
        }
        expect(JSON.stringify(gym.inference.requests)).not.toContain("post_story");
        expect(JSON.stringify(gym.inference.requests)).not.toContain("set_status");
        expect((await gym.http.get("/v0/stories/feed")).status).toBe(404);
        expect((await gym.client.getAgent(gym.defaultSessionId)).agent.statusLine).toBeNull();
        expect((await gym.client.getHealth()).capabilities).toMatchObject({ agentStories: true });
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
