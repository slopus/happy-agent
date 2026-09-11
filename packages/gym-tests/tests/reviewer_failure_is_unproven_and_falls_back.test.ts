import { describe, expect, it } from "vitest";
import { createGym } from "@slopus/happy-terminal-gym";

const missingModel = "404 not_found_error: The model 'anthropic.claude-sonnet-5' does not exist";
const allowed =
    "<review><risk_level>low</risk_level><user_authorization>high</user_authorization><outcome>allow</outcome><rationale>The user requested this command.</rationale></review>";

describe("automatic reviewer route failures", () => {
    it.each(["unavailable", "fallback", "unparseable"] as const)(
        "handles %s at the terminal boundary",
        async (scenario) => {
            let mainCalls = 0;
            const routes: string[] = [];
            let resultContext = "";
            const gym = await createGym({
                permissionMode: "auto",
                providerId: "bedrock",
                modelId: "anthropic/opus-5",
                rows: 50,
                homeFiles: {
                    "happy/config/happy.toml":
                        '[providers]\ndefault_enable = false\n[providers.bedrock]\nenabled = true\nregion = "us-east-1"\n',
                },
                inference(request) {
                    if (
                        request.context.systemPrompt?.includes(
                            "You are judging one planned coding-agent action.",
                        )
                    ) {
                        routes.push(request.modelId);
                        if (scenario === "unparseable")
                            return { content: [{ type: "text", text: "not a verdict" }] };
                        if (scenario === "unavailable" || routes.length === 1) {
                            return {
                                content: [],
                                stopReason: "error",
                                errorMessage: missingModel,
                                providerError: {
                                    type: "unclassified",
                                    diagnostics: {
                                        status: 404,
                                        errorType: "not_found_error",
                                        upstreamMessage: missingModel,
                                    },
                                },
                            };
                        }
                        return { content: [{ type: "text", text: allowed }] };
                    }
                    mainCalls += 1;
                    if (mainCalls === 1)
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    callId: "reviewed-command",
                                    name: "Bash",
                                    arguments: {
                                        command: "printf REVIEW_ACTION_RAN",
                                        dangerouslyDisableSandbox: true,
                                        description: "Run the user-requested harmless command.",
                                    },
                                },
                            ],
                        };
                    resultContext = JSON.stringify(request.context);
                    return { content: [{ type: "text", text: "REVIEW_SCENARIO_FINISHED" }] };
                },
            });
            try {
                gym.terminal.type("Run the harmless printf command with full access.");
                gym.terminal.press("enter");
                const screen = await gym.terminal.waitForText("REVIEW_SCENARIO_FINISHED", 30_000);
                const toolResult = gym.inference.requests
                    .flatMap((request) => request.context.messages)
                    .filter((message) => message.role === "tool")
                    .at(-1);
                expect(toolResult).toBeDefined();
                if (scenario === "fallback") {
                    expect(routes).toEqual(["anthropic/sonnet-5", "openai/gpt-5.4"]);
                    expect(screen.text).toContain("REVIEW_ACTION_RAN");
                    expect(resultContext).not.toContain("unreadable decision");
                    expect(toolResult?.["isError"]).not.toBe(true);
                    expect(JSON.stringify(toolResult?.content)).toContain("REVIEW_ACTION_RAN");
                } else if (scenario === "unavailable") {
                    expect(resultContext).toContain("unproven");
                    expect(resultContext).not.toContain("unreadable decision");
                    expect(screen.text).toContain("does not exist");
                    expect(routes).toEqual([
                        "anthropic/sonnet-5",
                        "openai/gpt-5.4",
                        "anthropic/opus-5",
                    ]);
                    expect(toolResult?.["isError"]).toBe(true);
                    expect(JSON.stringify(toolResult?.content)).toContain("No judgement was made");
                    expect(screen.text).toContain("Unproven");
                } else {
                    expect(routes).toEqual(["anthropic/sonnet-5"]);
                    expect(resultContext).toContain("unreadable decision");
                    expect(toolResult?.["isError"]).toBe(true);
                }
            } finally {
                await gym.dispose();
            }
        },
        60_000,
    );
});
