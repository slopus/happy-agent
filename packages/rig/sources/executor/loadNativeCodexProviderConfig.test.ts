import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadNativeCodexProviderConfig } from "./loadNativeCodexProviderConfig.js";

const tempDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("loadNativeCodexProviderConfig", () => {
    it("loads only the selected native Codex model provider", async () => {
        const codexHome = await writeConfig(`
model_provider = "balancer"

[model_providers.balancer]
base_url = "https://example.com/codex"
wire_api = "responses"
experimental_bearer_token = "provider"
requires_openai_auth = true

[model_providers.other]
base_url = "https://example.org/other"
experimental_bearer_token = "other"
`);

        await expect(loadNativeCodexProviderConfig({ CODEX_HOME: codexHome })).resolves.toEqual({
            baseUrl: "https://example.com/codex",
            experimentalBearerToken: "provider",
            requiresOpenAiAuth: true,
            wireApi: "responses",
        });
    });

    it("does not infer an active provider from missing or malformed configuration", async () => {
        const codexHome = await writeConfig(`
model_provider = "missing"

[model_providers.other]
base_url = "https://example.org/other"
`);

        await expect(
            loadNativeCodexProviderConfig({ CODEX_HOME: codexHome }),
        ).resolves.toBeNull();
        await writeFile(join(codexHome, "config.toml"), "model_provider = [");
        await expect(
            loadNativeCodexProviderConfig({ CODEX_HOME: codexHome }),
        ).resolves.toBeNull();
    });

    it("rejects an unsupported wire API instead of falling back to the default provider", async () => {
        const codexHome = await writeConfig(`
model_provider = "legacy"

[model_providers.legacy]
base_url = "https://example.net/legacy"
wire_api = "chat"
experimental_bearer_token = "legacy"
`);

        await expect(loadNativeCodexProviderConfig({ CODEX_HOME: codexHome })).rejects.toThrow(
            "The selected native Codex provider uses an unsupported wire_api. Rig supports responses only.",
        );
    });
});

async function writeConfig(contents: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-codex-config-"));
    tempDirectories.push(root);
    await writeFile(join(root, "config.toml"), contents);
    return root;
}
