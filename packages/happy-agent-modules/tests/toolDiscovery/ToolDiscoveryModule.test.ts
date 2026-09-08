import { describe, expect, it } from "vitest";

import type { AnthropicBedrockTransport } from "@slopus/happy-providers";

import {
    ToolDiscoveryModule,
    toolDiscoveryTools,
    type ToolDiscoverySelection,
} from "../../sources/toolDiscovery/index.js";
import { testConfig } from "../support/computeModule.js";

const CLAUDE_MODELS = [
    "anthropic/opus-5",
    "anthropic/sonnet-5",
    "anthropic/fable-5-1",
    "anthropic/fable-5",
    "anthropic/opus-4-8",
] as const;

const CODEX_MODELS = [
    "openai/gpt-6-astra",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
] as const;

describe("ToolDiscoveryModule", () => {
    it.each(CLAUDE_MODELS)("selects Claude ToolSearch for %s", (model) => {
        const tools = toolDiscoveryTools({ providerKind: "claude", model });

        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
            name: "ToolSearch",
            server: { type: "ToolSearch" },
            persistInHistory: false,
            visibleToUser: false,
        });
        expect(tools[0]?.defer).toBeUndefined();
    });

    it.each(CODEX_MODELS)("selects Codex client BM25 for %s", (model) => {
        const tools = toolDiscoveryTools({ providerKind: "codex", model });

        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
            name: "tool_search",
            server: {
                type: "tool_search",
                execution: "client",
            },
            persistInHistory: false,
            visibleToUser: false,
        });
        expect(tools[0]?.parameters).toMatchObject({
            type: "object",
            properties: {
                limit: expect.objectContaining({ minimum: 1 }),
                query: expect.objectContaining({ type: "string" }),
            },
        });
        expect(tools[0]?.server?.parameters).toEqual(tools[0]?.parameters);
        expect(tools[0]?.defer).toBeUndefined();
    });

    it.each(CLAUDE_MODELS)("selects hosted regex search for Bedrock Runtime %s", (model) => {
        const selection = {
            providerKind: "bedrock",
            model,
            bedrockTransport: "runtime",
        } satisfies ToolDiscoverySelection & {
            readonly bedrockTransport: AnthropicBedrockTransport;
        };

        const tools = toolDiscoveryTools(selection);

        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
            name: "ToolSearch",
            server: {
                type: "tool_search_tool_regex",
                name: "tool_search_tool_regex",
            },
            persistInHistory: false,
            visibleToUser: false,
        });
        expect(tools[0]?.defer).toBeUndefined();
    });

    it.each([
        { providerKind: "grok" as const, model: "xai/grok-4.6" },
        { providerKind: "gym" as const, model: "openai/gpt-5.6-sol" },
        { providerKind: "bedrock" as const, model: "openai/gpt-5.6-sol" },
        ...CLAUDE_MODELS.map((model) => ({
            providerKind: "bedrock" as const,
            model,
            bedrockTransport: "mantle" as const,
        })),
        { providerKind: "codex" as const, model: "openai/future-model" },
        { providerKind: "claude" as const, model: undefined },
        { providerKind: undefined, model: "openai/gpt-5.6-sol" },
    ])("falls back to eager provider behavior for $providerKind/$model", (selection) => {
        expect(toolDiscoveryTools(selection)).toEqual([]);
    });

    it("exposes its selection through the ordinary module tool hook", async () => {
        const hooks = await new ToolDiscoveryModule(testConfig).beforeStart();
        const tools = await hooks.tools?.(
            {} as never,
            {
                agent: {
                    id: "agent",
                    provider: "account",
                    providerKind: "codex",
                    model: "openai/gpt-5.6-sol",
                    effort: "medium",
                    tier: undefined,
                    permissionMode: "auto",
                    metadata: undefined,
                },
            } as never,
        );

        expect(tools).toEqual([
            expect.objectContaining({ name: "tool_search", visibleToUser: false }),
        ]);
    });
});
