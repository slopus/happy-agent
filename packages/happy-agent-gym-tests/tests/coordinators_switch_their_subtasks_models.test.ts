import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** A bot that runs one scripted tool call per request it is sent, and a subtask it created. */
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
            return { content: [{ type: "text", text: "Ready." }] };
        },
    });
    running.add(gym);
    const bot = (await gym.client.createBot({ name: "Model coordinator" })).bot;
    let callIndex = 0;
    async function call(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `switch_test_${++callIndex}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please execute ${name}, request ${callId}.`, { sessionId: agentId });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
    }
    /** The subtask's first inference request after `after` that contains `text`. */
    async function subtaskRequest(agentId: string, text: string, after = 0) {
        return await gym.waitUntil(
            async () =>
                gym.inference.requests
                    .slice(after)
                    .find(
                        (request) =>
                            request.sessionId === agentId &&
                            JSON.stringify(request.messages).includes(text),
                    ),
            `the subtask's inference containing "${text}"`,
        );
    }
    const created = await call(bot.agent.id, "create_subtask", {
        title: "Model switch",
        text: "Start on the second model.",
        model: "gym/model-2",
        effort: "high",
    });
    const subtaskId = /Created subtask ([a-z0-9]+)/.exec(created.text)?.[1];
    if (subtaskId === undefined) throw new Error(`No subtask was created: ${created.text}`);
    await subtaskRequest(subtaskId, "Start on the second model.");
    return { gym, bot, call, subtaskId, subtaskRequest };
}

describe("coordinators switching their subtasks' models", () => {
    it("switches a subtask with switch_subtask_model through the ordinary model-switch path", async () => {
        const { gym, bot, call, subtaskId, subtaskRequest } = await harness();
        const before = gym.inference.requests.length;

        const result = await call(bot.agent.id, "switch_subtask_model", {
            agentId: subtaskId,
            model: "gym/model",
            effort: "low",
        });

        expect(result.text).toContain(
            `Switched subtask ${subtaskId} to Gym Model (gym/model via gym) at low effort.`,
        );
        const request = await subtaskRequest(
            subtaskId,
            "I switched you to Gym Model at low effort.",
            before,
        );
        expect({ model: request.model, effort: request.effort }).toEqual({
            model: "gym/model",
            effort: "low",
        });
        // A person opening the subtask composes on top of the model its coordinator chose.
        expect((await gym.client.getAgentMode(subtaskId)).mode).toEqual({
            effort: "low",
            modelId: "gym/model",
            permissionMode: "auto",
            providerId: "gym",
            serviceTier: null,
        });
        expect(gym.errors).toEqual([]);
    });

    it("switches a subtask with the model fields of send_agent_message", async () => {
        const { gym, bot, call, subtaskId, subtaskRequest } = await harness();
        const before = gym.inference.requests.length;

        const result = await call(bot.agent.id, "send_agent_message", {
            toAgentId: subtaskId,
            explanation: "Continue on the first model",
            text: "Continue the work on the first model.",
            model: "gym/model",
            effort: "medium",
        });

        expect(result.text).toContain("Message delivered.");
        const request = await subtaskRequest(
            subtaskId,
            "Continue the work on the first model.",
            before,
        );
        expect({ model: request.model, effort: request.effort }).toEqual({
            model: "gym/model",
            effort: "medium",
        });
        expect((await gym.client.getAgentMode(subtaskId)).mode).toMatchObject({
            modelId: "gym/model",
            effort: "medium",
        });
    });

    it("refuses a subtask's attempt to switch its own coordinator", async () => {
        const { gym, bot, call, subtaskId } = await harness();
        const botMode = (await gym.client.getAgentMode(bot.agent.id)).mode;

        const refused = await call(subtaskId, "send_agent_message", {
            toAgentId: bot.agent.id,
            explanation: "Switch my coordinator",
            text: "Run on the second model.",
            model: "gym/model-2",
            effort: "high",
        });
        const switchTool = await call(subtaskId, "switch_subtask_model", {
            agentId: bot.agent.id,
            model: "gym/model-2",
            effort: "high",
        });

        expect(refused.text).toContain(
            `may switch the model only of agents it created directly, and "${bot.agent.id}" is not one of them`,
        );
        expect(switchTool.text).toContain(
            "Only a subtask's direct coordinating bot, task, or subtask may switch its model.",
        );
        expect((await gym.client.getAgentMode(bot.agent.id)).mode).toEqual(botMode);
    });
});
