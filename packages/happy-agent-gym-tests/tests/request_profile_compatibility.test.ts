import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, runIdOf, type AgentGym } from "@slopus/happy-agent-gym";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("request profiles", () => {
    it("normalizes unsupported opaque profiles without resetting private context", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ text: "first answer", type: "text" }] },
                { content: [{ text: "second answer", type: "text" }] },
                { content: [{ text: "third answer", type: "text" }] },
            ],
        });
        activeGyms.add(gym);

        const focused = await gym.client.getAgent(gym.defaultSessionId);
        const created = await gym.client.createAgent({
            title: "Profile catalog",
            workspaceId: focused.agent.workspaceId,
        });
        const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
        const markedRead = await gym.client.markAgentRead(gym.defaultSessionId);
        expect(focused.profiles).toEqual([]);
        expect(created.profiles).toEqual([]);
        expect(bootstrap.profiles).toEqual([]);
        expect(markedRead.profiles).toEqual([]);

        const profileA = "opaque-profile-alpha";
        const profileB = "opaque-profile-beta";
        const first = await send(gym, "first request", profileA);
        const second = await send(gym, "same-profile request", profileA);
        const third = await send(gym, "changed-profile request", profileB);

        expect(first.profile).toBeNull();
        expect(second.profile).toBeNull();
        expect(third.profile).toBeNull();

        expect(gym.inference.requests).toHaveLength(3);
        expect(gym.inference.requests[0]?.messages.map((message) => message.role)).toEqual([
            "user",
        ]);
        expect(gym.inference.requests[1]?.messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
        ]);
        expect(gym.inference.requests[2]?.messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
            "user",
        ]);
        expect(gym.inference.requests[2]?.messages.at(-1)).toMatchObject({
            role: "user",
            content: [{ type: "text", text: "changed-profile request" }],
        });

        const inference = JSON.stringify(gym.inference.requests);
        expect(inference).not.toContain(profileA);
        expect(inference).not.toContain(profileB);

        const history = await gym.client.getMessages(gym.defaultSessionId);
        const users = history.runs
            .flatMap((run) => run.messages)
            .filter((message) => message.role === "user");
        expect(users.map((message) => message.profile)).toEqual([null, null, null]);
        expect(users.map((message) => textOf(message))).toEqual([
            "first request",
            "same-profile request",
            "changed-profile request",
        ]);

        const retry = await gym.client.sendMessage(gym.defaultSessionId, {
            id: second.id,
            mode: modeFor(gym),
            profile: "replacement-profile-that-must-not-apply",
            text: "retry content that must not replace the original",
        });
        expect(retry.message).toMatchObject({
            id: second.id,
            profile: null,
            status: "accepted",
        });
        expect(gym.inference.requests).toHaveLength(3);
        expect(gym.inference.unscripted).toEqual([]);
    });
});

async function send(gym: AgentGym, text: string, profile: string) {
    const response = await gym.client.sendMessage(gym.defaultSessionId, {
        mode: modeFor(gym),
        profile,
        text,
    });
    const started = await gym.waitForEvent(
        (event) =>
            event.type === "run.started" &&
            event.payload.agentId === gym.defaultSessionId &&
            event.payload.acceptedMessageIds.includes(response.message.id),
        `the run for ${text}`,
    );
    const runId = runIdOf(started);
    if (runId === undefined) throw new Error(`The run for ${text} had no ID.`);
    await gym.waitForRun(runId);
    const history = await gym.client.getMessages(gym.defaultSessionId);
    const accepted = history.runs
        .flatMap((run) => run.messages)
        .find((message) => message.id === response.message.id);
    if (accepted === undefined || accepted.role !== "user") {
        throw new Error(`The user message for ${text} was not accepted.`);
    }
    return accepted;
}

function modeFor(gym: AgentGym) {
    return {
        effort: gym.selection.effort,
        modelId: gym.selection.modelId,
        permissionMode: "auto" as const,
        providerId: gym.selection.providerId,
        serviceTier: null,
    };
}

function textOf(message: {
    readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
    return message.content
        .filter(
            (block): block is { readonly type: "text"; readonly text: string } =>
                block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
}
