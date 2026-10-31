import type { AgentGym, GymTurn } from "@slopus/happy-agent-gym";
import { HappyAgentApiError } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it } from "vitest";

import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const text = (value: string): GymTurn => ({ content: [{ type: "text", text: value }] });
const call = (name: string, args: unknown): GymTurn => ({
    content: [{ type: "tool_call", name, arguments: args }],
});
const DENY =
    "<review><outcome>deny</outcome><risk>medium</risk><user_authorization>low</user_authorization><rationale>Nobody asked for a team post.</rationale></review>";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const status = async (work: Promise<unknown>) =>
    await work.then(
        () => 200,
        (error: unknown) => (error instanceof HappyAgentApiError ? error.status : 0),
    );

describe("stories", () => {
    it("posts, replaces, hides, shows, and takes down stories for the people who may see them", async () => {
        const turns = new Map<string, GymTurn[]>();
        const reviews: string[] = [];
        const { gym, alice, bob, aliceId, tokenFor } = await surfaceTeamClients({
            permissionMode: "auto",
            timeoutMs: 20_000,
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) return text("<title>Demo</title>");
                const queue = turns.get(request.sessionId);
                if (queue !== undefined) return queue.shift() ?? text("Done.");
                reviews.push(JSON.stringify(request.messages));
                return text(DENY);
            },
        });
        running.add(gym);
        await alice.saveUserSetting("tasks.rich", { value: true });
        const { upload } = await alice.uploadArtifactFile({ data: PNG });
        const frame = (
            await alice.createArtifact({
                type: "image",
                title: "Demo frame",
                files: [{ path: "frame.png", uploadId: upload.id }],
            })
        ).artifact;
        const task = (await alice.createTask({ name: "Onboarding v2" })).task;
        const cursors = [
            (await alice.getEvents()).latestCursor,
            (await bob.getEvents()).latestCursor,
        ];
        const media = { artifactId: frame.id };
        turns.set(task.agent.id, [
            call("set_story", { story: { media, caption: "First take" } }),
            call("set_story", { story: { media, caption: "New onboarding" } }),
            call("set_story", { audience: "team", story: { media, caption: "For everyone" } }),
            text("Posted."),
        ]);
        await gym.send("Post the demo as your story.", {
            sessionId: task.agent.id,
            permissionMode: "auto",
        });

        // Posting replaced the live story; the team post nobody asked for was refused in review.
        const mine = (await alice.listStories({ scope: "mine" })).stories;
        expect(mine.map((story) => [story.caption, story.state])).toEqual([
            ["New onboarding", "live"],
            ["First take", "replaced"],
        ]);
        const [live, first] = mine;
        expect(live).toMatchObject({
            audience: "owner",
            media: { artifactId: frame.id, version: 1 },
            poster: { kind: "agent", taskId: task.id, name: "Onboarding v2" },
        });
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toContain("Allow it only when a person asked for a post to the team");
        expect((await bob.listStories()).stories).toEqual([]);

        // Stories stay out of the artifact catalog and its events unless asked for by type.
        const ids = [live!.artifactId, first!.artifactId];
        expect((await alice.listArtifacts()).artifacts.map((a) => a.id)).toEqual([frame.id]);
        const listed = (await alice.listArtifacts({ type: "story" })).artifacts;
        expect(listed.map((a) => a.id).sort()).toEqual([...ids].sort());
        expect((await bob.listArtifacts({ type: "story" })).artifacts).toEqual([]);
        expect(await status(alice.getArtifact(live!.artifactId))).toBe(404);
        expect(await status(alice.getArtifact(live!.artifactId, { type: "story" }))).toBe(200);
        expect(await status(bob.getArtifact(live!.artifactId, { type: "story" }))).toBe(404);
        expect(await status(alice.getArtifact(frame.id, { type: "story" }))).toBe(200);
        const raw = async (method: string, path: string, body: unknown) =>
            (
                await fetch(new URL(path, gym.daemon.httpUrl), {
                    method,
                    headers: {
                        authorization: `Bearer ${tokenFor("alice")}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify(body),
                })
            ).status;
        const story = `/v0/artifacts/${live!.artifactId}`;
        expect(await raw("PATCH", `${story}?type=story`, { title: "Edited" })).toBe(409);
        expect(await raw("POST", `${story}/delete?type=story`, {})).toBe(409);
        const forged = {
            type: "story",
            title: "Forged",
            files: [{ path: "story.json", text: "{}" }],
        };
        expect(await raw("POST", "/v0/artifacts", forged)).toBe(400);
        const child = `/v0/tasks/${task.id}/children/artifact/${live!.artifactId}`;
        expect(await raw("PUT", child, { visibility: "shown" })).toBe(400);
        // No side door: a create reusing its ID, a Surface naming it, or another agent's read.
        const reuse = { ...forged, type: "markdown", id: live!.artifactId };
        expect(await raw("POST", "/v0/artifacts", reuse)).toBe(409);
        const reference = { type: "artifact", name: "Story", artifactId: live!.artifactId };
        expect(await raw("POST", "/v0/surfaces", reference)).toBe(404);
        const read = { artifactId: live!.artifactId };
        turns.set(gym.defaultSessionId, [
            call("read_artifact", read),
            call("read_artifact_file", { ...read, path: "story.json" }),
            text("Looked."),
        ]);
        const seenBefore = gym.inference.toolResults().length;
        await gym.send("Read that artifact.");
        const reads = gym.inference.toolResults().slice(seenBefore);
        expect(
            reads.map((r) => /not found/i.test(r.text) && !r.text.includes("onboarding")),
        ).toEqual([true, true]);
        const events = async (client: typeof bob, after: string) =>
            (await client.getEvents({ after, limit: 1_000 })).events;
        const aliceEvents = await events(alice, cursors[0]!);
        expect(
            JSON.stringify(aliceEvents.filter((e) => e.type.startsWith("artifact."))),
        ).not.toMatch(new RegExp(ids.join("|")));
        expect(aliceEvents.some((e) => e.type === "story.changed")).toBe(true);
        expect((await events(bob, cursors[1]!)).filter((e) => e.type === "story.changed")).toEqual(
            [],
        );

        // Seen state round-trips, once.
        const seen = (await alice.markStorySeen(live!.artifactId)).story;
        expect(seen.seenBy).toEqual([{ userId: aliceId, seenAt: expect.any(Number) }]);
        expect((await alice.markStorySeen(live!.artifactId)).story.seenBy).toEqual(seen.seenBy);

        // A repost reaches the team, and a teammate reads it by type.
        const repost = (await alice.repostStory(live!.artifactId, { caption: "Ship it?" })).story;
        expect(repost).toMatchObject({ audience: "team", repostOf: live!.artifactId });
        expect((await bob.listStories()).stories.map((s) => s.artifactId)).toEqual([
            repost.artifactId,
        ]);
        expect(await status(bob.getArtifact(repost.artifactId, { type: "story" }))).toBe(200);

        // Bob may not take Alice's story down; Alice may, and the agent's card shows it.
        expect(await status(bob.takeDownStory(repost.artifactId))).toBe(403);
        const down = (await alice.takeDownStory(live!.artifactId)).story;
        expect(down).toMatchObject({ state: "taken_down", takenDownBy: { userId: aliceId } });
        // An ended story stays readable by ID to whoever could see it.
        expect((await alice.getStory(first!.artifactId)).story.state).toBe("replaced");
        expect(await status(bob.getStory(first!.artifactId))).toBe(404);
        // Taking down a story that already ended changes nothing.
        expect((await alice.takeDownStory(first!.artifactId)).story).toMatchObject({
            state: "replaced",
            takenDownBy: null,
        });
        // A repost never takes over another artifact's ID.
        expect(await status(alice.repostStory(live!.artifactId, { id: frame.id }))).toBe(409);
        expect((await alice.getArtifact(frame.id)).artifact.type).toBe("image");
        turns.set(task.agent.id, [call("get_card", {}), text("Read it.")]);
        await gym.send("What does your card say?", { sessionId: task.agent.id });
        const card = JSON.parse(
            gym.inference.toolResults().find((r) => r.text.includes('"title"'))!.text,
        );
        expect(card).toMatchObject({
            title: { text: "Onboarding v2" },
            stories: [
                { id: live!.artifactId, state: "taken_down", takenDownBy: { userId: aliceId } },
                { id: first!.artifactId, state: "replaced" },
            ],
        });

        // A bot's story brings it back for the person it reaches, and nobody else.
        const bot = (await alice.createBot({ name: "Release monitor" })).bot;
        for (const client of [alice, bob]) await client.setBotVisibility(bot.id, { hidden: true });
        turns.set(bot.agent.id, [call("set_story", { story: { media } }), text("Posted.")]);
        await gym.send("Post today's numbers.", { sessionId: bot.agent.id });
        const hidden = async (client: typeof bob) =>
            (await client.listBots()).bots.find((b) => b.id === bot.id)!.hidden;
        expect([await hidden(alice), await hidden(bob)]).toEqual([false, true]);
        // Alice's own bot story stays off the card the bot reads in Bob's turn.
        await bob.saveUserSetting("tasks.rich", { value: true });
        turns.set(bot.agent.id, [call("get_card", {}), text("Read it.")]);
        const cardsBefore = gym.inference.toolResults().length;
        const mode = { ...gym.selection, permissionMode: "full_access" as const };
        await bob.sendMessage(bot.agent.id, { text: "What is on your card?", mode });
        const bobsCard = await gym.waitUntil(
            async () => gym.inference.toolResults().slice(cardsBefore)[0],
            "the bot's card in Bob's turn",
        );
        expect(JSON.parse(bobsCard.text).stories).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 120_000);
});
