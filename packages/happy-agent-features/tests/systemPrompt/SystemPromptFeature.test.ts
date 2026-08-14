import type { AgentFeatureAgent, AgentFeatureScope } from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { SystemPromptFeature } from "../../sources/systemPrompt/SystemPromptFeature.js";

const ctx: Context = createRootContext();

/** A scope naming only what the feature reads: which model the agent is running on. */
function scopeOf(
    model: string | undefined,
    providerKind: ProviderModelCompatibilityType | undefined,
): AgentFeatureScope {
    const agent: AgentFeatureAgent = {
        effort: undefined,
        id: "agent",
        metadata: undefined,
        model,
        permissionMode: "auto",
        provider: "provider",
        providerKind,
        tier: undefined,
    };
    return { agent } as AgentFeatureScope;
}

describe("SystemPromptFeature", () => {
    it("gives each model the prompt it was written for", () => {
        const feature = new SystemPromptFeature();

        const opus5 = feature.instructions(ctx, scopeOf("anthropic/opus-5", "claude"));
        const opus48 = feature.instructions(ctx, scopeOf("anthropic/opus-4-8", "claude"));
        const codex = feature.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex"));

        expect(opus5).toContain("mid-conversation system turns");
        expect(opus48).not.toContain("mid-conversation system turns");
        expect(opus5).not.toBe(opus48);
        expect(codex).not.toBe(opus5);
        expect(codex.length).toBeGreaterThan(0);
    });

    it("follows the model rather than the provider it is served through", () => {
        const feature = new SystemPromptFeature();

        expect(feature.instructions(ctx, scopeOf("anthropic/opus-5", "bedrock"))).toBe(
            feature.instructions(ctx, scopeOf("anthropic/opus-5", "claude")),
        );
        expect(feature.instructions(ctx, scopeOf("xai/grok-build", "grok"))).toBe(
            feature.instructions(ctx, scopeOf("xai/grok-4.5", "grok")),
        );
    });

    it("falls back to the provider's family when the model is unknown or absent", () => {
        const feature = new SystemPromptFeature();

        expect(feature.instructions(ctx, scopeOf("openai/gpt-9-unreleased", "codex"))).toBe(
            feature.instructions(ctx, scopeOf("openai/gpt-5.6-sol", "codex")),
        );
        expect(feature.instructions(ctx, scopeOf(undefined, "grok"))).toBe(
            feature.instructions(ctx, scopeOf("xai/grok-4.5", "grok")),
        );
    });

    it("falls back to the simple prompt when nothing was written for the model", () => {
        const feature = new SystemPromptFeature();

        const unknown = feature.instructions(ctx, scopeOf("mystery/model", "gym"));

        expect(unknown).toContain("You are an expert coding assistant.");
        expect(unknown.startsWith("You are Rig, built by Happy")).toBe(true);
        expect(feature.instructions(ctx, scopeOf(undefined, undefined))).toBe(unknown);
    });

    it("substitutes the identity it was built with", () => {
        const named = new SystemPromptFeature({
            identity: { name: "Scout", prompt: "You are Scout, built by Happy" },
        });

        const prompt = named.instructions(ctx, scopeOf("anthropic/opus-5", "claude"));

        expect(prompt.startsWith("You are Scout, built by Happy")).toBe(true);
        expect(prompt).not.toContain("{{identity}}");
        expect(prompt).not.toContain("{{name}}");
    });

    it("names Rig when the host names nobody", () => {
        const prompt = new SystemPromptFeature().instructions(
            ctx,
            scopeOf("anthropic/opus-5", "claude"),
        );

        expect(prompt.startsWith("You are Rig, built by Happy")).toBe(true);
    });
});
