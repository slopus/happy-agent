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

describe("saving a Claude setup token", () => {
    it("applies every whitespace-normalized token to an already-created provider registry", async () => {
        const root = await mkdtemp(join(tmpdir(), "claude-token-"));
        folders.push(root);
        const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
        await mkdir(folder, { recursive: true });
        await writeFile(
            join(folder, "happy.toml"),
            '[providers.claude]\ncredential_isolation = true\nenabled = false\nname = "My account"\n',
        );
        const config = await ConfigModule.load(join(root, ".happy"));
        const ctx = createRootContext();
        const registry = config.providers;
        await expect(config.resolveProviderUnchecked("claude", undefined)).rejects.toThrow();
        const original = config.configuration;
        await config.saveClaudeSetupToken(
            ctx,
            "\ufeffsk-ant-\r\noat01-\ttest\u0085-\u00a0token\u2003",
        );
        expect(config.configuration.values.providers.claude).toMatchObject({
            oauthToken: "sk-ant-oat01-test-token",
            name: "My account",
        });
        expect(original.values.providers.claude).not.toHaveProperty("oauthToken");
        expect(config.configuredProviderOverride("claude")).toBe(false);
        expect(config.providers).toBe(registry);
        await expect(config.resolveProviderUnchecked("claude", undefined)).resolves.not.toBeNull();
        expect(await readFile(config.configuration.paths.runtimeConfigPath, "utf8")).toContain(
            'oauth_token = "sk-ant-oat01-test-token"',
        );
        const reloaded = await ConfigModule.load(join(root, ".happy"));
        expect(reloaded.configuration.values.providers.claude).toMatchObject({
            oauthToken: "sk-ant-oat01-test-token",
            name: "My account",
        });
        expect(reloaded.configuredProviderOverride("claude")).toBe(false);
    });

    it("refuses invalid token shapes and preserves unrelated concurrent runtime changes", async () => {
        const root = await mkdtemp(join(tmpdir(), "claude-token-"));
        folders.push(root);
        const config = await ConfigModule.load(join(root, ".happy"));
        const ctx = createRootContext();
        await Promise.all([
            config.saveClaudeSetupToken(ctx, "sk-ant-oat01-first"),
            config.writeRuntimeNodeName(ctx, "My computer"),
        ]);
        const before = await readFile(config.configuration.paths.runtimeConfigPath, "utf8");
        for (const token of [
            "",
            "\t\r\n\u0085\ufeff",
            "sk-ant-api03-no",
            "sk-ant-oat01-",
            "sk-ant-oat01-invalid!",
            `sk-ant-oat01-${"a".repeat(8192)}`,
        ]) {
            await expect(config.saveClaudeSetupToken(ctx, token)).rejects.toThrow(
                "Enter a valid Claude setup token.",
            );
            expect(await readFile(config.configuration.paths.runtimeConfigPath, "utf8")).toBe(
                before,
            );
        }
        await config.saveClaudeSetupToken(ctx, "sk-ant-oat01-second");
        const reloaded = await ConfigModule.load(join(root, ".happy"));
        expect(reloaded.configuration.values.node.name).toBe("My computer");
        expect(reloaded.configuration.values.providers.claude).toMatchObject({
            oauthToken: "sk-ant-oat01-second",
        });
    });
});
