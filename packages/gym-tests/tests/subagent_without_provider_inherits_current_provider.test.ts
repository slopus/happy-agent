import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("subagent provider inheritance", () => {
    it("runs an omitted-provider collaborator on the creator's current provider", async () => {
        let parentSessionId: string | undefined;
        let parentCreatedCollaborator = false;
        const gym = await createGym({
            homeFiles: {
                "Happy/Config/happy.toml": [
                    "[providers]",
                    "default_enable = false",
                    "",
                    "[providers.codex]",
                    "enabled = true",
                    "",
                    "[providers.alternate]",
                    'type = "codex"',
                    "enabled = true",
                ].join("\n"),
            },
            inference(request) {
                parentSessionId ??= request.options.sessionId;
                if (request.options.sessionId === parentSessionId) {
                    const transcript = JSON.stringify(request.context.messages);
                    if (transcript.includes("CHILD_PROVIDER_OK")) {
                        return { content: [{ text: "REPORT_RECEIVED", type: "text" }] };
                    }
                    if (!parentCreatedCollaborator) {
                        parentCreatedCollaborator = true;
                        return {
                            content: [
                                {
                                    arguments: {
                                        effort: "low",
                                        model: "openai/gpt-5.6-sol",
                                        text: "Report that the inherited provider worked.",
                                        title: "Provider inheritance probe",
                                    },
                                    callId: "inheritprovider",
                                    name: "create_agent",
                                    type: "tool_call",
                                },
                            ],
                        };
                    }
                    return { content: [{ text: "PARENT_WAITING", type: "text" }] };
                }

                expect(request.providerId).toBe("codex");
                return { content: [{ text: "CHILD_PROVIDER_OK", type: "text" }] };
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
        });
        running.add(gym);

        gym.terminal.type("Create the provider inheritance collaborator.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("REPORT_RECEIVED", 30_000);
        expect(screen.text).toContain("REPORT_RECEIVED");
        expect(
            gym.inference.requests.some(
                (request) =>
                    request.options.sessionId !== parentSessionId && request.providerId === "codex",
            ),
        ).toBe(true);
    });
});
