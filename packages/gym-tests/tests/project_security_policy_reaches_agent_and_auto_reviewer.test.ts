import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("project security policy reaches the agent and Auto reviewer", () => {
    it("delivers AGENTS_SECURITY.md rules to both sides of an elevated action", async () => {
        const policy = "PROJECT SECURITY POLICY: require deployment verification.";
        const gym = await createGym({
            files: { "AGENTS_SECURITY.md": `${policy}\n` },
            inference(request, callIndex) {
                const systemPrompt = request.context.systemPrompt ?? "";
                if (systemPrompt.includes("judging one planned coding-agent action")) {
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    outcome: "allow",
                                    risk_level: "low",
                                    user_authorization: "high",
                                    rationale: "The project security policy allows this action.",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }
                if (callIndex === 0) {
                    return {
                        content: [
                            {
                                arguments: {
                                    cmd: "printf 'verified\\n' > verification.txt",
                                    justification: "Run the requested deployment verification.",
                                    sandbox_permissions: "require_escalated",
                                    workdir: "/workspace",
                                },
                                id: "verification-command",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                return { content: [{ text: "VERIFICATION_COMPLETE", type: "text" }] };
            },
            permissionMode: "auto",
        });
        running.add(gym);

        gym.terminal.type("Run the deployment verification.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("VERIFICATION_COMPLETE", 30_000);

        const requests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        const reviewer = requests.find((request) =>
            request.context.systemPrompt?.includes("judging one planned coding-agent action"),
        );
        const agent = requests.find(
            (request) =>
                !request.context.systemPrompt?.includes("judging one planned coding-agent action"),
        );
        expect(reviewer?.context.systemPrompt).toContain(policy);
        expect(JSON.stringify(agent?.context.messages)).toContain(policy);
        await expect(gym.readFile("verification.txt")).resolves.toBe("verified\n");
    }, 120_000);
});