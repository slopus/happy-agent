import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import {
    BaseProvider,
    BaseSession,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule, type ConfigInferenceOverride } from "../../sources/config/index.js";
import { ProviderScanModule } from "../../sources/providerScan/index.js";
import { testConfigRootedAt } from "../support/configModule.js";

const MODEL: AgentModel = {
    defaultEffort: "off",
    effortLevels: ["off"],
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    providerId: "codex",
};

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("ProviderScanModule", () => {
    it("starts automatic providers disabled and enables one only after its scan finds credentials", async () => {
        const { config, root } = await scriptedConfig();
        const scan = new ProviderScanModule(config);
        expect(config.isProviderEnabled("codex")).toBe(false);

        const result = await scan.open(createRootContext());

        expect(result.providers).toContainEqual({
            credentials: "available",
            enabled: true,
            enablement: "scan",
            providerId: "codex",
            remembered: true,
        });
        expect(config.isProviderEnabled("codex")).toBe(true);
        await expect(
            readFile(config.configuration.paths.runtimeConfigPath, "utf8"),
        ).resolves.toContain("auto_enable = true");
        await expect(
            readFile(join(config.configuration.paths.agentHome, "provider-state.json"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });

        const isolated = await testConfigRootedAt(root, isolatedProvidersToml());
        const restarted = new ProviderScanModule(isolated);
        const later = await restarted.open(createRootContext());
        expect(later.providers).toContainEqual({
            credentials: "missing",
            enabled: true,
            enablement: "scan",
            providerId: "codex",
            remembered: true,
        });
    });

    it("never lets a scan override an explicit enable or disable", async () => {
        const enabledRoot = await root();
        const explicitlyEnabled = await testConfigRootedAt(
            enabledRoot,
            isolatedProvidersToml().replace(
                "[providers.codex]\ncredential_isolation = true",
                "[providers.codex]\nenabled = true\ncredential_isolation = true",
            ),
        );
        const enabledResult = await new ProviderScanModule(explicitlyEnabled).open(
            createRootContext(),
        );
        expect(
            enabledResult.providers.find(({ providerId }) => providerId === "codex"),
        ).toMatchObject({ credentials: "missing", enabled: true, enablement: "explicit" });

        const disabledRoot = await root();
        const providers = providersWith(new PassingProvider());
        const explicitlyDisabled = await ConfigModule.load(join(disabledRoot, "happy"), {
            inference: { models: [MODEL], providers },
        });
        explicitlyDisabled.setProviderEnabled("codex", false);
        const disabled = new ProviderScanModule(explicitlyDisabled);
        await disabled.setOverrides(createRootContext(), { codex: { enabled: false } });
        const disabledResult = await disabled.scan(createRootContext());
        expect(disabledResult.providers).toContainEqual({
            credentials: "available",
            enabled: false,
            enablement: "explicit",
            providerId: "codex",
            remembered: true,
        });
    });

    it("keeps a remembered provider disabled until its startup scan completes", async () => {
        const installationRoot = await root();
        const happyHome = join(installationRoot, "happy");
        await mkdir(join(happyHome, "agent"), { recursive: true });
        await writeFile(
            join(happyHome, "agent", "runtime.toml"),
            '[providers.gym]\ntype = "codex"\nauto_enable = true\n',
        );
        const started = deferred<void>();
        const release = deferred<void>();
        const providers = new AgentProviders();
        providers.add(
            "gym",
            async () => {
                started.resolve(undefined);
                await release.promise;
                return new PassingProvider();
            },
            "gym",
        );
        const model = { ...MODEL, id: "gym/cheap", name: "Gym cheap", providerId: "gym" };
        const config = await ConfigModule.load(happyHome, {
            inference: { models: [model], providers },
        });
        const scan = new ProviderScanModule(config);

        const opening = scan.open(createRootContext());
        await started.promise;
        expect(config.isProviderEnabled("gym")).toBe(false);
        release.resolve(undefined);

        await expect(opening).resolves.toMatchObject({
            providers: [
                {
                    credentials: "available",
                    enabled: true,
                    enablement: "scan",
                    providerId: "gym",
                    remembered: true,
                },
            ],
        });
        expect(config.isProviderEnabled("gym")).toBe(true);
    });

    it("preserves auto_enable false instead of auto-enabling detected credentials", async () => {
        const installationRoot = await root();
        const happyHome = join(installationRoot, "happy");
        const runtimePath = join(happyHome, "agent", "runtime.toml");
        await mkdir(join(happyHome, "agent"), { recursive: true });
        await writeFile(runtimePath, "[providers.codex]\nauto_enable = false\n");
        const config = await ConfigModule.load(happyHome, { inference: inference() });

        const result = await new ProviderScanModule(config).open(createRootContext());

        expect(result.providers).toContainEqual({
            credentials: "available",
            enabled: false,
            enablement: "explicit",
            providerId: "codex",
            remembered: false,
        });
        await expect(
            readFile(config.configuration.paths.runtimeConfigPath, "utf8"),
        ).resolves.not.toContain("auto_enable = true");
    });

    it("persists live overrides and successful inference verification", async () => {
        const { config, root: installationRoot } = await scriptedConfig();
        const scan = new ProviderScanModule(config);
        await scan.open(createRootContext());
        await scan.setOverrides(createRootContext(), { codex: { enabled: false } });
        expect(config.isProviderEnabled("codex")).toBe(false);
        await expect(
            readFile(config.configuration.paths.runtimeConfigPath, "utf8"),
        ).resolves.toEqual(expect.stringContaining("enabled = false"));

        const verification = await scan.verify(createRootContext(), "codex", "inference");
        expect(verification).toMatchObject({
            modelId: MODEL.id,
            performedLevel: "inference",
            providerId: "codex",
            requestedLevel: "inference",
            status: "passed",
        });
        expect(config.isProviderEnabled("codex")).toBe(false);

        const restartedConfig = await ConfigModule.load(join(installationRoot, "happy"), {
            inference: inference(),
        });
        const restarted = new ProviderScanModule(restartedConfig);
        await restarted.open(createRootContext());
        expect(restartedConfig.isProviderEnabled("codex")).toBe(false);
    });

    it("joins a concurrent scan and falls authentication verification back to inference", async () => {
        const installationRoot = await root();
        const started = deferred<void>();
        const release = deferred<void>();
        let resolutions = 0;
        const providers = new AgentProviders();
        providers.add(
            "gym",
            async () => {
                resolutions += 1;
                started.resolve(undefined);
                await release.promise;
                return new PassingProvider();
            },
            "gym",
        );
        const model = { ...MODEL, id: "gym/cheap", name: "Gym cheap", providerId: "gym" };
        const config = await ConfigModule.load(join(installationRoot, "happy"), {
            inference: { models: [model], providers },
        });
        const scan = new ProviderScanModule(config);

        const first = scan.scan(createRootContext());
        const second = scan.scan(createRootContext());
        await started.promise;
        expect(resolutions).toBe(1);
        release.resolve(undefined);
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult).toBe(secondResult);
        expect(firstResult.providers).toContainEqual({
            credentials: "available",
            enabled: true,
            enablement: "scan",
            providerId: "gym",
            remembered: true,
        });
        await expect(
            scan.verify(createRootContext(), "gym", "authentication"),
        ).resolves.toMatchObject({
            modelId: model.id,
            performedLevel: "inference",
            requestedLevel: "authentication",
            status: "passed",
        });
    });

    it("does not apply a live override when its durable write fails", async () => {
        const { config } = await scriptedConfig();
        const scan = new ProviderScanModule(config);
        await scan.open(createRootContext());
        const statePath = config.configuration.paths.runtimeConfigPath;
        await rm(statePath);
        await mkdir(statePath);

        await expect(
            scan.setOverrides(createRootContext(), { codex: { enabled: false } }),
        ).rejects.toThrow();
        expect(config.isProviderEnabled("codex")).toBe(true);
    });
});

async function scriptedConfig(): Promise<{ readonly config: ConfigModule; readonly root: string }> {
    const installationRoot = await root();
    return {
        config: await ConfigModule.load(join(installationRoot, "happy"), {
            inference: inference(),
        }),
        root: installationRoot,
    };
}

function inference(): ConfigInferenceOverride {
    return { models: [MODEL], providers: providersWith(new PassingProvider()) };
}

function providersWith(provider: BaseProvider): AgentProviders {
    const providers = new AgentProviders();
    providers.add("codex", provider, "codex");
    return providers;
}

async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), "provider-scan-"));
    roots.push(value);
    return value;
}

function isolatedProvidersToml(): string {
    return [
        "[providers.bedrock]",
        "credential_isolation = true",
        "[providers.claude]",
        "credential_isolation = true",
        "[providers.codex]",
        "credential_isolation = true",
        "[providers.grok]",
        "credential_isolation = true",
    ].join("\n");
}

class PassingProvider extends BaseProvider {
    async session(id: string, _options: SessionOptions): Promise<BaseSession> {
        return new PassingSession(id);
    }
}

class PassingSession extends BaseSession {
    constructor(id: string) {
        super(id);
    }

    run(_ctx: Context, _request: SessionRunRequest): SessionStream {
        return (async function* () {
            yield { state: "normal", tokens: { input: 1, output: 1 }, type: "done" } as const;
        })();
    }

    async compact(_ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        return { context: options.context, status: "cancelled" };
    }

    destroy(): void {}
}

function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}
