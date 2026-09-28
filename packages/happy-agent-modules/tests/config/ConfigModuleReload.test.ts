import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function configurationRoot(): Promise<{ happyHome: string; configPath: string }> {
    const root = await mkdtemp(join(tmpdir(), "happy-config-reload-"));
    temporaryDirectories.push(root);
    const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(folder, { recursive: true });
    return { happyHome: join(root, ".happy"), configPath: join(folder, "happy.toml") };
}

const codex = (baseUrl: string): string =>
    ["[providers.codex]", 'type = "codex"', "enabled = true", `base_url = "${baseUrl}"`].join("\n");

describe("ConfigModule.reload", () => {
    it("applies a changed provider setting to the live registry without a restart", async () => {
        const { happyHome, configPath } = await configurationRoot();
        await writeFile(configPath, codex("https://one.example/v1"));
        const config = await ConfigModule.load(happyHome);
        const registry = config.providers;
        expect(registry.ids).toContain("codex");
        expect(registry.ids).not.toContain("second");

        await writeFile(
            configPath,
            [codex("https://two.example/v1"), "", "[providers.second]", 'type = "codex"'].join(
                "\n",
            ),
        );
        const result = await config.reload(createRootContext());

        expect(result).toEqual({
            status: "reloaded",
            changed: ["providers"],
            requiresRestart: [],
            warnings: [],
        });
        const provider = config.configuration.values.providers.codex;
        expect(provider?.type === "codex" ? provider.baseUrl : undefined).toBe(
            "https://two.example/v1",
        );
        // The registry the agent system was handed gains the new account in place.
        expect(registry.ids).toContain("second");
        expect(config.providerIds).toContain("second");
        // A gained provider starts behind a closed gate until a scan or an explicit enable.
        expect(config.isProviderEnabled("second")).toBe(false);
    });

    it("keeps the previous configuration and returns the errors when a file is invalid", async () => {
        const { happyHome, configPath } = await configurationRoot();
        await writeFile(configPath, codex("https://one.example/v1"));
        const config = await ConfigModule.load(happyHome);
        const before = config.configuration;
        let told = 0;
        config.onReloaded(() => {
            told += 1;
        });

        await writeFile(configPath, '[providers.codex]\ntype = "codex"\nbase_url = ');
        const result = await config.reload(createRootContext());

        expect(result.status).toBe("invalid");
        if (result.status !== "invalid") throw new Error("unreachable");
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain(configPath);
        expect(config.configuration).toBe(before);
        expect(told).toBe(0);
    });

    it("reports a changed section the running daemon cannot apply, and tells its observers", async () => {
        const { happyHome, configPath } = await configurationRoot();
        await writeFile(configPath, codex("https://one.example/v1"));
        const config = await ConfigModule.load(happyHome);
        const results: unknown[] = [];
        config.onReloaded((_ctx, result) => {
            results.push(result);
        });

        await writeFile(
            configPath,
            [codex("https://one.example/v1"), "", "[features]", "workspaces = false"].join("\n"),
        );
        const result = await config.reload(createRootContext());

        expect(result).toEqual({
            status: "reloaded",
            changed: ["features"],
            requiresRestart: ["features"],
            warnings: [],
        });
        expect(config.configuration.values.features.workspaces).toBe(false);
        expect(results).toEqual([result]);
    });

    it("names the settings it does not know instead of failing on them", async () => {
        const { happyHome, configPath } = await configurationRoot();
        await writeFile(configPath, codex("https://one.example/v1"));
        const config = await ConfigModule.load(happyHome);

        await writeFile(configPath, `${codex("https://one.example/v1")}\nbase_ur = "typo"\n`);
        const result = await config.reload(createRootContext());

        expect(result.status).toBe("reloaded");
        if (result.status !== "reloaded") throw new Error("unreachable");
        expect(result.changed).toEqual([]);
        expect(result.warnings).toEqual([
            `Unknown setting "providers.codex.base_ur" in ${configPath}.`,
        ]);
    });
});
