import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { claudeCodeRouterRoutes } from "../../sources/providerRoutes/impl/claudeCodeRouterRoutes.js";

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true })));
});

/** A throwaway home holding a fake Claude Code Router configuration with fake keys. */
async function home(config: unknown, env: Record<string, string> = {}) {
    const path = await mkdtemp(join(tmpdir(), "ccr-"));
    homes.push(path);
    await mkdir(join(path, ".claude-code-router"));
    await writeFile(
        join(path, ".claude-code-router", "config.json"),
        typeof config === "string" ? config : JSON.stringify(config),
    );
    return { platform: process.platform, env: { HOME: path, ...env }, programDirectories: [] };
}

describe("Claude Code Router's upstream providers", () => {
    it("offers each OpenAI-compatible upstream directly, copying or referencing its key", async () => {
        const routes = await claudeCodeRouterRoutes(
            await home(
                {
                    APIKEY: "router-client-key",
                    PORT: 3456,
                    Providers: [
                        {
                            name: "openrouter",
                            api_base_url: "https://openrouter.ai/api/v1/chat/completions",
                            api_key: "sk-or-fake",
                            models: ["openai/gpt-6.1-terra"],
                            transformer: { use: ["openrouter"] },
                        },
                        {
                            name: "deepseek",
                            api_base_url: "https://api.deepseek.com/chat/completions",
                            api_key: "$DEEPSEEK_API_KEY",
                            models: ["deepseek-chat"],
                        },
                        {
                            name: "ollama",
                            api_base_url: "http://localhost:11434/v1/chat/completions",
                            api_key: "ollama",
                            models: ["qwen3-coder:30b"],
                        },
                        {
                            name: "gemini",
                            api_base_url:
                                "https://generativelanguage.googleapis.com/v1beta/models/",
                            api_key: "gemini-fake",
                            models: ["gemini-3-pro"],
                        },
                    ],
                    Router: { default: "openrouter,openai/gpt-6.1-terra" },
                },
                { DEEPSEEK_API_KEY: "sk-ds-fake" },
            ),
        );

        expect(routes.map((route) => [route.id, route.billing, route.endpoint])).toEqual([
            ["ccr:openrouter", "pay_per_token", null],
            ["ccr:deepseek", "pay_per_token", null],
            ["ccr:ollama", "local", "http://localhost:11434/v1"],
            ["ccr:gemini", "pay_per_token", null],
        ]);
        expect(routes[0]).toMatchObject({
            kind: "router",
            name: "OpenRouter from Claude Code Router",
            vendors: ["OpenRouter"],
            models: [{ id: "openai/gpt-6.1-terra", vendor: "OpenRouter" }],
            provider: {
                id: "ccr_openrouter",
                table: {
                    type: "openai_compatible",
                    name: "OpenRouter",
                    base_url: "https://openrouter.ai/api/v1",
                    api_key: "sk-or-fake",
                    models: ["openai/gpt-6.1-terra"],
                },
            },
        });
        // A key the router reads from a variable stays a reference.
        expect(routes[1]?.provider?.table).toMatchObject({ api_key_env: "DEEPSEEK_API_KEY" });
        expect(routes[1]?.provider?.table).not.toHaveProperty("api_key");
        // Gemini's own protocol is not OpenAI-compatible, so it is shown but cannot be added.
        expect(routes[3]).not.toHaveProperty("provider");
    });

    it("cannot add an upstream whose key variable the daemon does not have", async () => {
        const routes = await claudeCodeRouterRoutes(
            await home({
                Providers: [
                    {
                        name: "deepseek",
                        api_base_url: "https://api.deepseek.com/chat/completions",
                        api_key: "${DEEPSEEK_API_KEY}",
                        models: ["deepseek-chat"],
                    },
                ],
            }),
        );
        expect(routes).toHaveLength(1);
        expect(routes[0]).not.toHaveProperty("provider");
    });

    it("finds nothing without a configuration, or in one it cannot read", async () => {
        const empty = await mkdtemp(join(tmpdir(), "ccr-"));
        homes.push(empty);
        await expect(
            claudeCodeRouterRoutes({
                platform: process.platform,
                env: { HOME: empty },
                programDirectories: [],
            }),
        ).resolves.toEqual([]);
        await expect(claudeCodeRouterRoutes(await home("{ not json"))).resolves.toEqual([]);
        await expect(claudeCodeRouterRoutes(await home({ Providers: "nope" }))).resolves.toEqual(
            [],
        );
    });
});
