import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("cross-provider fork context accounting", () => {
    it("starts a Fable child from the parent's compacted canonical checkpoint", async () => {
        let parentCompactions = 0;
        let parentSpawned = false;
        let childCompactionSeen = false;
        let childInferenceSeen = false;
        const gym = await createGym({
            contextWindow: 500,
            environment: { ANTHROPIC_API_KEY: "claude-test-key" },
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: {
                        access_token: "gym-codex-token",
                        account_id: "gym-account",
                    },
                }),
            },
            inference(request) {
                const sessionId = request.options.sessionId;
                if (sessionId?.endsWith(":title") === true) {
                    return { content: [{ text: "Fork checkpoint regression", type: "text" }] };
                }
                if (request.providerId === "claude") {
                    if (request.options.intent === "compaction") {
                        childCompactionSeen = true;
                        return {
                            compactionContext: {
                                ...request.context,
                                messages: [
                                    {
                                        role: "user",
                                        content: "Unexpected child compaction.",
                                        timestamp: 1,
                                    },
                                ],
                            },
                            content: [],
                        };
                    }
                    childInferenceSeen = true;
                    expect(JSON.stringify(request.context.messages)).toContain(
                        "<model-switch-history-context>",
                    );
                    expect(JSON.stringify(request.context.messages)).not.toContain(
                        "SOURCE_PROVIDER_OPAQUE_CHECKPOINT",
                    );
                    return {
                        content: [{ text: "CHILD_RAN_WITHOUT_COMPACTION", type: "text" }],
                    };
                }

                expect(request.providerId).toBe("codex");
                if (request.options.intent === "compaction") {
                    parentCompactions += 1;
                    expect(JSON.stringify(request.context.messages)).toContain(
                        parentCompactions === 1
                            ? "PARENT_REPLACED_VISIBLE_HISTORY"
                            : "SOURCE_PROVIDER_OPAQUE_CHECKPOINT",
                    );
                    return {
                        compactionContext: {
                            ...request.context,
                            messages: [
                                {
                                    role: "compaction",
                                    content: null,
                                    encryptedContent: "SOURCE_PROVIDER_OPAQUE_CHECKPOINT",
                                    timestamp: 1,
                                },
                            ],
                        },
                        content: [],
                    };
                }
                const lastText = messageText(request.context.messages.at(-1));
                if (lastText.includes("Create the high parent checkpoint.")) {
                    return {
                        content: [{ text: "PARENT_REPLACED_VISIBLE_HISTORY", type: "text" }],
                        contextTokens: 450,
                        usage: usage(400, 50),
                    };
                }
                if (lastText.includes("<subagent-notification>")) {
                    return { content: [{ text: "PARENT_SAW_CHILD_COMPLETE", type: "text" }] };
                }
                if (parentCompactions > 0 && !parentSpawned) {
                    parentSpawned = true;
                    return {
                        content: [
                            {
                                arguments: {
                                    fork_turns: "all",
                                    message: "Review the inherited context.",
                                    model: "anthropic/fable-5",
                                    provider: "claude",
                                    reasoning_effort: "medium",
                                    task_name: "inherited_checkpoint_child",
                                },
                                id: "spawn-inherited-checkpoint-child",
                                name: "spawn_agent",
                                namespace: "collaboration_ext",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                return { content: [{ text: "PARENT_STARTED_CHILD", type: "text" }] };
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
            providerOverrides: ["codex", "claude"],
            rows: 28,
        });
        running.add(gym);

        submit(gym, "Create the high parent checkpoint.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("PARENT_REPLACED_VISIBLE_HISTORY") &&
                snapshot.text.includes("Ask Rig to do anything"),
            "the parent checkpoint turn to settle",
            30_000,
        );

        submit(gym, "Start the inherited Fable child.");
        const completed = await gym.terminal.waitUntil(
            (snapshot) =>
                childInferenceSeen &&
                snapshot.text.includes('"Inherited checkpoint child" completed in'),
            "the inherited Fable child to complete",
            30_000,
        );

        expect(parentCompactions).toBeGreaterThan(0);
        expect(childCompactionSeen).toBe(false);
        expect(completed.text).not.toContain(
            "Claude completed compaction without reporting token usage",
        );
    }, 120_000);

    it("keeps a large native checkpoint for a compatible child without durable replay", async () => {
        const replacement =
            "COMPATIBLE_CHECKPOINT_START\n" + "C".repeat(500_000) + "\nCOMPATIBLE_CHECKPOINT_END";
        let parentCompactions = 0;
        let parentSpawned = false;
        let childInferenceSeen = false;
        let compactionAfterSpawn = false;
        const gym = await createGym({
            contextWindow: 1_000_000,
            homeFiles: {
                ".codex/auth.json": JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: {
                        access_token: "gym-codex-token",
                        account_id: "gym-account",
                    },
                }),
            },
            inference(request) {
                const sessionId = request.options.sessionId;
                if (sessionId?.endsWith(":title") === true) {
                    return {
                        content: [{ text: "Compatible checkpoint regression", type: "text" }],
                    };
                }

                expect(request.providerId).toBe("codex");
                if (request.options.intent === "compaction") {
                    parentCompactions += 1;
                    if (parentSpawned) compactionAfterSpawn = true;
                    expect(JSON.stringify(request.context.messages)).toContain(
                        "COMPATIBLE_REPLACED_VISIBLE_HISTORY",
                    );
                    return {
                        compactionContext: {
                            ...request.context,
                            messages: [{ role: "user", content: replacement, timestamp: 1 }],
                        },
                        content: [],
                    };
                }

                const lastText = messageText(request.context.messages.at(-1));
                if (lastText.includes("Build the compatible native checkpoint.")) {
                    return {
                        content: [{ text: "COMPATIBLE_REPLACED_VISIBLE_HISTORY", type: "text" }],
                        contextTokens: 980_000,
                        usage: usage(930_000, 50_000),
                    };
                }
                if (lastText.includes("Inspect the compatible inherited checkpoint.")) {
                    const childMessages = JSON.stringify(request.context.messages);
                    expect(childMessages).toContain("COMPATIBLE_CHECKPOINT_START");
                    expect(childMessages).toContain("COMPATIBLE_CHECKPOINT_END");
                    expect(childMessages).not.toContain("COMPATIBLE_REPLACED_VISIBLE_HISTORY");
                    expect(childMessages.length).toBeGreaterThan(500_000);
                    childInferenceSeen = true;
                    return { content: [{ text: "COMPATIBLE_CHILD_DONE", type: "text" }] };
                }
                if (lastText.includes("<subagent-notification>")) {
                    return { content: [{ text: "COMPATIBLE_PARENT_DONE", type: "text" }] };
                }
                if (parentCompactions > 0 && !parentSpawned) {
                    parentSpawned = true;
                    return {
                        content: [
                            {
                                arguments: {
                                    fork_turns: "all",
                                    message: "Inspect the compatible inherited checkpoint.",
                                    model: "openai/gpt-5.6-sol",
                                    provider: "codex",
                                    reasoning_effort: "medium",
                                    task_name: "compatible_checkpoint_child",
                                },
                                id: "spawn-compatible-checkpoint-child",
                                name: "spawn_agent",
                                namespace: "collaboration_ext",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                return { content: [{ text: "COMPATIBLE_PARENT_STARTED_CHILD", type: "text" }] };
            },
            modelId: "openai/gpt-5.6-sol",
            providerId: "codex",
            providerOverrides: ["codex"],
            rows: 28,
        });
        running.add(gym);

        submit(gym, "Build the compatible native checkpoint.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("COMPATIBLE_REPLACED_VISIBLE_HISTORY") &&
                snapshot.text.includes("Ask Rig to do anything"),
            "the compatible parent checkpoint turn to settle",
            30_000,
        );

        submit(gym, "Start the compatible inherited child.");
        await gym.terminal.waitUntil(
            (snapshot) =>
                childInferenceSeen &&
                snapshot.text.includes('"Compatible checkpoint child" completed in'),
            "the compatible child to inherit the native checkpoint",
            30_000,
        );

        expect(parentCompactions).toBe(1);
        expect(compactionAfterSpawn).toBe(false);
    }, 120_000);
});

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

function messageText(
    message: { content: string | readonly { text?: string; type: string }[] | null } | undefined,
): string {
    if (message?.content == null) return "";
    if (typeof message.content === "string") return message.content;
    return message.content
        .filter((block): block is { text: string; type: string } => typeof block.text === "string")
        .map((block) => block.text)
        .join("");
}

function usage(input: number, output: number) {
    return {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input,
        output,
        totalTokens: input + output,
    };
}
