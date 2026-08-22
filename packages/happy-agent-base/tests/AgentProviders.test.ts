import type { BaseProvider } from "@slopus/happy-providers";
import { describe, expect, it } from "vitest";

import { AgentProviders } from "../sources/index.js";

function provider(): BaseProvider {
    return {
        session: () => Promise.reject(new Error("Not implemented.")),
    } as unknown as BaseProvider;
}

describe("AgentProviders", () => {
    it("resolves registered static providers by ID", async () => {
        const codex = provider();
        const claude = provider();
        const providers = new AgentProviders();
        providers.add("codex", codex, "codex");
        providers.add("claude", claude, "claude");

        await expect(providers.resolve("codex", "openai/gpt")).resolves.toBe(codex);
        await expect(providers.resolve("claude", "anthropic/claude")).resolves.toBe(claude);
        expect(providers.typeOf("codex")).toBe("codex");
        expect(providers.typeOf("claude")).toBe("claude");
        expect(providers.ids).toEqual(["codex", "claude"]);
    });

    it("resolves a factory with its provider ID and selected model", async () => {
        const bedrockClaude = provider();
        const bedrockCodex = provider();
        const selections: unknown[] = [];
        const providers = new AgentProviders();
        providers.add(
            "bedrock",
            async (selection) => {
                selections.push(selection);
                return selection.model?.startsWith("anthropic/") ? bedrockClaude : bedrockCodex;
            },
            "bedrock",
        );

        await expect(providers.resolve("bedrock", "anthropic/claude")).resolves.toBe(bedrockClaude);
        await expect(providers.resolve("bedrock", "openai/gpt")).resolves.toBe(bedrockCodex);
        expect(selections).toEqual([
            { id: "bedrock", model: "anthropic/claude" },
            { id: "bedrock", model: "openai/gpt" },
        ]);
        expect(providers.typeOf("bedrock")).toBe("bedrock");
    });

    it("returns null when resolving an unknown provider", async () => {
        const providers = new AgentProviders();

        await expect(providers.resolve("missing", "openai/gpt")).resolves.toBeNull();
        expect(providers.typeOf("missing")).toBeNull();
    });

    it("retries a provider factory after a failed resolution", async () => {
        const resolved = provider();
        let attempts = 0;
        const providers = new AgentProviders();
        providers.add(
            "bedrock",
            () => {
                attempts += 1;
                if (attempts === 1) throw new Error("Route is temporarily unavailable.");
                return resolved;
            },
            "bedrock",
        );

        await expect(providers.resolve("bedrock", "anthropic/claude")).rejects.toThrow(
            "Route is temporarily unavailable.",
        );
        await expect(providers.resolve("bedrock", "anthropic/claude")).resolves.toBe(resolved);
        expect(attempts).toBe(2);
    });

    it("adds and removes provider sources on the fly", async () => {
        const providers = new AgentProviders();
        const grok = provider();

        providers.add("grok", grok, "grok");
        await expect(providers.resolve("grok", "grok/grok")).resolves.toBe(grok);

        expect(providers.remove("grok")).toBe(true);
        await expect(providers.resolve("grok", "grok/grok")).resolves.toBeNull();
        expect(providers.remove("grok")).toBe(false);
    });

    it("allows one provider instance under several IDs but rejects duplicate IDs", async () => {
        const shared = provider();
        const providers = new AgentProviders();
        providers.add("codex", shared, "codex");
        providers.add("bulka_codex", shared, "codex");

        await expect(providers.resolve("codex", "openai/gpt")).resolves.toBe(shared);
        await expect(providers.resolve("bulka_codex", "openai/gpt")).resolves.toBe(shared);
        expect(() => {
            providers.add("codex", provider(), "codex");
        }).toThrowError('Provider "codex" is already registered.');
    });

    it("groups named native accounts by provider type", async () => {
        const providers = new AgentProviders();
        providers.add("personal-claude", provider(), "claude");
        providers.add("work-codex", provider(), "codex");
        providers.add("team-grok", provider(), "grok");

        await expect(
            providers.contextCompatibilityKeyOf("personal-claude", "anthropic/opus"),
        ).resolves.toBe("claude");
        await expect(providers.contextCompatibilityKeyOf("work-codex", "openai/sol")).resolves.toBe(
            "codex",
        );
        await expect(providers.contextCompatibilityKeyOf("team-grok", "xai/build")).resolves.toBe(
            "grok",
        );
    });

    it("groups Bedrock GPT by resolved region and other Bedrock models together", async () => {
        const providers = new AgentProviders();
        providers.add(
            "work-bedrock",
            Object.assign(provider(), { region: " us-west-2 " }),
            "bedrock",
        );

        await expect(
            providers.contextCompatibilityKeyOf("work-bedrock", "openai/sol"),
        ).resolves.toBe("bedrock:us-west-2");
        await expect(
            providers.contextCompatibilityKeyOf("work-bedrock", "anthropic/opus"),
        ).resolves.toBe("bedrock");
    });

    it("isolates Bedrock GPT accounts whose resolved region is unavailable", async () => {
        const providers = new AgentProviders();
        providers.add("work-bedrock", provider(), "bedrock");

        await expect(
            providers.contextCompatibilityKeyOf("work-bedrock", "openai/sol"),
        ).resolves.toBe("bedrock-provider:work-bedrock");
        await expect(
            providers.contextCompatibilityKeyOf("missing", "openai/sol"),
        ).resolves.toBeNull();
    });
});
