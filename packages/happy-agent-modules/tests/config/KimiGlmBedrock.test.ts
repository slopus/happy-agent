import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GlmProvider, KimiProvider } from "@slopus/happy-providers";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configuration(extra = "") {
    const root = await mkdtemp(join(tmpdir(), "happy-kimi-glm-catalog-"));
    roots.push(root);
    const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(folder, { recursive: true });
    await writeFile(
        join(folder, "happy.toml"),
        [
            "[providers]",
            "default_enable = false",
            "[providers.bedrock]",
            "enabled = true",
            'region = "us-east-1"',
            'bearer_token = "test-placeholder"',
            extra,
        ].join("\n"),
    );
    return await ConfigModule.load(join(root, ".happy"));
}

describe("Kimi K3 and GLM 5.3 Bedrock agent routes", () => {
    it("advertises the documented Bedrock models and their executable effort choices", async () => {
        const config = await configuration();
        for (const [id, name, defaultEffort] of [
            ["moonshotai/kimi-k3", "Kimi K3", "high"],
            ["zai/glm-5.3", "GLM 5.3", "max"],
        ] as const) {
            expect(config.catalog.filter((entry) => entry.id === id)).toEqual([
                expect.objectContaining({
                    id,
                    name,
                    defaultEffort,
                    providerId: "bedrock",
                    enabled: true,
                    effortLevels: ["low", "high", "max"],
                    contextWindow: 1_000_000,
                    autoCompactWindow: 850_000,
                }),
            ]);
            expect(config.modelContext("bedrock", id)).toEqual({
                contextWindow: 1_000_000,
                autoCompactWindow: 850_000,
            });
        }
        expect(await config.providers.resolve("bedrock", "moonshotai/kimi-k3")).toBeInstanceOf(
            KimiProvider,
        );
        expect(await config.providers.resolve("bedrock", "zai/glm-5.3")).toBeInstanceOf(
            GlmProvider,
        );
    });

    it.each(["moonshotai/kimi-k3", "zai/glm-5.3"])(
        "refuses an explicitly forced Mantle route for %s",
        async (id) => {
            const config = await configuration(
                `\n[providers.bedrock.model_overrides."${id}"]\ntransport = "mantle"`,
            );
            expect(config.catalog.some((entry) => entry.id === id)).toBe(false);
            await expect(config.providers.resolve("bedrock", id)).rejects.toThrow(
                "requires Bedrock Runtime",
            );
        },
    );

    it("preserves ordinary model filters and exposes the same models through a smart Bedrock pool", async () => {
        const config = await configuration(
            [
                'include_models = ["moonshotai/kimi-k3", "zai/glm-5.3"]',
                'exclude_models = ["zai/glm-5.3"]',
                "[providers.pool]",
                'type = "smart"',
                "enabled = true",
                'providers = ["bedrock"]',
            ].join("\n"),
        );
        expect(
            config.catalog.find(
                (entry) => entry.providerId === "bedrock" && entry.id === "zai/glm-5.3",
            )?.enabled,
        ).toBe(false);
        expect(
            config.catalog.find(
                (entry) => entry.providerId === "pool" && entry.id === "moonshotai/kimi-k3",
            )?.enabled,
        ).toBe(true);
        expect(
            config.catalog.some(
                (entry) => entry.providerId === "pool" && entry.id === "zai/glm-5.3",
            ),
        ).toBe(false);
    });
});
