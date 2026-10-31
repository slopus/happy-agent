import type { AgentGym, GymTurn } from "@slopus/happy-agent-gym";
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

describe("bots hidden per person", () => {
    it("keeps a hidden bot working and brings it back for the one person it loops in", async () => {
        const botTurns: GymTurn[] = [];
        const focusTurns: GymTurn[] = [];
        const briefs: string[] = [];
        let botAgentId = "";
        // Alice stands in for Kirill and Bob for Steve.
        const { gym, alice, bob, bobId } = await surfaceTeamClients({
            timeoutMs: 20_000,
            inference: (request) => {
                if (request.sessionId === botAgentId) return botTurns.shift() ?? text("Done.");
                if (!request.tools.some((tool) => tool.name === "organize_tasks"))
                    return text("Done.");
                const last = request.messages.at(-1);
                if (last?.role !== "tool") briefs.push(JSON.stringify(last));
                return (last?.role === "tool" ? undefined : focusTurns.shift()) ?? text("Done.");
            },
        });
        running.add(gym);
        await alice.saveUserSetting("tasks.rich", { value: true });
        const social = (await alice.createBot({ name: "Social Growth" })).bot;
        botAgentId = social.agent.id;
        for (const client of [alice, bob])
            await client.setBotVisibility(social.id, { hidden: true });
        const cursors = [
            (await alice.getEvents()).latestCursor,
            (await bob.getEvents()).latestCursor,
        ];

        // Kirill sets up the hourly run; the run the scheduler delivers loops Steve in.
        const reason = "Steve knows swyx, whose thread fits the launch video.";
        botTurns.push(
            call("schedule_message", {
                input: { agent_id: botAgentId, message: "Hourly run.", in: { seconds: 1 } },
            }),
            text("Scheduled."),
            call("loop_in_teammate", { userId: bobId, reason }),
            text("Looped in Steve."),
        );
        await gym.send("Look for places to share the launch every hour.", {
            sessionId: botAgentId,
        });
        const mine = async (client: typeof bob) =>
            (await client.listBots()).bots.find((bot) => bot.id === social.id)!;
        const unread = { reason: "looped_in", since: expect.any(Number), agentId: botAgentId };
        await gym.waitUntil(
            async () => ((await mine(bob)).hidden === false ? true : undefined),
            "Social Growth to come back for Steve",
        );
        expect(await mine(bob)).toMatchObject({
            hidden: false,
            unread: { ...unread, note: reason },
        });
        const kirills = await mine(alice);
        expect(kirills.hidden).toBe(true);
        expect(kirills.unread).toBeUndefined();
        const updates = async (client: typeof bob, after: string) =>
            (await client.getEvents({ after })).events.filter(
                (event) => event.type === "bot.updated",
            );
        expect(await updates(alice, cursors[0]!)).toEqual([]);
        const [steves, ...more] = await updates(bob, cursors[1]!);
        expect(more).toEqual([]);
        expect(steves!.payload).toMatchObject({
            botId: social.id,
            previousVersion: social.version,
            version: social.version,
            changes: { hidden: false, unread: { ...unread, note: reason } },
        });

        // Steve keeps it shown himself, so Focus may not hide it, and never moves a bot.
        await bob.setBotVisibility(social.id, { hidden: false });
        const happy = (await bob.listBots()).bots.find(
            (bot) => bot.systemKey === "chief_of_staff",
        )!;
        focusTurns.push(
            call("organize_tasks", {
                ops: [
                    { op: "hide", botId: social.id, hidden: true },
                    { op: "hide", botId: happy.id, hidden: true },
                    { op: "move", taskId: social.id, after: null },
                ],
            }),
        );
        await bob.saveUserSetting("tasks.focus", { value: true });
        const result = await gym.waitUntil(
            async () =>
                gym.inference.toolResults().find((row) => row.text.includes("held_by_person")),
            "Focus to organize Steve's bots",
        );
        expect(briefs[0]).toContain(
            `- Social Growth (bot ${social.id}) · unread · held by the person`,
        );
        expect(JSON.parse(result.text)).toEqual({
            applied: 1,
            skipped: [
                { index: 0, reason: "held_by_person" },
                { index: 2, reason: "bots_not_allowed" },
            ],
        });
        const steve = (await bob.listBots()).bots;
        expect(steve.map((bot) => [bot.id, bot.hidden])).toEqual(
            expect.arrayContaining([
                [social.id, false],
                [happy.id, true],
            ]),
        );
        expect((await alice.getBot(happy.id)).bot.hidden).toBe(false);
        expect(gym.errors).toEqual([]);
    }, 90_000);
});
