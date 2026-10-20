import { afterEach, describe, expect, it } from "vitest";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("creating a subagent", () => {
    it("keeps the parent's instructions byte-stable and announces the collaborator once", async () => {
        let parentAgentId = "";
        let parentRequests = 0;
        const gym = await createAgentGym({
            inference: (request: GymInferenceRequest): GymTurn => {
                if (request.sessionId.startsWith("naming:")) {
                    return {
                        content: [
                            {
                                text: "<title>Stable prefix</title><slug>stable-prefix</slug>",
                                type: "text",
                            },
                        ],
                    };
                }
                if (request.sessionId !== parentAgentId) {
                    return { content: [{ text: "CHILD_DONE", type: "text" }] };
                }
                parentRequests += 1;
                if (parentRequests === 1) {
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    provider: "gym",
                                    text: "Say you are done.",
                                    title: "Prefix probe",
                                },
                                callId: "stableprefixchild",
                                name: "create_agent",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                if (parentRequests === 2) {
                    return {
                        content: [
                            {
                                arguments: { cmd: "true", yield_time_ms: 1_000 },
                                callId: "stableprefixcommand",
                                name: "exec_command",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                return { content: [{ text: "PARENT_DONE", type: "text" }] };
            },
        });
        running.add(gym);
        parentAgentId = gym.defaultSessionId;

        await gym.send("Create the collaborator.", { wait: false });

        const parent = await gym.waitUntil(() => {
            const requests = gym.inference.requests.filter(
                (request) => request.sessionId === parentAgentId,
            );
            return requests.length >= 3 ? requests : undefined;
        }, "the parent to run past the collaborator's creation");

        // The instructions are the cached prefix of every request. A change rebuilds the
        // provider session and re-sends the conversation uncached.
        const [first, ...later] = parent.map((request) => request.instructions);
        for (const instructions of later) expect(instructions).toBe(first);
        const announcement = "Collaborators you created:";
        expect(JSON.stringify(parent[0]!.messages)).not.toContain(announcement);
        const announced = parent[2]!.messages.filter((message) =>
            JSON.stringify(message).includes(announcement),
        );
        expect(announced).toHaveLength(1);
        expect(announced[0]!.role).toBe("system");
        expect(gym.inference.unscripted).toEqual([]);
    }, 30_000);
});
