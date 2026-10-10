import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("public API assistant identity across steering", () => {
    it("keeps the streamed segment's original message identity through its final snapshot", async () => {
        const firstAnswer = "the first streamed response keeps one assistant identity";
        let agentCalls = 0;
        const gym = await createAgentGym({
            inference: (request) => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [{ text: "<title>Streaming identity</title>", type: "text" }],
                    };
                }
                const call = agentCalls;
                agentCalls += 1;
                return call === 0
                    ? {
                          content: [{ text: firstAnswer, type: "text" }],
                          textDeltaChunkSize: 1,
                          textDeltaDelayMs: 20,
                      }
                    : { content: [{ text: "the steering response", type: "text" }] };
            },
        });
        activeGyms.add(gym);

        const first = await gym.send("start a streamed response", { wait: false });
        const created = await gym.waitForEvent(
            (event) =>
                event.type === "message.created" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.runId === first.runId &&
                event.payload.message.role === "agent",
            "the streamed assistant message to be created",
        );
        expect(created.type).toBe("message.created");
        if (created.type !== "message.created") {
            throw new Error("The streamed assistant message was not created.");
        }
        const messageId = created.payload.message.id;
        await gym.waitForEvent(
            (event) =>
                event.type === "message.delta" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.messageId === messageId,
            "the first assistant delta",
        );

        const steering = gym.steer("steer after streaming begins", {
            id: "streamingidentitysteering",
            wait: false,
        });
        await gym.waitUntil(async () => {
            const bootstrap = await gym.client.getAgentBootstrap(gym.defaultSessionId);
            return bootstrap.pending.some((message) => message.id === "streamingidentitysteering")
                ? true
                : undefined;
        }, "the steering message to become pending");
        const accepted = await steering;
        const boundary = await gym.waitForEvent(
            (event) =>
                event.type === "run.boundary" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.acceptedMessageIds.includes(accepted.id),
            "the steering run boundary",
        );
        expect(boundary.type).toBe("run.boundary");
        if (boundary.type !== "run.boundary") throw new Error("Steering created no boundary.");
        await gym.waitForRun(boundary.payload.startedRun.id);

        const completedSnapshots = (await gym.events()).flatMap((event) => {
            if (
                event.type !== "message.updated" ||
                event.payload.agentId !== gym.defaultSessionId ||
                !event.payload.message.content.some(
                    (block) => block.type === "text" && block.text === firstAnswer,
                )
            ) {
                return [];
            }
            return [event];
        });
        expect(completedSnapshots.length).toBeGreaterThan(0);
        expect(completedSnapshots.map((event) => event.payload.message.id)).toEqual(
            completedSnapshots.map(() => messageId),
        );
        expect(completedSnapshots.map((event) => event.payload.runId)).toEqual(
            completedSnapshots.map(() => first.runId),
        );
    }, 30_000);
});
