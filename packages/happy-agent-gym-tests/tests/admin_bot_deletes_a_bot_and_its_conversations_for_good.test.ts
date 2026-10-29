import { existsSync } from "node:fs";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** A gym where each agent runs exactly the tool call it is asked for, and then settles. */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        permissionMode: "full_access",
        timeoutMs: 20_000,
        inference: (request: GymInferenceRequest): GymTurn => {
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Settled." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function call(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `deletion_call_${++callIndex}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "full_access",
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            `the ${name} result`,
        );
    }
    return { gym, call };
}

describe("an admin bot deletes a bot for good", () => {
    it("previews, then erases the bot, its subtask, their conversations, and its folder", async () => {
        const { gym, call } = await harness();
        const worker = (await gym.client.createBot({ name: "Doomed worker" })).bot;
        const admin = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!;
        const created = await call(worker.agent.id, "create_subtask", {
            title: "Doomed subtask",
            text: "Work inside the bot.",
            model: gym.selection.modelId,
            effort: gym.selection.effort,
            provider: gym.selection.providerId,
        });
        const subtaskId = /Created subtask ([a-z0-9]+)/.exec(created.text)![1]!;
        expect(worker.compute.type).toBe("host");
        const folder = (worker.compute as { path: string }).path;
        expect(existsSync(folder)).toBe(true);

        // An admin cannot delete itself.
        const own = await call(admin.agent.id, "preview_delete", { kind: "bot", id: admin.id });
        expect(own.text).toContain("An admin cannot delete itself");

        const preview = await call(admin.agent.id, "preview_delete", {
            kind: "bot",
            id: worker.id,
        });
        expect(preview.text).toContain("Nothing has been changed.");
        expect(preview.text).toContain(worker.agent.id);
        expect(preview.text).toContain(subtaskId);
        expect(preview.text).toContain(folder);
        const confirmation = /confirmation "([0-9a-f]+)"/.exec(preview.text)![1]!;
        expect((await gym.client.listBots()).bots.map((bot) => bot.id)).toContain(worker.id);

        const refused = await call(admin.agent.id, "delete_permanently", {
            kind: "bot",
            id: worker.id,
            confirmation: "000000000000",
        });
        expect(refused.text).toContain("Nothing was deleted.");

        const deleted = await call(admin.agent.id, "delete_permanently", {
            kind: "bot",
            id: worker.id,
            confirmation,
        });
        expect(deleted.text).toContain("being removed in the background");

        await gym.waitUntil(async () => {
            const { bots } = await gym.client.listBots();
            return bots.some((bot) => bot.id === worker.id) ? undefined : true;
        }, "the bot to be deleted");
        for (const agentId of [worker.agent.id, subtaskId]) {
            await expect(gym.client.getAgent(agentId)).rejects.toMatchObject({ status: 404 });
        }
        await gym.waitUntil(
            async () => (existsSync(folder) ? undefined : true),
            "the bot's folder to be removed",
        );
        const types = (await gym.events()).map((event) => event.type as string);
        expect(types).toContain("bot.removed");
        expect(types).toContain("agent.removed");

        // The admin itself is untouched and still answers.
        expect((await gym.client.getAgent(admin.agent.id)).agent.id).toBe(admin.agent.id);
    }, 120_000);
});
