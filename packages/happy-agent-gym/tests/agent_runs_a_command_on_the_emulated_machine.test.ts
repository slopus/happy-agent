import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("the agent runs a command on the machine it was given", () => {
    it("writes a file the workspace really has afterwards, and reports the output back", async () => {
        const gym = await createAgentGym({
            files: { "README.md": "fixture repository\n" },
            inference: [
                {
                    content: [
                        {
                            arguments: { cmd: "cat README.md > copy.md && echo written" },
                            name: "exec_command",
                            type: "tool_call",
                        },
                    ],
                },
                { content: [{ text: "I copied the readme.", type: "text" }] },
            ],
            permissionMode: "full_access",
        });
        running.add(gym);

        await gym.send("Copy the readme.");

        // The effect is real: the file exists in the workspace the test can read.
        await expect(gym.readFile("copy.md")).resolves.toBe("fixture repository\n");

        // The model was shown what its own command produced, before it answered.
        const results = gym.inference.toolResults();
        expect(results).toHaveLength(1);
        expect(results[0]?.text).toContain("written");
        expect(agentRequests(gym)).toHaveLength(2);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("offers the shell tools the model's own vendor uses", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Nothing to do.", type: "text" }] }],
        });
        running.add(gym);

        await gym.send("Say nothing.");

        expect(gym.inference.lastTools()).toEqual(
            expect.arrayContaining(["exec_command", "apply_patch", "read_agent_history"]),
        );
    });
});

function agentRequests(gym: AgentGym) {
    return gym.inference.requests.filter(
        (request) => !request.instructions.includes("You name a piece of work"),
    );
}
