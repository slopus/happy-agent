import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { testConfigRootedAt } from "../support/configModule.js";

const SOL = "openai/gpt-6-sol";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configuration(...lines: string[]) {
    const root = await mkdtemp(join(tmpdir(), "opt-in-models-"));
    roots.push(root);
    return await testConfigRootedAt(
        root,
        ["[providers]", "default_enable = false", ...lines].join("\n"),
    );
}

describe("opt-in models", () => {
    it("keeps GPT-6 Sol routable for existing sessions but out of what Codex offers", async () => {
        const config = await configuration("[providers.codex]", "enabled = true");

        expect(
            config.catalog.find((model) => model.providerId === "codex" && model.id === SOL),
        ).toMatchObject({ enabled: true, hidden: true, name: "GPT-6 Sol" });
        expect(
            config.catalog
                .filter((model) => model.providerId === "codex" && model.id !== SOL)
                .every((model) => !model.hidden),
        ).toBe(true);
        expect(config.isModelHidden("codex", SOL)).toBe(true);
        // A conversation already on GPT-6 Sol still resolves its route and context.
        expect(
            config.models.some((model) => model.providerId === "codex" && model.id === SOL),
        ).toBe(true);
        expect(config.modelContext("codex", SOL)).toEqual({
            contextWindow: 272_000,
            autoCompactWindow: 244_800,
        });
        expect(config.visibleModels.some((model) => model.id === SOL)).toBe(false);
        expect(config.visibleModels.some((model) => model.id === "openai/gpt-6.1-sol")).toBe(true);
        expect(config.isSubagentModelAllowed("codex", SOL)).toBe(false);
        expect(config.isSubagentModelAllowed("codex", "openai/gpt-6.1-sol")).toBe(true);
    });

    it("offers GPT-6 Sol again when the account's include_models names it", async () => {
        const config = await configuration(
            "[providers.codex]",
            "enabled = true",
            `include_models = ["openai/gpt-6.1-sol", "${SOL}"]`,
        );

        expect(
            config.catalog.find((model) => model.providerId === "codex" && model.id === SOL),
        ).toMatchObject({ enabled: true, hidden: false });
        expect(config.isModelHidden("codex", SOL)).toBe(false);
        expect(config.visibleModels.map((model) => model.id)).toEqual(["openai/gpt-6.1-sol", SOL]);
        expect(config.isSubagentModelAllowed("codex", SOL)).toBe(true);
    });

    it("lets include_subagent_models delegate to a hidden model without showing it", async () => {
        const config = await configuration(
            "[providers.codex]",
            "enabled = true",
            `include_subagent_models = ["${SOL}"]`,
        );

        expect(config.isModelHidden("codex", SOL)).toBe(true);
        expect(config.visibleModels.some((model) => model.id === SOL)).toBe(false);
        expect(config.isSubagentModelAllowed("codex", SOL)).toBe(true);
    });

    it("never lets GPT-6 Sol stand in as the default", async () => {
        const config = await configuration(
            "[defaults]",
            'model = "openai/unknown"',
            "[providers.codex]",
            "enabled = true",
            'exclude_models = ["openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-astra"]',
        );

        expect(config.models[0]?.id).toBe("openai/gpt-6-luna");
        expect(config.models.some((model) => model.id === SOL)).toBe(true);
    });

    it("stands GPT-6 Sol in only when nothing else is enabled", async () => {
        const only = await configuration(
            "[defaults]",
            'model = "openai/unknown"',
            "[providers.codex]",
            "enabled = true",
            'exclude_models = ["openai/gpt-6.1-sol", "openai/gpt-6.1-terra", "openai/gpt-6-astra", "openai/gpt-6-luna"]',
        );
        expect(only.models.map((model) => model.id)).toEqual([SOL]);
        expect(only.visibleModels).toEqual([]);
    });

    it("honors a default the configuration names explicitly", async () => {
        const config = await configuration(
            "[defaults]",
            'provider = "codex"',
            `model = "${SOL}"`,
            "[providers.codex]",
            "enabled = true",
        );

        expect(config.models[0]).toMatchObject({ providerId: "codex", id: SOL });
        expect(config.isModelHidden("codex", SOL)).toBe(true);
    });

    it("keeps offering GPT-6 Sol on Bedrock, which does not serve GPT-6.1 Sol", async () => {
        const config = await configuration("[providers.bedrock]", "enabled = true");

        expect(
            config.catalog.find((model) => model.providerId === "bedrock" && model.id === SOL),
        ).toMatchObject({ enabled: true, hidden: false });
        expect(config.visibleModels.some((model) => model.id === SOL)).toBe(true);
    });

    it("hides a pool's GPT-6 Sol unless the pool or one of its members names it", async () => {
        const pool = [
            "[providers.router]",
            'type = "smart"',
            'providers = ["codex", "codex_work"]',
        ];
        const hidden = await configuration(
            "[providers.codex]",
            "enabled = true",
            "[providers.codex_work]",
            'type = "codex"',
            "enabled = true",
            ...pool,
            "enabled = true",
        );
        expect(hidden.isModelHidden("router", SOL)).toBe(true);
        expect(
            hidden.models.some((model) => model.providerId === "router" && model.id === SOL),
        ).toBe(true);

        const member = await configuration(
            "[providers.codex]",
            "enabled = true",
            "[providers.codex_work]",
            'type = "codex"',
            "enabled = true",
            `include_models = ["${SOL}"]`,
            ...pool,
            "enabled = true",
        );
        expect(member.isModelHidden("router", SOL)).toBe(false);
        expect(member.isModelHidden("codex", SOL)).toBe(true);

        const own = await configuration(
            "[providers.codex]",
            "enabled = true",
            ...pool.slice(0, 2),
            'providers = ["codex"]',
            "enabled = true",
            `include_models = ["openai/gpt-6.1-sol", "${SOL}"]`,
        );
        expect(own.isModelHidden("router", SOL)).toBe(false);
        expect(own.visibleModels.filter((model) => model.providerId === "router")).toHaveLength(2);
    });
});
