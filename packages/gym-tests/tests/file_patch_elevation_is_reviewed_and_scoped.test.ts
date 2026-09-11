import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<Gym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("explicit patch elevation", () => {
    it.each(["auto-allow", "auto-deny", "read_only", "workspace_write"] as const)(
        "enforces %s and restores the next call's boundary",
        async (mode) => {
            let mainCalls = 0;
            const reviews: string[] = [];
            const gym = await createGym({
                mode: "docker",
                permissionMode: mode === "auto-allow" || mode === "auto-deny" ? "auto" : mode,
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
                                    text: `<review><outcome>${mode === "auto-allow" ? "allow" : "deny"}</outcome><risk_level>medium</risk_level><user_authorization>high</user_authorization><rationale>Scripted file change review.</rationale></review>`,
                                },
                            ],
                        };
                    }
                    mainCalls += 1;
                    if (mainCalls === 1)
                        return {
                            content: [
                                {
                                    type: "toolCall",
                                    id: "elevated-patch",
                                    name: "apply_patch",
                                    arguments: {
                                        patch: "*** Begin Patch\n*** Add File: .git/elevation-test.txt\n+approved\n*** End Patch",
                                        sandbox_permissions: "require_escalated",
                                        justification:
                                            "Create the explicitly requested Git-control fixture.",
                                    },
                                },
                            ],
                        };
                    if (mainCalls === 2)
                        return {
                            content: [
                                {
                                    type: "toolCall",
                                    id: "sandbox-restored",
                                    name: "exec_command",
                                    arguments: { cmd: "printf leaked > .git/unreviewed.txt" },
                                },
                            ],
                        };
                    return { content: [{ type: "text", text: "FILE_ELEVATION_FINISHED" }] };
                },
            });
            running.add(gym);
            gym.terminal.type(
                "Create .git/elevation-test.txt containing approved. I authorize Full access for that file change only.",
            );
            gym.terminal.press("enter");
            await gym.terminal.waitForText("FILE_ELEVATION_FINISHED", 30_000);
            if (mode === "auto-allow")
                await expect(gym.readFile(".git/elevation-test.txt")).resolves.toBe("approved\n");
            else await expect(gym.readFile(".git/elevation-test.txt")).rejects.toThrow();
            await expect(gym.readFile(".git/unreviewed.txt")).rejects.toThrow();
            expect(reviews).toHaveLength(mode.startsWith("auto") ? 1 : 0);
            if (reviews.length > 0) {
                expect(reviews[0]).toContain("unrestricted filesystem access");
                expect(reviews[0]).toContain(
                    "Create the explicitly requested Git-control fixture.",
                );
            }
        },
        60_000,
    );
});
