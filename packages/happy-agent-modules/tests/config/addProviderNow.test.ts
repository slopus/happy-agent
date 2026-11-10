import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, expect, it } from "vitest";

import { testConfigRootedAt } from "../support/configModule.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TOML = `[providers.claude]
enabled = true
[providers.codex]
enabled = true
[providers.claude_pool]
type = "smart"
name = "Claude pool"
enabled = true
providers = ["claude"]
`;

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "add-provider-now-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const config = await testConfigRootedAt(root, TOML);
    cleanups.push(() => config.closeProviders());
    return { root, config };
}

it("adds an account that is used at once, joins its type's pool, and survives a restart", async () => {
    const { root, config } = await fixture();
    const ctx = createRootContext();
    // The live registry exists before the account does, as it does in a running daemon.
    const live = config.providers;
    expect(live.typeOf("claude_2")).toBeNull();
    const home = join(root, ".claude-2");

    const added = await config.addProviderNow(ctx, "claude_2", {
        type: "claude",
        name: "Claude Code 2",
        config_dir: home,
    });

    expect(added).toEqual({ pool: "claude_pool" });
    expect(config.configuration.values.providers["claude_2"]).toMatchObject({
        type: "claude",
        name: "Claude Code 2",
        configDir: home,
        enabled: true,
    });
    expect(config.providerIds).toContain("claude_2");
    expect(live.typeOf("claude_2")).toBe("claude");
    expect(config.isProviderEnabled("claude_2")).toBe(true);
    expect(config.models.some((model) => model.providerId === "claude_2")).toBe(true);
    expect(config.smartProviderPool("claude_pool")).toEqual({
        strategy: "round_robin",
        members: ["claude", "claude_2"],
    });
    // A pool of another type is left alone.
    expect(config.smartProviderPool("codex")).toBeUndefined();

    const runtime = await readFile(config.configuration.paths.runtimeConfigPath, "utf8");
    expect(runtime).toContain("[providers.claude_2]");
    expect(runtime).toContain(`config_dir = "${home}"`);

    const restarted = await testConfigRootedAt(root);
    cleanups.push(() => restarted.closeProviders());
    expect(restarted.configuration.values.providers["claude_2"]).toMatchObject({
        type: "claude",
        configDir: home,
        enabled: true,
    });
    expect(restarted.smartProviderPool("claude_pool")?.members).toEqual(["claude", "claude_2"]);

    await expect(
        config.addProviderNow(ctx, "claude_2", { type: "claude", config_dir: home }),
    ).rejects.toThrow('Provider "claude_2" is already configured.');
});

it("adds an account without a pool when none pools its type", async () => {
    const { root, config } = await fixture();
    const added = await config.addProviderNow(createRootContext(), "codex_2", {
        type: "codex",
        name: "Codex 2",
        auth_file: join(root, ".codex-2", "auth.json"),
    });
    expect(added).toEqual({ pool: null });
    expect(config.smartProviderPool("claude_pool")?.members).toEqual(["claude"]);
    // The registry was not built yet; it is built from the new configuration.
    expect(config.providers.typeOf("codex_2")).toBe("codex");
});
