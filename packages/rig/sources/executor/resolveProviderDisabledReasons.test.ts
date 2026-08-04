import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigProviders } from "../config/types.js";
import { resolveProviderDisabledReasons } from "./resolveProviderDisabledReasons.js";

const GROK_OAUTH_SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const tempDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("resolveProviderDisabledReasons", () => {
    it("accepts a configured Claude Code OAuth token for a named account", async () => {
        const reasons = await resolveProviderDisabledReasons(
            {
                work_claude: {
                    enabled: true,
                    oauthToken: "claude-work-token",
                    type: "claude",
                },
            },
            {},
        );

        expect(reasons.has("work_claude")).toBe(false);
    });

    it("disables configured providers when their local authentication is absent", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-provider-auth-"));
        tempDirectories.push(root);
        const reasons = await resolveProviderDisabledReasons(providersFor(root), {
            ANTHROPIC_API_KEY: "   ",
            AWS_BEARER_TOKEN_BEDROCK: "   ",
            CLAUDE_CODE_OAUTH_TOKEN: "   ",
            XAI_API_KEY: "   ",
        });

        expect(Object.fromEntries(reasons)).toEqual({
            bedrock: "not_authenticated",
            claude: "not_authenticated",
            codex: "not_authenticated",
            grok: "not_authenticated",
            turned_off: "not_enabled",
        });
    });

    it("accepts credential presence without contacting provider servers", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-provider-auth-"));
        tempDirectories.push(root);
        await writeFile(
            join(root, "codex.json"),
            JSON.stringify({ tokens: { access_token: "codex-token" } }),
        );
        await writeFile(
            join(root, "grok.json"),
            JSON.stringify({ [GROK_OAUTH_SCOPE]: { key: "grok-token" } }),
        );

        const reasons = await resolveProviderDisabledReasons(providersFor(root), {
            ANTHROPIC_API_KEY: "anthropic-key",
            AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
        });

        expect(Object.fromEntries(reasons)).toEqual({ turned_off: "not_enabled" });
    });

    it("accepts an API key stored by the native Codex login", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-provider-auth-"));
        tempDirectories.push(root);
        await writeFile(
            join(root, "codex.json"),
            JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "codex-api-key" }),
        );

        const reasons = await resolveProviderDisabledReasons(
            {
                codex: { authFile: join(root, "codex.json"), enabled: true, type: "codex" },
            },
            {},
        );

        expect(reasons.has("codex")).toBe(false);
    });

    it("accepts the bearer token from the active native Codex provider", async () => {
        const codexHome = await mkdtemp(join(tmpdir(), "rig-codex-home-"));
        tempDirectories.push(codexHome);
        await writeFile(
            join(codexHome, "config.toml"),
            `
model_provider = "balancer"

[model_providers.balancer]
base_url = "https://balancer.example/backend-api/codex"
wire_api = "responses"
experimental_bearer_token = "balancer-token"
`,
        );

        const reasons = await resolveProviderDisabledReasons(
            { codex: { enabled: true, type: "codex" } },
            { CODEX_HOME: codexHome },
        );

        expect(reasons.has("codex")).toBe(false);
    });

    it("does not fall back when the active native Codex provider uses an unsupported wire API", async () => {
        const codexHome = await mkdtemp(join(tmpdir(), "rig-codex-home-"));
        tempDirectories.push(codexHome);
        await Promise.all([
            writeFile(
                join(codexHome, "auth.json"),
                JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "stored-api-key" }),
            ),
            writeFile(
                join(codexHome, "config.toml"),
                `
model_provider = "legacy"

[model_providers.legacy]
base_url = "https://legacy.example/v1"
wire_api = "chat"
experimental_bearer_token = "legacy-token"
`,
            ),
        ]);

        const reasons = await resolveProviderDisabledReasons(
            { codex: { enabled: true, type: "codex" } },
            { CODEX_HOME: codexHome },
        );

        expect(reasons.get("codex")).toBe("not_authenticated");
    });

    it("ignores native provider errors when Rig explicitly overrides the endpoint", async () => {
        const codexHome = await mkdtemp(join(tmpdir(), "rig-codex-home-"));
        tempDirectories.push(codexHome);
        await Promise.all([
            writeFile(
                join(codexHome, "auth.json"),
                JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "stored-api-key" }),
            ),
            writeFile(
                join(codexHome, "config.toml"),
                `
model_provider = "legacy"

[model_providers.legacy]
base_url = "https://legacy.example/v1"
wire_api = "chat"
`,
            ),
        ]);

        const reasons = await resolveProviderDisabledReasons(
            {
                codex: {
                    baseUrl: "https://rig.example/v1",
                    enabled: true,
                    type: "codex",
                },
            },
            { CODEX_HOME: codexHome },
        );

        expect(reasons.has("codex")).toBe(false);
    });

    it("does not expose OpenAI credentials to a native provider that disables OpenAI auth", async () => {
        const codexHome = await mkdtemp(join(tmpdir(), "rig-codex-home-"));
        tempDirectories.push(codexHome);
        await Promise.all([
            writeFile(
                join(codexHome, "auth.json"),
                JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "stored-openai-key" }),
            ),
            writeFile(
                join(codexHome, "config.toml"),
                `
model_provider = "local"

[model_providers.local]
base_url = "https://local.example/v1"
wire_api = "responses"
requires_openai_auth = false
`,
            ),
        ]);

        const reasons = await resolveProviderDisabledReasons(
            { codex: { enabled: true, type: "codex" } },
            { CODEX_HOME: codexHome, OPENAI_API_KEY: "environment-openai-key" },
        );

        expect(reasons.get("codex")).toBe("not_authenticated");
    });
});

function providersFor(root: string): ConfigProviders {
    return {
        bedrock: { enabled: true, type: "bedrock" },
        claude: { configDir: join(root, "claude"), enabled: true, type: "claude" },
        codex: { authFile: join(root, "codex.json"), enabled: true, type: "codex" },
        grok: { authFile: join(root, "grok.json"), enabled: true, type: "grok" },
        turned_off: { enabled: false, type: "grok" },
    };
}
