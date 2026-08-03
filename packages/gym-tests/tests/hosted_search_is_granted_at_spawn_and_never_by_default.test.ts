import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

function grantingSpawn(capabilities: readonly string[]) {
    return {
        content: [
            {
                arguments: {
                    capabilities,
                    message: "What is X saying about the launch?",
                    // The gym scripts inference rather than reaching a real provider, so the
                    // child is its own model. What is under test is the grant, which is refused
                    // before the child's model is ever considered.
                    model: "openai/gym",
                    provider: "gym",
                    reasoning_effort: "medium",
                    task_name: "research_the_launch",
                },
                id: "grant-1",
                name: "spawn_agent",
                namespace: "collaboration_ext",
                type: "toolCall" as const,
            },
        ],
    };
}

/**
 * A hosted search is executed by the provider inside its own response, so unlike every other
 * network tool in Rig there is no call left for Rig to intercept. The whole boundary is the spawn
 * that grants it, which is what these check from the outside: the capability is offered on the
 * spawn, an agent that cannot reach past the sandbox cannot hand one out, and nobody is given one
 * they did not ask for.
 */
describe("granting a search the provider runs on its own backend", () => {
    it("is refused for a session that cannot reach outside the sandbox itself", async () => {
        const gym = await createGym({
            cols: 96,
            inference: (_request, callIndex) =>
                callIndex === 0
                    ? grantingSpawn(["x_search"])
                    : { content: [{ text: "GRANT_REFUSED", type: "text" }] },
            permissionMode: "read_only",
            rows: 32,
        });
        running.add(gym);

        gym.terminal.type("Find out what X is saying about the launch.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("GRANT_REFUSED", 30_000);

        const refusals = gym.inference.requests
            .flatMap((request) => request.context.messages ?? [])
            .filter((message) => message.role === "toolResult" && message.isError === true)
            .flatMap((message) =>
                message.role === "toolResult"
                    ? message.content.map((block) => (block.type === "text" ? block.text : ""))
                    : [],
            );

        // The spawn was reached and turned down for the stated reason, rather than failing for
        // some incidental one that would make this test pass without testing anything.
        expect(refusals.join("\n")).toMatch(
            /cannot grant x_search|requires Auto or Full access|holds none itself/u,
        );
        expect(refusals.join("\n")).not.toContain("Unknown tool");
    }, 120_000);

    it("offers the capability on the spawn and gives it to nobody by default", async () => {
        const gym = await createGym({
            cols: 96,
            inference: [{ content: [{ text: "NOTHING_GRANTED", type: "text" }] }],
            permissionMode: "full_access",
            rows: 32,
        });
        running.add(gym);

        gym.terminal.type("What is X saying about Claude Code?");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("NOTHING_GRANTED", 30_000);

        const agentRequest = gym.inference.requests.find(
            (request) => (request.context.tools ?? []).length > 0,
        );
        const tools = agentRequest?.context.tools ?? [];
        const spawn = tools.find(
            (tool) => tool.name === "spawn_agent" && tool.namespace === "collaboration_ext",
        );
        const spawnProperties = (spawn as { parameters?: { properties?: object } } | undefined)
            ?.parameters?.properties;
        expect(Object.keys(spawnProperties ?? {})).toContain("capabilities");

        // Full access is the widest mode there is, and it still grants nothing on its own.
        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).not.toContain("x_search");
        expect(toolNames).not.toContain("web_search");
    }, 120_000);
});
