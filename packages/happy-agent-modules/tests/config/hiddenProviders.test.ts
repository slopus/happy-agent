import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import {
    BaseProvider,
    BaseSession,
    type SessionCompactionOptions,
    type SessionStream,
} from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigModule, parseHappyAgentConfigToml } from "../../sources/config/index.js";
import { ProviderScanModule } from "../../sources/providerScan/index.js";
import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configuration(toml: string) {
    const root = await mkdtemp(join(tmpdir(), "hidden-providers-"));
    roots.push(root);
    return await testConfigRootedAt(root, toml);
}

describe("hidden providers", () => {
    it("keeps a hidden enabled account usable through a visible smart provider and polls its quota", async () => {
        const config = await configuration(
            [
                "[providers.codex]",
                "enabled = true",
                "hidden = true",
                "[providers.router]",
                'type = "smart"',
                'providers = ["codex"]',
                "enabled = true",
            ].join("\n"),
        );
        expect(config.visibleModels.some((model) => model.providerId === "router")).toBe(true);
        expect(config.visibleModels.some((model) => model.providerId === "codex")).toBe(false);
        expect(config.models.some((model) => model.providerId === "codex")).toBe(true);
        const read = vi.spyOn(config, "readProviderUsageUnchecked").mockResolvedValue(null);
        const ctx = createRootContext();
        await config.readProviderUsage(ctx, "codex");
        expect(read).toHaveBeenCalledWith(ctx, "codex");
        config.setProviderEnabled("codex", false);
        expect(config.models.some((model) => model.providerId === "router")).toBe(false);
    });

    it.each(["codex", "claude", "grok", "bedrock", "smart"])(
        "accepts a boolean hidden setting for %s and rejects invalid values",
        (type) => {
            const table = `[providers.account]\ntype = "${type}"\n`;
            const extra = type === "smart" ? 'providers = ["codex"]\n' : "";
            expect(
                parseHappyAgentConfigToml(`${table}${extra}hidden = true`).unknownSettings,
            ).toEqual([]);
            expect(() => parseHappyAgentConfigToml(`${table}${extra}hidden = "yes"`)).toThrow();
        },
    );

    it("reports hidden separately from enabled and keeps existing work running", async () => {
        const config = await configuration("[providers.codex]\nenabled = true\nhidden = true\n");
        expect(config.configuration.values.providers.codex).toMatchObject({
            enabled: true,
            hidden: true,
        });
        expect(config.providerIds).toContain("codex");
        expect(config.isProviderHidden("codex")).toBe(true);
        expect(config.isProviderEnabled("codex")).toBe(true);
        const catalog = config.catalog.filter((model) => model.providerId === "codex");
        expect(catalog.length).toBeGreaterThan(0);
        expect(catalog.every((model) => model.enabled)).toBe(true);
        expect(config.models.some((model) => model.providerId === "codex")).toBe(true);
        expect(config.visibleModels.some((model) => model.providerId === "codex")).toBe(false);
        expect(config.isSubagentModelAllowed("codex", "openai/gpt-5.6-sol")).toBe(false);
    });

    it("never lets a hidden account stand in as the default", async () => {
        const config = await configuration(
            [
                "[providers.claude]",
                "enabled = true",
                "hidden = true",
                "[providers.codex]",
                "enabled = true",
                "[defaults]",
                'model = "anthropic/opus-5"',
            ].join("\n"),
        );
        expect(config.models[0]?.providerId).toBe("codex");
        expect(config.models.some((model) => model.providerId === "claude")).toBe(true);
    });

    it("keeps every route usable when every provider is hidden", async () => {
        const ids = ["bedrock", "claude", "codex", "grok"];
        const config = await configuration(
            ids.map((id) => `[providers.${id}]\nenabled = true\nhidden = true`).join("\n"),
        );
        expect(config.visibleModels).toEqual([]);
        expect(config.models.length).toBeGreaterThan(0);
        expect(config.offeredModels.length).toBeGreaterThan(0);
        expect(config.catalog.every((model) => model.enabled)).toBe(true);
        expect(config.providerIds).toEqual(expect.arrayContaining(ids));
    });

    it("keeps hiding independent of scans and persisted enable overrides", async () => {
        const config = await configuration("[providers.codex]\nhidden = true\n");
        const ctx = createRootContext();
        const scan = new ProviderScanModule(config);
        vi.spyOn(config, "probeLocalProviderCredentials").mockResolvedValue("available");
        await scan.open(ctx);
        await scan.setOverrides(ctx, { codex: { enabled: true } });
        const result = await scan.scan(ctx);
        expect(result.providers.find((entry) => entry.providerId === "codex")).toMatchObject({
            credentials: "available",
            enabled: true,
            remembered: true,
        });
        const restarted = await ConfigModule.load(config.configuration.paths.happyHome);
        expect(restarted.isProviderEnabled("codex")).toBe(true);
        expect(restarted.isProviderHidden("codex")).toBe(true);
        expect(restarted.configuration.values.providers.codex).toMatchObject({
            hidden: true,
            enabled: true,
        });

        await writeFile(
            config.configuration.paths.globalConfigPath,
            "[providers.codex]\nhidden = false\n",
        );
        const visible = await ConfigModule.load(config.configuration.paths.happyHome);
        expect(visible.isProviderEnabled("codex")).toBe(true);
        expect(visible.isProviderHidden("codex")).toBe(false);
    });

    it("preserves a runtime hidden setting when generated runtime state is rewritten", async () => {
        const config = await configuration("[providers.codex]\nenabled = true\n");
        await config.writeRuntimeConfiguration(createRootContext());
        await writeFile(
            config.configuration.paths.runtimeConfigPath,
            "[providers.codex]\nhidden = true\n",
        );
        const hidden = await ConfigModule.load(config.configuration.paths.happyHome);
        await hidden.updateRuntimeProviderStates(createRootContext(), {
            codex: { autoEnable: true },
        });
        expect(await readFile(hidden.configuration.paths.runtimeConfigPath, "utf8")).toContain(
            "hidden = true",
        );
        const restarted = await ConfigModule.load(config.configuration.paths.happyHome);
        expect(restarted.isProviderHidden("codex")).toBe(true);
    });

    it("excludes hidden smart providers but offers visible routes backed by hidden accounts", async () => {
        const config = await configuration(
            [
                "[providers.codex]",
                "enabled = true",
                "hidden = true",
                "[providers.router]",
                'type = "smart"',
                'providers = ["codex"]',
                "enabled = true",
                "[providers.claude]",
                "enabled = true",
                "[providers.hidden_router]",
                'type = "smart"',
                'providers = ["claude"]',
                "enabled = true",
                "hidden = true",
            ].join("\n"),
        );
        expect(config.catalog.some((model) => model.providerId === "router")).toBe(true);
        expect(config.visibleModels.some((model) => model.providerId === "router")).toBe(true);
        expect(
            config.visibleModels.every(
                (model) => model.providerId === "claude" || model.providerId === "router",
            ),
        ).toBe(true);
        expect(config.models.some((model) => model.providerId === "hidden_router")).toBe(true);
        expect(config.isSubagentModelAllowed("hidden_router", "anthropic/opus-5")).toBe(false);
    });

    it("keeps a hidden scripted account usable directly and verifiable", async () => {
        const config = await configuration("[providers.codex]\nenabled = true\nhidden = true\n");
        const source = new AgentProviders();
        const resolve = vi.fn(() => new TestProvider());
        source.add("codex", resolve, "codex");
        const model: AgentModel = {
            id: "test/model",
            name: "Test model",
            providerId: "codex",
            defaultEffort: "off",
            effortLevels: ["off"],
        };
        const scripted = await ConfigModule.load(config.configuration.paths.happyHome, {
            inference: { providers: source, models: [model] },
        });
        expect(scripted.models).toEqual([model]);
        expect(scripted.visibleModels).toEqual([]);
        expect(scripted.offeredModels).toEqual([model]);
        expect(scripted.catalog).toContainEqual(
            expect.objectContaining({ id: model.id, enabled: true }),
        );
        await expect(scripted.providers.resolve("codex", model.id)).resolves.not.toBeNull();
        const scan = new ProviderScanModule(scripted);
        vi.spyOn(scripted, "probeLocalProviderCredentials").mockResolvedValue("available");
        await expect(scan.verify(createRootContext(), "codex", "inference")).resolves.toMatchObject(
            { status: "passed", modelId: model.id },
        );
        expect(resolve).toHaveBeenCalled();
    });

    it("runs a real smart router over hidden scripted accounts and honors account disablement", async () => {
        const config = await configuration(
            [
                "[providers]",
                "default_enable = false",
                "[providers.codex]",
                "enabled = true",
                "hidden = true",
                "[providers.router]",
                'type = "smart"',
                'providers = ["codex"]',
                "enabled = true",
            ].join("\n"),
        );
        const source = new AgentProviders();
        source.add("codex", new TestProvider(), "codex");
        const scripted = await ConfigModule.load(config.configuration.paths.happyHome, {
            inference: (real) => ({ models: real.models, providers: source }),
        });
        const model = "openai/gpt-5.6-sol";
        expect(scripted.visibleModels.some((entry) => entry.providerId === "router")).toBe(true);
        const router = await scripted.providers.resolve("router", model);
        expect(router).not.toBeNull();
        const session = await router!.session("agent", { instructions: "", tools: [] });
        const request = { model, context: { instructions: "", messages: [] } };
        try {
            const first = [];
            for await (const event of session.run(createRootContext(), request)) first.push(event);
            expect(first.at(-1)).toMatchObject({ state: "normal" });
            let markStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            const blocked = vi.spyOn(TestSession.prototype, "run").mockImplementation((ctx) =>
                (async function* () {
                    const signal = ctx.lifetime;
                    if (signal === undefined)
                        throw new Error("The routed account has no lifetime.");
                    markStarted();
                    await new Promise<void>((resolve) => {
                        if (signal.aborted) resolve();
                        else signal.addEventListener("abort", () => resolve(), { once: true });
                    });
                    yield { type: "done", state: "cancelled" } as const;
                })(),
            );
            const activeIterator = session
                .run(createRootContext(), request)
                [Symbol.asyncIterator]();
            const active = activeIterator.next();
            await started;
            scripted.setProviderEnabled("codex", false);
            await expect(active).resolves.toMatchObject({ value: { state: "cancelled" } });
            await activeIterator.return?.();
            blocked.mockRestore();
            expect(scripted.models).toEqual([]);
            const disabled = [];
            for await (const event of session.run(createRootContext(), request))
                disabled.push(event);
            expect(disabled.at(-1)).toMatchObject({ state: "error" });
            scripted.setProviderEnabled("codex", true);
            const restored = [];
            for await (const event of session.run(createRootContext(), request))
                restored.push(event);
            expect(restored.at(-1)).toMatchObject({ state: "normal" });
        } finally {
            await session.destroy();
            scripted.closeProviders();
        }
    });
});

class TestProvider extends BaseProvider {
    async session(id: string): Promise<BaseSession> {
        return new TestSession(id);
    }
}

class TestSession extends BaseSession {
    constructor(id: string) {
        super(id);
    }

    run(_ctx: Context): SessionStream {
        return (async function* () {
            yield { type: "done", state: "normal", tokens: { input: 10, output: 2 } } as const;
        })();
    }
    async compact(_ctx: Context, options: SessionCompactionOptions) {
        return { context: options.context, status: "cancelled" as const };
    }
    destroy(): void {}
}
