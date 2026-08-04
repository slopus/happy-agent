import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutorImageGenerationUnavailableError } from "@slopus/rig-execution";
import { CodexImageGenerationError, CodexProvider } from "@slopus/rig-providers";

import { codexExecution } from "./codexExecution.js";

const tempDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("codexExecution authentication", () => {
    it("uses an API key stored by the native Codex login", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-codex-auth-"));
        tempDirectories.push(root);
        const authFile = join(root, "auth.json");
        await writeFile(
            authFile,
            JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "codex-api-key" }),
        );
        const definition = codexExecution({
            config: { authFile, enabled: true, type: "codex" },
            env: {},
            id: "codex",
        });
        if (typeof definition.native !== "function") expect.fail("Expected lazy Codex provider.");
        const profile = definition.profiles[0];
        if (profile === undefined) expect.fail("Expected a Codex model profile.");

        const provider = await definition.native(profile);

        expect(provider).toBeInstanceOf(CodexProvider);
        expect((provider as CodexProvider).credential).toMatchObject({
            credential: { apiKey: "codex-api-key" },
            name: "codex-api-key",
        });
    });

    it("uses the active provider from the native Codex configuration", async () => {
        const codexHome = await writeCodexHome({
            auth: { auth_mode: "apikey", OPENAI_API_KEY: "stored-api-key" },
            config: `
model_provider = "balancer"

[model_providers.balancer]
base_url = "https://balancer.example/backend-api/codex"
wire_api = "responses"
experimental_bearer_token = "balancer-token"
requires_openai_auth = true
`,
        });
        const definition = codexExecution({
            config: { enabled: true, type: "codex" },
            env: { CODEX_HOME: codexHome },
            id: "codex",
        });
        if (typeof definition.native !== "function") expect.fail("Expected lazy Codex provider.");
        const profile = definition.profiles[0];
        if (profile === undefined) expect.fail("Expected a Codex model profile.");

        const provider = (await definition.native(profile)) as CodexProvider;

        expect(provider.endpoint).toBe("https://balancer.example/backend-api/codex");
        expect(provider.credential).toMatchObject({
            credential: { apiKey: "balancer-token" },
            name: "codex-api-key",
        });
    });

    it("keeps explicit Rig authentication and endpoint overrides authoritative", async () => {
        const codexHome = await writeCodexHome({
            auth: { auth_mode: "apikey", OPENAI_API_KEY: "stored-api-key" },
            config: `
model_provider = "balancer"

[model_providers.balancer]
base_url = "https://balancer.example/backend-api/codex"
wire_api = "responses"
experimental_bearer_token = "balancer-token"
`,
        });
        const definition = codexExecution({
            apiKey: "explicit-api-key",
            config: {
                baseUrl: "https://rig.example/v1",
                enabled: true,
                type: "codex",
            },
            env: { CODEX_HOME: codexHome, RIG_CODEX_BASE_URL: "https://env.example/v1" },
            id: "codex",
        });
        if (typeof definition.native !== "function") expect.fail("Expected lazy Codex provider.");
        const profile = definition.profiles[0];
        if (profile === undefined) expect.fail("Expected a Codex model profile.");

        const provider = (await definition.native(profile)) as CodexProvider;

        expect(provider.endpoint).toBe("https://rig.example/v1");
        expect(provider.credential).toMatchObject({
            credential: { apiKey: "explicit-api-key" },
            name: "codex-api-key",
        });
    });

    it("does not send the native provider bearer token to an overridden endpoint", async () => {
        const codexHome = await writeCodexHome({
            auth: { auth_mode: "apikey", OPENAI_API_KEY: "stored-api-key" },
            config: `
model_provider = "balancer"

[model_providers.balancer]
base_url = "https://balancer.example/backend-api/codex"
wire_api = "responses"
experimental_bearer_token = "balancer-token"
`,
        });
        const definition = codexExecution({
            config: {
                baseUrl: "https://override.example/v1",
                enabled: true,
                type: "codex",
            },
            env: { CODEX_HOME: codexHome },
            id: "codex",
        });
        if (typeof definition.native !== "function") expect.fail("Expected lazy Codex provider.");
        const profile = definition.profiles[0];
        if (profile === undefined) expect.fail("Expected a Codex model profile.");

        const provider = (await definition.native(profile)) as CodexProvider;

        expect(provider.endpoint).toBe("https://override.example/v1");
        expect(provider.credential).toMatchObject({
            credential: { apiKey: "stored-api-key" },
            name: "codex-api-key",
        });
    });
});

describe("codexExecution image generation", () => {
    it("bridges definitive account refusals into safe cross-provider fallback errors", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
                    status: 429,
                }),
            ),
        );
        try {
            const provider = providerDefinition();
            await expect(
                provider.imageGeneration?.generate({
                    prompt: "A lighthouse",
                    turnId: "turn-1",
                }),
            ).rejects.toBeInstanceOf(ExecutorImageGenerationUnavailableError);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("keeps indeterminate server failures terminal instead of trying another account", async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: { message: "internal failure" } }), {
                    status: 500,
                }),
            ),
        );
        try {
            const provider = providerDefinition();
            const failed = provider.imageGeneration
                ?.generate({
                    prompt: "A lighthouse",
                    turnId: "turn-1",
                })
                .catch((error: unknown) => error);
            await vi.runAllTimersAsync();
            expect(await failed).toBeInstanceOf(CodexImageGenerationError);
        } finally {
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });
});

function providerDefinition() {
    return codexExecution({
        apiKey: "test-key",
        config: {
            baseUrl: "https://example.test/v1",
            enabled: true,
            type: "codex",
        },
        env: {},
        id: "backup-codex",
    });
}

async function writeCodexHome(options: {
    auth: Record<string, unknown>;
    config: string;
}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-codex-home-"));
    tempDirectories.push(root);
    await Promise.all([
        writeFile(join(root, "auth.json"), JSON.stringify(options.auth)),
        writeFile(join(root, "config.toml"), options.config),
    ]);
    return root;
}
