import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("archived workspace subagents", () => {
    it("disappear from list_agents and do not keep wait_agent alive", async () => {
        let parentSessionId: string | undefined;
        let workspaceId: string | undefined;
        let workspaceArchived = false;
        const gym = await createGym({
            files: { "README.md": "# Archived subagent fixture\n" },
            inference(request) {
                const sessionId = request.options.sessionId;
                const lastMessage = request.context.messages.at(-1);
                const lastText = messageText(lastMessage);

                if (lastText.includes("ARCHIVED_CHILD_TASK")) {
                    expect(sessionId).not.toBe(parentSessionId);
                    return { content: [{ text: "ARCHIVED_CHILD_FINISHED", type: "text" }] };
                }

                if (lastText.includes("<subagent-notification>")) {
                    expect(lastText).toContain("Status: completed");
                    expect(workspaceId).toBeTypeOf("string");
                    return {
                        content: [
                            {
                                arguments: { workspace_id: workspaceId },
                                id: "archive-child-workspace",
                                name: "archive_workspace",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                parentSessionId ??= sessionId;
                if (lastText.includes("Archive completed delegated work.")) {
                    return {
                        content: [
                            {
                                arguments: { cmd: initializeRepositoryCommand },
                                id: "initialize-repository",
                                name: "exec_command",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (lastMessage?.role === "toolResult") {
                    if (lastMessage.toolName === "exec_command") {
                        return {
                            content: [
                                {
                                    arguments: { base_ref: "HEAD", name: "Archived child" },
                                    id: "create-archived-child-workspace",
                                    name: "create_workspace",
                                    type: "toolCall",
                                },
                            ],
                        };
                    }
                    if (lastMessage.toolName === "create_workspace") {
                        workspaceId = (JSON.parse(lastText) as { id: string }).id;
                        return {
                            content: [
                                {
                                    arguments: {
                                        background: true,
                                        context: "task",
                                        description: "Archived child",
                                        model: "openai/gym",
                                        prompt: "ARCHIVED_CHILD_TASK",
                                        reasoning_effort: "off",
                                        read_only: true,
                                        workspace_id: workspaceId,
                                    },
                                    id: "spawn-archived-child",
                                    name: "spawn_workspace_agent",
                                    type: "toolCall",
                                },
                            ],
                        };
                    }
                    if (lastMessage.toolName === "spawn_workspace_agent") {
                        return {
                            content: [{ text: "ARCHIVED_CHILD_STARTED", type: "text" }],
                        };
                    }
                    if (lastMessage.toolName === "archive_workspace") {
                        workspaceArchived = true;
                        return {
                            content: [
                                {
                                    arguments: {},
                                    id: "list-after-archive",
                                    name: "list_agents",
                                    namespace: "collaboration",
                                    type: "toolCall",
                                },
                            ],
                        };
                    }
                    if (lastMessage.toolName === "list_agents") {
                        const result = JSON.parse(lastText) as { agents: readonly unknown[] };
                        if (result.agents.length !== 0) {
                            return {
                                content: [{ text: "ARCHIVED_AGENT_STILL_LISTED", type: "text" }],
                            };
                        }
                        return {
                            content: [
                                {
                                    arguments: { timeout_ms: 60_000 },
                                    id: "wait-after-archive",
                                    name: "wait_agent",
                                    namespace: "collaboration",
                                    type: "toolCall",
                                },
                            ],
                        };
                    }
                    if (lastMessage.toolName === "wait_agent" && workspaceArchived) {
                        const result = JSON.parse(lastText) as {
                            agents: readonly unknown[];
                            timed_out: boolean;
                        };
                        expect(result).toMatchObject({ agents: [], timed_out: false });
                        return {
                            content: [{ text: "ARCHIVED_AGENT_IGNORED", type: "text" }],
                        };
                    }
                }

                throw new Error(`Unexpected inference request: ${lastText}`);
            },
            mode: "docker",
            rows: 30,
        });
        running.add(gym);

        gym.terminal.type("Archive completed delegated work.");
        gym.terminal.press("enter");

        const finished = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("ARCHIVED_AGENT_IGNORED") ||
                snapshot.text.includes("ARCHIVED_AGENT_STILL_LISTED"),
            "the archived child to be checked through collaboration tools",
            60_000,
        );
        expect(finished.text).toContain("ARCHIVED_AGENT_IGNORED");
        expect(finished.text).not.toContain("ARCHIVED_AGENT_STILL_LISTED");
    }, 120_000);
});

function messageText(message: { content?: unknown } | undefined): string {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (block): block is { text: string; type: "text" } =>
                typeof block === "object" &&
                block !== null &&
                "type" in block &&
                block.type === "text" &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("");
}

const initializeRepositoryCommand = [
    "git init -q",
    "git config user.email gym@example.test",
    "git config user.name 'Rig Gym'",
    "git add README.md",
    "git commit -q -m Initial",
].join(" && ");
