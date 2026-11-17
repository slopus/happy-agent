import { createAgentGym, GYM_MODELS, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("agent-created children inherit the creator's service tier", () => {
    it.each([
        {
            name: "inherits priority",
            parentTier: "priority",
            supported: true,
            explicit: false,
            expected: "priority",
        },
        {
            name: "keeps regular service",
            parentTier: null,
            supported: true,
            explicit: false,
            expected: null,
        },
        {
            name: "honors explicit priority",
            parentTier: null,
            supported: true,
            explicit: true,
            expected: "priority",
        },
        {
            name: "uses regular service on an unsupported target",
            parentTier: "priority",
            supported: false,
            explicit: false,
            expected: null,
        },
        {
            name: "rejects explicit priority on an unsupported target",
            parentTier: "priority",
            supported: false,
            explicit: true,
            expected: null,
        },
    ] as const)(
        "$name for collaborators and subtasks",
        async ({ parentTier, supported, explicit, expected }) => {
            const scripted = new Map<string, GymTurn>();
            const parentModel = GYM_MODELS[0]!;
            const childModel = {
                ...parentModel,
                id: "openai/gym-child",
                serviceTiers: supported ? ["priority"] : [],
            };
            const gym = await createAgentGym({
                timeoutMs: 20_000,
                models: [{ ...parentModel, serviceTiers: ["priority"] }, childModel],
                inference: (request) => {
                    const next = scripted.get(request.sessionId);
                    if (next !== undefined) {
                        scripted.delete(request.sessionId);
                        return next;
                    }
                    return { content: [{ type: "text", text: "Settled." }] };
                },
            });
            running.add(gym);
            const bot = (await gym.client.createBot({ name: "Coordinator" })).bot;
            const tools = ["create_agent", "create_subtask"] as const;
            scripted.set(bot.agent.id, {
                content: tools.map((name) => ({
                    type: "tool_call",
                    name,
                    callId: `tier_${name}`,
                    arguments: {
                        title: "Tier helper",
                        text: "Report your result.",
                        model: childModel.id,
                        effort: childModel.defaultEffort,
                        ...(explicit ? { serviceTier: "priority" } : {}),
                    },
                })),
            });
            const sent = await gym.client.sendMessage(bot.agent.id, {
                text: "Create both helpers.",
                mode: {
                    modelId: parentModel.id,
                    providerId: parentModel.providerId,
                    effort: parentModel.defaultEffort,
                    permissionMode: "auto",
                    serviceTier: parentTier,
                },
            });
            if (sent.message.runId != null) await gym.waitForRun(sent.message.runId);

            for (const name of tools) {
                const result = await gym.waitUntil(
                    () =>
                        gym.inference.toolResults().find((item) => item.callId === `tier_${name}`),
                    `${name}'s result`,
                );
                if (explicit && !supported) {
                    expect(result.text).toContain('Service tier "priority" is not available');
                    continue;
                }
                const agentId = /Created (?:collaborator|subtask) ([a-z0-9]+)/.exec(
                    result.text,
                )?.[1];
                expect(agentId, result.text).toBeDefined();
                const request = await gym.waitUntil(
                    () => gym.inference.requests.find((item) => item.sessionId === agentId),
                    "the child's first inference",
                );
                expect(request.serviceTier ?? null).toBe(expected);
                expect((await gym.client.getAgentMode(agentId!)).mode).toMatchObject({
                    modelId: childModel.id,
                    providerId: childModel.providerId,
                    serviceTier: expected,
                });
            }
            if (explicit && !supported) {
                expect((await gym.client.getAgentActivity(bot.agent.id)).subagents).toEqual([]);
            }
            expect(gym.errors).toEqual([]);
        },
        60_000,
    );
});
