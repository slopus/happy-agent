import { createGym, type Gym, type GymInferenceResponse } from "@slopus/happy-terminal-gym";
import { expect, it } from "vitest";

it("delegates from a bot through the terminal and shares the bot's files with its subtask", async () => {
    let gym: Gym | undefined;
    let mainCalls = 0;
    let chiefCalls = 0;
    let childCalls = 0;
    let parentReadRequested = false;
    let reportSent = false;
    let rootAgentId = "";
    try {
        gym = await createGym({
            mode: "docker",
            inference(request): GymInferenceResponse {
                const prompt = request.context.systemPrompt ?? "";
                const history = JSON.stringify(request.context.messages);
                if (prompt.includes("You are a subtask:")) {
                    childCalls += 1;
                    if (childCalls === 1)
                        return call("child-write", "exec_command", {
                            cmd: "printf 'shared-subtask\\n' > subtask-marker.txt",
                        });
                    return {
                        content: [
                            { type: "text", text: "I wrote the marker in our shared folder." },
                        ],
                    };
                }
                if (prompt.includes('You are the persistent bot named "Chief of Staff"')) {
                    chiefCalls += 1;
                    if (chiefCalls === 1)
                        return call("create-interactive-task", "create_subtask", {
                            title: "Write the shared marker",
                            text: "Write subtask-marker.txt containing shared-subtask in our shared folder.",
                            model: "openai/gym",
                            effort: "off",
                            provider: "gym",
                        });
                    expect(history).toContain("Created subtask");
                    if (
                        !parentReadRequested &&
                        history.includes("I wrote the marker in our shared folder.")
                    ) {
                        parentReadRequested = true;
                        return call("parent-read", "exec_command", {
                            cmd: "cat subtask-marker.txt",
                        });
                    }
                    if (parentReadRequested && !reportSent) {
                        expect(JSON.stringify(request.context.messages.at(-1))).toContain(
                            "shared-subtask",
                        );
                        reportSent = true;
                        return call("report-subtask", "send_agent_message", {
                            toAgentId: rootAgentId,
                            text: "SUBTASK_SHARED_FILE_CONFIRMED",
                        });
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: reportSent
                                    ? "The shared task is complete."
                                    : "The subtask is working independently.",
                            },
                        ],
                    };
                }
                mainCalls += 1;
                rootAgentId = prompt.match(/Your Agent ID is ([a-z0-9]+)/u)?.[1] ?? "";
                expect(rootAgentId).not.toBe("");
                if (mainCalls === 1) return call("find-bot", "list_bots", {});
                if (mainCalls === 2) {
                    const chiefId = history.match(/Chief of Staff — id ([a-z0-9]+)/u)?.[1];
                    expect(chiefId).toBeDefined();
                    return call("ask-bot", "send_bot_message", {
                        botId: chiefId,
                        text: `Create an interactive subtask that writes subtask-marker.txt in your shared folder. Read that file yourself and tell agent ${rootAgentId} when verified.`,
                    });
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: history.includes("SUBTASK_SHARED_FILE_CONFIRMED")
                                ? "SUBTASK_TERMINAL_DONE"
                                : "Task request sent.",
                        },
                    ],
                };
            },
        });
        gym.terminal.type(
            "Ask Chief of Staff to delegate a shared-folder subtask and verify its file.",
        );
        gym.terminal.press("enter");
        await gym.terminal.waitForText("SUBTASK_TERMINAL_DONE", 40_000);
        expect(childCalls).toBe(2);
        expect(chiefCalls).toBeGreaterThanOrEqual(4);
        expect(JSON.stringify(gym.inference.requests)).toContain("Created subtask");
    } finally {
        await gym?.dispose();
    }
}, 60_000);

function call(id: string, name: string, args: Record<string, unknown>): GymInferenceResponse {
    return { content: [{ type: "toolCall", id, name, arguments: args }] };
}
