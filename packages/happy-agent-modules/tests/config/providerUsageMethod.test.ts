import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "provider-usage-method-"));
    roots.push(root);
    return root;
}

/** Answers both Claude usage methods and records which one each read used. */
function stubClaude(): string[] {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        paths.push(path);
        if (path === "/api/oauth/usage") return Response.json({ five_hour: { utilization: 42 } });
        if (path === "/api/oauth/profile") return Response.json({});
        return Response.json(
            {},
            {
                headers: {
                    "anthropic-ratelimit-unified-status": "allowed",
                    "anthropic-ratelimit-unified-5h-utilization": "0.25",
                },
            },
        );
    });
    return paths;
}

describe("provider usage method", () => {
    it("measures a configured setup token from inference headers, never the usage endpoint", async () => {
        const config = await testConfigRootedAt(
            await directory(),
            ["[providers.claude]", "enabled = true", 'oauth_token = "setup-token"'].join("\n"),
        );
        const paths = stubClaude();

        const usage = await config.readProviderUsage(createRootContext(), "claude");

        expect(usage?.windows.fiveHour?.usedPercent).toBe(25);
        expect(paths).toEqual(["/v1/messages"]);
    });

    it("asks a stored login's endpoint unless the caller skips it", async () => {
        const login = await directory();
        await writeFile(
            join(login, ".credentials.json"),
            JSON.stringify({
                claudeAiOauth: { accessToken: "login", scopes: ["user:inference", "user:profile"] },
            }),
        );
        const config = await testConfigRootedAt(
            await directory(),
            [
                "[providers.claude]",
                "enabled = true",
                "credential_isolation = true",
                `config_dir = ${JSON.stringify(login)}`,
            ].join("\n"),
        );
        const paths = stubClaude();
        const ctx = createRootContext();

        await config.readProviderUsage(ctx, "claude");
        await config.readProviderUsage(ctx, "claude", { skipUsageEndpoint: true });

        expect(paths).toEqual(["/api/oauth/usage", "/api/oauth/profile", "/v1/messages"]);
    });

    it("measures a config_dir account through the gateway its Claude Code settings name", async () => {
        const claudeHome = await directory();
        await writeFile(
            join(claudeHome, "settings.json"),
            JSON.stringify({
                env: {
                    ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
                    ANTHROPIC_AUTH_TOKEN: "gateway-token",
                    ANTHROPIC_DEFAULT_HAIKU_MODEL: "gateway-haiku",
                },
            }),
        );
        const config = await testConfigRootedAt(
            await directory(),
            [
                "[providers.gateway]",
                'type = "claude"',
                "enabled = true",
                `config_dir = ${JSON.stringify(claudeHome)}`,
            ].join("\n"),
        );
        const requests: unknown[] = [];
        vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
            requests.push({
                url: String(input),
                authorization: new Headers(init?.headers).get("authorization"),
                model: (JSON.parse(String(init?.body)) as { model: string }).model,
            });
            return Response.json(
                {},
                {
                    headers: {
                        "anthropic-ratelimit-unified-status": "allowed",
                        "anthropic-ratelimit-unified-5h-utilization": "0.25",
                    },
                },
            );
        });

        const usage = await config.readProviderUsage(createRootContext(), "gateway");

        expect(requests).toEqual([
            {
                url: "https://gateway.example/anthropic/v1/messages",
                authorization: "Bearer gateway-token",
                model: "gateway-haiku",
            },
        ]);
        expect(usage?.windows.fiveHour?.usedPercent).toBe(25);
    });

    it("measures an account at the base_url its happy.toml table names", async () => {
        const config = await testConfigRootedAt(
            await directory(),
            [
                "[providers.claude]",
                "enabled = true",
                "credential_isolation = true",
                'oauth_token = "setup-token"',
                'base_url = "https://configured.example/anthropic"',
            ].join("\n"),
        );
        const urls: string[] = [];
        vi.stubGlobal("fetch", async (input: string | URL | Request) => {
            urls.push(String(input));
            return Response.json(
                {},
                {
                    headers: {
                        "anthropic-ratelimit-unified-status": "allowed",
                        "anthropic-ratelimit-unified-5h-utilization": "0.25",
                    },
                },
            );
        });

        await config.readProviderUsage(createRootContext(), "claude");

        expect(urls).toEqual(["https://configured.example/anthropic/v1/messages"]);
    });

    it("knows which accounts have any usage source to ask", async () => {
        const config = await testConfigRootedAt(
            await directory(),
            [
                "[providers.claude]",
                "enabled = true",
                "[providers.keyed]",
                'type = "codex"',
                "enabled = true",
                'api_key = "sk-test"',
                "[providers.bedrock]",
                "enabled = true",
                "[providers.off]",
                'type = "grok"',
                "enabled = false",
            ].join("\n"),
        );

        expect(config.hasProviderUsageSource("claude")).toBe(true);
        expect(config.hasProviderUsageSource("keyed")).toBe(false);
        expect(config.hasProviderUsageSource("bedrock")).toBe(false);
        expect(config.hasProviderUsageSource("off")).toBe(false);
        expect(config.hasProviderUsageSource("missing")).toBe(false);
    });
});
