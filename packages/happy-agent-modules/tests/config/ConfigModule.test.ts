import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrokProvider, GrokSessionCredential } from "@slopus/happy-providers";
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
            globalConfigPath: join(root, "Happy", "Config", "happy.toml"),
            publicHome: join(root, "Happy"),
            runtimeConfigPath: join(root, ".happy", "agent", "runtime.toml"),
        });
        expect(configuration.sources.global.exists).toBe(false);
        expect(configuration.sources.runtime.exists).toBe(false);
        expect(configuration.values.defaults.modelId).toBe("openai/gpt-5.6-sol");
        expect(configuration.values.settings).toMatchObject({
            maxCollaborationDepth: 3,
            maxCollaborators: 5,
        });
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
                codex: { include_models: ["openai/gpt-5.6-sol"] },
            },
        });
        // The parser intentionally retains TOML spelling; only the resolved snapshot is ergonomic.
        expect(parsed.unknownSettings).toEqual([]);
    });

    it("replaces provider records by layer and applies default enablement", async () => {
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
            ["[providers]", "[providers.codex]", 'include_models = ["runtime-model"]'].join("\n"),
        );

        const configuration = (await ConfigModule.load(happyHome)).configuration;
        expect(configuration.values.providers.codex).toMatchObject({
            enabled: false,
            includeModels: ["runtime-model"],
            type: "codex",
        });
        expect(configuration.values.providers.codex).not.toHaveProperty("apiKey");
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
