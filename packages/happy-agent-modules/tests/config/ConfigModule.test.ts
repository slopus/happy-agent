import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrokProvider, GrokSessionCredential } from "@slopus/happy-providers";
import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    ConfigModule,
    loadHappyAgentConfiguration,
    parseHappyAgentConfigToml,
} from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("ConfigModule", () => {
    it("loads defaults when both configuration files are missing", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-"));
        temporaryDirectories.push(root);

        const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));

        expect(configuration.paths).toMatchObject({
            agentHome: join(root, ".happy", "agent"),
            docsHome: join(root, ".happy", "docs"),
            globalConfigPath: join(root, "Happy", "Config", "happy.toml"),
            publicHome: join(root, "Happy"),
            runtimeConfigPath: join(root, ".happy", "agent", "runtime.toml"),
        });
        expect(configuration.sources.global.exists).toBe(false);
        expect(configuration.sources.runtime.exists).toBe(false);
        expect(configuration.values.defaults.modelId).toBe("openai/gpt-5.6-sol");
        expect(configuration.values.features.crossWorkspace).toBe(true);
        expect(configuration.values.feature.codemode.enabled).toBe(false);
        expect(configuration.values.feature.codemode.engine).toBe("monty");
        expect(configuration.values.feature.tailcat).toEqual({ enabled: false });
        expect(configuration.values.feature.team).toEqual({
            enabled: false,
            host: "0.0.0.0",
            port: 3_000,
            workosClientId: "client_01KZD3XE9YAFAMT0P8TD4HP73E",
        });
        expect(configuration.values.settings).toMatchObject({
            ethan: { enabled: false },
            maxCollaborationDepth: 3,
            maxCollaborators: 5,
        });
    });

    it("loads Ethan mode from its nested machine setting", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-ethan-"));
        temporaryDirectories.push(root);
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            ["[settings.ethan]", "enabled = true"].join("\n"),
        );

        const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));

        expect(configuration.values.settings.ethan).toEqual({ enabled: true });
        expect(configuration.provenance["settings.ethan"]).toBe("global");
    });

    it("loads Code Mode from feature.codemode and attributes its nested setting", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-codemode-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            ["[feature.codemode]", "enabled = true", 'engine = "bun"', "unknown = true"].join("\n"),
        );

        const configuration = await loadHappyAgentConfiguration(happyHome);

        expect(configuration.values.feature.codemode.enabled).toBe(true);
        expect(configuration.values.feature.codemode.engine).toBe("bun");
        expect(configuration.provenance["feature.codemode.enabled"]).toBe("global");
        expect(configuration.provenance["feature.codemode.engine"]).toBe("global");
        expect(configuration.sources.global.unknownSettings).toEqual(["feature.codemode.unknown"]);
    });

    it("loads team mode from the machine configuration", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-team-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            [
                "[feature.team]",
                "enabled = true",
                'host = "127.0.0.1"',
                "port = 4321",
                'workos_client_id = "client_staging123"',
                'workos_organization_id = "org_staging123"',
                'owner_workos_user_id = "user_owner123"',
                "unknown = true",
            ].join("\n"),
        );

        const configuration = await loadHappyAgentConfiguration(happyHome);

        expect(configuration.values.feature.team).toEqual({
            enabled: true,
            host: "127.0.0.1",
            ownerWorkOSUserId: "user_owner123",
            port: 4_321,
            workosClientId: "client_staging123",
            workosOrganizationId: "org_staging123",
        });
        expect(configuration.provenance["feature.team.enabled"]).toBe("global");
        expect(configuration.provenance["feature.team.host"]).toBe("global");
        expect(configuration.provenance["feature.team.ownerWorkOSUserId"]).toBe("global");
        expect(configuration.provenance["feature.team.port"]).toBe("global");
        expect(configuration.provenance["feature.team.workosClientId"]).toBe("global");
        expect(configuration.provenance["feature.team.workosOrganizationId"]).toBe("global");
        expect(configuration.sources.global.unknownSettings).toEqual(["feature.team.unknown"]);
    });

    it("loads Tailcat exposure only from machine configuration", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-tailcat-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            ["[feature.tailcat]", "enabled = true", "unknown = true"].join("\n"),
        );

        const configuration = await loadHappyAgentConfiguration(happyHome);

        expect(configuration.values.feature.tailcat).toEqual({ enabled: true });
        expect(configuration.provenance["feature.tailcat.enabled"]).toBe("global");
        expect(configuration.sources.global.unknownSettings).toEqual(["feature.tailcat.unknown"]);
    });

    it("requires organization and owner identities when team mode is enabled", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-team-identities-"));
        temporaryDirectories.push(root);
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            ["[feature.team]", "enabled = true"].join("\n"),
        );

        await expect(loadHappyAgentConfiguration(join(root, ".happy"))).rejects.toThrow(
            "The merged Happy Agent configuration is invalid.",
        );
    });

    it("does not let a project configuration enable team mode", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-project-team-"));
        temporaryDirectories.push(root);
        const previous = process.cwd();
        await writeFile(join(root, "happy.toml"), "[feature.team]\nenabled = true\n");
        process.chdir(root);
        try {
            const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));
            expect(configuration.values.feature.team.enabled).toBe(false);
            expect(configuration.provenance["feature.team.enabled"]).toBeUndefined();
        } finally {
            process.chdir(previous);
        }
    });

    it("does not let a project configuration expose the daemon through Tailcat", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-project-tailcat-"));
        temporaryDirectories.push(root);
        const previous = process.cwd();
        await writeFile(join(root, "happy.toml"), "[feature.tailcat]\nenabled = true\n");
        process.chdir(root);
        try {
            const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));
            expect(configuration.values.feature.tailcat.enabled).toBe(false);
            expect(configuration.provenance["feature.tailcat.enabled"]).toBeUndefined();
        } finally {
            process.chdir(previous);
        }
    });

    it("writes collaborator controls into the starter Happy settings", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-template-"));
        temporaryDirectories.push(root);
        const module = await ConfigModule.load(join(root, ".happy"));

        await module.ensureUserConfigurationFiles();

        const source = await readFile(module.configuration.paths.globalConfigPath, "utf8");
        expect(source).toContain("# [settings]");
        expect(source).toContain("# max_collaborators = 5");
        expect(source).toContain("# max_collaboration_depth = 3");
        expect(source).toContain("# cross_workspace = true");
        expect(source).toContain("# [feature.codemode]");
        expect(source).toContain("# enabled = false");
        expect(source).toContain('# engine = "monty"');
        expect(source).toContain("# [feature.tailcat]");
        expect(source).toContain("# [feature.team]");
        expect(source).toContain('# host = "0.0.0.0"');
        expect(source).toContain("# port = 3000");
        expect(source).toContain('# workos_client_id = "client_01KZD3XE9YAFAMT0P8TD4HP73E"');
        expect(source).toContain('# workos_organization_id = "org_01EXAMPLE"');
        expect(source).toContain('# owner_workos_user_id = "user_01EXAMPLE"');
    });

    it("always generates runtime.toml even when it has no settings yet", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-runtime-empty-"));
        temporaryDirectories.push(root);
        const config = await ConfigModule.load(join(root, ".happy"));

        await config.writeRuntimeConfiguration(createRootContext());

        await expect(readFile(config.configuration.paths.runtimeConfigPath, "utf8")).resolves.toBe(
            "\n",
        );
    });

    it("merges global happy.toml with runtime.toml, with runtime winning", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-layers-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await mkdir(join(happyHome, "agent"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            [
                "[defaults]",
                'model = "global-model"',
                'provider = "global-provider"',
                "",
                "[settings]",
                "show_usage = true",
                "inference_max_retries = 2",
                "max_collaborators = 7",
                "max_collaboration_depth = 4",
                "",
                "[providers.codex]",
                'type = "codex"',
                "enabled = true",
            ].join("\n"),
        );
        await writeFile(
            join(happyHome, "agent", "runtime.toml"),
            ["[defaults]", 'model = "runtime-model"', "", "[settings]", "show_usage = false"].join(
                "\n",
            ),
        );

        const module = await ConfigModule.load(happyHome);

        expect(module.configuration.values.defaults).toMatchObject({
            modelId: "runtime-model",
            providerId: "global-provider",
        });
        expect(module.configuration.values.settings).toMatchObject({
            inferenceMaxRetries: 2,
            maxCollaborationDepth: 4,
            maxCollaborators: 7,
            showUsage: false,
        });
        expect(module.configuration.values.providers.codex).toMatchObject({
            enabled: true,
            type: "codex",
        });
        expect(module.configuration.provenance["settings.maxCollaborators"]).toBe("global");
        expect(module.configuration.provenance["settings.maxCollaborationDepth"]).toBe("global");
    });

    it("lets a scripted provider own its catalog after compatibility state is restored", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-scripted-catalog-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        await mkdir(join(happyHome, "agent"), { recursive: true });
        await writeFile(
            join(happyHome, "agent", "runtime.toml"),
            ["[providers.gym]", 'type = "codex"', "enabled = true"].join("\n"),
        );
        const models: readonly AgentModel[] = [
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "gym/model",
                name: "Gym Model",
                providerId: "gym",
            },
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "gym/model-2",
                name: "Gym Model Two",
                providerId: "gym",
            },
        ];
        const module = await ConfigModule.load(happyHome, {
            inference: { models, providers: new AgentProviders() },
        });

        expect(
            module.catalog.filter((model) => model.providerId === "gym").map((model) => model.id),
        ).toEqual(["gym/model", "gym/model-2"]);
    });

    it("offers Fable 5.1 through Claude with its full context and effort ladder", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-fable-5-1-catalog-"));
        temporaryDirectories.push(root);
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            "[providers.claude]\nenabled = true\n\n[providers.bedrock]\nenabled = true\n",
        );

        const module = await ConfigModule.load(join(root, ".happy"));

        expect(
            module.catalog.find(
                (model) => model.providerId === "claude" && model.id === "anthropic/fable-5-1",
            ),
        ).toMatchObject({
            contextWindow: 1_000_000,
            defaultEffort: "medium",
            effortLevels: ["off", "low", "medium", "high", "xhigh", "max"],
            enabled: true,
            name: "Fable 5.1",
        });
        expect(
            module.catalog.some(
                (model) => model.providerId === "bedrock" && model.id === "anthropic/fable-5-1",
            ),
        ).toBe(false);
    });

    it("offers GPT-6 Astra only through Codex with Happy's operating profile", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-gpt-6-astra-catalog-"));
        temporaryDirectories.push(root);
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            "[providers.codex]\nenabled = true\n\n[providers.bedrock]\nenabled = true\n",
        );

        const module = await ConfigModule.load(join(root, ".happy"));

        expect(
            module.catalog.find(
                (model) => model.providerId === "codex" && model.id === "openai/gpt-6-astra",
            ),
        ).toMatchObject({
            contextWindow: 272_000,
            defaultEffort: "high",
            effortLevels: ["low", "medium", "high", "xhigh", "max"],
            enabled: true,
            name: "GPT-6 Astra",
            serviceTiers: ["priority"],
        });
        expect(module.modelContext("codex", "openai/gpt-6-astra")).toEqual({
            contextWindow: 272_000,
            autoCompactWindow: 244_800,
        });
        expect(
            module.catalog.some(
                (model) => model.providerId === "bedrock" && model.id === "openai/gpt-6-astra",
            ),
        ).toBe(false);
    });

    it("ignores unknown TOML fields while retaining their source locations", () => {
        const parsed = parseHappyAgentConfigToml(
            ["unknown = true", "[settings]", "show_usage = true", "show_usgae = false"].join("\n"),
        );

        expect(parsed.values.settings).toEqual({ show_usage: true });
        expect(parsed.unknownSettings).toEqual(["unknown", "settings.show_usgae"]);
    });

    it("rejects malformed TOML and invalid known values", async () => {
        expect(() => parseHappyAgentConfigToml("[settings\nshow_usage = true")).toThrow();
        expect(() => parseHappyAgentConfigToml('[settings]\nshow_usage = "yes"')).toThrow(
            "invalid value",
        );
        expect(() => parseHappyAgentConfigToml("[settings]\nmax_collaborators = 0")).toThrow(
            "invalid value",
        );
        expect(() => parseHappyAgentConfigToml("[settings]\nmax_collaboration_depth = 65")).toThrow(
            "invalid value",
        );
        expect(() => parseHappyAgentConfigToml('[feature.codemode]\nengine = "unknown"')).toThrow(
            "invalid value",
        );

        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-invalid-"));
        temporaryDirectories.push(root);
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            '[settings]\nshow_usage = "yes"\n',
        );
        await expect(ConfigModule.load(join(root, ".happy"))).rejects.toThrow(
            "Could not read Happy Agent configuration",
        );
    });

    it("returns the same frozen snapshot through the module and loader", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-snapshot-"));
        temporaryDirectories.push(root);
        const module = await ConfigModule.load(join(root, ".happy"));
        const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));

        expect(Object.isFrozen(module.configuration)).toBe(true);
        expect(Object.isFrozen(module.configuration.values.defaults)).toBe(true);
        expect(Object.isFrozen(module.configuration.values.providers.codex)).toBe(true);
        expect(module.configuration.paths).not.toBe(configuration.paths);
        expect(module.configuration.values).toEqual(configuration.values);
    });

    it("loads the project happy.toml layer and filters machine settings", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-project-"));
        temporaryDirectories.push(root);
        await writeFile(
            join(root, "happy.toml"),
            [
                "[defaults]",
                'model = "project-model"',
                'permission_mode = "full_access"',
                "",
                "[settings]",
                "show_usage = true",
                "inference_max_retries = 20",
                "max_collaborators = 100",
                "max_collaboration_depth = 20",
                "",
                "[settings.ethan]",
                "enabled = true",
                "",
                "[workspace]",
                'setup_commands = ["pnpm install"]',
            ].join("\n"),
        );

        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            const configuration = (await ConfigModule.load(join(root, ".happy"))).configuration;

            expect(configuration.sources.local).toMatchObject({
                exists: true,
                path: join(process.cwd(), "happy.toml"),
            });
            expect(configuration.values.defaults).toMatchObject({
                modelId: "project-model",
                permissionMode: "auto",
            });
            expect(configuration.values.settings).toMatchObject({
                ethan: { enabled: false },
                inferenceMaxRetries: 10,
                maxCollaborationDepth: 3,
                maxCollaborators: 5,
                showUsage: true,
            });
            expect(configuration.values.workspace.setupCommands).toEqual(["pnpm install"]);
            expect(configuration.provenance["defaults.modelId"]).toBe("local");
        } finally {
            process.chdir(previousCwd);
        }
    });

    it("prefers the configured Gemini key over the environment", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-gemini-"));
        temporaryDirectories.push(root);
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            ["[gemini]", 'api_key = "configured-gemini-key"'].join("\n"),
        );

        const module = await ConfigModule.load(join(root, ".happy"), {
            environment: { GEMINI_API_KEY: "environment-gemini-key" },
        });

        expect(module.geminiApiKey).toBe("configured-gemini-key");
        expect(module.configuration.provenance.gemini).toBe("global");
    });

    it("falls back to the GEMINI_API_KEY environment variable without a configured key", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-gemini-env-"));
        temporaryDirectories.push(root);

        const module = await ConfigModule.load(join(root, ".happy"), {
            environment: { GEMINI_API_KEY: "environment-gemini-key" },
        });

        expect(module.geminiApiKey).toBe("environment-gemini-key");
    });

    it("ignores a Gemini key written in a project happy.toml", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-gemini-project-"));
        temporaryDirectories.push(root);
        await writeFile(
            join(root, "happy.toml"),
            ["[gemini]", 'api_key = "project-gemini-key"'].join("\n"),
        );

        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            const module = await ConfigModule.load(join(root, ".happy"));

            expect(module.geminiApiKey).toBeUndefined();
        } finally {
            process.chdir(previousCwd);
        }
    });

    it("resolves the complete Happy Agent-shaped configuration into bounded camelCase values", () => {
        const parsed = parseHappyAgentConfigToml(
            [
                "[defaults]",
                'service_tier = "fast"',
                "",
                "[features]",
                "cross_workspace = true",
                "",
                "[docker]",
                'image = "node:22"',
                'workdir = "/workspace/project"',
                "",
                "[network]",
                "allow_local_binding = true",
                "allowed_ports = [8080]",
                "",
                "[permissions]",
                'protected_paths = [".env"]',
                "",
                "[providers]",
                "default_enable = false",
                "[providers.codex]",
                'api_key = "secret"',
                "auto_enable = true",
                'include_models = ["openai/gpt-5.6-sol"]',
                "",
                "[providers.bedrock]",
                'config_file = "/tmp/aws-config"',
                'credentials_file = "/tmp/aws-credentials"',
                'profile = "work-bedrock"',
                'region = "us-east-1"',
                'search_model = "openai.gpt-oss-120b"',
                "",
                "[workspace]",
                'sync = [".env.example"]',
            ].join("\n"),
        );

        expect(parsed.values).toMatchObject({
            defaults: { service_tier: "fast" },
            docker: { image: "node:22" },
            features: { cross_workspace: true },
            provider_default_enable: false,
            providers: {
                bedrock: {
                    config_file: "/tmp/aws-config",
                    credentials_file: "/tmp/aws-credentials",
                    profile: "work-bedrock",
                    region: "us-east-1",
                },
                codex: {
                    auto_enable: true,
                    include_models: ["openai/gpt-5.6-sol"],
                },
            },
        });
        // The parser intentionally retains TOML spelling; only the resolved snapshot is ergonomic.
        expect(parsed.unknownSettings).toEqual([]);
    });

    it("merges provider records by layer and applies default enablement", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-providers-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await mkdir(join(happyHome, "agent"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            [
                "[providers]",
                "default_enable = false",
                "[providers.codex]",
                'api_key = "secret"',
            ].join("\n"),
        );
        await writeFile(
            join(happyHome, "agent", "runtime.toml"),
            [
                "[providers]",
                "[providers.codex]",
                "auto_enable = true",
                'include_models = ["runtime-model"]',
            ].join("\n"),
        );

        const configuration = (await ConfigModule.load(happyHome)).configuration;
        expect(configuration.values.providers.codex).toMatchObject({
            enabled: false,
            autoEnable: true,
            includeModels: ["runtime-model"],
            apiKey: "secret",
            type: "codex",
        });
    });

    it("rewrites daemon runtime state without losing other runtime settings", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-runtime-state-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        await mkdir(join(happyHome, "agent"), { recursive: true });
        await writeFile(
            join(happyHome, "agent", "runtime.toml"),
            "[settings]\nshow_usage = true\n",
        );
        const config = await ConfigModule.load(happyHome);

        await config.updateRuntimeProviderStates(createRootContext(), {
            codex: { autoEnable: true, enabled: false },
        });

        const source = await readFile(config.configuration.paths.runtimeConfigPath, "utf8");
        const parsed = parseHappyAgentConfigToml(source);
        expect(parsed.values.settings).toMatchObject({ show_usage: true });
        expect(parsed.values.providers?.codex).toMatchObject({
            auto_enable: true,
            enabled: false,
        });
    });

    it("uses the ambient Grok CLI session without an explicit auth file", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-grok-session-"));
        temporaryDirectories.push(root);
        await writeFile(
            join(root, "auth.json"),
            JSON.stringify({
                "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
                    key: "grok-session-token",
                },
            }),
        );
        vi.stubEnv("GROK_HOME", root);
        vi.stubEnv("XAI_API_KEY", "");

        const config = await ConfigModule.load(join(root, ".happy"));
        config.setProviderEnabled("grok", true);
        const provider = await config.providers.resolve("grok", "xai/grok-4.6");

        expect(provider).toBeInstanceOf(GrokProvider);
        expect((provider as GrokProvider).credential).toBeInstanceOf(GrokSessionCredential);
    });

    it("rejects a TOML date table for a known scalar and bounds unknown metadata", () => {
        expect(() => parseHappyAgentConfigToml("[defaults.model]\nvalue = true")).toThrow();
        const source = Array.from({ length: 300 }, (_, index) => `unknown_${index} = true`).join(
            "\n",
        );
        const parsed = parseHappyAgentConfigToml(source);
        expect(parsed.unknownSettings).toHaveLength(256);
        expect(parsed.unknownSettingsTruncated).toBe(true);
    });

    it("defaults observation to logging only, with nothing leaving the machine", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-observation-"));
        temporaryDirectories.push(root);

        const configuration = (await ConfigModule.load(join(root, ".happy"))).configuration;

        expect(configuration.values.observation).toEqual({
            historyDump: false,
            logLevel: "info",
            logs: true,
            traces: false,
            tracesEndpoint: "http://127.0.0.1:4318/v1/traces",
        });
        expect(configuration.paths).toMatchObject({
            historyDumpHome: join(root, ".happy", "agent", "observation", "history"),
            logPath: join(root, ".happy", "agent", "observation", "agent.log"),
            observationHome: join(root, ".happy", "agent", "observation"),
        });
    });

    it("reads an [observation] section and records where each field came from", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-observation-layers-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        await mkdir(join(root, "Happy", "Config"), { recursive: true });
        await mkdir(join(happyHome, "agent"), { recursive: true });
        await writeFile(
            join(root, "Happy", "Config", "happy.toml"),
            [
                "[observation]",
                "history_dump = true",
                'log_level = "debug"',
                "traces = true",
                'traces_endpoint = "https://collector.internal:4318/v1/traces"',
            ].join("\n"),
        );
        await writeFile(
            join(happyHome, "agent", "runtime.toml"),
            ["[observation]", 'log_level = "warn"'].join("\n"),
        );

        const configuration = (await ConfigModule.load(happyHome)).configuration;

        expect(configuration.values.observation).toEqual({
            historyDump: true,
            logLevel: "warn",
            logs: true,
            traces: true,
            tracesEndpoint: "https://collector.internal:4318/v1/traces",
        });
        expect(configuration.provenance["observation.logLevel"]).toBe("runtime");
        expect(configuration.provenance["observation.historyDump"]).toBe("global");
    });

    it("ignores an [observation] section in a project file", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-config-observation-project-"));
        temporaryDirectories.push(root);
        await writeFile(
            join(root, "happy.toml"),
            [
                "[observation]",
                "traces = true",
                'traces_endpoint = "https://exfiltrate.example.com/v1/traces"',
            ].join("\n"),
        );

        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            const configuration = (await ConfigModule.load(join(root, ".happy"))).configuration;

            expect(configuration.values.observation).toMatchObject({
                traces: false,
                tracesEndpoint: "http://127.0.0.1:4318/v1/traces",
            });
            expect(configuration.provenance).not.toHaveProperty("observation");
        } finally {
            process.chdir(previousCwd);
        }
    });

    it("rejects an observation endpoint that is not an HTTP URL", () => {
        expect(() =>
            parseHappyAgentConfigToml('[observation]\ntraces_endpoint = "collector.internal"'),
        ).toThrow();
        expect(() => parseHappyAgentConfigToml('[observation]\nlog_level = "verbose"')).toThrow();
    });
});
