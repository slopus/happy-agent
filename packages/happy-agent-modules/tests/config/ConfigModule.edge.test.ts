import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import {
    ConfigModule,
    happyAgentConfigSourceSchema,
    happyAgentConfigValuesSchema,
    happyAgentConfigurationInputSchema,
    happyAgentConfigurationPathsSchema,
    happyAgentConfigurationSchema,
    loadHappyAgentConfiguration,
    parseHappyAgentConfigToml,
} from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function temporaryRoot(prefix = "happy-agent-config-edge-"): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(root);
    return root;
}

async function writeLayer(root: string, relativePath: string, source: string): Promise<void> {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source);
}

function expectParseError(source: string, message?: string): void {
    if (message === undefined) {
        expect(() => parseHappyAgentConfigToml(source)).toThrow();
    } else {
        expect(() => parseHappyAgentConfigToml(source)).toThrow(message);
    }
}

async function expectGlobalLoadError(source: string, message?: string): Promise<void> {
    const root = await temporaryRoot("happy-agent-config-invalid-layer-");
    await writeLayer(root, "Happy/Config/happy.toml", source);
    const assertion = expect(ConfigModule.load(join(root, ".happy"))).rejects;
    if (message === undefined) {
        await assertion.toThrow();
    } else {
        await assertion.toThrow(message);
    }
}

describe("ConfigModule edge coverage", () => {
    describe("paths and module hooks", () => {
        it("keeps the public root input schema closed over unsupported runtime values", () => {
            expect(Value.Check(happyAgentConfigurationInputSchema, undefined)).toBe(true);
            expect(Value.Check(happyAgentConfigurationInputSchema, "/tmp/.happy")).toBe(true);
            expect(Value.Check(happyAgentConfigurationInputSchema, null)).toBe(false);
            expect(Value.Check(happyAgentConfigurationInputSchema, 42)).toBe(false);
            expect(Value.Check(happyAgentConfigurationInputSchema, {})).toBe(false);
            expect(Value.Check(happyAgentConfigurationInputSchema, "")).toBe(false);
        });

        it("rejects empty, NUL-containing, and overlong Happy roots before reading files", async () => {
            await expect(ConfigModule.load("" as never)).rejects.toThrow(
                "The Happy root path must be a non-empty path.",
            );
            await expect(ConfigModule.load("\u0000" as never)).rejects.toThrow(
                "The Happy root path must be a non-empty path.",
            );
            await expect(ConfigModule.load("a".repeat(4_097) as never)).rejects.toThrow(
                "The Happy root path must be a non-empty path.",
            );
        });

        it("exposes only a bounded Git discovery ceiling from the configured environment", async () => {
            const root = await temporaryRoot();
            const configured = await ConfigModule.load(join(root, ".happy"), {
                environment: {
                    GIT_CEILING_DIRECTORIES: "  /tmp/happy-git-ceiling  ",
                    PRIVATE_FIXTURE_SECRET: "must-not-cross-the-module-seam",
                },
            });
            const overlong = await ConfigModule.load(join(root, ".happy-overlong"), {
                environment: { GIT_CEILING_DIRECTORIES: "x".repeat(16_385) },
            });

            expect(configured.gitCeilingDirectories).toBe("/tmp/happy-git-ceiling");
            expect(overlong.gitCeilingDirectories).toBeUndefined();
            expect("environment" in configured).toBe(false);
        });

        it("recognizes AWS credential material without treating a region-only config as Bedrock credentials", async () => {
            const root = await temporaryRoot();
            const configFile = join(root, ".aws", "config");
            const credentialsFile = join(root, ".aws", "credentials");
            await writeLayer(root, ".aws/config", "[default]\nregion = us-east-1\n");
            const environment = {
                AWS_ACCESS_KEY_ID: "",
                AWS_BEARER_TOKEN_BEDROCK: "",
                AWS_CONFIG_FILE: configFile,
                AWS_CONTAINER_CREDENTIALS_FULL_URI: "",
                AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "",
                AWS_ROLE_ARN: "",
                AWS_SECRET_ACCESS_KEY: "",
                AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
                AWS_WEB_IDENTITY_TOKEN_FILE: "",
                HOME: root,
            };
            const regionOnly = await ConfigModule.load(join(root, ".happy-region"), {
                environment,
            });

            await expect(regionOnly.probeLocalProviderCredentials("bedrock")).resolves.toBe(
                "missing",
            );

            await writeLayer(
                root,
                ".aws/credentials",
                "[default]\naws_access_key_id = local-key\naws_secret_access_key = local-secret\n",
            );
            const withCredentials = await ConfigModule.load(join(root, ".happy-credentials"), {
                environment,
            });
            await expect(withCredentials.probeLocalProviderCredentials("bedrock")).resolves.toBe(
                "available",
            );
        });

        it("resolves relative roots and derives the complete immutable path set", async () => {
            const root = await temporaryRoot();
            const relativeRoot = join(process.cwd(), ".context", `config-relative-${Date.now()}`);
            await mkdir(relativeRoot, { recursive: true });
            temporaryDirectories.push(relativeRoot);
            const relative = await loadHappyAgentConfiguration(
                `.context/${relativeRoot.split("/").pop()}`,
            );

            expect(Value.Check(happyAgentConfigurationInputSchema, root)).toBe(true);
            expect(relative.paths.happyHome).toBe(resolve(relativeRoot));
            const explicit = await loadHappyAgentConfiguration(join(root, ".happy"));
            expect(explicit.paths).toEqual({
                agentHome: join(root, ".happy", "agent"),
                agentLockPath: join(root, ".happy", "agent", "agent.lock"),
                autoAgentLockPath: join(root, ".happy", "agent", "auto-agent.lock"),
                autoDatabasePath: join(root, ".happy", "agent", "auto-agent.sqlite"),
                configHome: join(root, "Happy", "Config"),
                databasePath: join(root, ".happy", "agent", "agent.sqlite"),
                docsHome: join(root, ".happy", "docs"),
                generatedPath: join(root, "Happy", "Generated"),
                globalConfigPath: join(root, "Happy", "Config", "happy.toml"),
                happyHome: join(root, ".happy"),
                historyDumpHome: join(root, ".happy", "agent", "observation", "history"),
                instructionsPath: join(root, "Happy", "Config", "AGENTS.md"),
                localConfigPath: resolve(process.cwd(), "happy.toml"),
                logPath: join(root, ".happy", "agent", "observation", "agent.log"),
                observationHome: join(root, ".happy", "agent", "observation"),
                pidPath: join(root, ".happy", "agent", "daemon.pid"),
                publicHome: join(root, "Happy"),
                runtimeConfigPath: join(root, ".happy", "agent", "runtime.toml"),
                securityPath: join(root, "Happy", "Config", "SECURITY.md"),
                socketPath: join(root, ".happy", "agent", "server.sock"),
                tokenPath: join(root, ".happy", "agent", "token"),
            });
            expect(Value.Check(happyAgentConfigurationPathsSchema, explicit.paths)).toBe(true);
            expect(Object.isFrozen(explicit.paths)).toBe(true);
        });

        it("expands tilde roots using the current home directory", async () => {
            const root = await temporaryRoot();
            const tildeRoot = `~/${root.split("/").pop()}`;
            const configuration = await loadHappyAgentConfiguration(tildeRoot);

            expect(configuration.paths.happyHome).toBe(join(homedir(), root.split("/").pop()!));
        });

        it("exposes configured instructions through the normal module hook", async () => {
            const root = await temporaryRoot();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                '[defaults]\ninstructions = "Be concise."\n',
            );
            const module = await ConfigModule.load(join(root, ".happy"));
            const hooks = module.beforeStart();
            const instructions = await (
                hooks.instructions as unknown as (...args: readonly unknown[]) => Promise<string>
            )(undefined, undefined);

            expect(instructions).toBe("Be concise.");
        });

        it("returns an empty instruction string when no instructions are configured", async () => {
            const root = await temporaryRoot();
            const module = await ConfigModule.load(join(root, ".happy"));
            const hooks = module.beforeStart();
            const instructions = await (
                hooks.instructions as unknown as (...args: readonly unknown[]) => Promise<string>
            )(undefined, undefined);

            expect(instructions).toBe("");
        });
    });

    describe("source selection and merging", () => {
        it("uses project happy.toml", async () => {
            const root = await temporaryRoot();
            await writeLayer(root, "happy.toml", '[defaults]\nmodel = "fallback"\n');
            const previousCwd = process.cwd();
            process.chdir(root);
            try {
                const configuration = (await ConfigModule.load(join(root, ".happy"))).configuration;
                expect(configuration.sources.local).toMatchObject({
                    exists: true,
                    path: join(process.cwd(), "happy.toml"),
                });
                expect(configuration.values.defaults.modelId).toBe("fallback");
            } finally {
                process.chdir(previousCwd);
            }
        });

        it("ignores rig.toml when project happy.toml exists", async () => {
            const root = await temporaryRoot();
            await writeLayer(root, "happy.toml", '[defaults]\nmodel = "fallback"\n');
            await writeLayer(root, "rig.toml", '[defaults]\nmodel = "preferred"\n');
            const previousCwd = process.cwd();
            process.chdir(root);
            try {
                const configuration = (await ConfigModule.load(join(root, ".happy"))).configuration;
                expect(configuration.sources.local.path).toBe(join(process.cwd(), "happy.toml"));
                expect(configuration.values.defaults.modelId).toBe("fallback");
            } finally {
                process.chdir(previousCwd);
            }
        });

        it("retains local machine settings in the source snapshot but removes them from resolved values", async () => {
            const root = await temporaryRoot();
            await writeLayer(
                root,
                "happy.toml",
                [
                    "[defaults]",
                    'model = "project-model"',
                    'provider = "project-provider"',
                    'permission_mode = "full_access"',
                    "",
                    "[settings]",
                    "daemon_heap_snapshots = true",
                    "durable_global_event_queue = true",
                    "happy_integration = false",
                    "inference_max_retries = 1",
                    "menu_bar = false",
                    "tool_result_retention_days = 1",
                    "",
                    "[providers.codex]",
                    'api_key = "secret"',
                    "",
                    "[observation]",
                    "traces = true",
                ].join("\n"),
            );
            const previousCwd = process.cwd();
            process.chdir(root);
            try {
                const configuration = (await ConfigModule.load(join(root, ".happy"))).configuration;

                expect(configuration.sources.local.values).toMatchObject({
                    defaults: {
                        modelId: "project-model",
                        permissionMode: "full_access",
                        providerId: "project-provider",
                    },
                    observation: {
                        traces: true,
                    },
                    providers: {
                        codex: {
                            apiKey: "secret",
                            type: "codex",
                        },
                    },
                    settings: {
                        daemonHeapSnapshots: true,
                        durableGlobalEventQueue: true,
                        happyIntegration: false,
                        inferenceMaxRetries: 1,
                        menuBar: false,
                        toolResultRetentionDays: 1,
                    },
                });
                expect(configuration.values.defaults).toMatchObject({
                    modelId: "project-model",
                    permissionMode: "auto",
                    providerId: "project-provider",
                });
                expect(configuration.values.settings).toMatchObject({
                    daemonHeapSnapshots: false,
                    durableGlobalEventQueue: false,
                    happyIntegration: true,
                    inferenceMaxRetries: 10,
                    menuBar: true,
                    toolResultRetentionDays: 7,
                });
                expect(configuration.values).not.toHaveProperty("observation.traces", true);
                expect(configuration.values.providers.codex).toEqual({
                    enabled: false,
                    type: "codex",
                });
                expect(configuration.provenance).not.toHaveProperty("providers");
                expect(configuration.provenance).not.toHaveProperty("observation");
                expect(configuration.provenance).not.toHaveProperty("settings.inferenceMaxRetries");
            } finally {
                process.chdir(previousCwd);
            }
        });

        it("preserves source unknown metadata and truncation flags through loading", async () => {
            const root = await temporaryRoot();
            const unknown = Array.from(
                { length: 300 },
                (_, index) => `unknown_setting_${index} = true`,
            ).join("\n");
            await writeLayer(root, "Happy/Config/happy.toml", unknown);
            const source = (await ConfigModule.load(join(root, ".happy"))).configuration.sources
                .global;
            expect(source.unknownSettings).toHaveLength(256);
            expect(source.unknownSettings[0]).toBe("unknown_setting_0");
            expect(source.unknownSettingsTruncated).toBe(true);
            expect(Object.isFrozen(source.unknownSettings)).toBe(true);
        });

        it("merges nested MCP, presence, permissions, and P2P values by their documented rules", async () => {
            const root = await temporaryRoot();
            const happyHome = join(root, ".happy");
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                [
                    "[permissions]",
                    'protected_paths = [".env", "secrets"]',
                    "",
                    "[p2p]",
                    "enable_iroh = false",
                    "[p2p.direct]",
                    'listen = "127.0.0.1:9000"',
                    "",
                    "[presence]",
                    'fallback = "away"',
                    "until = 1",
                    "[presence.states.busy]",
                    'title = "Busy"',
                    'answer_wait = "2 seconds"',
                    "",
                    "[mcp_servers.docs]",
                    'command = "docs-server"',
                    "startup_timeout_sec = 0.001",
                    "",
                    "[mcp_servers.remote]",
                    'url = "https://example.test/mcp"',
                    "tool_timeout_sec = 2",
                ].join("\n"),
            );
            await writeLayer(
                root,
                ".happy/agent/runtime.toml",
                [
                    "[permissions]",
                    'protected_paths = ["secrets", "runtime.env"]',
                    "",
                    "[p2p]",
                    "role = 'secondary'",
                    'primary_id = "primary1"',
                    "[p2p.iroh]",
                    'relay_url = "https://relay.example.test"',
                    "",
                    "[presence]",
                    'current = "working"',
                    "[presence.states.busy]",
                    'answer_wait = "none"',
                    'emoji = "⏳"',
                ].join("\n"),
            );
            const configuration = (await ConfigModule.load(happyHome)).configuration;

            expect(configuration.values.permissions.protectedPaths).toEqual([
                ".env",
                "secrets",
                "runtime.env",
            ]);
            expect(configuration.values.p2p).toMatchObject({
                direct: { listen: "127.0.0.1:9000" },
                enableIroh: false,
                iroh: { relayUrl: "https://relay.example.test" },
                primaryId: "primary1",
                role: "secondary",
            });
            expect(configuration.values.presence).toMatchObject({
                current: "working",
                states: {
                    busy: {
                        answerWaitMs: 0,
                        emoji: "⏳",
                        title: "Busy",
                    },
                },
            });
            expect(configuration.values.mcpServers).toEqual({
                docs: {
                    command: "docs-server",
                    startupTimeoutMs: 1,
                    transport: "stdio",
                },
                remote: {
                    toolTimeoutMs: 2_000,
                    transport: "http",
                    url: "https://example.test/mcp",
                },
            });
        });

        it("resolves every supported section into the ergonomic snapshot shape", async () => {
            const root = await temporaryRoot();
            const previousCwd = process.cwd();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                [
                    "[defaults]",
                    'effort = "high"',
                    'instructions = "Use short answers."',
                    'model = "model-1"',
                    'permission_mode = "workspace_write"',
                    'provider = "codex"',
                    'service_tier = "fast"',
                    "",
                    "[features]",
                    "cross_workspace = true",
                    "workflows = false",
                    "workspaces = false",
                    "",
                    "[docker]",
                    'image = "node:22"',
                    'workdir = "/workspace/project"',
                    'env = { NODE_ENV = "test" }',
                    'mounts = [{ source = "/tmp/project", target = "/workspace/project", read_only = true }]',
                    "",
                    "[network]",
                    "allow_local_binding = true",
                    'allowed_domains = ["example.test"]',
                    "allowed_loopback_ports = [1, 65535]",
                    "allowed_ports = [443]",
                    'denied_domains = ["blocked.test"]',
                    "",
                    "[observation]",
                    "history_dump = true",
                    'log_level = "debug"',
                    "logs = false",
                    "traces = true",
                    'traces_endpoint = "https://collector.example.test/v1/traces"',
                    "",
                    "[p2p]",
                    "enable_direct = true",
                    "enable_iroh = false",
                    "enable_ssh = true",
                    "expose_api = true",
                    'name = "My Happy Agent 🚀"',
                    "[p2p.direct]",
                    'listen = "127.0.0.1:9000"',
                    "[p2p.iroh]",
                    'relay_url = "https://relay.example.test"',
                    "",
                    "[permissions]",
                    'protected_paths = [".env"]',
                    "",
                    "[presence]",
                    'current = "online"',
                    'fallback = "away"',
                    "until = 1234",
                    "[presence.states.online]",
                    'answer_wait = "unlimited"',
                    'emoji = "🟢"',
                    'prompt = "The human is available."',
                    'title = "Online"',
                    "",
                    "[providers]",
                    "default_enable = false",
                    "[providers.codex]",
                    "enabled = true",
                    "credential_isolation = true",
                    'api_key = "secret"',
                    'auth_file = "/tmp/auth.json"',
                    'base_url = "https://api.example.test"',
                    'exclude_models = ["slow-model"]',
                    'include_models = ["model-1"]',
                    'p2p_share = "shared"',
                    'transport = "sse"',
                    "",
                    "[settings]",
                    "compact_completed_turns = true",
                    "completion_chime = true",
                    "daemon_heap_snapshots = true",
                    "durable_global_event_queue = true",
                    "happy_integration = false",
                    "inference_max_retries = 100",
                    "show_reasoning = true",
                    "show_usage = true",
                    "tool_result_retention_days = 36500",
                    "",
                    "[theme]",
                    'accent = "blue"',
                    'brand = "ansi:33"',
                    'error = "magenta"',
                    'primary = "white"',
                    'secondary = "gray"',
                    'success = "bright_green"',
                    'warning = "bright_yellow"',
                    "",
                    "[workspace]",
                    "keep_copies_on_archive = false",
                    "keep_worktrees_on_archive = true",
                    'protected_sync = [".env"]',
                    'setup_commands = ["pnpm install"]',
                    'sync = [".env.example"]',
                    "",
                    "[mcp_servers.stdio]",
                    'command = "docs-server"',
                    'args = ["--stdio"]',
                    "enabled = true",
                    "startup_timeout_sec = 1",
                    "tool_timeout_sec = 2",
                    "",
                    "[mcp_servers.http]",
                    'url = "https://mcp.example.test"',
                    "enabled = false",
                    'http_headers = { X_Test = "yes" }',
                    'oauth_scopes = ["read"]',
                    "startup_timeout_sec = 3",
                    "tool_timeout_sec = 4",
                ].join("\n"),
            );
            process.chdir(root);
            try {
                const values = (await ConfigModule.load(join(root, ".happy"))).configuration.values;
                expect(values).toMatchObject({
                    defaults: {
                        effort: "high",
                        instructions: "Use short answers.",
                        modelId: "model-1",
                        permissionMode: "workspace_write",
                        providerId: "codex",
                        serviceTier: "fast",
                    },
                    features: { crossWorkspace: true, workflows: false, workspaces: false },
                    docker: {
                        environment: { NODE_ENV: "test" },
                        image: "node:22",
                        mounts: [
                            {
                                readOnly: true,
                                source: "/tmp/project",
                                target: "/workspace/project",
                            },
                        ],
                        workingDirectory: "/workspace/project",
                    },
                    network: {
                        allowLocalBinding: true,
                        allowedDomains: ["example.test"],
                        allowedLoopbackPorts: [1, 65535],
                        allowedPorts: [443],
                        deniedDomains: ["blocked.test"],
                    },
                    observation: {
                        historyDump: true,
                        logLevel: "debug",
                        logs: false,
                        traces: true,
                        tracesEndpoint: "https://collector.example.test/v1/traces",
                    },
                    p2p: {
                        direct: { listen: "127.0.0.1:9000" },
                        enableDirect: true,
                        enableIroh: false,
                        enableSsh: true,
                        exposeApi: true,
                        iroh: { relayUrl: "https://relay.example.test" },
                        name: "My Happy Agent 🚀",
                        role: "primary",
                    },
                    permissions: { protectedPaths: [".env"] },
                    presence: {
                        current: "online",
                        fallback: "away",
                        states: {
                            online: {
                                answerWaitMs: null,
                                emoji: "🟢",
                                prompt: "The human is available.",
                                title: "Online",
                            },
                        },
                        until: 1234,
                    },
                    providerDefaultEnable: false,
                    providers: {
                        codex: {
                            apiKey: "secret",
                            authFile: "/tmp/auth.json",
                            baseUrl: "https://api.example.test",
                            credentialIsolation: true,
                            enabled: true,
                            excludeModels: ["slow-model"],
                            includeModels: ["model-1"],
                            p2pShare: "shared",
                            transport: "sse",
                            type: "codex",
                        },
                    },
                    settings: {
                        compactCompletedTurns: true,
                        completionChime: true,
                        daemonHeapSnapshots: true,
                        durableGlobalEventQueue: true,
                        happyIntegration: false,
                        inferenceMaxRetries: 100,
                        showReasoning: true,
                        showUsage: true,
                        toolResultRetentionDays: 36500,
                    },
                    theme: {
                        accent: "blue",
                        brand: "ansi:33",
                        error: "magenta",
                        primary: "white",
                        secondary: "gray",
                        success: "bright_green",
                        warning: "bright_yellow",
                    },
                    workspace: {
                        keepCopiesOnArchive: false,
                        keepWorktreesOnArchive: true,
                        protectedSync: [".env"],
                        setupCommands: ["pnpm install"],
                        sync: [".env.example"],
                    },
                });
                expect(values.mcpServers).toEqual({
                    http: {
                        enabled: false,
                        headers: { X_Test: "yes" },
                        oauthScopes: ["read"],
                        startupTimeoutMs: 3_000,
                        toolTimeoutMs: 4_000,
                        transport: "http",
                        url: "https://mcp.example.test",
                    },
                    stdio: {
                        args: ["--stdio"],
                        command: "docs-server",
                        enabled: true,
                        startupTimeoutMs: 1_000,
                        toolTimeoutMs: 2_000,
                        transport: "stdio",
                    },
                });
            } finally {
                process.chdir(previousCwd);
            }
        });

        it("applies provider default enablement while preserving explicit overrides", async () => {
            const root = await temporaryRoot();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                [
                    "[providers]",
                    "default_enable = false",
                    "[providers.codex]",
                    "enabled = true",
                    "[providers.custom]",
                    'type = "grok"',
                ].join("\n"),
            );
            const values = (await ConfigModule.load(join(root, ".happy"))).configuration.values;
            expect(values.providerDefaultEnable).toBe(false);
            expect(values.providers.codex?.enabled).toBe(true);
            expect(values.providers.claude?.enabled).toBe(false);
            expect(values.providers.custom).toMatchObject({
                enabled: false,
                type: "grok",
            });
        });

        it("clears a runtime service tier when explicitly reset to default", async () => {
            const root = await temporaryRoot();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                '[defaults]\nservice_tier = "fast"\n',
            );
            await writeLayer(
                root,
                ".happy/agent/runtime.toml",
                '[defaults]\nservice_tier = "default"\n',
            );
            const configuration = (await ConfigModule.load(join(root, ".happy"))).configuration;
            expect(configuration.values.defaults).not.toHaveProperty("serviceTier");
            expect(configuration.provenance["defaults.serviceTier"]).toBe("runtime");
        });

        it("tracks section and field provenance across the global and runtime layers", async () => {
            const root = await temporaryRoot();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                [
                    "[defaults]",
                    'model = "global-model"',
                    'provider = "global-provider"',
                    "[features]",
                    "workspaces = false",
                    "[network]",
                    "allow_local_binding = true",
                    "[observation]",
                    "logs = false",
                    "[permissions]",
                    'protected_paths = [".env"]',
                    "[settings]",
                    "show_usage = true",
                    "[workspace]",
                    'sync = [".env.example"]',
                    "[theme]",
                    'accent = "blue"',
                    "[providers]",
                    "default_enable = false",
                    "[providers.codex]",
                    "enabled = true",
                    "[mcp_servers.docs]",
                    'command = "docs"',
                ].join("\n"),
            );
            await writeLayer(
                root,
                ".happy/agent/runtime.toml",
                [
                    "[defaults]",
                    'model = "runtime-model"',
                    "[features]",
                    "workspaces = true",
                    "[observation]",
                    "logs = true",
                    "[settings]",
                    "show_usage = false",
                    "[workspace]",
                    'sync = ["runtime.env"]',
                ].join("\n"),
            );
            const configuration = (await ConfigModule.load(join(root, ".happy"))).configuration;
            expect(configuration.provenance).toMatchObject({
                defaults: "runtime",
                "defaults.modelId": "runtime",
                "defaults.providerId": "global",
                features: "runtime",
                "features.workspaces": "runtime",
                network: "global",
                observation: "runtime",
                "observation.logs": "runtime",
                permissions: "global",
                settings: "runtime",
                "settings.showUsage": "runtime",
                workspace: "runtime",
                "workspace.sync": "runtime",
                theme: "global",
                providers: "global",
                providerDefaultEnable: "global",
                mcpServers: "global",
            });
        });

        it("lets a runtime provider state field preserve an earlier explicit enable", async () => {
            const root = await temporaryRoot();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                "[providers.codex]\nenabled = true\n",
            );
            await writeLayer(
                root,
                ".happy/agent/runtime.toml",
                "[providers.codex]\nauto_enable = true\n",
            );

            const config = await ConfigModule.load(join(root, ".happy"));

            expect(config.configuration.values.providers.codex?.enabled).toBe(true);
            expect(config.configuredProviderOverride("codex")).toBe(true);
        });

        it("resets a secondary P2P identity when a later layer makes the rig primary", async () => {
            const root = await temporaryRoot();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                "[p2p]\nrole = 'secondary'\nprimary_id = 'primary1'\n",
            );
            await writeLayer(root, ".happy/agent/runtime.toml", "[p2p]\nrole = 'primary'\n");
            const p2p = (await ConfigModule.load(join(root, ".happy"))).configuration.values.p2p;
            expect(p2p.role).toBe("primary");
            expect(p2p).not.toHaveProperty("primaryId");
        });
    });

    describe("bounded parsing and schemas", () => {
        it("rejects non-table values for every known TOML section", () => {
            for (const section of [
                "defaults",
                "docker",
                "features",
                "mcp_servers",
                "network",
                "observation",
                "p2p",
                "permissions",
                "presence",
                "providers",
                "settings",
                "theme",
                "workspace",
            ]) {
                expectParseError(`${section} = "not a table"`);
            }
        });

        it("records unknown fields at nested source locations", () => {
            const parsed = parseHappyAgentConfigToml(
                [
                    "top_unknown = true",
                    "[defaults]",
                    "unknown = true",
                    "[docker]",
                    'image = "node"',
                    "[features]",
                    "unknown = true",
                    "[mcp_servers.docs]",
                    'command = "docs"',
                    "unknown = true",
                    "[network]",
                    "unknown = true",
                    "[observation]",
                    "unknown = true",
                    "[p2p]",
                    "unknown = true",
                    "[p2p.direct]",
                    'listen = "127.0.0.1:1"',
                    "unknown = true",
                    "[p2p.iroh]",
                    'relay_url = "https://relay.example.test"',
                    "unknown = true",
                    "[permissions]",
                    "unknown = true",
                    "[presence]",
                    "unknown = true",
                    "[presence.states.busy]",
                    'title = "Busy"',
                    "unknown = true",
                    "[providers.codex]",
                    "unknown = true",
                    "[providers.bedrock.model_overrides.model-a]",
                    'region = "us-east-1"',
                    "unknown = true",
                    "[settings]",
                    "unknown = true",
                    "[theme]",
                    "unknown = true",
                    "[workspace]",
                    "unknown = true",
                ].join("\n"),
            );

            expect(parsed.unknownSettings).toEqual(
                expect.arrayContaining([
                    "top_unknown",
                    "defaults.unknown",
                    "features.unknown",
                    "mcp_servers.docs.unknown",
                    "network.unknown",
                    "observation.unknown",
                    "p2p.unknown",
                    "p2p.direct.unknown",
                    "p2p.iroh.unknown",
                    "permissions.unknown",
                    "presence.unknown",
                    "presence.states.busy.unknown",
                    "providers.codex.unknown",
                    "providers.bedrock.model_overrides.model-a.unknown",
                    "settings.unknown",
                    "theme.unknown",
                    "workspace.unknown",
                ]),
            );
        });

        it("accepts exact scalar and array bounds and rejects values beyond them", () => {
            expect(
                parseHappyAgentConfigToml(`[defaults]\nmodel = "${"m".repeat(16_384)}"\n`).values
                    .defaults?.model,
            ).toHaveLength(16_384);
            expectParseError(`[defaults]\nmodel = "${"m".repeat(16_385)}"`);
            expectParseError(
                `[network]\nallowed_ports = [${Array.from({ length: 257 }, () => "1").join(", ")}]`,
            );
            expectParseError(`[providers.codex]\nauth_file = "\\u0000"`, "invalid value");
        });

        it("enforces network, retry, retention, path, and endpoint bounds", async () => {
            expectParseError("[network]\nallowed_ports = [0]");
            expectParseError("[network]\nallowed_ports = [65536]");
            expectParseError("[network]\nallowed_ports = [1.5]");
            expectParseError("[settings]\ninference_max_retries = -1");
            expectParseError("[settings]\ninference_max_retries = 101");
            expectParseError("[settings]\ntool_result_retention_days = -1");
            expectParseError("[settings]\ntool_result_retention_days = 36501");
            expectParseError(`[workspace]\nsync = ["${"x".repeat(513)}"]`, "invalid value");
            expectParseError(
                `[observation]\ntraces_endpoint = "http://${"x".repeat(2042)}"`,
                "invalid value",
            );

            const root = await temporaryRoot();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                `[providers.codex]\nauth_file = "${"x".repeat(4_096)}"\n`,
            );
            const values = (await ConfigModule.load(join(root, ".happy"))).configuration.values;
            const codex = values.providers.codex;
            if (codex?.type !== "codex") throw new Error("Expected the Codex provider");
            expect(codex.authFile).toHaveLength(4_096);
            await expectGlobalLoadError(`[providers.codex]\nauth_file = "${"x".repeat(4_097)}"\n`);
        });

        it("rejects oversized files before TOML parsing", () => {
            const oversized = `unknown = "${"x".repeat(1_048_576)}"`;
            expectParseError(oversized, "1048576-byte limit");
        });

        it("bounds every table at 512 properties", () => {
            const accepted = Array.from({ length: 512 }, (_, index) => `key_${index} = true`).join(
                "\n",
            );
            const rejected = Array.from({ length: 513 }, (_, index) => `key_${index} = true`).join(
                "\n",
            );
            expect(parseHappyAgentConfigToml(accepted).unknownSettings).toHaveLength(256);
            expectParseError(rejected, "at most 512 properties");
            expectParseError(
                `[settings]\n${Array.from(
                    { length: 513 },
                    (_, index) => `unknown_${index} = true`,
                ).join("\n")}`,
                "at most 512 properties",
            );
        });

        it("bounds provider, MCP, and protected-path collections", () => {
            const providers = Array.from(
                { length: 65 },
                (_, index) => `p${index} = { type = "codex" }`,
            ).join("\n");
            expectParseError(`[providers]\n${providers}`, "at most 64 providers");

            const mcpServers = Array.from(
                { length: 513 },
                (_, index) => `server${index} = { command = "server" }`,
            ).join("\n");
            expectParseError(`[mcp_servers]\n${mcpServers}`, "at most 512 properties");

            const paths = Array.from({ length: 129 }, (_, index) => `"path${index}"`).join(", ");
            expectParseError(`[permissions]\nprotected_paths = [${paths}]`);
            expectParseError(`[permissions]\nprotected_paths = ["../escape"]`, "invalid value");
        });

        it("retains unknown paths but truncates both count and path length", () => {
            const longKey = "k".repeat(16_385);
            const parsed = parseHappyAgentConfigToml(`"${longKey}" = true`);
            expect(parsed.unknownSettings).toEqual(["k".repeat(16_384)]);
            expect(parsed.unknownSettingsTruncated).toBe(true);

            const many = Array.from({ length: 300 }, (_, index) => `unknown_${index} = true`).join(
                "\n",
            );
            const bounded = parseHappyAgentConfigToml(many);
            expect(bounded.unknownSettings).toHaveLength(256);
            expect(bounded.unknownSettingsTruncated).toBe(true);
        });

        it("returns valid frozen snapshots and source schemas", async () => {
            const root = await temporaryRoot();
            const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));

            expect(Value.Check(happyAgentConfigurationSchema, configuration)).toBe(true);
            expect(Value.Check(happyAgentConfigurationPathsSchema, configuration.paths)).toBe(true);
            expect(Value.Check(happyAgentConfigValuesSchema, configuration.values)).toBe(true);
            expect(Value.Check(happyAgentConfigSourceSchema, configuration.sources.global)).toBe(
                true,
            );
            expect(Object.isFrozen(configuration)).toBe(true);
            expect(Object.isFrozen(configuration.values.providers)).toBe(true);
            expect(Object.isFrozen(configuration.values.workspace.sync)).toBe(true);
            expect(() => {
                (configuration.values.defaults as { modelId: string }).modelId = "changed";
            }).toThrow();
            expect(() => {
                configuration.values.workspace.sync.push("changed");
            }).toThrow();
        });

        it("wraps malformed, directory, and oversized files with the source path", async () => {
            const malformedRoot = await temporaryRoot();
            await writeLayer(malformedRoot, "Happy/Config/happy.toml", "[settings\n");
            await expect(ConfigModule.load(join(malformedRoot, ".happy"))).rejects.toThrow(
                `Could not read Happy Agent configuration '${join(
                    malformedRoot,
                    "Happy/Config/happy.toml",
                )}'`,
            );

            const directoryRoot = await temporaryRoot();
            await mkdir(join(directoryRoot, "Happy", "Config", "happy.toml"), {
                recursive: true,
            });
            await expect(ConfigModule.load(join(directoryRoot, ".happy"))).rejects.toThrow(
                `Could not read Happy Agent configuration '${join(
                    directoryRoot,
                    "Happy/Config/happy.toml",
                )}'`,
            );

            const oversizedRoot = await temporaryRoot();
            await writeLayer(
                oversizedRoot,
                "Happy/Config/happy.toml",
                `unknown = "${"x".repeat(1_048_576)}"`,
            );
            await expect(ConfigModule.load(join(oversizedRoot, ".happy"))).rejects.toThrow(
                "Could not read Happy Agent configuration",
            );
        });
    });

    describe("Docker, MCP, and provider validation", () => {
        it("requires exactly one Docker execution mode and validates container-specific options", () => {
            expectParseError("[docker]\nimage = 'node'\ncontainer = 'existing'");
            expectParseError("[docker]\n");
            expectParseError("[docker]\nimage = 'node'\nworkdir = 'relative'");
            expectParseError("[docker]\ncontainer = 'existing'\nenv = { A = 'B' }");
            expectParseError("[docker]\nimage = 'node'\nmounts = [{ source = '/tmp' }]");
            expectParseError(
                "[docker]\nimage = 'node'\nmounts = [{ source = '/tmp', target = 'relative' }]",
                "absolute container path",
            );
        });

        it("normalizes Docker image mounts, environment, and default working directory", () => {
            const parsed = parseHappyAgentConfigToml(
                [
                    "[docker]",
                    'image = "node:22"',
                    'socket_path = "/var/run/docker.sock"',
                    "env = { NODE_ENV = 'test' }",
                    "mounts = [{ source = '/tmp/project', target = '/workspace', read_only = true }]",
                ].join("\n"),
            );
            expect(parsed.values.docker).toMatchObject({
                image: "node:22",
                socket_path: "/var/run/docker.sock",
            });
        });

        it("requires exactly one MCP command or URL and converts timeout seconds to milliseconds", async () => {
            expectParseError('[mcp_servers.one]\ncommand = "a"\nurl = "https://example.test"');
            expectParseError("[mcp_servers.one]\n");
            expectParseError(
                '[mcp_servers.one]\nurl = "https://example.test"\ntransport = "tcp"',
                "invalid value",
            );
            expectParseError('[mcp_servers.one]\ncommand = "a"\nstartup_timeout_sec = 0');
            await expectGlobalLoadError(
                '[mcp_servers.one]\ncommand = "a"\nstartup_timeout_sec = 0.0005',
                "whole millisecond",
            );
            expectParseError('[mcp_servers.one]\ncommand = "a"\nstartup_timeout_sec = 600.001');

            const parsed = parseHappyAgentConfigToml(
                [
                    "[mcp_servers.one]",
                    'command = "a"',
                    "startup_timeout_sec = 0.001",
                    "tool_timeout_sec = 600",
                ].join("\n"),
            );
            expect(parsed.values.mcp_servers?.one).toMatchObject({
                command: "a",
                startup_timeout_sec: 0.001,
                tool_timeout_sec: 600,
            });
        });

        it("does not silently reinterpret an explicit HTTP transport on a command server", async () => {
            await expectGlobalLoadError(
                '[mcp_servers.one]\ncommand = "a"\ntransport = "http"',
                "transport",
            );
        });

        it("normalizes each built-in and custom provider type and model overrides", () => {
            const parsed = parseHappyAgentConfigToml(
                [
                    "[providers.bedrock]",
                    'region = "us-east-1"',
                    "[providers.bedrock.model_overrides.model-a]",
                    'endpoint = "https://example.test"',
                    'transport = "runtime"',
                    "",
                    "[providers.claude]",
                    'config_dir = "/tmp/claude"',
                    "",
                    "[providers.codex]",
                    'auth_file = "/tmp/auth.json"',
                    'transport = "websocket"',
                    "",
                    "[providers.grok]",
                    'base_url = "https://grok.example.test"',
                    "",
                    "[providers.custom]",
                    'type = "codex"',
                    "enabled = false",
                ].join("\n"),
            );

            expect(parsed.values.providers).toMatchObject({
                bedrock: {
                    model_overrides: {
                        "model-a": {
                            endpoint: "https://example.test",
                            transport: "runtime",
                        },
                    },
                    region: "us-east-1",
                },
                claude: { config_dir: "/tmp/claude" },
                codex: { auth_file: "/tmp/auth.json", transport: "websocket" },
                custom: { enabled: false, type: "codex" },
                grok: { base_url: "https://grok.example.test" },
            });
            expectParseError("[providers.codex]\ntype = 'grok'", 'must use type "codex"');
            expectParseError("[providers.custom]\napi_key = 'x'", "must set type");
            expectParseError("[providers.custom]\ntype = 'unsupported'", "must set type");
            expectParseError("[providers.codex]\ncredential_isolation = false");
        });

        it("validates the provider default-enable switch independently of provider records", () => {
            expectParseError("[providers]\ndefault_enable = 'yes'", "boolean");
            expectParseError("[providers.codex]\nenabled = 'yes'");
        });

        it("retains unknown model override metadata without accepting invalid known values", () => {
            const parsed = parseHappyAgentConfigToml(
                [
                    "[providers.bedrock.model_overrides.model-a]",
                    'region = "us-east-1"',
                    "unknown = true",
                ].join("\n"),
            );
            expect(parsed.unknownSettings).toContain(
                "providers.bedrock.model_overrides.model-a.unknown",
            );
            expectParseError(
                "[providers.bedrock.model_overrides.model-a]\ntransport = 'unsupported'",
            );
        });
    });

    describe("P2P, presence, and project-relative validation", () => {
        it("validates P2P role, identity, relay URL, and bounded name", () => {
            expectParseError("[p2p]\nrole = 'secondary'");
            expectParseError("[p2p]\nrole = 'primary'\nprimary_id = 'primary1'");
            expectParseError("[p2p]\nrole = 'secondary'\nprimary_id = 'Bad_ID'");
            expectParseError("[p2p]\nrole = 'secondary'\nprimary_id = 'a'");
            expectParseError("[p2p]\niroh = { relay_url = 'ftp://relay.example.test' }");
            expectParseError(`[p2p]\nname = "${"x".repeat(129)}"`);

            const parsed = parseHappyAgentConfigToml(
                [
                    "[p2p]",
                    "role = 'secondary'",
                    "primary_id = 'primary1'",
                    "name = 'secondary-node'",
                    "[p2p.direct]",
                    'listen = "127.0.0.1:9999"',
                    "[p2p.iroh]",
                    'relay_url = "https://relay.example.test"',
                ].join("\n"),
            );
            expect(parsed.values.p2p).toMatchObject({
                direct: { listen: "127.0.0.1:9999" },
                iroh: { relay_url: "https://relay.example.test" },
                name: "secondary-node",
                primary_id: "primary1",
                role: "secondary",
            });
        });

        it("rejects non-printable P2P display names", async () => {
            await expectGlobalLoadError('[p2p]\nname = "\\u0001"', "printable");
        });

        it("parses presence dates, aliases, durations, and state names", () => {
            const parsed = parseHappyAgentConfigToml(
                [
                    "[presence]",
                    'until = "2030-01-01T00:00:00Z"',
                    "[presence.states.busy]",
                    'answer_wait = "1.5 minutes"',
                    'emoji = "⏳"',
                    "[presence.states.waiting]",
                    'answer_wait = "forever"',
                    "[presence.states.never]",
                    'answer_wait = "never"',
                ].join("\n"),
            );
            expect(parsed.values.presence).toMatchObject({
                states: {
                    busy: { answer_wait: "1.5 minutes", emoji: "⏳" },
                    never: { answer_wait: "never" },
                    waiting: { answer_wait: "forever" },
                },
            });
            expectParseError("[presence.states.Bad]\ntitle = 'bad'", "lowercase");

            const tomlDate = parseHappyAgentConfigToml(
                "[presence]\nuntil = 2030-01-01T00:00:00Z\n",
            );
            expect(tomlDate.values.presence?.until).toBe(Date.parse("2030-01-01T00:00:00Z"));
        });

        it("normalizes every supported finite answer-wait unit", async () => {
            const root = await temporaryRoot();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                [
                    "[presence.states.milliseconds]",
                    'answer_wait = "2 milliseconds"',
                    "[presence.states.seconds]",
                    'answer_wait = "2 seconds"',
                    "[presence.states.minutes]",
                    'answer_wait = "2 minutes"',
                    "[presence.states.hours]",
                    'answer_wait = "2 hours"',
                    "[presence.states.days]",
                    'answer_wait = "2 days"',
                    "[presence.states.zero]",
                    'answer_wait = "none"',
                ].join("\n"),
            );
            const states = (await ConfigModule.load(join(root, ".happy"))).configuration.values
                .presence.states;
            expect(states).toMatchObject({
                milliseconds: { answerWaitMs: 2 },
                seconds: { answerWaitMs: 2_000 },
                minutes: { answerWaitMs: 120_000 },
                hours: { answerWaitMs: 7_200_000 },
                days: { answerWaitMs: 172_800_000 },
                zero: { answerWaitMs: 0 },
            });
        });

        it("rejects invalid presence durations and dates when resolving the snapshot", async () => {
            await expectGlobalLoadError("[presence.states.busy]\nanswer_wait = 'soon'", "duration");
            await expectGlobalLoadError(
                "[presence.states.busy]\nanswer_wait = '-1 second'",
                "duration",
            );
            await expectGlobalLoadError("[presence]\nuntil = 'not a date'", "must be a date");
            await expectGlobalLoadError("[presence]\nuntil = 9007199254740992");
        });

        it("merges presence states while a current value clears stale transient fields", async () => {
            const root = await temporaryRoot();
            await writeLayer(
                root,
                "Happy/Config/happy.toml",
                [
                    "[presence]",
                    'fallback = "away"',
                    "until = 1000",
                    "[presence.states.busy]",
                    'title = "Busy"',
                    'prompt = "Working"',
                ].join("\n"),
            );
            await writeLayer(
                root,
                ".happy/agent/runtime.toml",
                [
                    "[presence]",
                    'current = "working"',
                    "[presence.states.busy]",
                    'emoji = "⏳"',
                ].join("\n"),
            );
            const configuration = await loadHappyAgentConfiguration(join(root, ".happy"));

            expect(configuration.values.presence).toEqual({
                current: "working",
                states: {
                    busy: {
                        emoji: "⏳",
                        prompt: "Working",
                        title: "Busy",
                    },
                },
            });
        });

        it("rejects unsafe protected, sync, and P2P paths", () => {
            for (const path of ["/absolute", "~/.secret", "../secret", "a/../b"]) {
                expectParseError(`[permissions]\nprotected_paths = ['${path}']`);
                expectParseError(`[workspace]\nsync = ['${path}']`);
                expectParseError(`[workspace]\nprotected_sync = ['${path}']`);
            }
            expectParseError("[permissions]\nprotected_paths = ['a\\\\b']");
            expectParseError('[permissions]\nprotected_paths = [".env", ".env"]');
        });
    });
});
