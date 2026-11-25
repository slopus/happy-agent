import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const folders: string[] = [];
afterEach(async () => {
    await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function load(machineFile: string): Promise<{ config: ConfigModule; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "provider-sign-in-"));
    folders.push(root);
    const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "happy.toml"), machineFile);
    return { config: await ConfigModule.load(join(root, ".happy")), root };
}

describe("an account's own sign-in", () => {
    it("reports where each account's credential comes from", async () => {
        const { config } = await load(
            [
                "[providers.codex_key]",
                'type = "codex"',
                'api_key = "sk-configured"',
                "",
                "[providers.codex_isolated]",
                'type = "codex"',
                "credential_isolation = true",
                "",
                "[providers.claude_home]",
                'type = "claude"',
                'config_dir = "/tmp/elsewhere/.claude-work"',
                "",
                "[providers.bedrock]",
                'region = "us-east-1"',
            ].join("\n"),
        );
        expect(config.providerCredentialSource("codex")).toBe("system");
        expect(config.providerCredentialSource("claude")).toBe("system");
        expect(config.providerCredentialSource("grok")).toBe("system");
        expect(config.providerCredentialSource("codex_key")).toBe("configured");
        expect(config.providerCredentialSource("codex_isolated")).toBe("configured");
        expect(config.providerCredentialSource("claude_home")).toBe("configured");
        expect(config.providerCredentialSource("bedrock")).toBeUndefined();
        expect(config.providerCredentialSource("missing")).toBeUndefined();
        expect(config.providerSignInHome("codex")).toBeUndefined();
    });

    it("points a Codex account at its own sign-in without a restart, and keeps it after one", async () => {
        const { config, root } = await load(
            '[providers.codex_work]\ntype = "codex"\nname = "Work"\n',
        );
        const ctx = createRootContext();
        const directory = config.providerSignInDirectory("codex_work", "attempt1");
        expect(directory).toBe(
            join(root, ".happy", "agent", "provider-accounts", "codex_work", "attempt1"),
        );
        const registry = config.providers;

        await config.adoptProviderSignIn(ctx, "codex_work", directory);

        expect(config.configuration.values.providers.codex_work).toMatchObject({
            type: "codex",
            name: "Work",
            authFile: join(directory, "auth.json"),
            credentialIsolation: true,
        });
        expect(config.providerCredentialSource("codex_work")).toBe("internal");
        expect(config.providerSignInHome("codex_work")).toBe(directory);
        expect(config.providers).toBe(registry);
        const runtime = await readFile(config.configuration.paths.runtimeConfigPath, "utf8");
        expect(runtime).toContain(`auth_file = "${join(directory, "auth.json")}"`);
        expect(runtime).toContain("credential_isolation = true");

        const reloaded = await ConfigModule.load(join(root, ".happy"));
        expect(reloaded.providerCredentialSource("codex_work")).toBe("internal");
        expect(reloaded.providerSignInHome("codex_work")).toBe(directory);
    });

    it("replaces a saved Claude token with a sign-in, and a sign-in with a later token", async () => {
        const { config } = await load('[providers.claude_two]\ntype = "claude"\n');
        const ctx = createRootContext();
        await config.saveProviderSetupToken(ctx, "claude_two", "sk-ant-oat01-first");
        expect(config.providerCredentialSource("claude_two")).toBe("internal");
        expect(config.providerSignInHome("claude_two")).toBeUndefined();

        const directory = config.providerSignInDirectory("claude_two", "attempt2");
        await config.adoptProviderSignIn(ctx, "claude_two", directory);
        expect(config.configuration.values.providers.claude_two).not.toHaveProperty("oauthToken");
        expect(config.configuration.values.providers.claude_two).toMatchObject({
            configDir: directory,
            credentialIsolation: true,
        });
        expect(config.providerSignInHome("claude_two")).toBe(directory);
        const runtime = await readFile(config.configuration.paths.runtimeConfigPath, "utf8");
        expect(runtime).not.toContain("sk-ant-oat01-first");

        await config.saveProviderSetupToken(ctx, "claude_two", "sk-ant-oat01-second");
        expect(config.providerCredentialSource("claude_two")).toBe("internal");
        expect(config.providerSignInHome("claude_two")).toBeUndefined();
    });

    it("leaves a key from the person's own file in charge", async () => {
        const { config } = await load('[providers.grok]\napi_key = "xai-configured"\n');
        const ctx = createRootContext();
        await config.adoptProviderSignIn(
            ctx,
            "grok",
            config.providerSignInDirectory("grok", "attempt3"),
        );
        expect(config.configuration.values.providers.grok).toMatchObject({
            apiKey: "xai-configured",
            authFile: join(config.providerSignInDirectory("grok", "attempt3"), "auth.json"),
        });
        expect(config.providerCredentialSource("grok")).toBe("configured");
    });

    it("refuses folders that are not the account's and accounts that cannot sign in", async () => {
        const { config } = await load('[providers.bedrock]\nregion = "us-east-1"\n');
        const ctx = createRootContext();
        const before = config.configuration;
        await expect(
            config.adoptProviderSignIn(ctx, "codex", config.providerSignInDirectory("grok", "x1")),
        ).rejects.toThrow("not this account's");
        await expect(
            config.adoptProviderSignIn(
                ctx,
                "bedrock",
                config.providerSignInDirectory("bedrock", "x2"),
            ),
        ).rejects.toThrow("cannot sign in");
        await expect(
            config.saveProviderSetupToken(ctx, "codex", "sk-ant-oat01-x"),
        ).rejects.toThrow();
        expect(() => config.providerSignInDirectory("codex", "../escape")).toThrow();
        expect(config.configuration).toBe(before);
    });

    it("names an account with an unusual ID by a hash", async () => {
        const { config } = await load('[providers."work codex"]\ntype = "codex"\n');
        const directory = config.providerSignInDirectory("work codex", "attempt4");
        expect(directory).toMatch(/provider-accounts\/account-[0-9a-f]{16}\/attempt4$/);
    });
});
