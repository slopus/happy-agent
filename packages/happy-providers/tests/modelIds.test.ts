import { describe, expect, it } from "vitest";

import { resolveBedrockModelId } from "@/vendors/bedrock/impl/resolveBedrockModelId.js";
import { resolveClaudeModelId } from "@/vendors/claude/impl/resolveClaudeModelId.js";
import { resolveCodexModelId } from "@/vendors/codex/impl/resolveCodexModelId.js";
import { resolveCodexSessionModelId } from "@/vendors/codex/impl/resolveCodexSessionModelId.js";
import { resolveGrokModelId } from "@/vendors/grok/impl/resolveGrokModelId.js";

describe("Rig model IDs", () => {
    it.each([
        [resolveClaudeModelId, "anthropic/sonnet-5", "claude-sonnet-5[1m]"],
        [resolveClaudeModelId, "anthropic/fable-5-1", "claude-fable-5-1"],
        [resolveClaudeModelId, "anthropic/fable-5", "claude-fable-5[1m]"],
        [resolveClaudeModelId, "anthropic/opus-5", "claude-opus-5[1m]"],
        [resolveClaudeModelId, "anthropic/opus-4-8", "claude-opus-4-8[1m]"],
        [resolveBedrockModelId, "anthropic/opus-5", "anthropic.claude-opus-5"],
        [resolveCodexModelId, "openai/gpt-6-astra", "gpt-6-astra"],
        [resolveCodexModelId, "openai/gpt-5.6-sol", "gpt-5.6-sol"],
        [resolveGrokModelId, "xai/grok-4.6", "grok-4.6"],
        [resolveGrokModelId, "xai/grok-4.5", "grok-4.5"],
        [resolveBedrockModelId, "anthropic/sonnet-5", "anthropic.claude-sonnet-5"],
        [resolveBedrockModelId, "openai/gpt-5.6-sol", "openai.gpt-5.6-sol"],
    ])("resolves %s", (resolve, modelId, expected) => {
        expect(resolve(modelId)).toBe(expected);
    });

    it("leaves native model IDs unchanged", () => {
        expect(resolveCodexModelId("custom-model")).toBe("custom-model");
    });

    it("maps Codex session model IDs to the credential's wire form", () => {
        // Bedrock keeps the dotted v1 id so tools ship over the v1 contract; native
        // Codex uses the bare v2 name.
        expect(resolveCodexSessionModelId("openai/gpt-5.6-sol", true)).toBe("openai.gpt-5.6-sol");
        expect(resolveCodexSessionModelId("openai/gpt-5.6-sol", false)).toBe("gpt-5.6-sol");
    });
});
