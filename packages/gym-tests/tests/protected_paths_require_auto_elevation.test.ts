import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("project protected paths", () => {
    it("elevates existing paths in Auto and excludes missing paths", async () => {
        let permissionReviews = 0;
        const gym = await createGym({
            files: {
                "AGENTS_SECURITY.md": "",
                "happy.toml": [
                    "[permissions]",
                    'protected_paths = ["plans", "missing.txt"]',
                    "",
                ].join("\n"),
                "plans/locked.md": "before\n",
            },
            inference(request, callIndex) {
                if (
                    request.context.systemPrompt?.includes(
                        "judging one planned coding-agent action",
                    )
                ) {
                    permissionReviews += 1;
                    return {
                        content: [
                            {
                                text: JSON.stringify({
                                    outcome: "allow",
                                    rationale: "The user requested this project edit.",
                                    risk_level: "medium",
                                    user_authorization: "high",
                                }),
                                type: "text",
                            },
                        ],
                    };
                }

                if (callIndex === 0) {
                    expect(request.context.systemPrompt).toContain("/workspace/plans");
                    expect(request.context.systemPrompt).not.toContain("/workspace/missing.txt");
                    return applyPatch(
                        "edit-protected-path",
                        [
                            "*** Begin Patch",
                            "*** Update File: plans/locked.md",
                            "@@",
                            "-before",
                            "+protected edit",
                            "*** End Patch",
                        ].join("\n"),
                    );
                }

                const result = request.context.messages.at(-1);
                if (result?.role === "toolResult" && result.isError) {
                    throw new Error(`apply_patch failed: ${messageText(result)}`);
                }
                expect(result).toMatchObject({
                    isError: false,
                    role: "toolResult",
                    toolName: "apply_patch",
                });
                return { content: [{ text: "PROTECTED_PATHS_COMPLETE", type: "text" }] };
            },
            permissionMode: "auto",
        });
        running.add(gym);

        gym.terminal.type("Apply both requested project edits.");
        gym.terminal.press("enter");

        const completed = await gym.terminal.waitForText("PROTECTED_PATHS_COMPLETE", 30_000);
        expect(completed.text).toContain("Approved automatically: temporary Full access.");
        expect(permissionReviews).toBe(1);
        await expect(gym.readFile("plans/locked.md")).resolves.toBe("protected edit\n");
        await expect(gym.readFile("missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
    }, 120_000);
});

function applyPatch(id: string, patch: string) {
    return {
        content: [
            {
                arguments: { patch, workdir: "/workspace" },
                id,
                name: "apply_patch",
                type: "toolCall" as const,
            },
        ],
    };
}

function messageText(message: { content: unknown } | undefined): string {
    if (typeof message?.content === "string") return message.content;
    if (!Array.isArray(message?.content)) return "";
    return message.content
        .filter(
            (block): block is { text: string } =>
                typeof block === "object" &&
                block !== null &&
                "text" in block &&
                typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n");
}
