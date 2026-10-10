import {
    createAgentGym,
    GYM_SECOND_MODEL_ID,
    type AgentGym,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** The bot works on the gym's second model, so inheriting it is told apart from the default. */
const BOT_MODE = { modelId: GYM_SECOND_MODEL_ID, effort: "high" } as const;

async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
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
            return { content: [{ type: "text", text: "Work settled." }] };
        },
    });
    running.add(gym);
    const bot = (await gym.client.createBot({ name: "Coordinator" })).bot;
    let callIndex = 0;
    async function call(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `opened_test_${++callIndex}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please execute ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "auto",
            ...BOT_MODE,
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
    }
    const firstRequest = async (agentId: string) =>
        await gym.waitUntil(
            async () => gym.inference.requests.find((request) => request.sessionId === agentId),
            "the conversation's first inference",
        );
    return { gym, bot, call, firstRequest };
}

describe("conversations an agent opens", () => {
    it("run a bot's new task on the bot's own model", async () => {
        const { gym, bot, call, firstRequest } = await harness();
        await call(bot.agent.id, "create_task", {
            name: "Fix login redirect",
            text: "The login page loops back to itself.",
        });
        const task = (await gym.client.listTasks()).tasks[0]!;

        const request = await firstRequest(task.agent.id);
        expect(request).toMatchObject({ model: GYM_SECOND_MODEL_ID, effort: "high" });
        expect(JSON.stringify(request.messages)).toContain("The login page loops back to itself.");
        expect((await gym.client.getAgentMode(task.agent.id)).mode).toEqual({
            providerId: gym.selection.providerId,
            modelId: GYM_SECOND_MODEL_ID,
            effort: "high",
            serviceTier: null,
            permissionMode: "auto",
        });
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("give a task that has no mode the sender's, and keep the mode a person chose", async () => {
        const { gym, bot, call, firstRequest } = await harness();
        // A task nobody has spoken to has no mode, like one created before tasks chose a model.
        const { task } = await gym.client.createTask({ name: "Audit exports" });
        expect((await gym.client.getAgentMode(task.agent.id)).mode).toBeNull();

        await call(bot.agent.id, "send_task_message", {
            taskId: task.id,
            text: "Check the billing exports.",
        });
        expect(await firstRequest(task.agent.id)).toMatchObject({
            model: GYM_SECOND_MODEL_ID,
            effort: "high",
        });

        // A person's choice is the task's from then on; the bot's next message does not undo it.
        await gym.send("Use the default model from here.", {
            sessionId: task.agent.id,
            effort: "low",
        });
        await call(bot.agent.id, "send_task_message", {
            taskId: task.id,
            text: "Any progress?",
        });
        const last = await gym.waitUntil(
            async () =>
                gym.inference.requests.findLast(
                    (request) =>
                        request.sessionId === task.agent.id &&
                        JSON.stringify(request.messages).includes("Any progress?"),
                ),
            "the task's turn on the bot's follow-up",
        );
        expect(last).toMatchObject({ model: gym.selection.modelId, effort: "low" });
        expect((await gym.client.getAgentMode(task.agent.id)).mode).toMatchObject({
            modelId: gym.selection.modelId,
            effort: "low",
        });
    });

    it("run a bot nobody has spoken to on the model of the bot that wrote first", async () => {
        const { gym, bot, call, firstRequest } = await harness();
        const quiet = (await gym.client.createBot({ name: "Researcher" })).bot;
        await call(bot.agent.id, "send_bot_message", {
            botId: quiet.id,
            text: "Collect last week's incident reports.",
        });
        expect(await firstRequest(quiet.agent.id)).toMatchObject({
            model: GYM_SECOND_MODEL_ID,
            effort: "high",
        });
        expect((await gym.client.getAgentMode(quiet.agent.id)).mode).toMatchObject({
            modelId: GYM_SECOND_MODEL_ID,
            effort: "high",
            permissionMode: "auto",
        });
    });
});
