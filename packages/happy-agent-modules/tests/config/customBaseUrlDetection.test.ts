import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AnthropicProvider, CodexProvider } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigModule } from "../../sources/config/index.js";
import { ProviderScanModule } from "../../sources/providerScan/index.js";
import { testConfigRootedAt } from "../support/configModule.js";

// People who reach their model through a gateway configure it for the native CLI and never sign
// in. These cases put that setup where the CLI keeps it and check Rig reaches the same endpoint.

const roots: string[] = [];
const servers: Server[] = [];
let root: string;
let claudeHome: string;
let codexHome: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "custom-base-url-"));
    roots.push(root);
    claudeHome = join(root, "claude");
    codexHome = join(root, "codex");
    await mkdir(claudeHome, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    for (const name of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "GATEWAY_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
    ])
        vi.stubEnv(name, "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
    vi.stubEnv("CODEX_HOME", codexHome);
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        servers
            .splice(0)
            .map(
                async (server) =>
                    await new Promise<void>((resolve) => server.close(() => resolve())),
            ),
    );
    await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Claude Code configured for a gateway", () => {
    it("uses the base URL and token from Claude Code's settings without a sign-in", async () => {
        await claudeSettings({
            ANTHROPIC_AUTH_TOKEN: "settings-gateway-token",
            ANTHROPIC_BASE_URL: "https://claude-gateway.example",
        });
        const config = await claudeConfig();

        expect(await config.probeLocalProviderCredentials("claude")).toBe("available");
        const { credential, env } = await claudeSession(config);
        expect(credential).toMatchObject({
            name: "claude-auth-token",
            credential: { authToken: "settings-gateway-token" },
        });
        expect(env.ANTHROPIC_BASE_URL).toBe("https://claude-gateway.example");
    });

    it("lets settings override the shell environment, as Claude Code does", async () => {
        vi.stubEnv("ANTHROPIC_BASE_URL", "https://shell-gateway.example");
        vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "shell-token");
        await claudeSettings({
            ANTHROPIC_AUTH_TOKEN: "settings-token",
            ANTHROPIC_BASE_URL: "https://settings-gateway.example",
        });

        const { credential, env } = await claudeSession(await claudeConfig());

        expect(credential).toMatchObject({ credential: { authToken: "settings-token" } });
        expect(env.ANTHROPIC_BASE_URL).toBe("https://settings-gateway.example");
    });

    it("finds a gateway token exported in the shell", async () => {
        vi.stubEnv("ANTHROPIC_BASE_URL", "https://shell-gateway.example");
        vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "shell-token");
        const config = await claudeConfig();

        expect(await config.probeLocalProviderCredentials("claude")).toBe("available");
        const { credential, env } = await claudeSession(config);
        expect(credential).toMatchObject({ credential: { authToken: "shell-token" } });
        expect(env.ANTHROPIC_BASE_URL).toBe("https://shell-gateway.example");
    });

    it("keeps a signed-in subscription ahead of an API key exported for other tools", async () => {
        await claudeLogin();
        vi.stubEnv("ANTHROPIC_API_KEY", "unrelated-tooling-key");

        expect((await claudeSession(await claudeConfig())).credential.name).toBe("claude-code");
    });

    it("uses an exported API key when nothing is signed in", async () => {
        vi.stubEnv("ANTHROPIC_API_KEY", "only-key");

        expect((await claudeSession(await claudeConfig())).credential).toMatchObject({
            name: "claude-api-key",
            credential: { apiKey: "only-key" },
        });
    });

    it("prefers an exported key over the sign-in when the shell points at a gateway", async () => {
        await claudeLogin();
        vi.stubEnv("ANTHROPIC_BASE_URL", "https://shell-gateway.example");
        vi.stubEnv("ANTHROPIC_API_KEY", "gateway-key");

        expect((await claudeSession(await claudeConfig())).credential).toMatchObject({
            credential: { apiKey: "gateway-key" },
        });
    });

    it("prefers a key in Claude Code's settings over the sign-in", async () => {
        await claudeLogin();
        await claudeSettings({ ANTHROPIC_API_KEY: "settings-key" });

        expect((await claudeSession(await claudeConfig())).credential).toMatchObject({
            credential: { apiKey: "settings-key" },
        });
    });

    it("ignores Claude Code's settings under credential isolation", async () => {
        await claudeSettings({
            ANTHROPIC_AUTH_TOKEN: "settings-token",
            ANTHROPIC_BASE_URL: "https://settings-gateway.example",
        });

        const config = await claudeConfig("credential_isolation = true");

        expect(await config.probeLocalProviderCredentials("claude")).toBe("missing");
    });

    it("ignores a settings file that is not valid JSON", async () => {
        await writeFile(join(claudeHome, "settings.json"), "{ not json");

        expect(await (await claudeConfig()).probeLocalProviderCredentials("claude")).toBe(
            "missing",
        );
    });
});

describe("Codex configured for a gateway", () => {
    it("uses a custom model provider's base URL and env_key", async () => {
        vi.stubEnv("GATEWAY_KEY", "gateway-secret");
        await codexConfigToml(
            [
                'model_provider = "gateway"',
                "[model_providers.gateway]",
                'name = "Gateway"',
                'base_url = "https://codex-gateway.example/v1/"',
                'env_key = "GATEWAY_KEY"',
                'wire_api = "responses"',
            ].join("\n"),
        );
        const config = await codexConfig();

        expect(await config.probeLocalProviderCredentials("codex")).toBe("available");
        const provider = await codexProvider(config);
        expect(provider.endpoint).toBe("https://codex-gateway.example/v1");
        expect(provider.transport).toBe("sse");
        expect(provider.credential).toMatchObject({
            name: "codex-api-key",
            credential: { apiKey: "gateway-secret" },
        });
    });

    it("keeps WebSocket when the custom provider declares support for it", async () => {
        vi.stubEnv("GATEWAY_KEY", "gateway-secret");
        await codexConfigToml(
            [
                'model_provider = "gateway"',
                "[model_providers.gateway]",
                'base_url = "https://codex-gateway.example/v1"',
                'env_key = "GATEWAY_KEY"',
                "supports_websockets = true",
            ].join("\n"),
        );

        expect((await codexProvider(await codexConfig())).transport).toBe("auto");
    });

    it("selects the model provider of the active profile", async () => {
        await codexConfigToml(
            [
                'profile = "work"',
                "[profiles.work]",
                'model_provider = "gateway"',
                "[model_providers.gateway]",
                'base_url = "https://profile-gateway.example/v1"',
                'experimental_bearer_token = "profile-token"',
            ].join("\n"),
        );

        const provider = await codexProvider(await codexConfig());

        expect(provider.endpoint).toBe("https://profile-gateway.example/v1");
        expect(provider.credential).toMatchObject({ credential: { apiKey: "profile-token" } });
    });

    it("reports a custom provider whose key variable is unset as missing", async () => {
        await codexConfigToml(
            [
                'model_provider = "gateway"',
                "[model_providers.gateway]",
                'base_url = "https://codex-gateway.example/v1"',
                'env_key = "GATEWAY_KEY"',
            ].join("\n"),
        );
        // A ChatGPT sign-in must not stand in for the gateway's own key.
        await codexLogin();

        expect(await (await codexConfig()).probeLocalProviderCredentials("codex")).toBe("missing");
    });

    it("points an OpenAI API key at OPENAI_BASE_URL", async () => {
        vi.stubEnv("OPENAI_API_KEY", "openai-key");
        vi.stubEnv("OPENAI_BASE_URL", "https://openai-proxy.example/v1");

        const provider = await codexProvider(await codexConfig());

        expect(provider.endpoint).toBe("https://openai-proxy.example/v1");
        expect(provider.transport).toBe("sse");
        expect(provider.credential).toMatchObject({ credential: { apiKey: "openai-key" } });
    });

    it("prefers config.toml's openai_base_url over OPENAI_BASE_URL", async () => {
        vi.stubEnv("OPENAI_API_KEY", "openai-key");
        vi.stubEnv("OPENAI_BASE_URL", "https://environment-proxy.example/v1");
        await codexConfigToml('openai_base_url = "https://config-proxy.example/v1"');

        expect((await codexProvider(await codexConfig())).endpoint).toBe(
            "https://config-proxy.example/v1",
        );
    });

    it("keeps a ChatGPT sign-in on its own backend despite OPENAI_BASE_URL", async () => {
        await codexLogin();
        vi.stubEnv("OPENAI_API_KEY", "unrelated-tooling-key");
        vi.stubEnv("OPENAI_BASE_URL", "https://openai-proxy.example/v1");

        const provider = await codexProvider(await codexConfig());

        expect(provider.credential.name).toBe("codex-session");
        expect(provider.endpoint).toBe("https://chatgpt.com/backend-api");
        expect(provider.transport).toBe("auto");
    });

    it("ignores a provider Rig cannot speak", async () => {
        vi.stubEnv("GATEWAY_KEY", "gateway-secret");
        vi.stubEnv("OPENAI_API_KEY", "openai-key");
        await codexConfigToml(
            [
                'model_provider = "gateway"',
                "[model_providers.gateway]",
                'base_url = "https://codex-gateway.example/v1"',
                'env_key = "GATEWAY_KEY"',
                'wire_api = "chat"',
            ].join("\n"),
        );

        expect((await codexProvider(await codexConfig())).endpoint).toBe(
            "https://api.openai.com/v1",
        );
    });

    it("lets happy.toml's own base_url and key win over Codex's configuration", async () => {
        vi.stubEnv("GATEWAY_KEY", "gateway-secret");
        await codexConfigToml(
            [
                'model_provider = "gateway"',
                "[model_providers.gateway]",
                'base_url = "https://codex-gateway.example/v1"',
                'env_key = "GATEWAY_KEY"',
            ].join("\n"),
        );

        const provider = await codexProvider(
            await codexConfig('api_key = "happy-key"\nbase_url = "https://happy.example/v1"'),
        );

        expect(provider.endpoint).toBe("https://happy.example/v1");
        expect(provider.credential).toMatchObject({ credential: { apiKey: "happy-key" } });
    });

    it("ignores Codex's configuration under credential isolation", async () => {
        vi.stubEnv("GATEWAY_KEY", "gateway-secret");
        await codexConfigToml(
            [
                'model_provider = "gateway"',
                "[model_providers.gateway]",
                'base_url = "https://codex-gateway.example/v1"',
                'env_key = "GATEWAY_KEY"',
            ].join("\n"),
        );

        expect(
            await (
                await codexConfig("credential_isolation = true")
            ).probeLocalProviderCredentials("codex"),
        ).toBe("missing");
    });

    it("verifies inference against the gateway with the gateway's key", async () => {
        const requests: { url: string | undefined; headers: IncomingHttpHeaders }[] = [];
        const server = createServer((request, response) => {
            request.resume();
            requests.push({ url: request.url, headers: request.headers });
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
                'data: {"type":"response.completed","response":{"id":"gateway-response","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\ndata: [DONE]\n\n',
            );
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing port.");
        vi.stubEnv("GATEWAY_KEY", "gateway-secret");
        await codexConfigToml(
            [
                'model_provider = "gateway"',
                "[model_providers.gateway]",
                `base_url = "http://127.0.0.1:${String(address.port)}/v1"`,
                'env_key = "GATEWAY_KEY"',
            ].join("\n"),
        );
        const scan = new ProviderScanModule(await codexConfig());

        const result = await scan.verify(createRootContext(), "codex", "inference");

        expect(result).toMatchObject({ status: "passed", modelId: "openai/gpt-6-luna" });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe("/v1/responses");
        expect(requests[0]?.headers.authorization).toBe("Bearer gateway-secret");
    });
});

async function claudeSettings(env: Record<string, string>): Promise<void> {
    await writeFile(join(claudeHome, "settings.json"), JSON.stringify({ env }));
}

async function claudeLogin(): Promise<void> {
    await writeFile(
        join(claudeHome, ".credentials.json"),
        JSON.stringify({
            claudeAiOauth: { accessToken: "login", scopes: ["user:inference", "user:profile"] },
        }),
    );
}

async function claudeConfig(extra = ""): Promise<ConfigModule> {
    return await testConfigRootedAt(
        root,
        `[providers]\ndefault_enable = false\n[providers.claude]\nenabled = true\n${extra}\n`,
    );
}

async function claudeSession(config: ConfigModule) {
    const provider = await config.providers.resolve("claude", "anthropic/sonnet-5");
    if (!(provider instanceof AnthropicProvider)) throw new Error("Expected a Claude provider.");
    const session = await provider.session("custom-base-url", { instructions: "", tools: [] });
    try {
        if (!("env" in session) || !("credential" in session))
            throw new Error("Expected a Claude Code session.");
        return {
            credential: provider.credential,
            env: session.env as NodeJS.ProcessEnv,
        };
    } finally {
        await session.destroy();
    }
}

async function codexConfigToml(text: string): Promise<void> {
    await writeFile(join(codexHome, "config.toml"), text);
}

async function codexLogin(): Promise<void> {
    await writeFile(
        join(codexHome, "auth.json"),
        JSON.stringify({ tokens: { access_token: "chatgpt-access", account_id: "account" } }),
    );
}

async function codexConfig(extra = ""): Promise<ConfigModule> {
    return await testConfigRootedAt(
        root,
        `[providers]\ndefault_enable = false\n[providers.codex]\nenabled = true\n${extra}\n[settings]\ninference_max_retries = 0\n`,
    );
}

async function codexProvider(config: ConfigModule): Promise<CodexProvider> {
    const provider = await config.providers.resolve("codex", "openai/gpt-6-luna");
    if (!(provider instanceof CodexProvider)) throw new Error("Expected a Codex provider.");
    return provider;
}
