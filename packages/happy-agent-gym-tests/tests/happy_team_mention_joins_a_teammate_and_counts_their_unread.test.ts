import type { HappyAgentClient } from "@slopus/happy-agent-client";
import type { AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("mentioning a teammate in a task", () => {
    it("joins them with the message and counts what each person has not read", async () => {
        const { gym, alice, bob, aliceId, bobId } = await surfaceTeamClients({
            inference: [
                { content: [{ type: "text", text: "Bob, the refund path is in billing." }] },
                { content: [{ type: "text", text: "Thanks, Bob." }] },
            ],
        });
        running.push(gym);
        const { task } = await alice.createTask({ name: "Refund flow" });
        // Bob closed the task, so only the mention can bring it back to his list.
        await bob.leaveTask(task.id);
        expect((await bob.getTask(task.id)).membership).toBeNull();

        // The bootstrap already holds whom `@` can offer.
        expect((await alice.getDesktopBootstrap()).teammates?.map((user) => user.id)).toEqual(
            expect.arrayContaining([aliceId, bobId]),
        );

        await gym.send(`Can [Bob](happy://users/${bobId}) check the refund path?`, {
            sessionId: task.agent.id,
        });
        const membership = async (client: HappyAgentClient) =>
            (await client.getTask(task.id)).membership;
        await gym.waitUntil(
            async () => ((await membership(bob))?.unread?.count === 2 ? true : undefined),
            "Bob to have Alice's message and the reply unread",
        );
        expect((await membership(bob))?.unread).toMatchObject({
            reason: "mentioned",
            userId: aliceId,
        });
        // Alice wrote the message, so only the reply is new to her.
        await gym.waitUntil(
            async () => ((await membership(alice))?.unread?.count === 1 ? true : undefined),
            "Alice to have the reply unread",
        );

        // Bob writing in Alice's task counts for her, not for him.
        const sent = await bob.sendMessage(task.agent.id, {
            text: "Looking now.",
            mode: { ...gym.selection, permissionMode: "auto" },
        });
        expect(sent.message.id).toEqual(expect.any(String));
        await gym.waitUntil(
            async () => ((await membership(alice))?.unread?.count === 3 ? true : undefined),
            "Alice to have Bob's message and the second reply unread",
        );
        expect((await membership(bob))?.unread?.count).toBe(3);

        // Reading is each person's own, and the mentioned person can leave again.
        await bob.markTaskRead(task.id);
        expect((await membership(bob))?.unread).toBeNull();
        expect((await membership(alice))?.unread?.count).toBe(3);
        await bob.leaveTask(task.id);
        expect(await membership(bob)).toBeNull();
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
