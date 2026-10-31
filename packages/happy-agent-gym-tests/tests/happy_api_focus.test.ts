import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const text = (value: string): GymTurn => ({ content: [{ type: "text", text: value }] });
const organize = (...ops: unknown[]): GymTurn => ({
    content: [{ type: "tool_call", name: "organize_tasks", arguments: { ops } }],
});

describe("Focus", () => {
    it("moves what needs the person up, leaves what they hold, and never wakes itself", async () => {
        const briefs: { at: number; agentId: string; text: string }[] = [];
        const plans: GymTurn[] = [];
        const turns = new Map<string, GymTurn>();
        const gym = await createAgentGym({
            timeoutMs: 20_000,
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) return text("Named");
                const last = request.messages.at(-1);
                if (!request.tools.some((tool) => tool.name === "organize_tasks")) {
                    const turn = last?.role === "user" ? turns.get(request.sessionId) : undefined;
                    turns.delete(request.sessionId);
                    return turn ?? text("Done.");
                }
                // Focus opens on a message from Happy; later briefs arrive as notices.
                if (last?.role === "tool") return text("Moved what needed you up.");
                briefs.push({
                    at: Date.now(),
                    agentId: request.sessionId,
                    text: JSON.stringify(last),
                });
                return plans.shift() ?? text("No changes.");
            },
        });
        running.add(gym);
        const tasks = [];
        for (const name of ["Alpha", "Bravo", "Charlie"])
            tasks.push((await gym.client.createTask({ name })).task);
        const [alpha, bravo] = [tasks[0]!, tasks[1]!];
        const order = async () =>
            (await gym.client.listTasks({ scope: "joined" })).tasks.map((task) => task.name);
        const briefed = async (count: number) =>
            await gym.waitUntil(async () => briefs[count - 1], `Focus brief ${String(count)}`);
        expect(await order()).toEqual(["Charlie", "Bravo", "Alpha"]);

        // Focus starts as Happy's subtask with the whole list.
        await gym.client.saveUserSetting("tasks.rich", { value: true });
        await gym.client.saveUserSetting("tasks.focus", { value: true });
        const first = await briefed(1);
        expect(first.text).toContain(`- Charlie (${tasks[2]!.id})`);
        const happy = (await gym.client.listBots()).bots.find(
            (bot) => bot.username === "chief_of_staff",
        )!;
        const tree = (await gym.client.getAgent(happy.agent.id)).agent.subtasks ?? [];
        expect(tree.map((agent) => [agent.id, agent.title])).toEqual([[first.agentId, "Focus"]]);
        await gym.waitUntil(
            async () =>
                (await gym.client.getAgent(first.agentId)).agent.status === "idle"
                    ? true
                    : undefined,
            "Focus idle",
        );

        // The person writes to Alpha and its agent asks for their OK: one brief, then Alpha is on top.
        turns.set(alpha.agent.id, {
            content: [
                {
                    type: "tool_call",
                    name: "set_status",
                    arguments: { text: "Needs your OK to push" },
                },
            ],
        });
        plans.push(organize({ op: "move", taskId: alpha.id, after: null }));
        const asked = Date.now();
        await gym.send("Ship it when ready.", { sessionId: alpha.agent.id });
        const second = await briefed(2);
        expect(second.text).toContain('Alpha status: \\"Needs your OK to push\\"');
        expect(second.text).toContain("Alpha got its first message");
        expect(second.at - asked).toBeLessThan(2_000 + 2_000);
        await gym.waitUntil(
            async () => ((await order())[0] === "Alpha" ? true : undefined),
            "Alpha on top",
        );

        // The person moves Bravo to the top. Focus hears that alone, not its own move of Alpha,
        // and its attempt to move Bravo is skipped because the person holds it.
        plans.push(organize({ op: "move", taskId: bravo.id, after: { taskId: alpha.id } }));
        await gym.client.reorderTask(bravo.id, { afterId: null });
        const third = await briefed(3);
        expect(third.text).toContain(`the person moved ${bravo.id}, which is now held`);
        expect(third.text.split("Changed since your last brief:")[1]).not.toContain("Alpha");
        const skipped = await gym.waitUntil(
            async () =>
                gym.inference
                    .toolResults()
                    .find((result) => result.text.includes("held_by_person")),
            "the held move to be skipped",
        );
        expect(JSON.parse(skipped.text)).toMatchObject({
            applied: 0,
            skipped: [{ index: 0, reason: "held_by_person" }],
        });
        expect(await order()).toEqual(["Bravo", "Alpha", "Charlie"]);

        // Turning Focus off and on again resumes the same Focus.
        await gym.client.saveUserSetting("tasks.focus", { value: false });
        await gym.client.saveUserSetting("tasks.focus", { value: true });
        expect((await briefed(4)).agentId).toBe(first.agentId);
        expect(briefs).toHaveLength(4);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 90_000);
});
