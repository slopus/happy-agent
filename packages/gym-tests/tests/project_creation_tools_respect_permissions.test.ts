import { join } from "node:path";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<Gym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe.each(["create_project", "clone_project"] as const)(
    "%s through the terminal",
    (toolName) => {
        it.each([
            "read_only",
            "workspace_write",
            "auto-deny",
            "auto-allow",
            "full_access",
        ] as const)(
            "enforces %s and leaves the catalog usable",
            async (mode) => {
                const permissionMode =
                    mode === "auto-allow" || mode === "auto-deny" ? "auto" : mode;
                let mainCalls = 0;
                let projectPath = "";
                const reviews: string[] = [];
                const gym = await createGym({
                    permissionMode,
                    files: { "imported-project/README.md": "A plain local project.\n" },
                    inference(request) {
                        if (
                            request.context.systemPrompt?.includes(
                                "You are judging one planned coding-agent action.",
                            )
                        ) {
                            reviews.push(JSON.stringify(request.context));
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `<review><outcome>${mode === "auto-allow" ? "allow" : "deny"}</outcome><risk_level>medium</risk_level><user_authorization>high</user_authorization><rationale>Scripted project registration review.</rationale></review>`,
                                    },
                                ],
                            };
                        }
                        mainCalls += 1;
                        if (mainCalls === 1) {
                            return {
                                content: [
                                    {
                                        type: "toolCall",
                                        id: "create-project",
                                        name: toolName,
                                        arguments:
                                            toolName === "create_project"
                                                ? { path: projectPath }
                                                : {
                                                      name: "imported-project",
                                                      source: {
                                                          kind: "github",
                                                          repository: "example/private-gym-project",
                                                      },
                                                      // The isolated gym has no GitHub credential. Provisioning must fail
                                                      // locally without contacting a real repository or using host secrets.
                                                      secret: { kind: "github" },
                                                  },
                                    },
                                ],
                            };
                        }
                        if (mainCalls === 2) {
                            return {
                                content: [
                                    {
                                        type: "toolCall",
                                        id: "list-after-registration",
                                        name: "list_projects",
                                        arguments: {},
                                    },
                                ],
                            };
                        }
                        return {
                            content: [{ type: "text", text: "PROJECT_REGISTRATION_FINISHED" }],
                        };
                    },
                });
                running.add(gym);
                projectPath = join(gym.workspacePath, "imported-project");
                gym.terminal.type(
                    toolName === "create_project"
                        ? "Register the imported-project folder as a Happy project, then list projects."
                        : "Import example/private-gym-project from GitHub as imported-project using the configured GitHub credential, then list projects.",
                );
                gym.terminal.press("enter");
                await gym.terminal.waitForText("PROJECT_REGISTRATION_FINISHED", 30_000);

                const results = gym.inference.requests
                    .flatMap((request) => request.context.messages)
                    .filter((message) => message.role === "tool");
                const text = JSON.stringify(results);
                const allowed = mode === "auto-allow" || mode === "full_access";
                const success =
                    toolName === "create_project" ? "Project registered:" : "Project import:";
                const catalog = JSON.stringify(results.at(-1));
                if (allowed) {
                    expect(text).toContain(success);
                    expect(catalog).toContain("imported-project");
                } else {
                    expect(text).not.toContain(success);
                    expect(catalog).not.toContain("imported-project");
                    expect(text).toMatch(
                        mode === "auto-deny" ? /denied|permission/i : /acts outside the sandbox/,
                    );
                }
                expect(reviews).toHaveLength(permissionMode === "auto" ? 1 : 0);
                if (reviews.length > 0) {
                    expect(reviews[0]).toContain(
                        toolName === "create_project"
                            ? join(gym.workspacePath, "imported-project")
                            : "https://github.com/example/private-gym-project",
                    );
                    expect(reviews[0]).toContain("outside the current workspace");
                    if (toolName === "clone_project") {
                        expect(reviews[0]).toContain("configured GitHub credential");
                        expect(reviews[0]).toContain("external Git network access");
                    }
                }
                await expect(gym.readFile("imported-project/README.md")).resolves.toBe(
                    "A plain local project.\n",
                );
            },
            60_000,
        );
    },
);
