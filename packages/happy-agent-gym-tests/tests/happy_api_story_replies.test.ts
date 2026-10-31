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
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const status = async (work: Promise<unknown>) =>
    await work.then(
        () => 200,
        (error: unknown) => (error instanceof HappyAgentApiError ? error.status : 0),
    );

describe("story replies", () => {
    it("lands a teammate's reply in the agent's chat, wakes it, and shows their face", async () => {
        const turns: (GymTurn | Promise<GymTurn>)[] = [];
        // Alice plays Kirill, who owns the task; Bob plays Steve, who replies from his phone.
        const { gym, alice, bob, bobId } = await surfaceTeamClients({
            timeoutMs: 20_000,
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) return text("<title>Demo</title>");
                return turns.shift() ?? text("Done.");
            },
        });
        running.add(gym);
        await alice.saveUserSetting("tasks.rich", { value: true });
        const { upload } = await alice.uploadArtifactFile({ data: PNG });
        const files = [{ path: "frame.png", uploadId: upload.id }];
        const frame = (await alice.createArtifact({ type: "image", title: "Frame", files }))
            .artifact;
        const task = (await alice.createTask({ name: "Onboarding v2" })).task;
        const agentId = task.agent.id;
        const media = { artifactId: frame.id };
        turns.push(
            call("set_story", { story: { media, caption: "Just for Kirill" } }),
            call("set_story", { audience: "team", story: { media, caption: "Onboarding v2" } }),
            text("Posted."),
        );
        await gym.send("Post the demo, and post it to the team too.", {
            sessionId: agentId,
            permissionMode: "full_access",
        });
        const mine = (await alice.listStories({ scope: "mine" })).stories;
        const team = mine.find((story) => story.audience === "team")!;
        const owner = mine.find((story) => story.audience === "owner")!;
        expect(team.replies).toBe(0);
        await alice.markAgentRead(agentId);

        // Steve replies to the team story: his own message, carrying the story it answers. The
        // turn it wakes waits until the mark it left is checked.
        const ofAgent = () => gym.inference.requests.filter((r) => r.sessionId === agentId);
        const asked = ofAgent().length;
        let release = () => {};
        turns.push(new Promise((resolve) => (release = () => resolve(text("Merging now.")))));
        const replyTo = { kind: "story" as const, artifactId: team.artifactId };
        const mode = { ...gym.selection, permissionMode: "full_access" as const };
        const sent = await bob.sendMessage(agentId, {
            text: "Looks good, ship it?",
            mode,
            replyTo,
        });
        expect(sent.message).toMatchObject({ metadata: { userId: bobId }, replyTo });
        expect((await alice.getAgent(agentId)).agent.unread).toMatchObject({
            reason: "story_reply",
            from: [bobId],
        });

        // The reply wakes the agent, told which story it answers; Steve's face stays after.
        const woken = await gym.waitUntil(
            async () => (turns.length === 0 ? ofAgent().at(asked) : undefined),
            "the agent's turn answering the reply",
        );
        release();
        expect(JSON.stringify(woken.messages)).toContain(
            `replies to your story \\"Onboarding v2\\" (artifact ${team.artifactId})`,
        );
        const unread = await gym.waitUntil(async () => {
            const current = (await alice.getAgent(agentId)).agent.unread;
            return current?.reason === "turn_finished" ? current : undefined;
        }, "the finished turn's unread mark");
        expect(unread.from).toEqual([bobId]);
        const history = (await alice.getMessages(agentId)).runs.flatMap((run) => run.messages);
        expect(history.find((m) => m.id === sent.message.id)).toMatchObject({
            role: "user",
            metadata: { userId: bobId },
            replyTo,
        });

        // The story lists its reply for anyone who may see it, and counts it.
        const replies = await bob.listStoryReplies(team.artifactId);
        expect(replies).toMatchObject({ agentId, hasMore: false });
        expect(replies.messages.map((m) => [m.id, m.replyTo])).toEqual([
            [sent.message.id, replyTo],
        ]);
        expect((await alice.getStory(team.artifactId)).story.replies).toBe(1);
        expect((await alice.getStory(owner.artifactId)).story.replies).toBe(0);

        // Reading the agent clears the mark and the faces.
        expect((await alice.markAgentRead(agentId)).agent.unread).toBeNull();

        // Steve may not reply to Kirill's own story, nor send a reply to another agent.
        const hidden = { kind: "story" as const, artifactId: owner.artifactId };
        const reply = (to: string, story: typeof replyTo) =>
            bob.sendMessage(to, { text: "Hm?", mode, replyTo: story });
        expect(await status(reply(agentId, hidden))).toBe(404);
        // A resend of the reply's ID answers with the reply as sent, whatever it now names.
        const again = { id: sent.message.id, text: "Hm?", mode, replyTo: hidden };
        expect((await bob.sendMessage(agentId, again)).message).toMatchObject({ replyTo });
        expect(await status(reply(gym.defaultSessionId, replyTo))).toBe(409);
        expect(await status(bob.listStoryReplies(owner.artifactId))).toBe(404);
        expect(gym.errors).toEqual([]);
    }, 120_000);
});
