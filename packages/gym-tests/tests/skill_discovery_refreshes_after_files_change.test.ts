import { createGym } from "@slopus/happy-terminal-gym";
import { describe, expect, it } from "vitest";

describe("skill discovery after filesystem changes", () => {
    it("uses the new skill catalog on a following turn without restarting", async () => {
        const gym = await createGym({
            files: {
                ".agents/skills/review/SKILL.md":
                    "---\nname: review\ndescription: INITIAL_SKILL_DESCRIPTION\n---\nReview instructions.",
                "updated-skill.md":
                    "---\nname: audit\ndescription: UPDATED_SKILL_DESCRIPTION\n---\nAudit instructions.",
            },
            inference(request, callIndex) {
                if (callIndex === 0) {
                    expect(request.context.systemPrompt).toContain("INITIAL_SKILL_DESCRIPTION");
                    return {
                        content: [
                            {
                                type: "toolCall",
                                id: "update-skill",
                                name: "exec_command",
                                arguments: {
                                    cmd: "cp updated-skill.md .agents/skills/review/SKILL.md",
                                },
                            },
                        ],
                    };
                }
                if (callIndex === 1)
                    return { content: [{ type: "text", text: "SKILL_FILE_UPDATED" }] };
                expect(request.context.systemPrompt).toContain("UPDATED_SKILL_DESCRIPTION");
                expect(request.context.systemPrompt).not.toContain("INITIAL_SKILL_DESCRIPTION");
                return { content: [{ type: "text", text: "FRESH_SKILL_CATALOG_CONFIRMED" }] };
            },
        });
        try {
            gym.terminal.type("Replace the review skill with updated-skill.md.");
            gym.terminal.press("enter");
            await gym.terminal.waitForText("SKILL_FILE_UPDATED", 30_000);
            expect(await gym.readFile(".agents/skills/review/SKILL.md")).toContain(
                "UPDATED_SKILL_DESCRIPTION",
            );
            await gym.terminal.waitForText("Ask Happy Terminal to do anything");
            gym.terminal.type("Check the current skills again.");
            gym.terminal.press("enter");
            await gym.terminal.waitForText("FRESH_SKILL_CATALOG_CONFIRMED", 30_000);
        } finally {
            await gym.dispose();
        }
    }, 60_000);
});
