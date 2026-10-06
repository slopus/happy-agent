import { describe, expect, it } from "vitest";
import { systemPromptForModel } from "../../sources/systemPrompt/impl/systemPromptForModel.js";

describe("Bedrock model harness prompts", () => {
    it("selects Kimi Code's prompt for K3 independently of the reseller account", () => {
        const prompt = systemPromptForModel({
            model: "moonshotai/kimi-k3",
            providerKind: "bedrock",
        });
        expect(prompt).toContain(
            "Your primary goal is to help users with software engineering tasks.",
        );
        expect(prompt).toContain("Match the user's language.");
        expect(prompt).toContain("Context management");
        expect(prompt).toContain("{{identity}}");
        expect(prompt).not.toContain("${");
        expect(prompt).not.toContain("The environment is not a sandbox");
        expect(prompt).not.toContain("plugin_sections");
        expect(prompt).not.toBe(systemPromptForModel({ providerKind: "codex" }));
    });

    it("selects the documented Claude Code non-Claude base for GLM 5.3", () => {
        const prompt = systemPromptForModel({ model: "zai/glm-5.3", providerKind: "bedrock" });
        expect(prompt).toContain("{{identity}}");
        expect(prompt).toContain("# Harness");
        expect(prompt).toContain("Prefer the dedicated file/search tools");
        expect(prompt).not.toContain("Hooks may intercept");
        expect(prompt).not.toContain("You are Claude");
        expect(prompt).not.toBe(systemPromptForModel({ providerKind: "claude" }));
    });
});
