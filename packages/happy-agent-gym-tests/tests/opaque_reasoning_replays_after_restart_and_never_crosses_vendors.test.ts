import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import type { SessionEvent, SessionMessage } from "@slopus/happy-providers";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
}, 30_000);

const THINKING = "39 times 41 is 1599, which beats 1591.";
/** Stands in for an Anthropic signature or an encrypted Responses reasoning item. */
const OPAQUE = "opaque-signed-reasoning-7f3a9c";

/**
 * A turn that thinks, with readable text and a separate opaque payload, and then calls the shell.
 * Scripted `content` reasoning reuses its text as the payload, so the events are spelled out.
 */
function thinkThenRun(tool: string, args: Record<string, unknown>): GymTurn {
    const callId = "reasoning-call";
    const serialized = JSON.stringify(args);
    const events: SessionEvent[] = [
        { type: "block_start" },
        { type: "reasoning_start" },
        { type: "reasoning_delta", delta: THINKING },
        { type: "reasoning_end", reasoning: OPAQUE },
        { type: "block_stop" },
        { type: "block_start" },
        { type: "toolcall_start", callId, name: tool },
        { type: "toolcall_delta", callId, delta: serialized },
        { type: "toolcall_end", callId, arguments: serialized },
        { type: "block_stop" },
        {
            type: "token_usage",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        },
        { type: "done", state: "tool_call", tokens: { input: 0, output: 0 } },
    ];
    return { events };
}

/** The shell tool the request offered, with arguments in its own schema. */
function shellCall(request: GymInferenceRequest): GymTurn {
    const names = request.tools.map((tool) => tool.name);
    if (names.includes("exec_command")) {
        return thinkThenRun("exec_command", { cmd: "echo marker-ALPHA" });
    }
    if (names.includes("Bash")) {
        return thinkThenRun("Bash", { command: "echo marker-ALPHA", description: "Print it" });
    }
    throw new Error(`No shell tool was offered: ${names.join(", ")}`);
}

function reasoningBlocks(messages: readonly SessionMessage[]) {
    return messages.flatMap((message) =>
        message.role === "assistant"
            ? message.content.filter((block) => block.type === "reasoning")
            : [],
    );
}

describe("opaque reasoning in replayed history", () => {
    it("replays the opaque payload verbatim to a fresh provider session after a restart", async () => {
        let agentCall = 0;
        const gym = await createAgentGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "Reasoning restart", type: "text" }] };
                }
                const call = agentCall;
                agentCall += 1;
                if (call === 0) return shellCall(request);
                return { content: [{ text: `answer ${String(call)}`, type: "text" }] };
            },
            permissionMode: "full_access",
        });
        running.add(gym);
        const agentRequests = () =>
            gym.inference.requests.filter((request) => request.sessionId === gym.defaultSessionId);

        await gym.send("Think, then print the marker.");
        expect(agentRequests()).toHaveLength(2);
        expect(reasoningBlocks(agentRequests()[1]!.messages)).toEqual([
            { type: "reasoning", text: THINKING, reasoning: OPAQUE },
        ]);

        await gym.restart();
        await gym.send("What did the command print?");

        const resumed = agentRequests()[2]!;
        expect(reasoningBlocks(resumed.messages)).toEqual([
            { type: "reasoning", text: THINKING, reasoning: OPAQUE },
        ]);
        expect(JSON.stringify(resumed.messages)).toContain("marker-ALPHA");
        // A restart is not a model change: nothing announces a fresh context.
        expect(JSON.stringify(resumed.messages)).not.toContain("history-context");
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("keeps opaque reasoning within a vendor and never sends it to another vendor", async () => {
        const model = (id: string, name: string) => ({
            defaultEffort: "medium" as const,
            effortLevels: ["medium" as const],
            id,
            name,
            providerId: "gym",
        });
        const opus = { providerId: "gym", modelId: "anthropic/gym-opus", effort: "medium" };
        const sonnet = { providerId: "gym", modelId: "anthropic/gym-sonnet", effort: "medium" };
        const gpt = { providerId: "gym", modelId: "openai/gym-gpt", effort: "medium" };
        let agentCall = 0;
        const gym = await createAgentGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ text: "Vendor switch", type: "text" }] };
                }
                const call = agentCall;
                agentCall += 1;
                if (call === 0) return shellCall(request);
                return { content: [{ text: `answer ${String(call)}`, type: "text" }] };
            },
            models: [
                model(opus.modelId, "Gym Opus"),
                model(sonnet.modelId, "Gym Sonnet"),
                model(gpt.modelId, "Gym GPT"),
            ],
            permissionMode: "full_access",
        });
        running.add(gym);
        const agentRequests = () =>
            gym.inference.requests.filter((request) => request.sessionId === gym.defaultSessionId);

        await gym.send("Think, then print the marker.", opus);
        await gym.send("Same vendor, another model.", sonnet);
        const sameVendor = agentRequests().at(-1)!;
        expect(sameVendor.model).toBe(sonnet.modelId);
        expect(reasoningBlocks(sameVendor.messages)).toEqual([
            { type: "reasoning", text: THINKING, reasoning: OPAQUE },
        ]);

        await gym.send("Another vendor now.", gpt);
        const otherVendor = agentRequests().at(-1)!;
        expect(otherVendor.model).toBe(gpt.modelId);
        expect(reasoningBlocks(otherVendor.messages)).toEqual([]);
        expect(JSON.stringify(otherVendor.messages)).not.toContain(OPAQUE);
        expect(JSON.stringify(otherVendor.messages[0])).toContain("model-switch-history-context");
        expect(gym.inference.unscripted).toEqual([]);
    });
});
