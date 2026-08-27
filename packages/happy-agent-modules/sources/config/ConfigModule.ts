import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type {
    AgentModel,
    AgentModule,
    AgentModuleHooks,
    AgentProviders,
} from "@slopus/happy-agent-base";
import type { ProviderUsage } from "@slopus/happy-providers";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";
import { parse, stringify, TomlDate, type TomlTable, type TomlValue } from "smol-toml";

import { getManagedProjectsDirectory } from "../impl/managedProjectsDirectory.js";
import { getManagedWorkspacesDirectory } from "../impl/managedWorkspacesDirectory.js";
import {
    agentModelCatalog,
    agentModelContext,
    agentModels,
    agentProviders,
    type AgentModelContext,
    type ConfiguredAgentModel,
} from "./impl/agentCatalog.js";
import { loadConfiguredProviderUsage } from "./impl/loadConfiguredProviderUsage.js";
import { ProviderEnablement, providerRegistryUntil } from "./impl/providerRegistryUntil.js";
import { readGlobalInstructions } from "./impl/readGlobalInstructions.js";
import { HAPPY_TOML_TEMPLATE, MCP_TOML_TEMPLATE } from "./impl/userConfigurationTemplate.js";
import { readSecurityDocument } from "./impl/readSecurityDocument.js";

const MAX_PATH_LENGTH = 4_096;
const MAX_CONFIG_STRING_LENGTH = 16_384;
const MAX_CONFIG_FILE_BYTES = 1_048_576;
const MAX_CONFIG_ARRAY_ITEMS = 256;
const MAX_PROTECTED_PATHS = 128;
const MAX_CONFIG_TABLE_ENTRIES = 512;
const MAX_PROVIDER_COUNT = 64;
const MAX_UNKNOWN_SETTINGS = 256;
const MAX_PROVENANCE_ENTRIES = 512;
const MAX_CONFIGURED_COLLABORATORS = 1_000;
const MAX_CONFIGURED_COLLABORATION_DEPTH = 64;
const MAX_INFERENCE_MAX_RETRIES = 100;
const MAX_TOOL_RESULT_RETENTION_DAYS = 36_500;
const MAX_MCP_TIMEOUT_SECONDS = 600;
const MAX_LOCAL_CREDENTIAL_FILE_BYTES = 256 * 1024;

const pathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PATH_LENGTH,
    pattern: "^[^\\u0000]+$",
});
const configStringSchema = Type.String({ maxLength: MAX_CONFIG_STRING_LENGTH });
const boundedStringArraySchema = Type.Array(configStringSchema, {
    maxItems: MAX_CONFIG_ARRAY_ITEMS,
});
const projectRelativePathSchema = Type.String({
    minLength: 1,
    maxLength: 512,
    pattern: "^(?!/)(?!~(?:/|$))(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\r\\n]+$",
});
const projectRelativePathsSchema = Type.Array(projectRelativePathSchema, {
    maxItems: MAX_PROTECTED_PATHS,
    uniqueItems: true,
});
const permissionModeSchema = Type.Union([
    Type.Literal("auto"),
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
    Type.Literal("full_access"),
]);
const effortSchema = Type.Union([
    Type.Literal("off"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
    Type.Literal("ultra"),
    configStringSchema,
]);
const serviceTierSchema = Type.Literal("fast");
const defaultServiceTierSchema = Type.Union([serviceTierSchema, Type.Literal("default")]);
const p2pShareSchema = Type.Union([
    Type.Literal("owner_only"),
    Type.Literal("shared"),
    Type.Literal("disabled"),
]);
const p2pInstanceIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});
const logLevelSchema = Type.Union([
    Type.Literal("trace"),
    Type.Literal("debug"),
    Type.Literal("info"),
    Type.Literal("warn"),
    Type.Literal("error"),
    Type.Literal("fatal"),
]);
const traceEndpointSchema = Type.String({
    minLength: 1,
    maxLength: 2_048,
    pattern: "^https?://[^\\s]+$",
});

const defaultsInputSchema = Type.Object(
    {
        effort: Type.Optional(configStringSchema),
        instructions: Type.Optional(configStringSchema),
        model: Type.Optional(configStringSchema),
        permission_mode: Type.Optional(permissionModeSchema),
        provider: Type.Optional(configStringSchema),
        service_tier: Type.Optional(defaultServiceTierSchema),
    },
    { additionalProperties: false },
);
const settingsInputSchema = Type.Object(
    {
        compact_completed_turns: Type.Optional(Type.Boolean()),
        completion_chime: Type.Optional(Type.Boolean()),
        daemon_heap_snapshots: Type.Optional(Type.Boolean()),
        durable_global_event_queue: Type.Optional(Type.Boolean()),
        ethan: Type.Optional(
            Type.Object(
                {
                    enabled: Type.Optional(Type.Boolean()),
                },
                { additionalProperties: false },
            ),
        ),
        happy_integration: Type.Optional(Type.Boolean()),
        inference_max_retries: Type.Optional(
            Type.Integer({ minimum: 0, maximum: MAX_INFERENCE_MAX_RETRIES }),
        ),
        max_collaboration_depth: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_CONFIGURED_COLLABORATION_DEPTH }),
        ),
        max_collaborators: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_CONFIGURED_COLLABORATORS }),
        ),
        menu_bar: Type.Optional(Type.Boolean()),
        show_reasoning: Type.Optional(Type.Boolean()),
        show_usage: Type.Optional(Type.Boolean()),
        tool_result_retention_days: Type.Optional(
            Type.Integer({ minimum: 0, maximum: MAX_TOOL_RESULT_RETENTION_DAYS }),
        ),
    },
    { additionalProperties: false },
);
const providerCommonInput = {
    auto_enable: Type.Optional(Type.Boolean()),
    credential_isolation: Type.Optional(Type.Literal(true)),
    enabled: Type.Optional(Type.Boolean()),
    exclude_models: Type.Optional(boundedStringArraySchema),
    include_models: Type.Optional(boundedStringArraySchema),
    p2p_share: Type.Optional(p2pShareSchema),
};
const providerInputSchemas = {
    bedrock: Type.Object(
        {
            ...providerCommonInput,
            bearer_token: Type.Optional(configStringSchema),
            bearer_token_env_var: Type.Optional(configStringSchema),
            config_file: Type.Optional(pathSchema),
            credentials_file: Type.Optional(pathSchema),
            model_overrides: Type.Optional(
                Type.Record(
                    configStringSchema,
                    Type.Object(
                        {
                            endpoint: Type.Optional(configStringSchema),
                            region: Type.Optional(configStringSchema),
                            transport: Type.Optional(
                                Type.Union([Type.Literal("mantle"), Type.Literal("runtime")]),
                            ),
                        },
                        { additionalProperties: true },
                    ),
                    { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
                ),
            ),
            profile: Type.Optional(configStringSchema),
            region: Type.Optional(configStringSchema),
            search_model: Type.Optional(configStringSchema),
            type: Type.Optional(Type.Literal("bedrock")),
        },
        { additionalProperties: false },
    ),
    claude: Type.Object(
        {
            ...providerCommonInput,
            api_key: Type.Optional(configStringSchema),
            auth_token: Type.Optional(configStringSchema),
            config_dir: Type.Optional(pathSchema),
            executable: Type.Optional(pathSchema),
            oauth_token: Type.Optional(configStringSchema),
            type: Type.Optional(Type.Literal("claude")),
        },
        { additionalProperties: false },
    ),
    codex: Type.Object(
        {
            ...providerCommonInput,
            api_key: Type.Optional(configStringSchema),
            auth_file: Type.Optional(pathSchema),
            base_url: Type.Optional(configStringSchema),
            transport: Type.Optional(
                Type.Union([
                    Type.Literal("auto"),
                    Type.Literal("sse"),
                    Type.Literal("websocket"),
                    Type.Literal("websocket-cached"),
                ]),
            ),
            type: Type.Optional(Type.Literal("codex")),
        },
        { additionalProperties: false },
    ),
    grok: Type.Object(
        {
            ...providerCommonInput,
            api_key: Type.Optional(configStringSchema),
            auth_file: Type.Optional(pathSchema),
            base_url: Type.Optional(configStringSchema),
            type: Type.Optional(Type.Literal("grok")),
        },
        { additionalProperties: false },
    ),
} as const;
const providerInputSchema = Type.Union([
    providerInputSchemas.bedrock,
    providerInputSchemas.claude,
    providerInputSchemas.codex,
    providerInputSchemas.grok,
]);
const providerMapInputSchema = Type.Record(configStringSchema, providerInputSchema, {
    maxProperties: MAX_PROVIDER_COUNT,
});
const dockerInputSchema = Type.Object(
    {
        container: Type.Optional(configStringSchema),
        env: Type.Optional(
            Type.Record(configStringSchema, configStringSchema, {
                maxProperties: MAX_CONFIG_TABLE_ENTRIES,
            }),
        ),
        image: Type.Optional(configStringSchema),
        mounts: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        read_only: Type.Optional(Type.Boolean()),
                        source: pathSchema,
                        target: configStringSchema,
                    },
                    { additionalProperties: true },
                ),
                { maxItems: MAX_CONFIG_ARRAY_ITEMS },
            ),
        ),
        name: Type.Optional(configStringSchema),
        socket_path: Type.Optional(pathSchema),
        workdir: Type.Optional(configStringSchema),
    },
    { additionalProperties: false },
);
const mcpInputSchema = Type.Record(
    configStringSchema,
    Type.Object(
        {
            args: Type.Optional(boundedStringArraySchema),
            bearer_token_env_var: Type.Optional(configStringSchema),
            command: Type.Optional(
                Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH }),
            ),
            cwd: Type.Optional(pathSchema),
            disabled_tools: Type.Optional(boundedStringArraySchema),
            enabled: Type.Optional(Type.Boolean()),
            enabled_tools: Type.Optional(boundedStringArraySchema),
            env: Type.Optional(
                Type.Record(configStringSchema, configStringSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            http_headers: Type.Optional(
                Type.Record(configStringSchema, configStringSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            oauth_client_id_env_var: Type.Optional(configStringSchema),
            oauth_client_secret_env_var: Type.Optional(configStringSchema),
            oauth_scopes: Type.Optional(boundedStringArraySchema),
            startup_timeout_sec: Type.Optional(
                Type.Number({ exclusiveMinimum: 0, maximum: MAX_MCP_TIMEOUT_SECONDS }),
            ),
            tool_timeout_sec: Type.Optional(
                Type.Number({ exclusiveMinimum: 0, maximum: MAX_MCP_TIMEOUT_SECONDS }),
            ),
            transport: Type.Optional(Type.Literal("http")),
            url: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH })),
        },
        { additionalProperties: false },
    ),
    { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
);
const partialValuesSchema = Type.Object(
    {
        docker: Type.Optional(dockerInputSchema),
        defaults: Type.Optional(defaultsInputSchema),
        features: Type.Optional(
            Type.Object(
                {
                    cross_workspace: Type.Optional(Type.Boolean()),
                    workflows: Type.Optional(Type.Boolean()),
                    workspaces: Type.Optional(Type.Boolean()),
                },
                { additionalProperties: false },
            ),
        ),
        gemini: Type.Optional(
            Type.Object(
                {
                    api_key: Type.Optional(configStringSchema),
                },
                { additionalProperties: false },
            ),
        ),
        mcp_servers: Type.Optional(mcpInputSchema),
        network: Type.Optional(
            Type.Object(
                {
                    allow_local_binding: Type.Optional(Type.Boolean()),
                    allowed_domains: Type.Optional(boundedStringArraySchema),
                    allowed_loopback_ports: Type.Optional(
                        Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), {
                            maxItems: MAX_CONFIG_ARRAY_ITEMS,
                        }),
                    ),
                    allowed_ports: Type.Optional(
                        Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), {
                            maxItems: MAX_CONFIG_ARRAY_ITEMS,
                        }),
                    ),
                    denied_domains: Type.Optional(boundedStringArraySchema),
                },
                { additionalProperties: false },
            ),
        ),
        observation: Type.Optional(
            Type.Object(
                {
                    history_dump: Type.Optional(Type.Boolean()),
                    log_level: Type.Optional(logLevelSchema),
                    logs: Type.Optional(Type.Boolean()),
                    traces: Type.Optional(Type.Boolean()),
                    traces_endpoint: Type.Optional(traceEndpointSchema),
                },
                { additionalProperties: false },
            ),
        ),
        p2p: Type.Optional(
            Type.Object(
                {
                    direct: Type.Optional(
                        Type.Object(
                            { listen: Type.Optional(configStringSchema) },
                            {
                                additionalProperties: true,
                            },
                        ),
                    ),
                    enable_direct: Type.Optional(Type.Boolean()),
                    enable_iroh: Type.Optional(Type.Boolean()),
                    enable_ssh: Type.Optional(Type.Boolean()),
                    expose_api: Type.Optional(Type.Boolean()),
                    iroh: Type.Optional(
                        Type.Object(
                            { relay_url: Type.Optional(configStringSchema) },
                            {
                                additionalProperties: true,
                            },
                        ),
                    ),
                    name: Type.Optional(configStringSchema),
                    primary_id: Type.Optional(configStringSchema),
                    role: Type.Optional(
                        Type.Union([Type.Literal("primary"), Type.Literal("secondary")]),
                    ),
                },
                { additionalProperties: false },
            ),
        ),
        permissions: Type.Optional(
            Type.Object(
                {
                    protected_paths: Type.Optional(projectRelativePathsSchema),
                },
                { additionalProperties: false },
            ),
        ),
        presence: Type.Optional(
            Type.Object(
                {
                    current: Type.Optional(configStringSchema),
                    fallback: Type.Optional(configStringSchema),
                    states: Type.Optional(
                        Type.Record(
                            configStringSchema,
                            Type.Object(
                                {
                                    answer_wait: Type.Optional(
                                        Type.Union([configStringSchema, Type.Null()]),
                                    ),
                                    emoji: Type.Optional(configStringSchema),
                                    prompt: Type.Optional(configStringSchema),
                                    title: Type.Optional(configStringSchema),
                                },
                                { additionalProperties: false },
                            ),
                            { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
                        ),
                    ),
                    until: Type.Optional(Type.Union([Type.String(), Type.Number()])),
                },
                { additionalProperties: false },
            ),
        ),
        provider_default_enable: Type.Optional(Type.Boolean()),
        providers: Type.Optional(providerMapInputSchema),
        settings: Type.Optional(settingsInputSchema),
        theme: Type.Optional(
            Type.Object(
                {
                    accent: Type.Optional(configStringSchema),
                    brand: Type.Optional(configStringSchema),
                    error: Type.Optional(configStringSchema),
                    primary: Type.Optional(configStringSchema),
                    secondary: Type.Optional(configStringSchema),
                    success: Type.Optional(configStringSchema),
                    warning: Type.Optional(configStringSchema),
                },
                { additionalProperties: false },
            ),
        ),
        workspace: Type.Optional(
            Type.Object(
                {
                    keep_copies_on_archive: Type.Optional(Type.Boolean()),
                    keep_worktrees_on_archive: Type.Optional(Type.Boolean()),
                    protected_sync: Type.Optional(projectRelativePathsSchema),
                    setup_commands: Type.Optional(boundedStringArraySchema),
                    sync: Type.Optional(projectRelativePathsSchema),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);

const providerRecordBase = {
    autoEnable: Type.Optional(Type.Boolean()),
    credentialIsolation: Type.Optional(Type.Literal(true)),
    enabled: Type.Boolean(),
    excludeModels: Type.Optional(boundedStringArraySchema),
    includeModels: Type.Optional(boundedStringArraySchema),
    p2pShare: Type.Optional(p2pShareSchema),
};
const providerSchemas = {
    bedrock: Type.Object(
        {
            ...providerRecordBase,
            bearerToken: Type.Optional(configStringSchema),
            bearerTokenEnvVar: Type.Optional(configStringSchema),
            configFile: Type.Optional(pathSchema),
            credentialsFile: Type.Optional(pathSchema),
            modelOverrides: Type.Optional(
                Type.Record(
                    configStringSchema,
                    Type.Object(
                        {
                            endpoint: Type.Optional(configStringSchema),
                            region: Type.Optional(configStringSchema),
                            transport: Type.Optional(
                                Type.Union([Type.Literal("mantle"), Type.Literal("runtime")]),
                            ),
                        },
                        { additionalProperties: true },
                    ),
                    { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
                ),
            ),
            profile: Type.Optional(configStringSchema),
            region: Type.Optional(configStringSchema),
            searchModelId: Type.Optional(configStringSchema),
            type: Type.Literal("bedrock"),
        },
        { additionalProperties: false },
    ),
    claude: Type.Object(
        {
            ...providerRecordBase,
            apiKey: Type.Optional(configStringSchema),
            authToken: Type.Optional(configStringSchema),
            configDir: Type.Optional(pathSchema),
            executable: Type.Optional(pathSchema),
            oauthToken: Type.Optional(configStringSchema),
            type: Type.Literal("claude"),
        },
        { additionalProperties: false },
    ),
    codex: Type.Object(
        {
            ...providerRecordBase,
            apiKey: Type.Optional(configStringSchema),
            authFile: Type.Optional(pathSchema),
            baseUrl: Type.Optional(configStringSchema),
            transport: Type.Optional(
                Type.Union([
                    Type.Literal("auto"),
                    Type.Literal("sse"),
                    Type.Literal("websocket"),
                    Type.Literal("websocket-cached"),
                ]),
            ),
            type: Type.Literal("codex"),
        },
        { additionalProperties: false },
    ),
    grok: Type.Object(
        {
            ...providerRecordBase,
            apiKey: Type.Optional(configStringSchema),
            authFile: Type.Optional(pathSchema),
            baseUrl: Type.Optional(configStringSchema),
            type: Type.Literal("grok"),
        },
        { additionalProperties: false },
    ),
} as const;
const providerSchema = Type.Union([
    providerSchemas.bedrock,
    providerSchemas.claude,
    providerSchemas.codex,
    providerSchemas.grok,
]);

const resolvedValuesSchema = Type.Object(
    {
        docker: Type.Optional(
            Type.Object(
                {
                    container: Type.Optional(configStringSchema),
                    environment: Type.Optional(
                        Type.Record(configStringSchema, configStringSchema, {
                            maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                        }),
                    ),
                    image: Type.Optional(configStringSchema),
                    mounts: Type.Optional(
                        Type.Array(
                            Type.Object(
                                {
                                    readOnly: Type.Optional(Type.Boolean()),
                                    source: pathSchema,
                                    target: configStringSchema,
                                },
                                { additionalProperties: false },
                            ),
                            { maxItems: MAX_CONFIG_ARRAY_ITEMS },
                        ),
                    ),
                    name: Type.Optional(configStringSchema),
                    socketPath: Type.Optional(pathSchema),
                    workingDirectory: configStringSchema,
                },
                { additionalProperties: false },
            ),
        ),
        defaults: Type.Object(
            {
                effort: Type.Optional(effortSchema),
                instructions: Type.Optional(configStringSchema),
                modelId: configStringSchema,
                permissionMode: permissionModeSchema,
                providerId: Type.Optional(configStringSchema),
                serviceTier: Type.Optional(serviceTierSchema),
            },
            { additionalProperties: false },
        ),
        features: Type.Object(
            {
                crossWorkspace: Type.Boolean(),
                workflows: Type.Boolean(),
                workspaces: Type.Boolean(),
            },
            { additionalProperties: false },
        ),
        gemini: Type.Object(
            {
                apiKey: Type.Optional(configStringSchema),
            },
            { additionalProperties: false },
        ),
        mcpServers: Type.Record(
            configStringSchema,
            Type.Union([
                Type.Object(
                    {
                        args: Type.Optional(boundedStringArraySchema),
                        command: Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH }),
                        cwd: Type.Optional(pathSchema),
                        disabledTools: Type.Optional(boundedStringArraySchema),
                        enabled: Type.Optional(Type.Boolean()),
                        enabledTools: Type.Optional(boundedStringArraySchema),
                        env: Type.Optional(
                            Type.Record(configStringSchema, configStringSchema, {
                                maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                            }),
                        ),
                        startupTimeoutMs: Type.Optional(
                            Type.Integer({ minimum: 1, maximum: MAX_MCP_TIMEOUT_SECONDS * 1_000 }),
                        ),
                        toolTimeoutMs: Type.Optional(
                            Type.Integer({ minimum: 1, maximum: MAX_MCP_TIMEOUT_SECONDS * 1_000 }),
                        ),
                        transport: Type.Literal("stdio"),
                    },
                    { additionalProperties: false },
                ),
                Type.Object(
                    {
                        bearerTokenEnvVar: Type.Optional(configStringSchema),
                        disabledTools: Type.Optional(boundedStringArraySchema),
                        enabled: Type.Optional(Type.Boolean()),
                        enabledTools: Type.Optional(boundedStringArraySchema),
                        headers: Type.Optional(
                            Type.Record(configStringSchema, configStringSchema, {
                                maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                            }),
                        ),
                        oauthClientIdEnvVar: Type.Optional(configStringSchema),
                        oauthClientSecretEnvVar: Type.Optional(configStringSchema),
                        oauthScopes: Type.Optional(boundedStringArraySchema),
                        startupTimeoutMs: Type.Optional(
                            Type.Integer({ minimum: 1, maximum: MAX_MCP_TIMEOUT_SECONDS * 1_000 }),
                        ),
                        toolTimeoutMs: Type.Optional(
                            Type.Integer({ minimum: 1, maximum: MAX_MCP_TIMEOUT_SECONDS * 1_000 }),
                        ),
                        transport: Type.Literal("http"),
                        url: Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH }),
                    },
                    { additionalProperties: false },
                ),
            ]),
            { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
        ),
        network: Type.Optional(
            Type.Object(
                {
                    allowLocalBinding: Type.Optional(Type.Boolean()),
                    allowedDomains: Type.Optional(boundedStringArraySchema),
                    allowedLoopbackPorts: Type.Optional(
                        Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), {
                            maxItems: MAX_CONFIG_ARRAY_ITEMS,
                        }),
                    ),
                    allowedPorts: Type.Optional(
                        Type.Array(Type.Integer({ minimum: 1, maximum: 65_535 }), {
                            maxItems: MAX_CONFIG_ARRAY_ITEMS,
                        }),
                    ),
                    deniedDomains: Type.Optional(boundedStringArraySchema),
                },
                { additionalProperties: false },
            ),
        ),
        observation: Type.Object(
            {
                historyDump: Type.Boolean(),
                logLevel: logLevelSchema,
                logs: Type.Boolean(),
                traces: Type.Boolean(),
                tracesEndpoint: traceEndpointSchema,
            },
            { additionalProperties: false },
        ),
        p2p: Type.Object(
            {
                direct: Type.Object(
                    { listen: Type.Optional(configStringSchema) },
                    {
                        additionalProperties: false,
                    },
                ),
                enableDirect: Type.Boolean(),
                enableIroh: Type.Boolean(),
                enableSsh: Type.Boolean(),
                exposeApi: Type.Boolean(),
                iroh: Type.Object(
                    { relayUrl: Type.Optional(configStringSchema) },
                    {
                        additionalProperties: false,
                    },
                ),
                name: configStringSchema,
                primaryId: Type.Optional(configStringSchema),
                role: Type.Union([Type.Literal("primary"), Type.Literal("secondary")]),
            },
            { additionalProperties: false },
        ),
        permissions: Type.Object(
            {
                protectedPaths: projectRelativePathsSchema,
            },
            { additionalProperties: false },
        ),
        presence: Type.Object(
            {
                current: Type.Optional(configStringSchema),
                fallback: Type.Optional(configStringSchema),
                states: Type.Record(
                    configStringSchema,
                    Type.Object(
                        {
                            answerWaitMs: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                            emoji: Type.Optional(configStringSchema),
                            prompt: Type.Optional(configStringSchema),
                            title: Type.Optional(configStringSchema),
                        },
                        { additionalProperties: false },
                    ),
                    { maxProperties: MAX_CONFIG_TABLE_ENTRIES },
                ),
                until: Type.Optional(Type.Integer()),
            },
            { additionalProperties: false },
        ),
        providerDefaultEnable: Type.Boolean(),
        providers: Type.Record(configStringSchema, providerSchema, {
            maxProperties: MAX_PROVIDER_COUNT,
        }),
        settings: Type.Object(
            {
                compactCompletedTurns: Type.Boolean(),
                completionChime: Type.Boolean(),
                daemonHeapSnapshots: Type.Boolean(),
                durableGlobalEventQueue: Type.Boolean(),
                ethan: Type.Object(
                    {
                        enabled: Type.Boolean(),
                    },
                    { additionalProperties: false },
                ),
                happyIntegration: Type.Boolean(),
                inferenceMaxRetries: Type.Integer({
                    minimum: 0,
                    maximum: MAX_INFERENCE_MAX_RETRIES,
                }),
                maxCollaborationDepth: Type.Integer({
                    minimum: 1,
                    maximum: MAX_CONFIGURED_COLLABORATION_DEPTH,
                }),
                maxCollaborators: Type.Integer({
                    minimum: 1,
                    maximum: MAX_CONFIGURED_COLLABORATORS,
                }),
                menuBar: Type.Boolean(),
                showReasoning: Type.Boolean(),
                showUsage: Type.Boolean(),
                toolResultRetentionDays: Type.Integer({
                    minimum: 0,
                    maximum: MAX_TOOL_RESULT_RETENTION_DAYS,
                }),
            },
            { additionalProperties: false },
        ),
        theme: Type.Object(
            {
                accent: configStringSchema,
                brand: configStringSchema,
                error: configStringSchema,
                primary: configStringSchema,
                secondary: configStringSchema,
                success: configStringSchema,
                warning: configStringSchema,
            },
            { additionalProperties: false },
        ),
        workspace: Type.Object(
            {
                /**
                 * A workspace copied from a project without Git is the person's own folder rather
                 * than a checkout Git can rebuild, so archiving leaves it behind by default. A
                 * worktree is rebuildable, so archiving removes it by default.
                 */
                keepCopiesOnArchive: Type.Boolean(),
                keepWorktreesOnArchive: Type.Boolean(),
                protectedSync: projectRelativePathsSchema,
                setupCommands: boundedStringArraySchema,
                sync: projectRelativePathsSchema,
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);

const pathSchemaSet = Type.Object(
    {
        agentHome: pathSchema,
        agentLockPath: pathSchema,
        autoAgentLockPath: pathSchema,
        autoDatabasePath: pathSchema,
        configHome: pathSchema,
        databasePath: pathSchema,
        docsHome: pathSchema,
        generatedPath: pathSchema,
        globalConfigPath: pathSchema,
        happyHome: pathSchema,
        historyDumpHome: pathSchema,
        instructionsPath: pathSchema,
        localConfigPath: pathSchema,
        logPath: pathSchema,
        mcpConfigPath: pathSchema,
        observationHome: pathSchema,
        pidPath: pathSchema,
        publicHome: pathSchema,
        runtimeConfigPath: pathSchema,
        securityPath: pathSchema,
        socketPath: pathSchema,
        tokenPath: pathSchema,
    },
    { additionalProperties: false },
);
const sourceSchema = Type.Object(
    {
        exists: Type.Boolean(),
        path: pathSchema,
        unknownSettings: Type.Array(configStringSchema, { maxItems: MAX_UNKNOWN_SETTINGS }),
        unknownSettingsTruncated: Type.Boolean(),
        values: Type.Record(configStringSchema, Type.Unknown(), {
            maxProperties: MAX_CONFIG_TABLE_ENTRIES,
        }),
    },
    { additionalProperties: false },
);
const provenanceSchema = Type.Record(
    configStringSchema,
    Type.Union([
        Type.Literal("default"),
        Type.Literal("global"),
        Type.Literal("local"),
        Type.Literal("runtime"),
    ]),
    { maxProperties: MAX_PROVENANCE_ENTRIES },
);

export const happyAgentConfigurationInputSchema = Type.Union([
    Type.String({
        minLength: 1,
        maxLength: MAX_PATH_LENGTH,
        pattern: "^[^\\u0000]+$",
    }),
    Type.Undefined(),
]);
export type HappyAgentConfigurationInput = Static<typeof happyAgentConfigurationInputSchema>;

export const happyAgentConfigurationPathsSchema = pathSchemaSet;
export const happyAgentConfigValuesSchema = resolvedValuesSchema;
export const happyAgentConfigSourceSchema = sourceSchema;
export const happyAgentConfigurationSchema = Type.Object(
    {
        paths: happyAgentConfigurationPathsSchema,
        provenance: provenanceSchema,
        sources: Type.Object(
            {
                global: sourceSchema,
                local: sourceSchema,
                runtime: sourceSchema,
            },
            { additionalProperties: false },
        ),
        values: happyAgentConfigValuesSchema,
        /**
         * The version this build of the agent reports as itself.
         *
         * It is not a setting: nobody edits it in a file, and no `.happy` folder owns it. It is a
         * fact about the running program, and it belongs here because everything that has to say
         * what this agent is — a span, a log line, the client header sent to a server — already
         * reads the configuration and would otherwise be handed it separately.
         */
        version: Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH }),
    },
    { additionalProperties: false },
);

export type HappyAgentConfigurationPaths = Readonly<
    Static<typeof happyAgentConfigurationPathsSchema>
>;
export type HappyAgentConfigValues = Readonly<Static<typeof happyAgentConfigValuesSchema>>;
export type HappyAgentConfigSource = Readonly<Static<typeof happyAgentConfigSourceSchema>>;
export type HappyAgentConfiguration = Readonly<Static<typeof happyAgentConfigurationSchema>>;
type PartialValues = Static<typeof partialValuesSchema>;
type ConfigSourceKind = "global" | "local" | "runtime";

const DEFAULT_VALUES: HappyAgentConfigValues = {
    defaults: {
        modelId: "openai/gpt-5.6-sol",
        permissionMode: "auto",
    },
    features: {
        crossWorkspace: false,
        workflows: true,
        workspaces: true,
    },
    gemini: {},
    mcpServers: {},
    observation: {
        historyDump: false,
        logLevel: "info",
        logs: true,
        traces: false,
        tracesEndpoint: "http://127.0.0.1:4318/v1/traces",
    },
    p2p: {
        direct: {},
        enableDirect: false,
        enableIroh: true,
        enableSsh: false,
        exposeApi: false,
        iroh: {},
        name: "happy",
        role: "primary",
    },
    permissions: { protectedPaths: [] },
    presence: { states: {} },
    providerDefaultEnable: false,
    providers: {
        bedrock: { enabled: false, type: "bedrock" },
        claude: { enabled: false, type: "claude" },
        codex: { enabled: false, type: "codex" },
        grok: { enabled: false, type: "grok" },
    },
    settings: {
        compactCompletedTurns: false,
        completionChime: false,
        daemonHeapSnapshots: false,
        durableGlobalEventQueue: false,
        ethan: { enabled: false },
        happyIntegration: true,
        inferenceMaxRetries: 10,
        maxCollaborationDepth: 3,
        maxCollaborators: 5,
        menuBar: true,
        showReasoning: false,
        showUsage: false,
        toolResultRetentionDays: 7,
    },
    theme: {
        accent: "cyan",
        brand: "ansi:202",
        error: "red",
        primary: "default",
        secondary: "dim",
        success: "green",
        warning: "yellow",
    },
    workspace: {
        keepCopiesOnArchive: true,
        keepWorktreesOnArchive: false,
        protectedSync: [],
        setupCommands: [],
        sync: [],
    },
};

/** What the caller knows that no file on disk does. */
export interface ConfigModuleLoadOptions {
    /** The version this build reports as itself. Defaults to `"development"`. */
    readonly version?: string;
    /**
     * Replaces the accounts and the catalog this configuration would otherwise build.
     *
     * This exists so a test can script inference without a vendor credential. Nothing in the
     * product supplies it, and it belongs here because this is what owns the accounts: a scripted
     * account reaches every module that names one, not only the agent system. Given as a
     * factory, it receives the catalog the configuration would build on its own, so a gym can
     * reroute the real, config-enabled accounts instead of inventing a parallel catalog.
     */
    readonly inference?: ConfigInferenceOverride | ConfigInferenceFactory;
    /** Test-owned environment overrides for paths and credentials. */
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

/** Daemon-owned provider fields persisted together in generated runtime.toml. */
export interface RuntimeProviderStateUpdate {
    readonly autoEnable?: boolean;
    readonly enabled?: boolean;
}

/**
 * The resolved Happy Agent configuration and filesystem layout. It is loaded before the agent
 * system and passed to every module that needs configuration.
 */
export class ConfigModule implements AgentModule {
    readonly name = "config";
    readonly configuration: HappyAgentConfiguration;

    readonly #scripted: ConfigInferenceOverride | ConfigInferenceFactory | undefined;
    readonly #environment: Readonly<NodeJS.ProcessEnv>;
    readonly #providerLifetime = new AbortController();
    readonly #providerEnabled = new Map<string, boolean>();
    readonly #mcpLock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #runtimeLock: AsyncLock = asyncLock({ reentry: "allow" });
    #mcpServers: HappyAgentConfigValues["mcpServers"];
    #runtimeValues: PartialValues;
    #providerEnablement: ProviderEnablement | undefined;
    readonly #catalogNotices: string[] = [];
    #projectsHome: string | undefined;
    #providers: AgentProviders | undefined;
    #sourceProviders: AgentProviders | undefined;
    readonly #accountUsageListeners = new Set<(usage: ProviderUsage) => void>();
    #resolvedScripted: ConfigInferenceOverride | undefined;
    #scriptedModelSnapshot: readonly AgentModel[] | undefined;
    #workspacesHome: string | undefined;

    /** The public root for persistent bot folders. Configuration owns every product path. */
    get botsHome(): string {
        return join(this.configuration.paths.publicHome, "Bots");
    }

    /** One immutable bot folder below the configuration-owned bot root. */
    botPath(username: string): string {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(username)) {
            throw new Error("The bot username cannot name a folder.");
        }
        return join(this.botsHome, username);
    }

    private constructor(
        configuration: HappyAgentConfiguration,
        runtimeValues: PartialValues,
        scripted: ConfigInferenceOverride | ConfigInferenceFactory | undefined,
        environment: Readonly<NodeJS.ProcessEnv>,
    ) {
        this.configuration = configuration;
        this.#mcpServers = configuration.values.mcpServers;
        this.#runtimeValues = structuredClone(runtimeValues);
        this.#scripted = scripted;
        this.#environment = environment;
        for (const id of Object.keys(configuration.values.providers)) {
            this.#providerEnabled.set(id, this.configuredProviderOverride(id) ?? false);
        }
    }

    readonly #hooks: AgentModuleHooks = {
        /** Apply configured root instructions through the normal pre-inference hook. */
        instructions: async (): Promise<string> =>
            this.configuration.values.defaults.instructions ?? "",
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /**
     * Every model the configuration enables, with the configured default first.
     *
     * The order is the answer to "what does a session run on when it names nothing", so the first
     * entry is the account every agent starts on.
     */
    get models(): readonly AgentModel[] {
        const scripted = this.#scriptedModels();
        if (scripted !== undefined) {
            // Initialize the test-owned accounts before applying their live gates. The scan module
            // can then take ownership and turn them off during its startup phase just like real
            // accounts.
            void this.#providerSource();
            return scripted.filter((model) => this.isProviderEnabled(model.providerId));
        }
        return agentModels(
            this.configuration,
            (message) => {
                if (!this.#catalogNotices.includes(message)) this.#catalogNotices.push(message);
            },
            (id) => this.isProviderEnabled(id),
        );
    }

    /** Every configured route independent of its live provider gate. */
    get offeredModels(): readonly AgentModel[] {
        return this.#scriptedModels() ?? agentModels(this.configuration, undefined, () => true);
    }

    /** Every configured provider/model route, including disabled and filtered catalog entries. */
    get catalog(): readonly ConfiguredAgentModel[] {
        const scripted = this.#scriptedModels();
        const scriptedProviderIds = new Set(scripted?.map((model) => model.providerId) ?? []);
        const catalog = agentModelCatalog(this.configuration, (id) =>
            this.isProviderEnabled(id),
        ).filter((model) => !scriptedProviderIds.has(model.providerId));
        if (scripted !== undefined) {
            for (const model of scripted) {
                const entry: ConfiguredAgentModel = {
                    ...model,
                    contextWindow: agentModelContext(model.id)?.contextWindow ?? null,
                    enabled: this.isProviderEnabled(model.providerId),
                };
                catalog.push(entry);
            }
        }
        return catalog;
    }

    /** Curated context limits for one enabled provider/model route. */
    modelContext(providerId: string, modelId: string): AgentModelContext | undefined {
        const enabled = this.models.some(
            (model) => model.providerId === providerId && model.id === modelId,
        );
        return enabled ? agentModelContext(modelId) : undefined;
    }

    /**
     * What the catalog ignored to stay serviceable: a configured default model or effort that
     * no enabled provider satisfies. The daemon surfaces these instead of refusing to start.
     */
    get catalogNotices(): readonly string[] {
        void this.models;
        return this.#catalogNotices;
    }

    /**
     * The accounts, as one registry built once.
     *
     * A provider holds a credential and a connection, so there is exactly one of each per
     * installation: a module that needs to reach a vendor asks for this rather than building a
     * second registry that would sign in again.
     */
    get providers(): AgentProviders {
        if (this.#providers !== undefined) return this.#providers;
        const source = this.#providerSource();
        this.#providerEnablement = new ProviderEnablement(source.ids, (id) =>
            this.isProviderEnabled(id),
        );
        this.#providers = providerRegistryUntil(
            source,
            this.#providerLifetime.signal,
            this.#providerEnablement,
        );
        return this.#providers;
    }

    get providerIds(): readonly string[] {
        return this.#providerSource().ids;
    }

    isProviderEnabled(providerId: string): boolean {
        return this.#providerEnabled.get(providerId) === true;
    }

    setProviderEnabled(providerId: string, enabled: boolean): void {
        if (!this.#providerEnabled.has(providerId)) {
            throw new Error(`Provider "${providerId}" is not configured.`);
        }
        this.#providerEnabled.set(providerId, enabled);
        this.#providerEnablement?.setEnabled(providerId, enabled);
    }

    /** A configuration-file setting is explicit and always outranks automatic discovery. */
    configuredProviderOverride(providerId: string): boolean | undefined {
        let explicitDefault: boolean | undefined;
        let explicitProvider: boolean | undefined;
        const sources = [
            this.configuration.sources.global.values,
            normalizeSourceValues(this.#runtimeValues),
        ];
        for (const values of sources) {
            if (typeof values.providerDefaultEnable === "boolean") {
                explicitDefault = values.providerDefaultEnable;
            }
            const providers = values.providers as
                | Record<string, { readonly enabled?: unknown }>
                | undefined;
            const enabled = providers?.[providerId]?.enabled;
            if (typeof enabled === "boolean") explicitProvider = enabled;
        }
        return explicitProvider ?? explicitDefault;
    }

    /** The generated auto-enable setting, or nothing before a provider has been detected. */
    providerAutoEnable(providerId: string): boolean | undefined {
        const runtimeProvider = this.#runtimeValues.providers?.[providerId] as
            | { readonly auto_enable?: unknown }
            | undefined;
        if (typeof runtimeProvider?.auto_enable === "boolean") return runtimeProvider.auto_enable;
        return this.configuration.values.providers[providerId]?.autoEnable;
    }

    /** Canonically rewrite the daemon-owned runtime configuration. */
    async writeRuntimeConfiguration(ctx: Context): Promise<void> {
        await this.#runtimeLock.runInLock(ctx, async () => {
            await writeRuntimeConfigurationFile(
                this.configuration.paths.runtimeConfigPath,
                this.#runtimeValues,
            );
        });
    }

    /** Atomically merge daemon provider state into generated runtime.toml. */
    async updateRuntimeProviderStates(
        ctx: Context,
        updates: Readonly<Record<string, RuntimeProviderStateUpdate>>,
    ): Promise<void> {
        const entries = Object.entries(updates);
        for (const [providerId] of entries) {
            if (!this.#providerEnabled.has(providerId)) {
                throw new Error(`Provider "${providerId}" is not configured.`);
            }
        }
        await this.#runtimeLock.runInLock(ctx, async () => {
            const next = structuredClone(this.#runtimeValues);
            const providers = (next.providers ?? {}) as Record<string, Record<string, unknown>>;
            next.providers = providers as NonNullable<PartialValues["providers"]>;
            for (const [providerId, update] of entries) {
                const provider = { ...(providers[providerId] ?? {}) };
                if (
                    !["bedrock", "claude", "codex", "grok"].includes(providerId) &&
                    provider["type"] === undefined
                ) {
                    const type = this.configuration.values.providers[providerId]?.type;
                    const compatibility = type ?? this.#providerSource().typeOf(providerId);
                    provider["type"] = compatibility === "gym" ? "codex" : compatibility;
                }
                if (update.autoEnable !== undefined) provider["auto_enable"] = update.autoEnable;
                if (update.enabled !== undefined) provider["enabled"] = update.enabled;
                providers[providerId] = provider;
            }
            if (!Value.Check(partialValuesSchema, next)) {
                throw new Error("The generated runtime configuration is invalid.");
            }
            await writeRuntimeConfigurationFile(this.configuration.paths.runtimeConfigPath, next);
            this.#runtimeValues = next;
        });
    }

    /** Resolve an account without consulting its live gate, for bounded scans and verification. */
    async resolveProviderUnchecked(
        providerId: string,
        model: string | undefined,
    ): Promise<import("@slopus/happy-providers").BaseProvider | null> {
        return await this.#providerSource().resolve(providerId, model);
    }

    /** Local credential evidence only; this method never performs a vendor request. */
    async probeLocalProviderCredentials(providerId: string): Promise<"available" | "missing"> {
        if (this.#scripted !== undefined) {
            return (await this.resolveProviderUnchecked(providerId, undefined)) === null
                ? "missing"
                : "available";
        }
        const configured = this.configuration.values.providers[providerId];
        if (configured === undefined) return "missing";
        if (configured.type === "bedrock") {
            return (await this.#hasLocalBedrockCredential(configured)) ? "available" : "missing";
        }
        try {
            return (await this.resolveProviderUnchecked(providerId, undefined)) === null
                ? "missing"
                : "available";
        } catch (error: unknown) {
            if (error instanceof Error && error.message.includes("authentication is unavailable")) {
                return "missing";
            }
            throw error;
        }
    }

    async #hasLocalBedrockCredential(
        provider: HappyAgentConfigValues["providers"][string] & { readonly type: "bedrock" },
    ): Promise<boolean> {
        const environment = { ...process.env, ...this.#environment };
        if ((provider.bearerToken?.trim().length ?? 0) > 0) return true;
        if (
            provider.bearerTokenEnvVar !== undefined &&
            (environment[provider.bearerTokenEnvVar]?.trim().length ?? 0) > 0
        ) {
            return true;
        }
        const explicitFiles = [provider.credentialsFile, provider.configFile].filter(
            (path): path is string => path !== undefined,
        );
        if (await hasAwsCredentialConfiguration(explicitFiles)) return true;
        if (provider.credentialIsolation === true) return false;
        if ((environment.AWS_BEARER_TOKEN_BEDROCK?.trim().length ?? 0) > 0) return true;
        if (
            (environment.AWS_ACCESS_KEY_ID?.trim().length ?? 0) > 0 &&
            (environment.AWS_SECRET_ACCESS_KEY?.trim().length ?? 0) > 0
        ) {
            return true;
        }
        if (
            (environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim().length ?? 0) > 0 ||
            (environment.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim().length ?? 0) > 0
        ) {
            return true;
        }
        const webIdentityToken = environment.AWS_WEB_IDENTITY_TOKEN_FILE?.trim();
        if (
            webIdentityToken !== undefined &&
            webIdentityToken.length > 0 &&
            (environment.AWS_ROLE_ARN?.trim().length ?? 0) > 0 &&
            (await anyNonemptyFile([webIdentityToken]))
        ) {
            return true;
        }
        const home = environment.HOME?.trim() || homedir();
        return await hasAwsCredentialConfiguration([
            environment.AWS_SHARED_CREDENTIALS_FILE ?? join(home, ".aws", "credentials"),
            environment.AWS_CONFIG_FILE ?? join(home, ".aws", "config"),
        ]);
    }

    /**
     * Watch account-usage readings the vendors report during ordinary inference.
     *
     * A vendor that measures the account on every response has already answered the question its
     * usage API is asked, so the reading arrives as a side effect of real work instead of costing
     * a separate request against an endpoint that is itself rate limited. Returns the function
     * that ends the subscription.
     */
    onProviderAccountUsage(listener: (usage: ProviderUsage) => void): () => void {
        this.#accountUsageListeners.add(listener);
        return () => this.#accountUsageListeners.delete(listener);
    }

    /** Usage is bookkeeping beside the run, so a listener that throws never breaks inference. */
    #reportAccountUsage(usage: ProviderUsage): void {
        for (const listener of this.#accountUsageListeners) {
            try {
                listener(usage);
            } catch {
                // A usage listener never decides whether inference continues.
            }
        }
    }

    /** Cancel every provider request owned by this daemon without coupling agents to its lifetime. */
    closeProviders(): void {
        this.#providerLifetime.abort(new Error("The Happy Agent runtime is shutting down."));
    }

    /** Ask one configured account for its complete normalized vendor usage reading. */
    async readProviderUsage(
        ctx: Context,
        providerId: string,
    ): Promise<import("@slopus/happy-providers").ProviderUsage | null> {
        if (!this.isProviderEnabled(providerId)) return null;
        return await this.readProviderUsageUnchecked(ctx, providerId);
    }

    /** Authenticated usage probe that bypasses enablement for explicit verification. */
    async readProviderUsageUnchecked(
        ctx: Context,
        providerId: string,
    ): Promise<import("@slopus/happy-providers").ProviderUsage | null> {
        return await loadConfiguredProviderUsage({
            environment: { ...process.env, ...this.#environment },
            providerId,
            providers: this.configuration.values.providers,
            ignoreEnabled: true,
            ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
        });
    }

    /**
     * A scripted override given as a factory sees the catalog this configuration would build on
     * its own, so it can reroute real accounts instead of inventing a parallel catalog.
     */
    #resolveScripted(): ConfigInferenceOverride | undefined {
        if (typeof this.#scripted !== "function") return this.#scripted;
        this.#resolvedScripted ??= this.#scripted(
            {
                models: agentModels(this.configuration, (message) =>
                    this.#catalogNotices.push(message),
                ),
                providers: agentProviders(this.configuration),
            },
            this.configuration,
        );
        return this.#resolvedScripted;
    }

    /** Snapshot a test-owned catalog once while retaining only its provider gates as live state. */
    #scriptedModels(): readonly AgentModel[] | undefined {
        const models = this.#resolveScripted()?.models;
        if (models === undefined) return undefined;
        this.#scriptedModelSnapshot ??= Object.freeze(
            models.map((model) =>
                Object.freeze({
                    ...model,
                    effortLevels: Object.freeze([...model.effortLevels]),
                    ...(model.serviceTiers === undefined
                        ? {}
                        : { serviceTiers: Object.freeze([...model.serviceTiers]) }),
                }),
            ),
        );
        return this.#scriptedModelSnapshot;
    }

    #providerSource(): AgentProviders {
        if (this.#sourceProviders === undefined) {
            this.#sourceProviders =
                this.#resolveScripted()?.providers ??
                agentProviders(this.configuration, (usage) => this.#reportAccountUsage(usage));
            // A test-owned inference registry is already authenticated. Initialize all its
            // accounts as usable, including canonical IDs whose production defaults are off. This
            // happens exactly once: ProviderScanModule may subsequently gate them without a later
            // registry read silently re-enabling them.
            if (this.#scripted !== undefined) {
                const ids = new Set([
                    ...this.#sourceProviders.ids,
                    ...(this.#scriptedModels()?.map((model) => model.providerId) ?? []),
                ]);
                for (const id of ids) {
                    this.#providerEnabled.set(id, this.configuredProviderOverride(id) ?? true);
                }
            }
        }
        return this.#sourceProviders;
    }

    /**
     * Creates the user's global configuration files when they do not exist yet: a fully
     * commented happy.toml template plus empty AGENTS.md and SECURITY.md, all inside a private
     * Config directory. Existing files are never touched. The daemon calls this once at
     * startup; ephemeral commands such as installation inspection must not.
     */
    async ensureUserConfigurationFiles(): Promise<void> {
        const paths = this.configuration.paths;
        const directories = [
            ...new Set([
                dirname(paths.globalConfigPath),
                dirname(paths.instructionsPath),
                dirname(paths.mcpConfigPath),
                dirname(paths.securityPath),
            ]),
        ];
        for (const directory of directories) {
            // Keep the user-facing Happy parent normally accessible; only Config is private.
            await mkdir(dirname(directory), { recursive: true });
            await mkdir(directory, { mode: 0o700, recursive: true });
            await chmod(directory, 0o700);
        }
        await Promise.all([
            writeUserFileIfMissing(paths.globalConfigPath, HAPPY_TOML_TEMPLATE),
            writeUserFileIfMissing(paths.instructionsPath, ""),
            writeUserFileIfMissing(paths.mcpConfigPath, MCP_TOML_TEMPLATE),
            writeUserFileIfMissing(paths.securityPath, ""),
        ]);
    }

    /**
     * The Gemini key, when this installation carries one.
     *
     * Gemini is not one of the accounts a chat runs on: it answers over its own HTTP API, so it has
     * no `[providers.*]` entry. The key comes from `[gemini] api_key` in the user `happy.toml`, or
     * failing that from `GEMINI_API_KEY`, and it is read here because configuration is what owns
     * credentials — a module that wants Gemini asks for this rather than reading the environment
     * behind config's back. The environment is read on every call, so a key exported after startup
     * reaches the next request. Blank, whitespace, or longer than any other configured string, and
     * there is no Gemini key at all.
     */
    get geminiApiKey(): string | undefined {
        const configured = this.configuration.values.gemini.apiKey?.trim();
        if (configured !== undefined && configured.length > 0) return configured;
        const value = this.#environmentValue("GEMINI_API_KEY")?.trim();
        if (value === undefined || value.length === 0) return undefined;
        return value.length > MAX_CONFIG_STRING_LENGTH ? undefined : value;
    }

    /**
     * The GitHub token this installation acts with, when its environment carries one.
     *
     * Cloning a private repository needs a credential, and the only one a local installation has is
     * whatever the person's own tooling already exported — `GITHUB_TOKEN`, or `GH_TOKEN` under the
     * name the GitHub CLI uses. It is read here because configuration is what owns credentials, and
     * on every call, so a token exported after startup reaches the next clone. Blank, whitespace, or
     * longer than any other configured string, and this installation has no GitHub token at all.
     */
    get githubToken(): string | undefined {
        for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
            const value = this.#environmentValue(name)?.trim();
            if (value === undefined || value.length === 0) continue;
            return value.length > MAX_CONFIG_STRING_LENGTH ? undefined : value;
        }
        return undefined;
    }

    /**
     * The optional discovery ceiling for unattended Git reads.
     *
     * A hermetic installation can live beneath another repository while treating its own project
     * folders as independent plain directories. Git owns the scan, but configuration owns this
     * process-level path boundary and exposes only that value rather than its whole environment.
     */
    get gitCeilingDirectories(): string | undefined {
        const value = this.#environmentValue("GIT_CEILING_DIRECTORIES")?.trim();
        if (value === undefined || value.length === 0) return undefined;
        return value.length > MAX_CONFIG_STRING_LENGTH ? undefined : value;
    }

    /** The process-level Happy settings used to find and authorize the mobile integration. */
    get happyEnvironment(): Readonly<NodeJS.ProcessEnv> {
        const environment: NodeJS.ProcessEnv = {};
        for (const name of [
            "HAPPY_AGENT_HAPPY_SERVER_URL",
            "HAPPY_HOME_DIR",
            "HAPPY_SERVER_URL",
        ] as const) {
            const value = this.#environmentValue(name);
            if (value !== undefined) environment[name] = value;
        }
        return environment;
    }

    /** Bedrock serves its hosted search index from particular models, so an account may name one. */
    get bedrockSearchModels(): Readonly<Record<string, string>> {
        const models: Record<string, string> = {};
        for (const [id, provider] of Object.entries(this.configuration.values.providers)) {
            if (!this.isProviderEnabled(id) || provider.type !== "bedrock") continue;
            if (provider.searchModelId !== undefined) models[id] = provider.searchModelId;
        }
        return models;
    }

    /**
     * The folder projects Happy Agent cloned for someone live under.
     *
     * A project records its own folder once it exists, so this only decides where the next clone
     * lands. Like the rest of the layout it is settled once per installation.
     */
    get projectsHome(): string {
        this.#projectsHome ??= getManagedProjectsDirectory({
            ...process.env,
            ...this.#environment,
        });
        return this.#projectsHome;
    }

    /**
     * The folder managed workspaces live under.
     *
     * A workspace records its own path once it is created, so this only decides where the next
     * one lands. It is settled once per installation, the way the rest of the layout is.
     */
    get workspacesHome(): string {
        this.#workspacesHome ??= getManagedWorkspacesDirectory({
            ...process.env,
            ...this.#environment,
        });
        return this.#workspacesHome;
    }

    #environmentValue(name: string): string | undefined {
        return Object.hasOwn(this.#environment, name) ? this.#environment[name] : process.env[name];
    }

    /**
     * What a workspace folder does when it says nothing itself: what to sync, what to protect,
     * what to run on setup, and what archiving leaves on disk.
     */
    get workspaceSettings(): HappyAgentConfigValues["workspace"] {
        return this.configuration.values.workspace;
    }

    /** Read the Happy-owned MCP catalog fresh so an online reload sees edits immediately. */
    async readMcpServers(): Promise<HappyAgentConfigValues["mcpServers"]> {
        const servers = await readMcpConfigurationFile(this.configuration.paths.mcpConfigPath);
        this.#mcpServers = servers;
        return servers;
    }

    /** Read the MCP catalog owned by one workspace without merging it into machine settings. */
    async readWorkspaceMcpServers(
        workspacePath: string,
    ): Promise<HappyAgentConfigValues["mcpServers"]> {
        if (workspacePath.length === 0 || workspacePath.length > MAX_PATH_LENGTH) {
            throw new Error("Workspace path is invalid.");
        }
        return await readMcpConfigurationFile(join(resolve(workspacePath), "mcp.toml"));
    }

    /** The most recently loaded Happy-owned MCP catalog. */
    get mcpServers(): HappyAgentConfigValues["mcpServers"] {
        return this.#mcpServers;
    }

    /** Canonically add, replace, or remove one server without exposing the other server values. */
    async updateMcpServer(
        ctx: Context,
        name: string,
        server: HappyAgentConfigValues["mcpServers"][string] | undefined,
    ): Promise<HappyAgentConfigValues["mcpServers"]> {
        if (name.length === 0 || name.length > 128) throw new Error("MCP server name is invalid.");
        return await this.#mcpLock.runInLock(ctx, async () => {
            const current = structuredClone(await this.readMcpServers()) as Record<string, unknown>;
            if (server === undefined) delete current[name];
            else current[name] = structuredClone(server);
            if (!Value.Check(resolvedValuesSchema.properties.mcpServers, current)) {
                throw new Error("MCP server configuration is invalid.");
            }
            await writeMcpConfigurationFile(
                this.configuration.paths.mcpConfigPath,
                current as HappyAgentConfigValues["mcpServers"],
            );
            const servers = deepFreeze(current) as HappyAgentConfigValues["mcpServers"];
            this.#mcpServers = servers;
            return servers;
        });
    }

    /**
     * The person's own instructions, the ones that apply to every project.
     *
     * Configuration owns the path, so a module that wants the document asks for the text and is
     * given at most `maxBytes` of it. A file that is not there is an absent document, not a
     * failure, and the read happens on every call so an edit reaches the next turn.
     */
    async readGlobalInstructions(ctx: Context, maxBytes: number): Promise<string | undefined> {
        return await readGlobalInstructions(
            ctx,
            this.configuration.paths.instructionsPath,
            maxBytes,
        );
    }

    /**
     * The person's own security policy, the one that applies wherever this installation runs.
     *
     * Configuration owns the path, so a module that judges what an agent may do asks for the text
     * and is given at most `maxBytes` of it. It is read on every call, so a policy edited while a
     * session is open takes effect on the next decision that consults it. A file that is not there
     * is an absent policy; anything else that goes wrong is raised, so a caller can refuse to act
     * on a policy it could not read rather than act on half of one.
     */
    async readGlobalSecurity(_ctx: Context, maxBytes: number): Promise<string | undefined> {
        return await readSecurityDocument(this.configuration.paths.securityPath, maxBytes);
    }

    /**
     * The security policy written at the root of the folder the agent works in.
     *
     * It sits beside that folder's own instructions and is read the same way, under the same bound
     * and with the same treatment of an absent file. Where the folder is, is the configuration's
     * answer rather than the caller's.
     */
    async readProjectSecurity(_ctx: Context, maxBytes: number): Promise<string | undefined> {
        return await readSecurityDocument(
            join(this.configuration.paths.publicHome, "AGENTS_SECURITY.md"),
            maxBytes,
        );
    }

    static async load(
        input?: HappyAgentConfigurationInput,
        options: ConfigModuleLoadOptions = {},
    ): Promise<ConfigModule> {
        const paths = derivePaths(input);
        const [global, local, runtime, mcp] = await Promise.all([
            readConfigSource(paths.globalConfigPath, "global"),
            readConfigSource(paths.localConfigPath, "local"),
            readConfigSource(paths.runtimeConfigPath, "runtime"),
            readConfigSource(paths.mcpConfigPath, "global"),
        ]);
        const localValues = withoutProjectMachineSettings(local.values);
        const globalValues = withoutMcpServers(global.values);
        const runtimeValues = withoutMcpServers(runtime.values);
        const values = mergeValues(
            globalValues,
            withoutMcpServers(localValues),
            runtimeValues,
            mcp.values.mcp_servers === undefined ? {} : { mcp_servers: mcp.values.mcp_servers },
        );
        const configuration = {
            paths,
            provenance: {
                ...calculateProvenance(globalValues, withoutMcpServers(localValues), runtimeValues),
                ...(mcp.values.mcp_servers === undefined ? {} : { mcpServers: "global" }),
            },
            sources: {
                global: sourceSnapshot(global),
                local: sourceSnapshot(local),
                runtime: sourceSnapshot(runtime),
            },
            values,
            // A build that was never stamped is a development build, and says so rather than
            // reporting an empty version that reads as a bug wherever it is displayed.
            version: options.version ?? "development",
        };
        if (!Value.Check(happyAgentConfigurationSchema, configuration)) {
            throw new Error("The Happy Agent configuration is invalid.");
        }
        return new ConfigModule(
            deepFreeze(configuration),
            runtimeValues,
            options.inference,
            Object.freeze({ ...options.environment }),
        );
    }
}

/** Creates one user configuration file exclusively, leaving an existing file untouched. */
async function writeUserFileIfMissing(path: string, contents: string): Promise<void> {
    let file: Awaited<ReturnType<typeof open>>;
    try {
        file = await open(path, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
        throw error;
    }
    try {
        await file.writeFile(contents, { encoding: "utf8" });
        await file.close();
    } catch (error) {
        await file.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
    }
}

/** Replace generated runtime.toml atomically; comments and unknown fields are intentionally gone. */
async function writeRuntimeConfigurationFile(path: string, values: PartialValues): Promise<void> {
    if (!Value.Check(partialValuesSchema, values)) {
        throw new Error("The generated runtime configuration is invalid.");
    }
    const encoded = stringify(runtimeConfigurationTable(values));
    const contents = encoded.length === 0 || encoded.endsWith("\n") ? encoded : `${encoded}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_CONFIG_FILE_BYTES) {
        throw new Error(`Configuration exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit.`);
    }
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

/** Replace the user-owned MCP catalog atomically after rendering its normalized values. */
async function writeMcpConfigurationFile(
    path: string,
    servers: HappyAgentConfigValues["mcpServers"],
): Promise<void> {
    const mcpServers: TomlTable = {};
    for (const [name, server] of Object.entries(servers)) {
        mcpServers[name] =
            server.transport === "stdio"
                ? {
                      command: server.command,
                      ...(server.args === undefined ? {} : { args: [...server.args] }),
                      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
                      ...(server.env === undefined ? {} : { env: { ...server.env } }),
                      ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
                      ...(server.startupTimeoutMs === undefined
                          ? {}
                          : { startup_timeout_sec: server.startupTimeoutMs / 1_000 }),
                      ...(server.toolTimeoutMs === undefined
                          ? {}
                          : { tool_timeout_sec: server.toolTimeoutMs / 1_000 }),
                      ...(server.enabledTools === undefined
                          ? {}
                          : { enabled_tools: [...server.enabledTools] }),
                      ...(server.disabledTools === undefined
                          ? {}
                          : { disabled_tools: [...server.disabledTools] }),
                  }
                : {
                      url: server.url,
                      ...(server.headers === undefined
                          ? {}
                          : { http_headers: { ...server.headers } }),
                      ...(server.bearerTokenEnvVar === undefined
                          ? {}
                          : { bearer_token_env_var: server.bearerTokenEnvVar }),
                      ...(server.oauthClientIdEnvVar === undefined
                          ? {}
                          : { oauth_client_id_env_var: server.oauthClientIdEnvVar }),
                      ...(server.oauthClientSecretEnvVar === undefined
                          ? {}
                          : { oauth_client_secret_env_var: server.oauthClientSecretEnvVar }),
                      ...(server.oauthScopes === undefined
                          ? {}
                          : { oauth_scopes: [...server.oauthScopes] }),
                      ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
                      ...(server.startupTimeoutMs === undefined
                          ? {}
                          : { startup_timeout_sec: server.startupTimeoutMs / 1_000 }),
                      ...(server.toolTimeoutMs === undefined
                          ? {}
                          : { tool_timeout_sec: server.toolTimeoutMs / 1_000 }),
                      ...(server.enabledTools === undefined
                          ? {}
                          : { enabled_tools: [...server.enabledTools] }),
                      ...(server.disabledTools === undefined
                          ? {}
                          : { disabled_tools: [...server.disabledTools] }),
                  };
    }
    const encoded = stringify(
        Object.keys(mcpServers).length === 0 ? {} : { mcp_servers: mcpServers },
    );
    const contents = encoded.length === 0 || encoded.endsWith("\n") ? encoded : `${encoded}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_CONFIG_FILE_BYTES) {
        throw new Error(`MCP configuration exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit.`);
    }
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

function runtimeConfigurationTable(values: PartialValues): TomlTable {
    const { provider_default_enable: defaultEnable, providers, ...rest } = values;
    const providerTable = {
        ...(defaultEnable === undefined ? {} : { default_enable: defaultEnable }),
        ...(providers ?? {}),
    };
    return {
        ...(rest as TomlTable),
        ...(Object.keys(providerTable).length === 0 ? {} : { providers: providerTable }),
    };
}

/** Scripted accounts, for a test that runs the whole product without a vendor credential. */
export interface ConfigInferenceOverride {
    readonly models: readonly AgentModel[];
    readonly providers: AgentProviders;
}

/**
 * Builds a scripted override from the catalog the configuration enables on its own, so the
 * override can honor real provider enablement while replacing how inference is served.
 */
export type ConfigInferenceFactory = (
    real: ConfigInferenceOverride,
    configuration: HappyAgentConfiguration,
) => ConfigInferenceOverride;

export async function loadHappyAgentConfiguration(
    input?: HappyAgentConfigurationInput,
    options: ConfigModuleLoadOptions = {},
): Promise<HappyAgentConfiguration> {
    return (await ConfigModule.load(input, options)).configuration;
}

export function parseHappyAgentConfigToml(source: string): {
    readonly unknownSettings: readonly string[];
    readonly unknownSettingsTruncated: boolean;
    readonly values: PartialValues;
} {
    if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_FILE_BYTES) {
        throw new Error(`Configuration exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit.`);
    }
    const table = parse(source);
    if (!isTable(table)) throw new Error("The Happy Agent configuration must be a TOML table.");
    assertTableSize(table, "configuration");
    const unknownSettings: string[] = [];
    let unknownSettingsTruncated = false;
    const recordUnknown = (path: string) => {
        if (unknownSettings.length >= MAX_UNKNOWN_SETTINGS) {
            unknownSettingsTruncated = true;
            return;
        }
        if (path.length > MAX_CONFIG_STRING_LENGTH) {
            unknownSettings.push(path.slice(0, MAX_CONFIG_STRING_LENGTH));
            unknownSettingsTruncated = true;
            return;
        }
        unknownSettings.push(path);
    };
    const knownTopLevel = new Set([
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
    ]);
    for (const key of Object.keys(table)) {
        if (!knownTopLevel.has(key)) recordUnknown(key);
    }
    const defaults = readDefaults(table.defaults, recordUnknown);
    const providers = readProviders(table.providers, recordUnknown);
    const settings = readSettings(table.settings, recordUnknown);
    const features = readFeatures(table.features, recordUnknown);
    const gemini = readGemini(table.gemini, recordUnknown);
    const workspace = readWorkspace(table.workspace, recordUnknown);
    const docker = readDocker(table.docker, recordUnknown);
    const mcpServers = readMcpServers(table.mcp_servers, recordUnknown);
    const network = readNetwork(table.network, recordUnknown);
    const observation = readObservation(table.observation, recordUnknown);
    const p2p = readP2p(table.p2p, recordUnknown);
    const permissions = readPermissions(table.permissions, recordUnknown);
    const presence = readPresence(table.presence, recordUnknown);
    const theme = readTheme(table.theme, recordUnknown);
    const providerDefaultEnable =
        table.providers !== undefined && isTable(table.providers)
            ? readBoolean(table.providers, "default_enable", "providers.default_enable")
            : undefined;
    const values = {
        ...(defaults === undefined ? {} : { defaults }),
        ...(features === undefined ? {} : { features }),
        ...(docker === undefined ? {} : { docker }),
        ...(gemini === undefined ? {} : { gemini }),
        ...(mcpServers === undefined ? {} : { mcp_servers: mcpServers }),
        ...(network === undefined ? {} : { network }),
        ...(observation === undefined ? {} : { observation }),
        ...(p2p === undefined ? {} : { p2p }),
        ...(permissions === undefined ? {} : { permissions }),
        ...(presence === undefined ? {} : { presence }),
        ...(providerDefaultEnable === undefined
            ? {}
            : { provider_default_enable: providerDefaultEnable }),
        ...(providers === undefined ? {} : { providers }),
        ...(settings === undefined ? {} : { settings }),
        ...(theme === undefined ? {} : { theme }),
        ...(workspace === undefined ? {} : { workspace }),
    };
    if (!Value.Check(partialValuesSchema, values)) {
        throw new Error("The Happy Agent configuration contains an invalid value.");
    }
    return { unknownSettings, unknownSettingsTruncated, values };
}

interface ReadSource {
    readonly exists: boolean;
    readonly path: string;
    readonly unknownSettings: readonly string[];
    readonly unknownSettingsTruncated: boolean;
    readonly values: PartialValues;
}

async function readMcpConfigurationFile(
    path: string,
): Promise<HappyAgentConfigValues["mcpServers"]> {
    const source = await readConfigSource(path, "global");
    const misplaced = Object.keys(source.values).filter((key) => key !== "mcp_servers");
    if (misplaced.length > 0) {
        throw new Error(
            `MCP configuration may contain only mcp_servers, not ${misplaced.join(", ")}.`,
        );
    }
    return deepFreeze(
        normalizeMcpServers(source.values.mcp_servers ?? {}),
    ) as HappyAgentConfigValues["mcpServers"];
}

function sourceSnapshot(source: ReadSource): HappyAgentConfigSource {
    return {
        exists: source.exists,
        path: source.path,
        unknownSettings: [...source.unknownSettings],
        unknownSettingsTruncated: source.unknownSettingsTruncated,
        values: normalizeSourceValues(source.values),
    };
}

function normalizeSourceValues(values: PartialValues): Record<string, unknown> {
    return {
        ...(values.docker === undefined ? {} : { docker: normalizeDocker(values.docker) }),
        ...(values.defaults === undefined ? {} : { defaults: normalizeDefaults(values.defaults) }),
        ...(values.features === undefined ? {} : { features: normalizeFeatures(values.features) }),
        ...(values.gemini === undefined ? {} : { gemini: normalizeGemini(values.gemini) }),
        ...(values.mcp_servers === undefined
            ? {}
            : { mcpServers: normalizeMcpServers(values.mcp_servers) }),
        ...(values.network === undefined ? {} : { network: normalizeNetwork(values.network) }),
        ...(values.observation === undefined
            ? {}
            : { observation: normalizeObservation(values.observation) }),
        ...(values.p2p === undefined ? {} : { p2p: normalizeP2p(values.p2p) }),
        ...(values.permissions === undefined
            ? {}
            : { permissions: { protectedPaths: values.permissions.protected_paths ?? [] } }),
        ...(values.presence === undefined ? {} : { presence: normalizePresence(values.presence) }),
        ...(values.provider_default_enable === undefined
            ? {}
            : { providerDefaultEnable: values.provider_default_enable }),
        ...(values.providers === undefined
            ? {}
            : {
                  providers: Object.fromEntries(
                      Object.entries(values.providers).map(([id, provider]) => [
                          id,
                          normalizeProvider(id, provider as Record<string, unknown>),
                      ]),
                  ),
              }),
        ...(values.settings === undefined ? {} : { settings: normalizeSettings(values.settings) }),
        ...(values.theme === undefined ? {} : { theme: values.theme }),
        ...(values.workspace === undefined
            ? {}
            : { workspace: normalizeWorkspace(values.workspace) }),
    };
}

async function readConfigSource(path: string, _kind: ConfigSourceKind): Promise<ReadSource> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        file = await open(path, "r");
        const bytes = Buffer.allocUnsafe(MAX_CONFIG_FILE_BYTES + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_CONFIG_FILE_BYTES) {
            throw new Error(`Configuration exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit.`);
        }
        const parsed = parseHappyAgentConfigToml(bytes.subarray(0, bytesRead).toString("utf8"));
        return { exists: true, path, ...parsed };
    } catch (error) {
        if (isMissingFile(error)) {
            return {
                exists: false,
                path,
                unknownSettings: [],
                unknownSettingsTruncated: false,
                values: {},
            };
        }
        if (error instanceof Error) {
            throw new Error(
                `Could not read Happy Agent configuration '${path}'. ${error.message}`,
                { cause: error },
            );
        }
        throw error;
    } finally {
        await file?.close().catch(() => undefined);
    }
}

function derivePaths(input: HappyAgentConfigurationInput): HappyAgentConfigurationPaths {
    if (!Value.Check(happyAgentConfigurationInputSchema, input)) {
        throw new Error("The Happy root path must be a non-empty path.");
    }
    const happyHome = resolveHappyHome(input);
    const publicHome = join(dirname(happyHome), "Happy");
    const agentHome = join(happyHome, "agent");
    const configHome = join(publicHome, "Config");
    // What the agent records about itself stays in the private root beside its database, because
    // logs and a verbatim history dump say everything the conversation said.
    const observationHome = join(agentHome, "observation");
    const paths = {
        agentHome,
        agentLockPath: join(agentHome, "agent.lock"),
        // The automatic permission reviewer keeps its own review-only agent system in a separate
        // database and single-owner lock beside, never on top of, the main agent's own files, so
        // the reviewer's state shares nothing with the agent it reviews.
        autoAgentLockPath: join(agentHome, "auto-agent.lock"),
        autoDatabasePath: join(agentHome, "auto-agent.sqlite"),
        configHome,
        databasePath: join(agentHome, "agent.sqlite"),
        docsHome: join(happyHome, "docs"),
        generatedPath: join(publicHome, "Generated"),
        globalConfigPath: join(configHome, "happy.toml"),
        happyHome,
        historyDumpHome: join(observationHome, "history"),
        instructionsPath: join(configHome, "AGENTS.md"),
        localConfigPath: join(process.cwd(), "happy.toml"),
        logPath: join(observationHome, "agent.log"),
        mcpConfigPath: join(configHome, "mcp.toml"),
        observationHome,
        pidPath: join(agentHome, "daemon.pid"),
        publicHome,
        runtimeConfigPath: join(agentHome, "runtime.toml"),
        securityPath: join(configHome, "SECURITY.md"),
        socketPath: join(agentHome, "server.sock"),
        tokenPath: join(agentHome, "token"),
    };
    if (!Value.Check(happyAgentConfigurationPathsSchema, paths)) {
        throw new Error("The Happy Agent filesystem layout is invalid.");
    }
    return Object.freeze(paths);
}

function resolveHappyHome(input: HappyAgentConfigurationInput): string {
    if (input === undefined) return resolve(homedir(), ".happy");
    if (input === "~") return resolve(homedir());
    if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
    return resolve(input);
}

function mergeValues(...partials: readonly PartialValues[]): HappyAgentConfigValues {
    const merged = structuredClone(DEFAULT_VALUES) as MutableResolvedValues;
    const explicitProviderEnabled = new Set<string>();
    for (const partial of partials) {
        if (partial.docker !== undefined) merged.docker = normalizeDocker(partial.docker);
        if (partial.defaults !== undefined) {
            const defaults = normalizeDefaults(partial.defaults);
            Object.assign(merged.defaults, defaults);
            if (partial.defaults.service_tier === "default") delete merged.defaults.serviceTier;
        }
        if (partial.features !== undefined)
            Object.assign(merged.features, normalizeFeatures(partial.features));
        if (partial.gemini !== undefined)
            Object.assign(merged.gemini, normalizeGemini(partial.gemini));
        if (partial.mcp_servers !== undefined) {
            Object.assign(merged.mcpServers, normalizeMcpServers(partial.mcp_servers));
        }
        if (partial.network !== undefined) merged.network = normalizeNetwork(partial.network);
        if (partial.observation !== undefined)
            Object.assign(merged.observation, normalizeObservation(partial.observation));
        if (partial.permissions?.protected_paths !== undefined) {
            merged.permissions.protectedPaths = [
                ...new Set([
                    ...merged.permissions.protectedPaths,
                    ...partial.permissions.protected_paths,
                ]),
            ];
        }
        if (partial.p2p !== undefined) merged.p2p = mergeP2p(merged.p2p, partial.p2p);
        if (partial.presence !== undefined)
            merged.presence = mergePresence(merged.presence, partial.presence);
        if (partial.provider_default_enable !== undefined) {
            merged.providerDefaultEnable = partial.provider_default_enable;
        }
        if (partial.providers !== undefined) {
            for (const [id, provider] of Object.entries(partial.providers)) {
                const normalized = normalizeProvider(id, provider as Record<string, unknown>);
                const current = merged.providers[id];
                const sameType = current?.type === normalized.type;
                merged.providers[id] = {
                    ...(sameType ? current : {}),
                    ...normalized,
                    enabled:
                        provider.enabled ??
                        (sameType ? current!.enabled : merged.providerDefaultEnable),
                } as Static<typeof providerSchema>;
                if (!sameType) explicitProviderEnabled.delete(id);
                if (provider.enabled !== undefined) explicitProviderEnabled.add(id);
            }
        }
        if (partial.settings !== undefined) {
            Object.assign(merged.settings, normalizeSettings(partial.settings));
        }
        if (partial.theme !== undefined) Object.assign(merged.theme, partial.theme);
        if (partial.workspace !== undefined) {
            Object.assign(merged.workspace, normalizeWorkspace(partial.workspace));
        }
    }
    for (const [id, provider] of Object.entries(merged.providers)) {
        if (!explicitProviderEnabled.has(id)) {
            provider.enabled = merged.providerDefaultEnable;
        }
    }
    if (!Value.Check(happyAgentConfigValuesSchema, merged)) {
        throw new Error("The merged Happy Agent configuration is invalid.");
    }
    return deepFreeze(merged);
}

type MutableResolvedValues = {
    -readonly [Key in keyof Static<typeof resolvedValuesSchema>]: Static<
        typeof resolvedValuesSchema
    >[Key];
};

function normalizeDefaults(value: PartialValues["defaults"]): Record<string, unknown> {
    if (value === undefined) return {};
    return {
        ...(value.effort === undefined ? {} : { effort: value.effort }),
        ...(value.instructions === undefined ? {} : { instructions: value.instructions }),
        ...(value.model === undefined ? {} : { modelId: value.model }),
        ...(value.permission_mode === undefined ? {} : { permissionMode: value.permission_mode }),
        ...(value.provider === undefined ? {} : { providerId: value.provider }),
        ...(value.service_tier === undefined || value.service_tier === "default"
            ? {}
            : { serviceTier: value.service_tier }),
    };
}

function normalizeGemini(value: NonNullable<PartialValues["gemini"]>): Record<string, unknown> {
    return {
        ...(value.api_key === undefined ? {} : { apiKey: value.api_key }),
    };
}

function normalizeFeatures(value: NonNullable<PartialValues["features"]>): Record<string, unknown> {
    return {
        ...(value.cross_workspace === undefined ? {} : { crossWorkspace: value.cross_workspace }),
        ...(value.workflows === undefined ? {} : { workflows: value.workflows }),
        ...(value.workspaces === undefined ? {} : { workspaces: value.workspaces }),
    };
}

function normalizeSettings(value: NonNullable<PartialValues["settings"]>): Record<string, unknown> {
    return {
        ...(value.compact_completed_turns === undefined
            ? {}
            : { compactCompletedTurns: value.compact_completed_turns }),
        ...(value.completion_chime === undefined
            ? {}
            : { completionChime: value.completion_chime }),
        ...(value.daemon_heap_snapshots === undefined
            ? {}
            : { daemonHeapSnapshots: value.daemon_heap_snapshots }),
        ...(value.durable_global_event_queue === undefined
            ? {}
            : { durableGlobalEventQueue: value.durable_global_event_queue }),
        ...(value.ethan === undefined ? {} : { ethan: { enabled: value.ethan.enabled ?? false } }),
        ...(value.happy_integration === undefined
            ? {}
            : { happyIntegration: value.happy_integration }),
        ...(value.inference_max_retries === undefined
            ? {}
            : { inferenceMaxRetries: value.inference_max_retries }),
        ...(value.max_collaboration_depth === undefined
            ? {}
            : { maxCollaborationDepth: value.max_collaboration_depth }),
        ...(value.max_collaborators === undefined
            ? {}
            : { maxCollaborators: value.max_collaborators }),
        ...(value.menu_bar === undefined ? {} : { menuBar: value.menu_bar }),
        ...(value.show_reasoning === undefined ? {} : { showReasoning: value.show_reasoning }),
        ...(value.show_usage === undefined ? {} : { showUsage: value.show_usage }),
        ...(value.tool_result_retention_days === undefined
            ? {}
            : { toolResultRetentionDays: value.tool_result_retention_days }),
    };
}

function normalizeWorkspace(
    value: NonNullable<PartialValues["workspace"]>,
): Record<string, unknown> {
    return {
        ...(value.keep_copies_on_archive === undefined
            ? {}
            : { keepCopiesOnArchive: value.keep_copies_on_archive }),
        ...(value.keep_worktrees_on_archive === undefined
            ? {}
            : { keepWorktreesOnArchive: value.keep_worktrees_on_archive }),
        ...(value.protected_sync === undefined ? {} : { protectedSync: value.protected_sync }),
        ...(value.setup_commands === undefined ? {} : { setupCommands: value.setup_commands }),
        ...(value.sync === undefined ? {} : { sync: value.sync }),
    };
}

function normalizeDocker(
    value: NonNullable<PartialValues["docker"]>,
): NonNullable<Static<typeof resolvedValuesSchema>["docker"]> {
    if ((value.container === undefined) === (value.image === undefined)) {
        throw new Error('docker must configure exactly one of "container" or "image".');
    }
    if (value.workdir !== undefined && !value.workdir.startsWith("/")) {
        throw new Error("docker.workdir must be an absolute container path.");
    }
    return {
        ...(value.container === undefined ? {} : { container: value.container }),
        ...(value.env === undefined ? {} : { environment: value.env }),
        ...(value.image === undefined ? {} : { image: value.image }),
        ...(value.mounts === undefined
            ? {}
            : {
                  mounts: value.mounts.map((mount) => ({
                      ...(mount.read_only === undefined ? {} : { readOnly: mount.read_only }),
                      source: mount.source,
                      target: mount.target,
                  })),
              }),
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.socket_path === undefined ? {} : { socketPath: value.socket_path }),
        workingDirectory: value.workdir ?? "/workspace",
    };
}

function normalizeNetwork(value: NonNullable<PartialValues["network"]>): Record<string, unknown> {
    return {
        ...(value.allow_local_binding === undefined
            ? {}
            : { allowLocalBinding: value.allow_local_binding }),
        ...(value.allowed_domains === undefined ? {} : { allowedDomains: value.allowed_domains }),
        ...(value.allowed_loopback_ports === undefined
            ? {}
            : { allowedLoopbackPorts: value.allowed_loopback_ports }),
        ...(value.allowed_ports === undefined ? {} : { allowedPorts: value.allowed_ports }),
        ...(value.denied_domains === undefined ? {} : { deniedDomains: value.denied_domains }),
    };
}

function normalizeObservation(
    value: NonNullable<PartialValues["observation"]>,
): Record<string, unknown> {
    return {
        ...(value.history_dump === undefined ? {} : { historyDump: value.history_dump }),
        ...(value.log_level === undefined ? {} : { logLevel: value.log_level }),
        ...(value.logs === undefined ? {} : { logs: value.logs }),
        ...(value.traces === undefined ? {} : { traces: value.traces }),
        ...(value.traces_endpoint === undefined ? {} : { tracesEndpoint: value.traces_endpoint }),
    };
}

function normalizeP2p(value: NonNullable<PartialValues["p2p"]>): Record<string, unknown> {
    return {
        ...(value.enable_direct === undefined ? {} : { enableDirect: value.enable_direct }),
        ...(value.enable_iroh === undefined ? {} : { enableIroh: value.enable_iroh }),
        ...(value.enable_ssh === undefined ? {} : { enableSsh: value.enable_ssh }),
        ...(value.expose_api === undefined ? {} : { exposeApi: value.expose_api }),
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.primary_id === undefined ? {} : { primaryId: value.primary_id }),
        ...(value.role === undefined ? {} : { role: value.role }),
        ...(value.direct === undefined
            ? {}
            : {
                  direct: {
                      ...(value.direct.listen === undefined ? {} : { listen: value.direct.listen }),
                  },
              }),
        ...(value.iroh === undefined
            ? {}
            : {
                  iroh: {
                      ...(value.iroh.relay_url === undefined
                          ? {}
                          : { relayUrl: value.iroh.relay_url }),
                  },
              }),
    };
}

function normalizePresence(value: NonNullable<PartialValues["presence"]>): Record<string, unknown> {
    return {
        ...(value.current === undefined ? {} : { current: value.current }),
        ...(value.fallback === undefined ? {} : { fallback: value.fallback }),
        ...(value.until === undefined ? {} : { until: parseDateValue(value.until) }),
        ...(value.states === undefined
            ? {}
            : {
                  states: Object.fromEntries(
                      Object.entries(value.states).map(([id, state]) => [
                          id,
                          {
                              ...(state.answer_wait === undefined
                                  ? {}
                                  : { answerWaitMs: parseAnswerWait(state.answer_wait) }),
                              ...(state.emoji === undefined ? {} : { emoji: state.emoji }),
                              ...(state.prompt === undefined ? {} : { prompt: state.prompt }),
                              ...(state.title === undefined ? {} : { title: state.title }),
                          },
                      ]),
                  ),
              }),
    };
}

function normalizeMcpServers(
    value: NonNullable<PartialValues["mcp_servers"]>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(value)) {
        const startupTimeoutMs =
            server.startup_timeout_sec === undefined
                ? undefined
                : mcpTimeoutMilliseconds(server.startup_timeout_sec, `${name}.startup_timeout_sec`);
        const toolTimeoutMs =
            server.tool_timeout_sec === undefined
                ? undefined
                : mcpTimeoutMilliseconds(server.tool_timeout_sec, `${name}.tool_timeout_sec`);
        if ((server.command === undefined) === (server.url === undefined)) {
            throw new Error(`MCP server "${name}" must configure either command or url.`);
        }
        if (server.command !== undefined) {
            result[name] = {
                ...(server.args === undefined ? {} : { args: server.args }),
                ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
                ...(server.disabled_tools === undefined
                    ? {}
                    : { disabledTools: server.disabled_tools }),
                ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
                ...(server.enabled_tools === undefined
                    ? {}
                    : { enabledTools: server.enabled_tools }),
                ...(server.env === undefined ? {} : { env: server.env }),
                ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
                ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
                command: server.command,
                transport: "stdio",
            };
        } else {
            result[name] = {
                ...(server.bearer_token_env_var === undefined
                    ? {}
                    : { bearerTokenEnvVar: server.bearer_token_env_var }),
                ...(server.disabled_tools === undefined
                    ? {}
                    : { disabledTools: server.disabled_tools }),
                ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
                ...(server.enabled_tools === undefined
                    ? {}
                    : { enabledTools: server.enabled_tools }),
                ...(server.http_headers === undefined ? {} : { headers: server.http_headers }),
                ...(server.oauth_client_id_env_var === undefined
                    ? {}
                    : { oauthClientIdEnvVar: server.oauth_client_id_env_var }),
                ...(server.oauth_client_secret_env_var === undefined
                    ? {}
                    : { oauthClientSecretEnvVar: server.oauth_client_secret_env_var }),
                ...(server.oauth_scopes === undefined ? {} : { oauthScopes: server.oauth_scopes }),
                ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
                ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
                transport: "http",
                url: server.url,
            };
        }
    }
    return result;
}

function mcpTimeoutMilliseconds(seconds: number, name: string): number {
    const milliseconds = seconds * 1_000;
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
        throw new Error(`MCP ${name} must resolve to a whole millisecond.`);
    }
    return milliseconds;
}

function mergeP2p(
    base: MutableResolvedValues["p2p"],
    value: NonNullable<PartialValues["p2p"]>,
): MutableResolvedValues["p2p"] {
    const { primaryId: basePrimaryId, ...baseWithoutPrimaryId } = base;
    const primaryId =
        value.role === "primary"
            ? {}
            : value.primary_id === undefined
              ? basePrimaryId === undefined
                  ? {}
                  : { primaryId: basePrimaryId }
              : { primaryId: value.primary_id };
    return {
        ...baseWithoutPrimaryId,
        ...(value.enable_direct === undefined ? {} : { enableDirect: value.enable_direct }),
        ...(value.enable_iroh === undefined ? {} : { enableIroh: value.enable_iroh }),
        ...(value.enable_ssh === undefined ? {} : { enableSsh: value.enable_ssh }),
        ...(value.expose_api === undefined ? {} : { exposeApi: value.expose_api }),
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.role === undefined ? {} : { role: value.role }),
        ...primaryId,
        direct: {
            ...base.direct,
            ...(value.direct?.listen === undefined ? {} : { listen: value.direct.listen }),
        },
        iroh: {
            ...base.iroh,
            ...(value.iroh === undefined ? {} : { relayUrl: value.iroh.relay_url }),
        },
    };
}

function mergePresence(
    base: MutableResolvedValues["presence"],
    value: NonNullable<PartialValues["presence"]>,
): MutableResolvedValues["presence"] {
    const baseWithoutTransient =
        value.current === undefined
            ? base
            : (({ fallback: _fallback, until: _until, ...rest }) => rest)(base);
    return {
        ...baseWithoutTransient,
        ...(value.current === undefined ? {} : { current: value.current }),
        ...(value.fallback === undefined ? {} : { fallback: value.fallback }),
        ...(value.until === undefined ? {} : { until: parseDateValue(value.until) }),
        states: {
            ...base.states,
            ...Object.fromEntries(
                Object.entries(value.states ?? {}).map(([id, state]) => [
                    id,
                    {
                        ...base.states[id],
                        ...(state.answer_wait === undefined
                            ? {}
                            : { answerWaitMs: parseAnswerWait(state.answer_wait) }),
                        ...(state.emoji === undefined ? {} : { emoji: state.emoji }),
                        ...(state.prompt === undefined ? {} : { prompt: state.prompt }),
                        ...(state.title === undefined ? {} : { title: state.title }),
                    },
                ]),
            ),
        },
    };
}

function normalizeProvider(id: string, value: Record<string, unknown>): Record<string, unknown> {
    const inferred = inferProviderType(id, value["type"]);
    switch (inferred) {
        case "bedrock":
            return {
                ...normalizeProviderCommon(value),
                ...(value["bearer_token"] === undefined
                    ? {}
                    : { bearerToken: value["bearer_token"] }),
                ...(value["bearer_token_env_var"] === undefined
                    ? {}
                    : { bearerTokenEnvVar: value["bearer_token_env_var"] }),
                ...(value["config_file"] === undefined ? {} : { configFile: value["config_file"] }),
                ...(value["credentials_file"] === undefined
                    ? {}
                    : { credentialsFile: value["credentials_file"] }),
                ...(value["model_overrides"] === undefined
                    ? {}
                    : { modelOverrides: value["model_overrides"] }),
                ...(value["profile"] === undefined ? {} : { profile: value["profile"] }),
                ...(value["region"] === undefined ? {} : { region: value["region"] }),
                ...(value["search_model"] === undefined
                    ? {}
                    : { searchModelId: value["search_model"] }),
                type: inferred,
            };
        case "claude":
            return {
                ...normalizeProviderCommon(value),
                ...(value["api_key"] === undefined ? {} : { apiKey: value["api_key"] }),
                ...(value["auth_token"] === undefined ? {} : { authToken: value["auth_token"] }),
                ...(value["config_dir"] === undefined ? {} : { configDir: value["config_dir"] }),
                ...(value["executable"] === undefined ? {} : { executable: value["executable"] }),
                ...(value["oauth_token"] === undefined ? {} : { oauthToken: value["oauth_token"] }),
                type: inferred,
            };
        case "codex":
            return {
                ...normalizeProviderCommon(value),
                ...(value["api_key"] === undefined ? {} : { apiKey: value["api_key"] }),
                ...(value["auth_file"] === undefined ? {} : { authFile: value["auth_file"] }),
                ...(value["base_url"] === undefined ? {} : { baseUrl: value["base_url"] }),
                ...(value["transport"] === undefined ? {} : { transport: value["transport"] }),
                type: inferred,
            };
        case "grok":
            return {
                ...normalizeProviderCommon(value),
                ...(value["api_key"] === undefined ? {} : { apiKey: value["api_key"] }),
                ...(value["auth_file"] === undefined ? {} : { authFile: value["auth_file"] }),
                ...(value["base_url"] === undefined ? {} : { baseUrl: value["base_url"] }),
                type: inferred,
            };
    }
}

function normalizeProviderCommon(value: Record<string, unknown>): Record<string, unknown> {
    return {
        ...(value["auto_enable"] === undefined ? {} : { autoEnable: value["auto_enable"] }),
        ...(value["credential_isolation"] === true ? { credentialIsolation: true } : {}),
        ...(value["enabled"] === undefined ? {} : { enabled: value["enabled"] }),
        ...(value["exclude_models"] === undefined
            ? {}
            : { excludeModels: value["exclude_models"] }),
        ...(value["include_models"] === undefined
            ? {}
            : { includeModels: value["include_models"] }),
        ...(value["p2p_share"] === undefined ? {} : { p2pShare: value["p2p_share"] }),
    };
}

function inferProviderType(id: string, type: unknown): "bedrock" | "claude" | "codex" | "grok" {
    const builtIn = ["bedrock", "claude", "codex", "grok"].includes(id)
        ? (id as "bedrock" | "claude" | "codex" | "grok")
        : undefined;
    if (type !== undefined && type !== builtIn && builtIn !== undefined) {
        throw new Error(`Built-in provider "${id}" must use type "${builtIn}".`);
    }
    if (type !== undefined && !["bedrock", "claude", "codex", "grok"].includes(String(type))) {
        throw new Error(`Provider "${id}" has an unsupported type.`);
    }
    const inferred = (type ?? builtIn) as "bedrock" | "claude" | "codex" | "grok" | undefined;
    if (inferred === undefined) {
        throw new Error(
            `Provider "${id}" must set type to "codex", "claude", "grok", or "bedrock".`,
        );
    }
    return inferred;
}

function withoutProjectMachineSettings(values: PartialValues): PartialValues {
    const {
        docker: _docker,
        // A credential is this machine's, never a repository's: a checked-in project file must not
        // choose which Gemini account this installation's tools bill against.
        gemini: _gemini,
        // Observation is dropped along with the other machine settings, and for a sharper reason:
        // a checked-in project file that turns tracing on and names its own endpoint would send
        // this machine's traces wherever the repository asked.
        observation: _observation,
        p2p: _p2p,
        provider_default_enable: _providerDefaultEnable,
        providers: _providers,
        defaults,
        settings,
        ...rest
    } = values;
    const { permission_mode: _permissionMode, ...projectDefaults } = defaults ?? {};
    const {
        daemon_heap_snapshots: _daemonHeapSnapshots,
        durable_global_event_queue: _durableGlobalEventQueue,
        ethan: _ethan,
        happy_integration: _happyIntegration,
        inference_max_retries: _inferenceMaxRetries,
        max_collaboration_depth: _maxCollaborationDepth,
        max_collaborators: _maxCollaborators,
        // Whether this machine shows a menu bar is the person's business, not a repository's.
        menu_bar: _menuBar,
        tool_result_retention_days: _toolResultRetentionDays,
        ...projectSettings
    } = settings ?? {};
    return {
        ...rest,
        ...(Object.keys(projectDefaults).length === 0 ? {} : { defaults: projectDefaults }),
        ...(Object.keys(projectSettings).length === 0 ? {} : { settings: projectSettings }),
    };
}

function withoutMcpServers(values: PartialValues): PartialValues {
    const { mcp_servers: _mcpServers, ...rest } = values;
    return rest;
}

function calculateProvenance(...sources: readonly PartialValues[]): Record<string, string> {
    const result: Record<string, string> = {};
    const names: readonly ConfigSourceKind[] = ["global", "local", "runtime"];
    const sectionNames: Readonly<Record<string, string>> = {
        mcp_servers: "mcpServers",
        provider_default_enable: "providerDefaultEnable",
    };
    const fieldNames: Readonly<Record<string, Readonly<Record<string, string>>>> = {
        defaults: {
            effort: "effort",
            instructions: "instructions",
            model: "modelId",
            permission_mode: "permissionMode",
            provider: "providerId",
            service_tier: "serviceTier",
        },
        features: {
            cross_workspace: "crossWorkspace",
            workflows: "workflows",
            workspaces: "workspaces",
        },
        observation: {
            history_dump: "historyDump",
            log_level: "logLevel",
            logs: "logs",
            traces: "traces",
            traces_endpoint: "tracesEndpoint",
        },
        settings: {
            compact_completed_turns: "compactCompletedTurns",
            completion_chime: "completionChime",
            daemon_heap_snapshots: "daemonHeapSnapshots",
            durable_global_event_queue: "durableGlobalEventQueue",
            ethan: "ethan",
            happy_integration: "happyIntegration",
            inference_max_retries: "inferenceMaxRetries",
            max_collaboration_depth: "maxCollaborationDepth",
            max_collaborators: "maxCollaborators",
            menu_bar: "menuBar",
            show_reasoning: "showReasoning",
            show_usage: "showUsage",
            tool_result_retention_days: "toolResultRetentionDays",
        },
        workspace: {
            keep_copies_on_archive: "keepCopiesOnArchive",
            keep_worktrees_on_archive: "keepWorktreesOnArchive",
            protected_sync: "protectedSync",
            setup_commands: "setupCommands",
            sync: "sync",
        },
    };
    for (let index = 0; index < sources.length; index += 1) {
        const source = sources[index];
        const name = names[index];
        if (source === undefined || name === undefined) continue;
        for (const section of Object.keys(source)) {
            const normalizedSection = sectionNames[section] ?? section;
            result[normalizedSection] = name;
            if (
                section === "defaults" ||
                section === "settings" ||
                section === "features" ||
                section === "observation" ||
                section === "workspace"
            ) {
                for (const key of Object.keys(source[section] ?? {})) {
                    result[`${normalizedSection}.${fieldNames[section]?.[key] ?? key}`] = name;
                }
            }
        }
    }
    return result;
}

function readDefaults(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["defaults"] {
    return readTableValues(
        value,
        "defaults",
        unknown,
        ["effort", "instructions", "model", "permission_mode", "provider", "service_tier"],
        defaultsInputSchema,
    ) as PartialValues["defaults"];
}

function readSettings(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["settings"] {
    return readTableValues(
        value,
        "settings",
        unknown,
        [
            "compact_completed_turns",
            "completion_chime",
            "daemon_heap_snapshots",
            "durable_global_event_queue",
            "ethan",
            "happy_integration",
            "inference_max_retries",
            "max_collaboration_depth",
            "max_collaborators",
            "menu_bar",
            "show_reasoning",
            "show_usage",
            "tool_result_retention_days",
        ],
        settingsInputSchema,
    ) as PartialValues["settings"];
}

function readFeatures(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["features"] {
    return readTableValues(
        value,
        "features",
        unknown,
        ["cross_workspace", "workflows", "workspaces"],
        Type.Object(
            {
                cross_workspace: Type.Optional(Type.Boolean()),
                workflows: Type.Optional(Type.Boolean()),
                workspaces: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: false },
        ),
    ) as PartialValues["features"];
}

function readGemini(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["gemini"] {
    return readTableValues(
        value,
        "gemini",
        unknown,
        ["api_key"],
        partialValuesSchema.properties.gemini!,
    ) as PartialValues["gemini"];
}

function readWorkspace(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["workspace"] {
    return readTableValues(
        value,
        "workspace",
        unknown,
        [
            "keep_copies_on_archive",
            "keep_worktrees_on_archive",
            "protected_sync",
            "setup_commands",
            "sync",
        ],
        Type.Object(
            {
                keep_copies_on_archive: Type.Optional(Type.Boolean()),
                keep_worktrees_on_archive: Type.Optional(Type.Boolean()),
                protected_sync: Type.Optional(projectRelativePathsSchema),
                setup_commands: Type.Optional(boundedStringArraySchema),
                sync: Type.Optional(projectRelativePathsSchema),
            },
            { additionalProperties: false },
        ),
    ) as PartialValues["workspace"];
}

function readTheme(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["theme"] {
    return readTableValues(
        value,
        "theme",
        unknown,
        ["accent", "brand", "error", "primary", "secondary", "success", "warning"],
        Type.Object(
            {
                accent: Type.Optional(configStringSchema),
                brand: Type.Optional(configStringSchema),
                error: Type.Optional(configStringSchema),
                primary: Type.Optional(configStringSchema),
                secondary: Type.Optional(configStringSchema),
                success: Type.Optional(configStringSchema),
                warning: Type.Optional(configStringSchema),
            },
            { additionalProperties: false },
        ),
    ) as PartialValues["theme"];
}

function readDocker(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["docker"] {
    const docker = readTableValues(
        value,
        "docker",
        unknown,
        Object.keys(dockerInputSchema.properties),
        dockerInputSchema,
    ) as PartialValues["docker"];
    if (docker === undefined) return undefined;
    const mounts = docker.mounts?.map((mount, index) => {
        const raw = mount as Record<string, unknown>;
        for (const key of Object.keys(raw)) {
            if (!["read_only", "source", "target"].includes(key)) {
                unknown(`docker.mounts[${index}].${key}`);
            }
        }
        return {
            ...(raw.read_only === undefined ? {} : { read_only: raw.read_only }),
            source: raw.source,
            target: raw.target,
        };
    });
    const sanitized = {
        ...docker,
        ...(mounts === undefined ? {} : { mounts }),
    } as NonNullable<PartialValues["docker"]>;
    if ((sanitized.container === undefined) === (sanitized.image === undefined)) {
        throw new Error('docker must configure exactly one of "container" or "image".');
    }
    if (sanitized.workdir !== undefined && !sanitized.workdir.startsWith("/")) {
        throw new Error("docker.workdir must be an absolute container path.");
    }
    if (
        sanitized.container !== undefined &&
        (sanitized.env !== undefined ||
            sanitized.mounts !== undefined ||
            sanitized.name !== undefined)
    ) {
        throw new Error("docker env, mounts, and name can only be used when docker.image is set.");
    }
    for (const [index, mount] of (sanitized.mounts ?? []).entries()) {
        if (!mount.target.startsWith("/")) {
            throw new Error(`docker.mounts[${index}].target must be an absolute container path.`);
        }
    }
    if (!Value.Check(dockerInputSchema, sanitized)) {
        throw new Error("docker contains an invalid value.");
    }
    return sanitized;
}

function readNetwork(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["network"] {
    return readTableValues(
        value,
        "network",
        unknown,
        [
            "allow_local_binding",
            "allowed_domains",
            "allowed_loopback_ports",
            "allowed_ports",
            "denied_domains",
        ],
        partialValuesSchema.properties.network!,
    ) as PartialValues["network"];
}

function readObservation(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["observation"] {
    return readTableValues(
        value,
        "observation",
        unknown,
        ["history_dump", "log_level", "logs", "traces", "traces_endpoint"],
        partialValuesSchema.properties.observation!,
    ) as PartialValues["observation"];
}

function readP2p(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["p2p"] {
    const p2p = readTableValues(
        value,
        "p2p",
        unknown,
        [
            "direct",
            "enable_direct",
            "enable_iroh",
            "enable_ssh",
            "expose_api",
            "iroh",
            "name",
            "primary_id",
            "role",
        ],
        partialValuesSchema.properties.p2p!,
    ) as PartialValues["p2p"];
    if (p2p === undefined) return undefined;
    const direct = p2p.direct;
    if (direct !== undefined) {
        const raw = direct as Record<string, unknown>;
        for (const key of Object.keys(raw)) {
            if (key !== "listen") unknown(`p2p.direct.${key}`);
        }
        if (raw.listen !== undefined && typeof raw.listen !== "string") {
            throw new Error("p2p.direct.listen must be a string.");
        }
        p2p.direct = raw.listen === undefined ? {} : { listen: raw.listen };
    }
    const iroh = p2p.iroh;
    if (iroh !== undefined) {
        const raw = iroh as Record<string, unknown>;
        for (const key of Object.keys(raw)) {
            if (key !== "relay_url") unknown(`p2p.iroh.${key}`);
        }
        if (raw.relay_url !== undefined && typeof raw.relay_url !== "string") {
            throw new Error("p2p.iroh.relay_url must be a string.");
        }
        p2p.iroh = raw.relay_url === undefined ? {} : { relay_url: raw.relay_url };
    }
    if (p2p.name !== undefined && !/^[^\p{C}]{1,128}$/u.test(p2p.name)) {
        throw new Error("p2p.name must be 1–128 printable characters.");
    }
    if (p2p.iroh?.relay_url !== undefined && !/^https?:\/\//u.test(p2p.iroh.relay_url)) {
        throw new Error("p2p.iroh.relay_url must be an HTTP or HTTPS URL.");
    }
    if (
        (p2p.role === "secondary" &&
            (p2p.primary_id === undefined || !Value.Check(p2pInstanceIdSchema, p2p.primary_id))) ||
        (p2p.role !== "secondary" && p2p.primary_id !== undefined)
    ) {
        throw new Error("p2p.primary_id requires p2p.role to be secondary.");
    }
    return p2p;
}

function readPermissions(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["permissions"] {
    return readTableValues(
        value,
        "permissions",
        unknown,
        ["protected_paths"],
        partialValuesSchema.properties.permissions!,
    ) as PartialValues["permissions"];
}

function readPresence(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["presence"] {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error("presence must be a TOML table.");
    assertTableSize(value, "presence");
    const known = new Set(["current", "fallback", "states", "until"]);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (!known.has(key)) {
            unknown(`presence.${key}`);
            continue;
        }
        if (key === "until" && item instanceof TomlDate) {
            result.until = item.getTime();
            continue;
        }
        if (key !== "states") {
            result[key] = item;
            continue;
        }
        if (!isTable(item)) throw new Error("presence.states must be a TOML table.");
        assertTableSize(item, "presence.states");
        const states: Record<string, unknown> = {};
        for (const [id, state] of Object.entries(item)) {
            if (!/^[a-z0-9_-]+$/u.test(id)) {
                throw new Error(
                    `Presence "${id}" must be named with lowercase letters, numbers, dashes, or underscores.`,
                );
            }
            if (!isTable(state)) throw new Error(`presence.states.${id} must be a TOML table.`);
            assertTableSize(state, `presence.states.${id}`);
            const stateResult: Record<string, unknown> = {};
            for (const [stateKey, stateValue] of Object.entries(state)) {
                if (!["answer_wait", "emoji", "prompt", "title"].includes(stateKey)) {
                    unknown(`presence.states.${id}.${stateKey}`);
                    continue;
                }
                stateResult[stateKey] = stateValue;
            }
            states[id] = stateResult;
        }
        result.states = states;
    }
    if (!Value.Check(partialValuesSchema.properties.presence!, result)) {
        throw new Error("presence contains an invalid value.");
    }
    return result as PartialValues["presence"];
}

function readMcpServers(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["mcp_servers"] {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error("mcp_servers must be a TOML table.");
    assertTableSize(value, "mcp_servers");
    const result: Record<string, unknown> = {};
    const known = [
        "args",
        "bearer_token_env_var",
        "command",
        "cwd",
        "disabled_tools",
        "enabled",
        "enabled_tools",
        "env",
        "http_headers",
        "oauth_client_id_env_var",
        "oauth_client_secret_env_var",
        "oauth_scopes",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "transport",
        "url",
    ];
    const entrySchema = Type.Object(
        {
            args: Type.Optional(boundedStringArraySchema),
            bearer_token_env_var: Type.Optional(configStringSchema),
            command: Type.Optional(
                Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH }),
            ),
            cwd: Type.Optional(pathSchema),
            disabled_tools: Type.Optional(boundedStringArraySchema),
            enabled: Type.Optional(Type.Boolean()),
            enabled_tools: Type.Optional(boundedStringArraySchema),
            env: Type.Optional(
                Type.Record(configStringSchema, configStringSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            http_headers: Type.Optional(
                Type.Record(configStringSchema, configStringSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            oauth_client_id_env_var: Type.Optional(configStringSchema),
            oauth_client_secret_env_var: Type.Optional(configStringSchema),
            oauth_scopes: Type.Optional(boundedStringArraySchema),
            startup_timeout_sec: Type.Optional(
                Type.Number({ exclusiveMinimum: 0, maximum: MAX_MCP_TIMEOUT_SECONDS }),
            ),
            tool_timeout_sec: Type.Optional(
                Type.Number({ exclusiveMinimum: 0, maximum: MAX_MCP_TIMEOUT_SECONDS }),
            ),
            transport: Type.Optional(Type.Literal("http")),
            url: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CONFIG_STRING_LENGTH })),
        },
        { additionalProperties: false },
    );
    for (const [name, server] of Object.entries(value)) {
        if (!isTable(server)) throw new Error(`mcp_servers.${name} must be a TOML table.`);
        result[name] = readTableValues(server, `mcp_servers.${name}`, unknown, known, entrySchema);
        const parsed = result[name] as Record<string, unknown>;
        const command = parsed["command"];
        const url = parsed["url"];
        if ((command === undefined) === (url === undefined)) {
            throw new Error(`MCP server "${name}" must configure either command or url.`);
        }
        if (
            url !== undefined &&
            parsed["transport"] !== undefined &&
            parsed["transport"] !== "http"
        ) {
            throw new Error(`MCP server "${name}" uses unsupported transport.`);
        }
        if (command !== undefined && parsed["transport"] !== undefined) {
            throw new Error(
                `MCP server "${name}" runs a command, so it always speaks stdio and cannot set transport.`,
            );
        }
    }
    if (!Value.Check(mcpInputSchema, result)) {
        throw new Error("mcp_servers contains an invalid server.");
    }
    return result as PartialValues["mcp_servers"];
}

function readProviders(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["providers"] {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error("providers must be a TOML table.");
    assertTableSize(value, "providers");
    if (Object.keys(value).filter((id) => id !== "default_enable").length > MAX_PROVIDER_COUNT) {
        throw new Error(`providers must contain at most ${MAX_PROVIDER_COUNT} providers.`);
    }
    const result: Record<string, unknown> = {};
    for (const [id, providerValue] of Object.entries(value)) {
        if (id === "default_enable") continue;
        if (!isTable(providerValue)) throw new Error(`providers.${id} must be a TOML table.`);
        assertTableSize(providerValue, `providers.${id}`);
        const type =
            providerValue.type ??
            (["bedrock", "claude", "codex", "grok"].includes(id) ? id : undefined);
        const schema =
            type === "bedrock"
                ? providerInputSchemas.bedrock
                : type === "claude"
                  ? providerInputSchemas.claude
                  : type === "codex"
                    ? providerInputSchemas.codex
                    : type === "grok"
                      ? providerInputSchemas.grok
                      : undefined;
        if (schema === undefined) {
            throw new Error(
                `Provider "${id}" must set type to "codex", "claude", "grok", or "bedrock".`,
            );
        }
        if (["bedrock", "claude", "codex", "grok"].includes(id) && type !== id) {
            throw new Error(`Built-in provider "${id}" must use type "${id}".`);
        }
        const allowed = Object.keys(schema.properties);
        const parsed = readTableValues(providerValue, `providers.${id}`, unknown, allowed, schema);
        if (parsed !== undefined && providerValue.model_overrides !== undefined) {
            parsed.model_overrides = readModelOverrides(
                providerValue.model_overrides,
                `providers.${id}.model_overrides`,
                unknown,
            );
        }
        result[id] = parsed;
    }
    if (!Value.Check(providerMapInputSchema, result)) {
        throw new Error("providers contains an invalid provider.");
    }
    return result as PartialValues["providers"];
}

function readModelOverrides(
    value: TomlValue,
    name: string,
    unknown: (path: string) => void,
): Record<string, unknown> {
    if (!isTable(value)) throw new Error(`${name} must be a TOML table.`);
    assertTableSize(value, name);
    const schema = Type.Object(
        {
            endpoint: Type.Optional(configStringSchema),
            region: Type.Optional(configStringSchema),
            transport: Type.Optional(Type.Union([Type.Literal("mantle"), Type.Literal("runtime")])),
        },
        { additionalProperties: false },
    );
    const result: Record<string, unknown> = {};
    for (const [model, override] of Object.entries(value)) {
        if (!isTable(override)) throw new Error(`${name}.${model} must be a TOML table.`);
        assertTableSize(override, `${name}.${model}`);
        result[model] = readTableValues(
            override,
            `${name}.${model}`,
            unknown,
            ["endpoint", "region", "transport"],
            schema,
        );
    }
    return result;
}

function readTableValues(
    value: TomlValue | undefined,
    name: string,
    unknown: (path: string) => void,
    knownKeys: readonly string[],
    schema: TSchema,
): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error(`${name} must be a TOML table.`);
    assertTableSize(value, name);
    const result: Record<string, unknown> = {};
    const known = new Set(knownKeys);
    for (const [key, item] of Object.entries(value)) {
        if (!known.has(key)) {
            unknown(`${name}.${key}`);
            continue;
        }
        result[key] = item;
    }
    if (!Value.Check(schema, result)) {
        throw new Error(`${name} contains an invalid value.`);
    }
    return result;
}

function assertTableSize(table: TomlTable, name: string): void {
    if (Object.keys(table).length > MAX_CONFIG_TABLE_ENTRIES) {
        throw new Error(`${name} must contain at most ${MAX_CONFIG_TABLE_ENTRIES} properties.`);
    }
}

function readBoolean(table: TomlTable, key: string, path: string): boolean | undefined {
    const value = table[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
    return value;
}

function parseAnswerWait(value: string | null): number | null {
    if (value === null) return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "unlimited" || normalized === "forever") return null;
    if (normalized === "none" || normalized === "never") return 0;
    const match =
        /^([0-9]+(?:\.[0-9]+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m|hours?|h|days?|d)$/u.exec(
            normalized,
        );
    if (match === null) throw new Error("presence.states.*.answer_wait must be a duration.");
    const amount = match[1];
    const unitName = match[2];
    if (amount === undefined || unitName === undefined) {
        throw new Error("presence.states.*.answer_wait must be a duration.");
    }
    const unit =
        unitName.startsWith("ms") || unitName.startsWith("millisecond")
            ? 1
            : unitName.startsWith("s")
              ? 1_000
              : unitName.startsWith("m")
                ? 60_000
                : unitName.startsWith("h")
                  ? 3_600_000
                  : 86_400_000;
    return Math.round(Number(amount) * unit);
}

function parseDateValue(value: string | number): number {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new Error("presence.until must be a date.");
        return value;
    }
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new Error("presence.until must be a date.");
    return time;
}

function isTable(value: TomlValue | undefined): value is TomlTable {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !(value instanceof TomlDate)
    );
}

function isMissingFile(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
    );
}

async function anyNonemptyFile(paths: readonly string[]): Promise<boolean> {
    for (const path of paths) {
        try {
            if ((await stat(path)).size > 0) return true;
        } catch (error: unknown) {
            if (!isMissingFile(error)) throw error;
        }
    }
    return false;
}

/** Recognize configured AWS credential sources without invoking a process or metadata service. */
async function hasAwsCredentialConfiguration(paths: readonly string[]): Promise<boolean> {
    for (const path of paths) {
        const source = await readLocalCredentialFile(path);
        if (source === undefined) continue;
        const hasKeyPair =
            hasIniAssignment(source, "aws_access_key_id") &&
            hasIniAssignment(source, "aws_secret_access_key");
        const hasConfiguredSource =
            hasIniAssignment(source, "credential_process") ||
            hasIniAssignment(source, "web_identity_token_file") ||
            hasIniAssignment(source, "sso_start_url") ||
            hasIniAssignment(source, "sso_session");
        if (hasKeyPair || hasConfiguredSource) return true;
    }
    return false;
}

function hasIniAssignment(source: string, key: string): boolean {
    return new RegExp(`^\\s*${key}\\s*=\\s*\\S+`, "imu").test(source);
}

async function readLocalCredentialFile(path: string): Promise<string | undefined> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
        file = await open(path, "r");
        const size = Math.min((await file.stat()).size, MAX_LOCAL_CREDENTIAL_FILE_BYTES);
        if (size <= 0) return undefined;
        const buffer = Buffer.allocUnsafe(size);
        const { bytesRead } = await file.read(buffer, 0, size, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
    } catch (error: unknown) {
        if (isMissingFile(error)) return undefined;
        throw error;
    } finally {
        await file?.close().catch(() => undefined);
    }
}

function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return value;
}
