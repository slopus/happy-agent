import {
    computePermissions,
    localAgentSocketPath,
    ensurePrivateDirectory,
    toManagedNetworkPolicy,
    type Compute,
    type ManagedNetworkPolicy,
    type ComputeServiceExecution,
} from "@slopus/happy-agent-compute";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
    AgentModel,
    AgentModule,
    AgentModuleHooks,
    AgentProviders,
} from "@slopus/happy-agent-base";
import { cuid2Schema } from "@slopus/happy-agent-base";
import {
    CodexProvider,
    CodexSessionCredential,
    GrokProvider,
    GrokSessionCredential,
    type AnthropicBedrockTransport,
    type BaseProvider,
    type SessionReasoningEffort,
    type ProviderUsage,
} from "@slopus/happy-providers";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    asyncLock,
    detach,
    forever,
    withLifetime,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";
import { parse, stringify, TomlDate, type TomlTable, type TomlValue } from "smol-toml";

import { getManagedProjectsDirectory } from "../impl/managedProjectsDirectory.js";
import { getManagedWorkspacesDirectory } from "../impl/managedWorkspacesDirectory.js";
import { isUserOriginMetadata } from "../impl/messageOrigin.js";
import {
    agentModelCatalog,
    agentModelContext,
    agentModels,
    foreignAgentModelContext,
    openAICompatibleModelContext,
    agentProviders,
    configuredAnthropicBedrockTransport,
    smartProviderRoute,
    type AgentModelContext,
    type ConfiguredAgentModel,
} from "./impl/agentCatalog.js";
import {
    DEFAULT_HARNESSES,
    harnessAllowsSubagents,
    harnessInputSchema,
    harnessSchema,
    isOwnLoginHarness,
    mergeHarnesses,
    readHarnesses,
    validateHarnesses,
} from "./impl/harnesses.js";
import {
    foreignAgentRouteForModel,
    foreignAgentRoutes,
    foreignAgentStart,
} from "./impl/createForeignAgentProvider.js";
import { refreshForeignAgentModels } from "./impl/foreignAgentModels.js";
import { refreshOpenAICompatibleMetadata } from "./impl/openAICompatibleModels.js";
import { readAntigravityUsage, type HarnessUsageWindow } from "./impl/harnessUsage.js";
import {
    hasConfiguredProviderUsageSource,
    loadConfiguredProviderUsage,
    type ProviderUsageReadMethod,
} from "./impl/loadConfiguredProviderUsage.js";
import { ProviderEnablement, providerRegistryUntil } from "./impl/providerRegistryUntil.js";
import { ProviderServiceTiers } from "./impl/ProviderServiceTiers.js";
import {
    RoundRobinRouterProvider,
    type RoundRobinAccountFailure as SmartRouteAccountFailure,
} from "./impl/RoundRobinRouterProvider.js";
import {
    ProviderCredentialFailures,
    type UnavailableCredentialFailure,
} from "./impl/ProviderCredentialFailures.js";
import {
    ProviderAccountFailures,
    type ProviderSignInObservation,
} from "./impl/ProviderAccountFailures.js";
import { ProviderCredentialsUnavailableError } from "./impl/ProviderCredentialsUnavailableError.js";
import {
    ProviderExecutionObservations,
    type CurrentProviderExecutionAttempt,
    type ProviderExecutionAttempt,
    type ProviderExecutionKind,
} from "./impl/ProviderExecutionObservations.js";
import { VoiceCredentialPoolError } from "./VoiceCredentialPoolError.js";
import { VoiceControllerRouteError } from "./VoiceControllerRouteError.js";
import {
    VOICE_CONTROLLER_DEFAULT_MODEL,
    VoiceSettingsError,
    voiceSettingsTomlSchema,
    voiceSettingsUpdateSchema,
    type VoiceSettingsToml,
    type VoiceSettingsUpdate,
} from "./VoiceSettings.js";
import { modelServiceTierOptions } from "./impl/modelServiceTierOptions.js";
import { readGlobalInstructions } from "./impl/readGlobalInstructions.js";
import { HAPPY_TOML_TEMPLATE, MCP_TOML_TEMPLATE } from "./impl/userConfigurationTemplate.js";
import { readSecurityDocument } from "./impl/readSecurityDocument.js";
import { DEFAULT_TELEGRAM_API_URL, telegramApiUrlSchema } from "./TelegramConfig.js";
import {
    executionConfigSchema,
    executionExecutableSchema,
    executionUserSchema,
    MAX_EXECUTION_BOTS,
    type ExecutionConfig,
} from "./ExecutionConfig.js";
import {
    MAX_RUNNERS,
    runnerConfigSchema,
    runnersConfigSchema,
    type RunnerConfig,
    type RunnersConfig,
} from "./RunnerConfig.js";
import {
    apiConfigSchema,
    remoteConnectionsConfigSchema,
    remoteConnectionEntrySchema,
    type RemoteConnectionEntry,
} from "./RemoteConnectionConfig.js";
import {
    resolveTeamJwtConfig,
    teamJwtConfigSchema,
    teamJwtTomlSchema,
    teamOwnerUserIdSchema,
} from "./TeamJwtConfig.js";
import {
    resolveTeamMembersConfig,
    teamMembersConfigSchema,
    teamMembersTomlSchema,
} from "./TeamMembersConfig.js";
import {
    connectionIdSchema,
    nodeNameSchema,
    type LiveCredential,
    type MessageFailureProvider,
    type ServiceTierOption,
} from "@slopus/happy-agent-client";
import { resolveDefaultNodeName } from "./impl/resolveDefaultNodeName.js";
import { nativeAccountIdentityMigrations } from "./persistence/nativeAccountIdentity.js";
import {
    peerMessagingConfigSchema,
    validatePeerMessagingConfig,
    type PeerMessagingConfig,
} from "./PeerMessagingConfig.js";

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
const DEFAULT_TAILCAT_PORT = 24_779;
const DEFAULT_MOBILE_CONNECTOR_PORT = 24_781;
const TAILCAT_EXPOSURE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const PROVIDER_CREDENTIAL_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1_000;
const PROVIDER_SERVICE_TIER_REFRESH_INTERVAL_MS = 60_000;

const pathSchema = Type.String({
    minLength: 1,
    maxLength: MAX_PATH_LENGTH,
    pattern: "^[^\\u0000]+$",
});
const configStringSchema = Type.String({ maxLength: MAX_CONFIG_STRING_LENGTH });
const teamAuthenticationConfigSchema = Type.Union([Type.Literal("workos"), Type.Literal("jwt")]);
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
/**
 * Extra folders skill discovery scans, beside the standard `.agents/skills` roots.
 *
 * A global entry is absolute or `~`-relative and names a folder on this machine. A project entry
 * is relative to the project root, or absolute. Each folder is a container of skill directories,
 * exactly like `.agents/skills`.
 */
const skillDirectoriesSchema = Type.Array(
    Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH, pattern: "^[^\\u0000\\r\\n]+$" }),
    { maxItems: MAX_CONFIG_ARRAY_ITEMS, uniqueItems: true },
);
const skillsInputSchema = Type.Object(
    { directories: Type.Optional(skillDirectoriesSchema) },
    { additionalProperties: false },
);
const permissionModeSchema = Type.Union([
    Type.Literal("auto"),
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
    Type.Literal("full_access"),
]);
const codeModeEngineSchema = Type.Union([Type.Literal("monty"), Type.Literal("bun")]);
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
const serviceTierSchema = Type.Union([Type.Literal("fast"), Type.Literal("ultrafast")]);
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
const profileBootstrapSchema = Type.Object(
    {
        name: Type.String({
            minLength: 1,
            maxLength: 128,
            pattern:
                "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f]+$",
        }),
        email: Type.String({
            minLength: 3,
            maxLength: 254,
            pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$",
        }),
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
/** Extra environment variables for an agent process. */
const environmentSchema = Type.Record(configStringSchema, configStringSchema, {
    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
});
const providerCommonInput = {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" })),
    auto_enable: Type.Optional(Type.Boolean()),
    credential_isolation: Type.Optional(Type.Literal(true)),
    enabled: Type.Optional(Type.Boolean()),
    hidden: Type.Optional(Type.Boolean()),
    exclude_models: Type.Optional(boundedStringArraySchema),
    exclude_subagent_models: Type.Optional(boundedStringArraySchema),
    include_models: Type.Optional(boundedStringArraySchema),
    include_subagent_models: Type.Optional(boundedStringArraySchema),
    p2p_share: Type.Optional(p2pShareSchema),
};
/** The reasoning efforts an OpenAI-compatible model may be configured to accept. */
const openAICompatibleEffortSchema = Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
]);
/** Request fields passed through verbatim, such as OpenRouter's `reasoning = { enabled = true }`. */
const openAICompatibleRequestSchema = Type.Record(configStringSchema, Type.Unknown(), {
    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
});
const openAICompatibleHeadersSchema = Type.Record(configStringSchema, configStringSchema, {
    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
});
/** Per-model settings that override what the vendor's `/models` endpoint reports. */
const openAICompatibleModelOverrideInputSchema = Type.Object(
    {
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" })),
        context_window: Type.Optional(Type.Integer({ minimum: 1_024, maximum: 100_000_000 })),
        auto_compact_window: Type.Optional(Type.Integer({ minimum: 512, maximum: 100_000_000 })),
        input: Type.Optional(
            Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
                minItems: 1,
                maxItems: 2,
                uniqueItems: true,
            }),
        ),
        efforts: Type.Optional(
            Type.Array(openAICompatibleEffortSchema, {
                minItems: 1,
                maxItems: 7,
                uniqueItems: true,
            }),
        ),
        default_effort: Type.Optional(openAICompatibleEffortSchema),
        request: Type.Optional(openAICompatibleRequestSchema),
    },
    { additionalProperties: false },
);
const openAICompatibleModelOverrideSchema = Type.Object(
    {
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" })),
        contextWindow: Type.Optional(Type.Integer({ minimum: 1_024, maximum: 100_000_000 })),
        autoCompactWindow: Type.Optional(Type.Integer({ minimum: 512, maximum: 100_000_000 })),
        input: Type.Optional(
            Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
                minItems: 1,
                maxItems: 2,
                uniqueItems: true,
            }),
        ),
        efforts: Type.Optional(
            Type.Array(openAICompatibleEffortSchema, {
                minItems: 1,
                maxItems: 7,
                uniqueItems: true,
            }),
        ),
        defaultEffort: Type.Optional(openAICompatibleEffortSchema),
        request: Type.Optional(openAICompatibleRequestSchema),
    },
    { additionalProperties: false },
);
const reasoningFieldSchema = Type.Union([
    Type.Literal("reasoning_content"),
    Type.Literal("reasoning"),
    Type.Literal("none"),
]);
const providerInputSchemas = {
    openai_compatible: Type.Object(
        {
            ...providerCommonInput,
            api_key: Type.Optional(configStringSchema),
            api_key_env: Type.Optional(configStringSchema),
            // Optional in one layer: the generated runtime file records only enablement.
            base_url: Type.Optional(configStringSchema),
            headers: Type.Optional(openAICompatibleHeadersSchema),
            model_metadata: Type.Optional(Type.Boolean()),
            model_overrides: Type.Optional(
                Type.Record(configStringSchema, openAICompatibleModelOverrideInputSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            models: Type.Optional(boundedStringArraySchema),
            reasoning_field: Type.Optional(reasoningFieldSchema),
            request: Type.Optional(openAICompatibleRequestSchema),
            type: Type.Literal("openai_compatible"),
        },
        { additionalProperties: false },
    ),
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
    // Agents with their own login. They are configured under [harnesses]; a provider table of
    // these types only ever holds the daemon's generated enablement for that harness.
    antigravity: Type.Object(
        {
            ...providerCommonInput,
            api_key: Type.Optional(configStringSchema),
            args: Type.Optional(boundedStringArraySchema),
            command: Type.Optional(configStringSchema),
            type: Type.Literal("antigravity"),
        },
        { additionalProperties: false },
    ),
    opencode: Type.Object(
        {
            ...providerCommonInput,
            api_key: Type.Optional(configStringSchema),
            args: Type.Optional(boundedStringArraySchema),
            command: Type.Optional(configStringSchema),
            type: Type.Literal("opencode"),
        },
        { additionalProperties: false },
    ),
    acp: Type.Object(
        {
            ...providerCommonInput,
            args: Type.Optional(boundedStringArraySchema),
            // Optional in one layer: the generated runtime file records only enablement.
            command: Type.Optional(configStringSchema),
            env: Type.Optional(environmentSchema),
            type: Type.Literal("acp"),
        },
        { additionalProperties: false },
    ),
    smart: Type.Object(
        {
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" })),
            auto_enable: Type.Optional(Type.Boolean()),
            enabled: Type.Optional(Type.Boolean()),
            hidden: Type.Optional(Type.Boolean()),
            exclude_models: Type.Optional(boundedStringArraySchema),
            exclude_subagent_models: Type.Optional(boundedStringArraySchema),
            include_models: Type.Optional(boundedStringArraySchema),
            include_subagent_models: Type.Optional(boundedStringArraySchema),
            p2p_share: Type.Optional(p2pShareSchema),
            providers: Type.Optional(
                Type.Array(configStringSchema, {
                    minItems: 1,
                    maxItems: MAX_CONFIG_ARRAY_ITEMS,
                    uniqueItems: true,
                }),
            ),
            strategy: Type.Optional(Type.Literal("round_robin")),
            type: Type.Literal("smart"),
        },
        { additionalProperties: false },
    ),
} as const;
const providerInputSchema = Type.Union([
    providerInputSchemas.openai_compatible,
    providerInputSchemas.bedrock,
    providerInputSchemas.claude,
    providerInputSchemas.codex,
    providerInputSchemas.grok,
    providerInputSchemas.antigravity,
    providerInputSchemas.opencode,
    providerInputSchemas.acp,
    providerInputSchemas.smart,
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
        skill_enablement: Type.Optional(
            Type.Record(Type.String({ minLength: 1, maxLength: 4096 }), Type.Boolean(), {
                maxProperties: 10000,
            }),
        ),
        node: Type.Optional(
            Type.Object({ name: Type.Optional(nodeNameSchema) }, { additionalProperties: false }),
        ),
        voice: Type.Optional(voiceSettingsTomlSchema),
        profile: Type.Optional(profileBootstrapSchema),
        api: Type.Optional(apiConfigSchema),
        telegram: Type.Optional(
            Type.Object(
                { api_url: Type.Optional(telegramApiUrlSchema) },
                { additionalProperties: false },
            ),
        ),
        connections: Type.Optional(remoteConnectionsConfigSchema),
        peer_messaging: Type.Optional(peerMessagingConfigSchema),
        runners: Type.Optional(runnersConfigSchema),
        execution: Type.Optional(executionConfigSchema),
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
        feature: Type.Optional(
            Type.Object(
                {
                    codemode: Type.Optional(
                        Type.Object(
                            {
                                enabled: Type.Optional(Type.Boolean()),
                                engine: Type.Optional(codeModeEngineSchema),
                            },
                            { additionalProperties: false },
                        ),
                    ),
                    mobile_connector: Type.Optional(
                        Type.Object(
                            {
                                enabled: Type.Optional(Type.Boolean()),
                                port: Type.Optional(Type.Integer({ maximum: 65_535, minimum: 1 })),
                            },
                            { additionalProperties: false },
                        ),
                    ),
                    tailcat: Type.Optional(
                        Type.Object(
                            {
                                enabled: Type.Optional(Type.Boolean()),
                                port: Type.Optional(Type.Integer({ maximum: 65_535, minimum: 1 })),
                            },
                            { additionalProperties: false },
                        ),
                    ),
                    team: Type.Optional(
                        Type.Object(
                            {
                                authentication: Type.Optional(teamAuthenticationConfigSchema),
                                enabled: Type.Optional(Type.Boolean()),
                                host: Type.Optional(
                                    Type.String({
                                        maxLength: 255,
                                        minLength: 1,
                                        pattern: "^[^\\s\\u0000-\\u001f\\u007f]+$",
                                    }),
                                ),
                                owner_workos_user_id: Type.Optional(
                                    Type.String({
                                        maxLength: 160,
                                        minLength: 7,
                                        pattern: "^user_[A-Za-z0-9]+$",
                                    }),
                                ),
                                jwt: Type.Optional(teamJwtTomlSchema),
                                members: Type.Optional(teamMembersTomlSchema),
                                owner_user_id: Type.Optional(teamOwnerUserIdSchema),
                                port: Type.Optional(Type.Integer({ maximum: 65_535, minimum: 0 })),
                                workos_client_id: Type.Optional(
                                    Type.String({
                                        maxLength: 160,
                                        minLength: 8,
                                        pattern: "^client_[A-Za-z0-9]+$",
                                    }),
                                ),
                                workos_organization_id: Type.Optional(
                                    Type.String({
                                        maxLength: 160,
                                        minLength: 6,
                                        pattern: "^org_[A-Za-z0-9]+$",
                                    }),
                                ),
                            },
                            { additionalProperties: false },
                        ),
                    ),
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
        harnesses: Type.Optional(
            Type.Record(configStringSchema, harnessInputSchema, {
                maxProperties: MAX_CONFIG_TABLE_ENTRIES,
            }),
        ),
        provider_default_enable: Type.Optional(Type.Boolean()),
        providers: Type.Optional(providerMapInputSchema),
        settings: Type.Optional(settingsInputSchema),
        skills: Type.Optional(skillsInputSchema),
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
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" })),
    autoEnable: Type.Optional(Type.Boolean()),
    credentialIsolation: Type.Optional(Type.Literal(true)),
    enabled: Type.Boolean(),
    hidden: Type.Optional(Type.Boolean()),
    excludeModels: Type.Optional(boundedStringArraySchema),
    excludeSubagentModels: Type.Optional(boundedStringArraySchema),
    includeModels: Type.Optional(boundedStringArraySchema),
    includeSubagentModels: Type.Optional(boundedStringArraySchema),
    p2pShare: Type.Optional(p2pShareSchema),
};
const providerSchemas = {
    openai_compatible: Type.Object(
        {
            ...providerRecordBase,
            apiKey: Type.Optional(configStringSchema),
            apiKeyEnv: Type.Optional(configStringSchema),
            baseUrl: Type.String({ minLength: 1, maxLength: 2_048, pattern: "^https?://[^\\s]+$" }),
            headers: Type.Optional(openAICompatibleHeadersSchema),
            modelMetadata: Type.Optional(Type.Boolean()),
            modelOverrides: Type.Optional(
                Type.Record(configStringSchema, openAICompatibleModelOverrideSchema, {
                    maxProperties: MAX_CONFIG_TABLE_ENTRIES,
                }),
            ),
            models: Type.Optional(boundedStringArraySchema),
            reasoningField: Type.Optional(reasoningFieldSchema),
            request: Type.Optional(openAICompatibleRequestSchema),
            type: Type.Literal("openai_compatible"),
        },
        { additionalProperties: false },
    ),
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
    antigravity: Type.Object(
        {
            ...providerRecordBase,
            apiKey: Type.Optional(configStringSchema),
            args: Type.Optional(boundedStringArraySchema),
            command: Type.Optional(configStringSchema),
            type: Type.Literal("antigravity"),
        },
        { additionalProperties: false },
    ),
    opencode: Type.Object(
        {
            ...providerRecordBase,
            apiKey: Type.Optional(configStringSchema),
            args: Type.Optional(boundedStringArraySchema),
            command: Type.Optional(configStringSchema),
            type: Type.Literal("opencode"),
        },
        { additionalProperties: false },
    ),
    acp: Type.Object(
        {
            ...providerRecordBase,
            args: Type.Optional(boundedStringArraySchema),
            command: configStringSchema,
            env: Type.Optional(environmentSchema),
            type: Type.Literal("acp"),
        },
        { additionalProperties: false },
    ),
    smart: Type.Object(
        {
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" })),
            autoEnable: Type.Optional(Type.Boolean()),
            enabled: Type.Boolean(),
            hidden: Type.Optional(Type.Boolean()),
            excludeModels: Type.Optional(boundedStringArraySchema),
            excludeSubagentModels: Type.Optional(boundedStringArraySchema),
            includeModels: Type.Optional(boundedStringArraySchema),
            includeSubagentModels: Type.Optional(boundedStringArraySchema),
            p2pShare: Type.Optional(p2pShareSchema),
            providers: Type.Array(configStringSchema, {
                minItems: 1,
                maxItems: MAX_CONFIG_ARRAY_ITEMS,
                uniqueItems: true,
            }),
            strategy: Type.Literal("round_robin"),
            type: Type.Literal("smart"),
        },
        { additionalProperties: false },
    ),
} as const;
const providerSchema = Type.Union([
    providerSchemas.openai_compatible,
    providerSchemas.bedrock,
    providerSchemas.claude,
    providerSchemas.codex,
    providerSchemas.grok,
    providerSchemas.antigravity,
    providerSchemas.opencode,
    providerSchemas.acp,
    providerSchemas.smart,
]);

const resolvedValuesSchema = Type.Object(
    {
        profile: Type.Optional(profileBootstrapSchema),
        api: Type.Optional(apiConfigSchema),
        telegram: Type.Optional(
            Type.Object(
                { apiUrl: Type.Optional(telegramApiUrlSchema) },
                { additionalProperties: false },
            ),
        ),
        connections: Type.Optional(remoteConnectionsConfigSchema),
        peer_messaging: Type.Optional(peerMessagingConfigSchema),
        runners: Type.Optional(runnersConfigSchema),
        execution: Type.Optional(executionConfigSchema),
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
        feature: Type.Object(
            {
                codemode: Type.Object(
                    { enabled: Type.Boolean(), engine: codeModeEngineSchema },
                    { additionalProperties: false },
                ),
                mobileConnector: Type.Object(
                    {
                        enabled: Type.Boolean(),
                        port: Type.Integer({ maximum: 65_535, minimum: 1 }),
                    },
                    { additionalProperties: false },
                ),
                tailcat: Type.Object(
                    {
                        enabled: Type.Boolean(),
                        port: Type.Integer({ maximum: 65_535, minimum: 1 }),
                    },
                    { additionalProperties: false },
                ),
                team: Type.Union([
                    Type.Object(
                        {
                            authentication: teamAuthenticationConfigSchema,
                            enabled: Type.Literal(false),
                            host: Type.String({ maxLength: 255, minLength: 1 }),
                            jwt: Type.Optional(teamJwtConfigSchema),
                            members: Type.Optional(teamMembersConfigSchema),
                            ownerUserId: Type.Optional(teamOwnerUserIdSchema),
                            ownerWorkOSUserId: Type.Optional(
                                Type.String({
                                    maxLength: 160,
                                    minLength: 7,
                                    pattern: "^user_[A-Za-z0-9]+$",
                                }),
                            ),
                            port: Type.Integer({ maximum: 65_535, minimum: 0 }),
                            workosClientId: Type.String({
                                maxLength: 160,
                                minLength: 8,
                                pattern: "^client_[A-Za-z0-9]+$",
                            }),
                            workosOrganizationId: Type.Optional(
                                Type.String({
                                    maxLength: 160,
                                    minLength: 6,
                                    pattern: "^org_[A-Za-z0-9]+$",
                                }),
                            ),
                        },
                        { additionalProperties: false },
                    ),
                    Type.Object(
                        {
                            authentication: Type.Literal("workos"),
                            enabled: Type.Literal(true),
                            host: Type.String({ maxLength: 255, minLength: 1 }),
                            members: Type.Optional(teamMembersConfigSchema),
                            ownerWorkOSUserId: Type.String({
                                maxLength: 160,
                                minLength: 7,
                                pattern: "^user_[A-Za-z0-9]+$",
                            }),
                            port: Type.Integer({ maximum: 65_535, minimum: 0 }),
                            workosClientId: Type.String({
                                maxLength: 160,
                                minLength: 8,
                                pattern: "^client_[A-Za-z0-9]+$",
                            }),
                            workosOrganizationId: Type.String({
                                maxLength: 160,
                                minLength: 6,
                                pattern: "^org_[A-Za-z0-9]+$",
                            }),
                        },
                        { additionalProperties: false },
                    ),
                    Type.Object(
                        {
                            authentication: Type.Literal("jwt"),
                            enabled: Type.Literal(true),
                            host: Type.String({ maxLength: 255, minLength: 1 }),
                            jwt: teamJwtConfigSchema,
                            members: Type.Optional(teamMembersConfigSchema),
                            ownerUserId: teamOwnerUserIdSchema,
                            port: Type.Integer({ maximum: 65_535, minimum: 0 }),
                            workosClientId: Type.String({
                                maxLength: 160,
                                minLength: 8,
                                pattern: "^client_[A-Za-z0-9]+$",
                            }),
                        },
                        { additionalProperties: false },
                    ),
                ]),
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
        node: Type.Object({ name: Type.Optional(nodeNameSchema) }, { additionalProperties: false }),
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
        harnesses: Type.Record(configStringSchema, harnessSchema, {
            maxProperties: MAX_CONFIG_TABLE_ENTRIES,
        }),
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
        skills: Type.Object(
            { directories: skillDirectoriesSchema },
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
        claudeWorkingDirectory: pathSchema,
        configHome: pathSchema,
        databasePath: pathSchema,
        dataVersionPath: pathSchema,
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
        skillsHome: pathSchema,
        socketPath: pathSchema,
        tailcatAddressPath: pathSchema,
        tailcatHome: pathSchema,
        tailcatKeyPath: pathSchema,
        tailcatPortPath: pathSchema,
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
        modelId: "openai/gpt-6.1-sol",
        permissionMode: "auto",
    },
    features: {
        crossWorkspace: true,
        workflows: true,
        workspaces: true,
    },
    feature: {
        codemode: { enabled: false, engine: "monty" },
        mobileConnector: { enabled: true, port: DEFAULT_MOBILE_CONNECTOR_PORT },
        tailcat: { enabled: false, port: DEFAULT_TAILCAT_PORT },
        team: {
            authentication: "workos",
            enabled: false,
            host: "0.0.0.0",
            port: 3_000,
            workosClientId: "client_01KZD3XE9YAFAMT0P8TD4HP73E",
        },
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
    node: {},
    permissions: { protectedPaths: [] },
    presence: { states: {} },
    harnesses: DEFAULT_HARNESSES,
    providerDefaultEnable: false,
    providers: {
        bedrock: { enabled: false, type: "bedrock" },
        claude: { enabled: false, name: "Current CLI", type: "claude" },
        codex: { enabled: false, name: "Current CLI", type: "codex" },
        grok: { enabled: false, name: "Current CLI", type: "grok" },
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
    skills: { directories: [] },
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
/** The private files of one Tailcat exposure: its stable key and its live address and port. */
export interface TailcatExposurePaths {
    readonly addressPath: string;
    readonly home: string;
    readonly keyPath: string;
    readonly portPath: string;
}

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
/** How each provider family is named in a sentence, such as "Couldn't reach Claude". */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
    bedrock: "Amazon Bedrock",
    claude: "Claude",
    codex: "Codex",
    grok: "Grok",
};

export class ConfigModule implements AgentModule {
    readonly migrations = nativeAccountIdentityMigrations;
    readonly #executionObservations = new ProviderExecutionObservations();
    readonly #credentialFailures = new ProviderCredentialFailures(Date.now, (providerId) => {
        this.#reportSignIn(providerId, "signed_out");
    });
    readonly #accountFailures = new ProviderAccountFailures(Date.now, (providerId, signIn) => {
        this.#reportSignIn(providerId, signIn);
    });
    readonly #signInListeners = new Set<
        (providerId: string, signIn: ProviderSignInObservation) => void
    >();

    /**
     * The typed details of a failure configuration raised because a provider had no credential,
     * matched by the exact text it raised for the selected provider or, behind a smart alias, one
     * of the accounts it routes to; any other text has none.
     */
    unavailableCredentialFailure(
        message: string,
        providerId: string,
    ): UnavailableCredentialFailure | undefined {
        const candidates =
            smartProviderRoute(this.configuration, providerId)?.models.flatMap(
                (route) => route.candidates,
            ) ?? [];
        return this.#credentialFailures.find(message, [providerId, ...new Set(candidates)]);
    }

    /**
     * Let a smart route reconsider every account for this agent, once per request the person made:
     * a message they sent, or their explicit retry of a failed turn. Accounts that failed stay
     * skipped otherwise, so an automatic run never spins through spent accounts again.
     */
    async reopenRoute(
        agentId: string,
        providerId: string,
        model: string | undefined,
        requestId: string,
    ): Promise<void> {
        if (
            this.configuration.values.providers[providerId]?.type !== "smart" ||
            !this.isProviderEnabled(providerId)
        )
            return;
        const provider = await this.providers.resolve(providerId, model);
        if (provider instanceof RoundRobinRouterProvider) {
            provider.acceptUserMessage(agentId, requestId);
        }
    }

    /**
     * Whether this agent's smart route has no account to offer because usage ran out, or because
     * every account is turned off. Any other provider is never a spent pool.
     */
    async routeSpent(
        agentId: string,
        providerId: string,
        model: string | undefined,
    ): Promise<boolean> {
        if (this.configuration.values.providers[providerId]?.type !== "smart") return false;
        if (!this.isProviderEnabled(providerId)) return false;
        // Describing a failure must never fail it again; a route that cannot open says nothing.
        const provider = await this.providers.resolve(providerId, model).catch(() => null);
        return provider instanceof RoundRobinRouterProvider && provider.spent(agentId);
    }

    /**
     * The account whose failure this agent's exhausted smart route reports. It is not always the
     * last account tried: a rejected sign-in outranks a spent account, because signing in is what
     * the person can do now. Undefined for any other provider or a route that is not exhausted.
     */
    async routeFailedAccount(
        agentId: string,
        providerId: string,
        model: string | undefined,
    ): Promise<string | undefined> {
        if (this.configuration.values.providers[providerId]?.type !== "smart") return undefined;
        if (!this.isProviderEnabled(providerId)) return undefined;
        // Describing a failure must never fail it again; a route that cannot open says nothing.
        const provider = await this.providers.resolve(providerId, model).catch(() => null);
        return provider instanceof RoundRobinRouterProvider
            ? provider.failedAccount(agentId)
            : undefined;
    }

    /**
     * Every account this agent's exhausted smart route set aside, in configured order, without
     * accounts turned off since. Empty for any other provider or a route that is not exhausted.
     */
    async routeFailedAccounts(
        agentId: string,
        providerId: string,
        model: string | undefined,
    ): Promise<readonly SmartRouteAccountFailure[]> {
        if (this.configuration.values.providers[providerId]?.type !== "smart") return [];
        if (!this.isProviderEnabled(providerId)) return [];
        // Describing a failure must never fail it again; a route that cannot open says nothing.
        const provider = await this.providers.resolve(providerId, model).catch(() => null);
        return provider instanceof RoundRobinRouterProvider ? provider.failedAccounts(agentId) : [];
    }

    /** The accounts a smart route sends to, or null when the provider is not a smart route. */
    smartRouteAccounts(providerId: string): readonly string[] | null {
        const route = smartProviderRoute(this.configuration, providerId);
        if (route === undefined) return null;
        return [...new Set(route.models.flatMap((model) => model.candidates))];
    }

    /**
     * A smart provider's strategy and the accounts it can route to, in configured failover order,
     * hidden and disabled accounts included. Undefined for any other provider.
     */
    smartProviderPool(
        providerId: string,
    ): { readonly strategy: string; readonly members: readonly string[] } | undefined {
        const configured = this.configuration.values.providers[providerId];
        if (configured?.type !== "smart") return undefined;
        const routed = new Set(this.smartRouteAccounts(providerId) ?? []);
        return {
            strategy: configured.strategy,
            members: configured.providers.filter((id) => routed.has(id)),
        };
    }

    /** Whether this provider's last construction found no credential to sign in with. */
    providerNeedsSignIn(providerId: string): boolean {
        return this.#credentialFailures.has(providerId);
    }

    /**
     * The provider entry a failure is about, as a failure card names it: its family, the vendor as
     * people say it in a sentence, and the configured entry's display label.
     */
    failureProvider(providerId: string): MessageFailureProvider {
        const type = this.providerType(providerId) ?? "unknown";
        return {
            id: providerId,
            type,
            vendorName: VENDOR_NAMES[type] ?? this.providerName(providerId),
            label: this.configuration.values.providers[providerId]?.name ?? providerId,
        };
    }

    beginExecutionObservation(
        agentId: string,
        operationId: string,
        kind: ProviderExecutionKind,
    ): void {
        this.#executionObservations.begin(agentId, operationId, kind);
    }

    executionObservation(
        agentId: string,
        operationId: string,
    ): readonly ProviderExecutionAttempt[] | undefined {
        return this.#executionObservations.read(agentId, operationId);
    }

    endExecutionObservation(agentId: string, operationId: string): void {
        this.#executionObservations.end(agentId, operationId);
    }

    currentExecutionObservation(
        agentId: string,
        operationId: string,
    ): CurrentProviderExecutionAttempt | undefined {
        return this.#executionObservations.current(agentId, operationId);
    }

    endAgentExecutionObservations(agentId: string): void {
        this.#executionObservations.endAgent(agentId);
    }
    readonly name = "config";
    readonly configuration: HappyAgentConfiguration;

    readonly #scripted: ConfigInferenceOverride | ConfigInferenceFactory | undefined;
    readonly #environment: Readonly<NodeJS.ProcessEnv>;
    readonly #harnessUsage = new Map<
        string,
        {
            readonly at: number;
            readonly reading: Promise<readonly HarnessUsageWindow[] | undefined>;
        }
    >();
    readonly #providerLifetime = new AbortController();
    #credentialRefreshStarted = false;
    readonly #serviceTierListeners = new Set<() => void>();
    readonly #serviceTiers = new ProviderServiceTiers(() => {
        for (const listener of this.#serviceTierListeners) {
            try {
                listener();
            } catch {
                /* Capability notifications cannot fail inference. */
            }
        }
    });
    #serviceTierRefresh: Promise<void> | undefined;
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
    #tailcatEnabled: boolean;
    #connections: Record<string, RemoteConnectionEntry>;
    #peerMessaging: PeerMessagingConfig;
    readonly #accountUsageListeners = new Set<(usage: ProviderUsage) => void>();
    #resolvedScripted: ConfigInferenceOverride | undefined;
    #scriptedModelSnapshot: readonly AgentModel[] | undefined;
    #workspacesHome: string | undefined;

    /** The public root for persistent bot folders. Configuration owns every product path. */
    get botsHome(): string {
        return join(this.configuration.paths.publicHome, "Bots");
    }

    /** The public root for dedicated task folders, beside the bot folders. */
    get tasksHome(): string {
        return join(this.configuration.paths.publicHome, "Tasks");
    }

    /** The public root for Surface chat folders, beside the task and bot folders. */
    get surfacesHome(): string {
        return join(this.configuration.paths.publicHome, "Surfaces");
    }

    /** Installed global skills live on this daemon's machine, independently of its config home. */
    get globalSkillsRoot(): string {
        return join(this.#environment.HOME?.trim() || homedir(), ".agents", "skills");
    }

    /**
     * Extra skill folders configured for this machine, as absolute paths.
     *
     * `[skills] directories` in the user `happy.toml` (or generated `runtime.toml`) lists folders
     * that skill discovery scans beside `~/.agents/skills`. A `~` prefix or a relative entry is
     * resolved against the same home as the global skills root.
     */
    get globalSkillDirectories(): readonly string[] {
        return [...new Set([...this.userSkillDirectories, ...this.runtimeSkillDirectories])];
    }

    /** The extra skill folders the user `happy.toml` names, which live mutations cannot change. */
    get userSkillDirectories(): readonly string[] {
        const skills = this.configuration.sources.global.values["skills"];
        const directories = Value.Check(skillsInputSchema, skills) ? skills.directories : undefined;
        return (directories ?? []).map((directory) => this.resolveSkillDirectory(directory));
    }

    /** The extra skill folders added live and kept in generated `runtime.toml`. */
    get runtimeSkillDirectories(): readonly string[] {
        return (this.#runtimeValues.skills?.directories ?? []).map((directory) =>
            this.resolveSkillDirectory(directory),
        );
    }

    /** An absolute or `~`-relative machine skill folder, resolved against the skills home. */
    resolveSkillDirectory(directory: string): string {
        return resolveSkillDirectory(directory, this.#environment.HOME?.trim() || homedir());
    }

    /**
     * Add one machine skill folder to generated `runtime.toml`, taking effect on the next discovery.
     * Returns false when the folder was already listed, so a repeated call changes nothing.
     */
    async addRuntimeSkillDirectory(ctx: Context, directory: string): Promise<boolean> {
        const resolved = this.resolveSkillDirectory(directory);
        return await this.#runtimeLock.runInLock(ctx, async () => {
            const current = this.runtimeSkillDirectories;
            if (current.includes(resolved)) return false;
            await this.#writeRuntimeSkillDirectories([...current, resolved]);
            return true;
        });
    }

    /**
     * Remove one machine skill folder from generated `runtime.toml`. Returns false when it was not
     * listed there; a folder the user `happy.toml` names stays, since that file is the user's.
     */
    async removeRuntimeSkillDirectory(ctx: Context, directory: string): Promise<boolean> {
        const resolved = this.resolveSkillDirectory(directory);
        return await this.#runtimeLock.runInLock(ctx, async () => {
            const current = this.runtimeSkillDirectories;
            if (!current.includes(resolved)) return false;
            await this.#writeRuntimeSkillDirectories(current.filter((path) => path !== resolved));
            return true;
        });
    }

    async #writeRuntimeSkillDirectories(directories: readonly string[]): Promise<void> {
        const { skills: _skills, ...rest } = structuredClone(this.#runtimeValues);
        const next: PartialValues =
            directories.length === 0
                ? rest
                : { ...rest, skills: { directories: [...directories] } };
        if (!Value.Check(partialValuesSchema, next)) {
            throw new Error(
                `At most ${MAX_CONFIG_ARRAY_ITEMS} skill folders can be added, each a path of at most ${MAX_PATH_LENGTH} characters.`,
            );
        }
        await writeRuntimeConfigurationFile(this.configuration.paths.runtimeConfigPath, next);
        this.#runtimeValues = next;
    }

    /**
     * Extra skill folders one project's `happy.toml` names, as the file wrote them.
     *
     * Skill discovery reads the project file through the agent's compute and resolves each entry
     * against that project root, so this only parses. The whole file must be valid configuration;
     * an unparseable file is an error the caller decides how to treat.
     */
    projectSkillDirectories(source: string): readonly string[] {
        return [...(parseHappyAgentConfigToml(source).values.skills?.directories ?? [])];
    }

    get runtimeSkillEnablement(): Readonly<Record<string, boolean>> {
        return structuredClone(this.#runtimeValues.skill_enablement ?? {});
    }

    /** Durable skills work writes the current committed preference snapshot, never old call arguments. */
    async writeRuntimeSkillEnablement(
        ctx: Context,
        enablement: Readonly<Record<string, boolean>>,
    ): Promise<void> {
        if (!Value.Check(partialValuesSchema.properties.skill_enablement, enablement))
            throw new Error("The global skill preferences are invalid.");
        await this.#runtimeLock.runInLock(ctx, async () => {
            const next = { ...this.#runtimeValues, skill_enablement: structuredClone(enablement) };
            await writeRuntimeConfigurationFile(this.configuration.paths.runtimeConfigPath, next);
            this.#runtimeValues = next;
        });
    }

    /** The private, per-agent Code Mode interpreter snapshot owned by this installation. */
    codeModeSnapshotPath(agentId: string): string {
        if (!Value.Check(cuid2Schema, agentId)) {
            throw new Error("The agent ID cannot name a Code Mode state folder.");
        }
        return join(this.configuration.paths.agentHome, "state", agentId, "snapshot.bin");
    }

    /** The private root holding every artifact's stored content, beside the database. */
    get artifactsHome(): string {
        return join(this.configuration.paths.agentHome, "artifacts");
    }

    /** One stored artifact file, named by the SHA-256 of its bytes and never rewritten. */
    artifactContentPath(sha256: string): string {
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            throw new Error("The artifact content digest cannot name a file.");
        }
        return join(this.artifactsHome, "content", sha256.slice(0, 2), sha256);
    }

    /**
     * One snapshot of media shown in a chat, named by the SHA-256 of its bytes and never
     * rewritten, in the private root beside the database rather than in history.
     */
    chatMediaContentPath(sha256: string): string {
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            throw new Error("The chat media digest cannot name a file.");
        }
        return join(this.configuration.paths.agentHome, "media", sha256.slice(0, 2), sha256);
    }

    /**
     * The folder of sticker packs the story editor offers, one folder per pack. Nothing ships in
     * it: whoever runs the installation puts packs there.
     */
    get stickersHome(): string {
        return join(this.configuration.paths.agentHome, "stickers");
    }

    /** A sticker's Lottie JSON, decompressed once from its `tgs` file of this digest. */
    stickerLottieCachePath(sha256: string): string {
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            throw new Error("The sticker digest cannot name a file.");
        }
        return join(this.configuration.paths.agentHome, "cache", "stickers", `${sha256}.json`);
    }

    /**
     * The private folder where an exported bot keeps files people sent until they are taken in,
     * one per export kind and account.
     */
    exportedBotFilesPath(kind: string, account: string): string {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(kind) || !/^[A-Za-z0-9_-]{1,128}$/.test(account)) {
            throw new Error("The exported bot cannot name a files folder.");
        }
        return join(this.configuration.paths.agentHome, "exported-bots", kind, account);
    }

    /** Where one artifact upload's bytes arrive before they are stored by their digest. */
    artifactUploadPath(uploadId: string): string {
        if (!Value.Check(cuid2Schema, uploadId)) {
            throw new Error("The artifact upload ID cannot name a file.");
        }
        return join(this.artifactsHome, "uploads", uploadId);
    }

    /**
     * One artifact's data store: a SQLite file of its own in the artifacts folder's `_data_`
     * directory, outside the main database, shared by every version of that artifact.
     */
    artifactDataPath(artifactId: string): string {
        if (!Value.Check(cuid2Schema, artifactId)) {
            throw new Error("The artifact ID cannot name a data store.");
        }
        return join(this.artifactsHome, "_data_", artifactId, "kv.sqlite");
    }

    /** A strict service's private native controls never live in the workspace it serves. */
    serviceExecution(serviceId: string): ComputeServiceExecution {
        if (process.platform !== "linux")
            throw new Error(
                "Sandboxed workspace services require a Linux compute with native namespace and cgroup support.",
            );
        if (!Value.Check(cuid2Schema, serviceId) || serviceId.length < 16) {
            throw new Error("The service ID cannot name an execution folder.");
        }
        const directory = join(this.configuration.paths.agentHome, "services", serviceId);
        if (Buffer.byteLength(join(directory, "bridge"), "utf8") > 100) {
            throw new Error(
                "The Happy Agent private home is too long for a secure service socket. Use a shorter private home path.",
            );
        }
        return { id: serviceId, directory };
    }

    /** Prepare only the private parent; the supervisor SDK exclusively creates each execution. */
    async prepareServiceControls(): Promise<void> {
        await ensurePrivateDirectory(join(this.configuration.paths.agentHome, "services"));
    }

    /** Re-read the target workspace's root policy, never another agent's startup directory. */
    async serviceNetworkPolicy(workspacePath: string): Promise<ManagedNetworkPolicy | undefined> {
        if (!Value.Check(pathSchema, workspacePath))
            throw new Error("The service workspace path is invalid.");
        const [global, local] = await Promise.all([
            readConfigSource(this.configuration.paths.globalConfigPath, "global"),
            readConfigSource(join(workspacePath, "happy.toml"), "local"),
        ]);
        const values = mergeValues(
            global.values,
            withoutProjectMachineSettings(local.values),
            this.#runtimeValues,
        );
        return toManagedNetworkPolicy(values.network);
    }

    /** One immutable bot folder below the configuration-owned bot root. */
    botPath(username: string): string {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(username)) {
            throw new Error("The bot username cannot name a folder.");
        }
        return join(this.botsHome, username);
    }

    /** One immutable task folder below the configuration-owned task root. */
    taskPath(folderName: string): string {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(folderName)) {
            throw new Error("The task folder name cannot name a folder.");
        }
        return join(this.tasksHome, folderName);
    }

    /** One Surface's chat folder, named by its immutable CUID2. */
    surfacePath(surfaceId: string): string {
        if (!/^[a-z][a-z0-9]{23}$/.test(surfaceId)) {
            throw new Error("The Surface ID cannot name a folder.");
        }
        return join(this.surfacesHome, surfaceId);
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
        this.#tailcatEnabled = configuration.values.feature.tailcat.enabled;
        this.#connections = structuredClone(configuration.values.connections ?? {});
        this.#peerMessaging = structuredClone(configuration.values.peer_messaging ?? {});
        for (const id of Object.keys(configuration.values.providers)) {
            this.#providerEnabled.set(id, this.configuredProviderOverride(id) ?? false);
        }
    }

    readonly #hooks: AgentModuleHooks = {
        messageAccepted: async (_ctx, scope, accepted): Promise<void> => {
            if (accepted.message.role !== "user" || !isUserOriginMetadata(accepted.metadata))
                return;
            await this.reopenRoute(
                scope.agent.id,
                scope.agent.provider,
                scope.agent.model,
                accepted.id,
            );
        },
        /** Apply configured root instructions through the normal pre-inference hook. */
        instructions: async (): Promise<string> =>
            this.configuration.values.defaults.instructions ?? "",
        afterStart: async (ctx): Promise<void> => {
            if (this.#credentialRefreshStarted) return;
            this.#credentialRefreshStarted = true;
            this.#refreshForeignAgentModels(ctx);
            this.#refreshOpenAICompatibleMetadata(ctx);
            const lifetime =
                ctx.lifetime === undefined
                    ? this.#providerLifetime.signal
                    : AbortSignal.any([ctx.lifetime, this.#providerLifetime.signal]);
            const owner = withLifetime(
                detach(ctx).named("provider-credential-maintenance"),
                lifetime,
            );
            // The loop belongs to the daemon, not startup or the next inference request. A
            // completed pass schedules the next one, so slow refreshes never pile up.
            void forever(
                owner,
                {
                    delay: PROVIDER_CREDENTIAL_REFRESH_INTERVAL_MS,
                    delayFirst: false,
                    name: "refresh-provider-credentials",
                },
                async (refreshCtx) => {
                    await this.refreshProviderCredentials(refreshCtx);
                },
            ).catch(() => {
                if (!lifetime.aborted) owner.log.warn("Background provider token refresh stopped.");
            });
            const tierOwner = withLifetime(
                detach(ctx).named("provider-service-tier-maintenance"),
                lifetime,
            );
            void forever(
                tierOwner,
                {
                    delay: PROVIDER_SERVICE_TIER_REFRESH_INTERVAL_MS,
                    delayFirst: false,
                    name: "refresh-provider-service-tiers",
                },
                async (refreshCtx) => {
                    await this.refreshProviderServiceTiers(refreshCtx);
                },
            ).catch(() => {
                if (!lifetime.aborted)
                    tierOwner.log.warn("Background provider capability refresh stopped.");
            });
        },
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
            return scripted.filter((model) => this.#isModelSelectable(model));
        }
        return agentModels(
            this.configuration,
            (message) => {
                if (!this.#catalogNotices.includes(message)) this.#catalogNotices.push(message);
            },
            (id) => this.isProviderEnabled(id),
            (id) => this.#isAccountEnabled(id),
        ).map((model) => this.#serviceTiers.apply(model));
    }

    /** Every configured route independent of its live provider gate. */
    get offeredModels(): readonly AgentModel[] {
        return (
            this.#scriptedModels() ??
            agentModels(
                this.configuration,
                undefined,
                () => true,
                () => true,
            )
        );
    }

    /** Every configured provider/model route, including disabled and filtered catalog entries. */
    get catalog(): readonly (ConfiguredAgentModel & {
        readonly serviceTierOptions: readonly ServiceTierOption[];
    })[] {
        const scripted = this.#scriptedModels();
        const scriptedProviderIds = new Set(scripted?.map((model) => model.providerId) ?? []);
        const catalog = agentModelCatalog(
            this.configuration,
            (id) => this.isProviderEnabled(id),
            (id) => this.#isAccountEnabled(id),
        ).filter((model) => !scriptedProviderIds.has(model.providerId));
        if (scripted !== undefined) {
            for (const model of scripted) {
                // A configured provider served next to the script reports its own context.
                const modelContext =
                    foreignAgentModelContext(this.configuration, model.providerId, model.id) ??
                    openAICompatibleModelContext(this.configuration, model.providerId, model.id) ??
                    agentModelContext(model.id);
                const entry: ConfiguredAgentModel = {
                    ...model,
                    autoCompactWindow: modelContext?.autoCompactWindow ?? null,
                    contextWindow: modelContext?.contextWindow ?? null,
                    enabled: this.#isModelSelectable(model),
                    hidden: false,
                };
                catalog.push(entry);
            }
        }
        return catalog.map((model) => {
            const effective = scriptedProviderIds.has(model.providerId)
                ? model
                : this.#serviceTiers.apply(model);
            return {
                ...effective,
                serviceTierOptions: modelServiceTierOptions(effective.serviceTiers),
            };
        });
    }

    /** Context limits for one enabled provider/model route: curated, or a foreign agent's own. */
    modelContext(providerId: string, modelId: string): AgentModelContext | undefined {
        const enabled = this.models.some(
            (model) => model.providerId === providerId && model.id === modelId,
        );
        if (!enabled) return undefined;
        return (
            foreignAgentModelContext(this.configuration, providerId, modelId) ??
            openAICompatibleModelContext(this.configuration, providerId, modelId) ??
            agentModelContext(modelId)
        );
    }

    /** The concrete Anthropic Bedrock transport used by every route behind this selection. */
    anthropicBedrockTransport(
        providerId: string,
        modelId: string | undefined,
    ): AnthropicBedrockTransport | undefined {
        return configuredAnthropicBedrockTransport(this.configuration, providerId, modelId);
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
            this.#isAccountEnabled(id),
        );
        this.#providers = providerRegistryUntil(
            source,
            this.#providerLifetime.signal,
            this.#providerEnablement,
            (id) => this.isProviderEnabled(id),
            (id, request, provider) =>
                this.validateProviderServiceTier(id, request.model, request.serviceTier, provider),
        );
        return this.#providers;
    }

    get providerIds(): readonly string[] {
        return this.#providerSource().ids;
    }

    /** Stored voice settings: generated runtime values override the machine file; projects never set them. */
    get voiceSettings(): VoiceSettingsToml {
        return this.#voiceSettingsWithRuntime(this.#runtimeValues.voice ?? {});
    }

    #voiceSettingsWithRuntime(runtime: VoiceSettingsToml): VoiceSettingsToml {
        const machine = this.configuration.sources.global.values["voice"];
        return {
            ...(Value.Check(voiceSettingsTomlSchema, machine) ? machine : {}),
            ...runtime,
        };
    }

    /**
     * What a voice call starting now would run its controller on, with a readable explanation of
     * any setting that is currently ignored or unusable. Without a stored account, use the ordinary
     * default route independently of the voice model, retaining an explicit disabled default.
     */
    voiceController(settings: VoiceSettingsToml = this.voiceSettings): {
        readonly providerId: string | null;
        readonly modelId: string;
        readonly model: AgentModel | undefined;
        readonly effort: string;
        readonly serviceTier: "priority" | null;
        readonly notice: string | null;
    } {
        const models = this.models;
        const modelId = settings.controller_model ?? VOICE_CONTROLLER_DEFAULT_MODEL;
        const providerId =
            settings.controller_provider ??
            this.configuration.values.defaults.providerId ??
            models[0]?.providerId ??
            null;
        const model = models.find(
            (candidate) => candidate.providerId === providerId && candidate.id === modelId,
        );
        const name =
            model?.name ?? this.catalog.find((entry) => entry.id === modelId)?.name ?? modelId;
        const effort =
            settings.controller_effort ??
            (model === undefined || model.effortLevels.includes("low")
                ? "low"
                : model.defaultEffort);
        const fast = model?.serviceTiers?.includes("priority") === true;
        let notice: string | null = null;
        if (providerId === null)
            notice =
                "No account is enabled for voice. Enable an account, then choose a controller model in voice settings.";
        else if (model === undefined)
            notice = `${name} is not enabled on ${settings.controller_provider === undefined ? "the default account" : "the selected account"}, so voice cannot start. Choose another controller account or model in voice settings.`;
        else if (!model.effortLevels.some((level) => level === effort))
            notice = `${name} does not accept ${effort} effort, so voice cannot start. Choose another effort in voice settings.`;
        else if (settings.controller_fast_mode === true && !fast)
            notice = `Fast mode is not available for ${name}, so it is ignored.`;
        return {
            providerId,
            modelId,
            model,
            effort,
            serviceTier: settings.controller_fast_mode === true && fast ? "priority" : null,
            notice,
        };
    }

    /** Persist a voice settings change in generated runtime configuration; true when it changed. */
    async updateRuntimeVoiceSettings(ctx: Context, update: VoiceSettingsUpdate): Promise<boolean> {
        if (!Value.Check(voiceSettingsUpdateSchema, update))
            throw new VoiceSettingsError("The voice settings are invalid.");
        return await this.#runtimeLock.runInLock(ctx, async () => {
            const current = this.#runtimeValues.voice ?? {};
            const voice: Record<string, unknown> = { ...current };
            for (const [key, value] of Object.entries(update)) {
                if (value === undefined) continue;
                if (value === null) delete voice[key];
                else voice[key] = value;
            }
            if (!Value.Check(voiceSettingsTomlSchema, voice))
                throw new VoiceSettingsError("The voice settings are invalid.");
            if (
                update.controller_provider !== undefined ||
                update.controller_model !== undefined ||
                update.controller_effort !== undefined
            ) {
                this.#validateVoiceController(this.#voiceSettingsWithRuntime(voice));
            }
            if (Value.Equal(voice, current)) return false;
            const next = structuredClone(this.#runtimeValues);
            if (Object.keys(voice).length === 0) delete next.voice;
            else next.voice = voice;
            if (!Value.Check(partialValuesSchema, next))
                throw new Error("The generated runtime configuration is invalid.");
            await writeRuntimeConfigurationFile(this.configuration.paths.runtimeConfigPath, next);
            this.#runtimeValues = next;
            return true;
        });
    }

    /** A stored controller must name a configured account that offers the model and effort. */
    #validateVoiceController(settings: VoiceSettingsToml): void {
        const providerId = this.voiceController(settings).providerId;
        const modelId = settings.controller_model ?? VOICE_CONTROLLER_DEFAULT_MODEL;
        const name = this.catalog.find((entry) => entry.id === modelId)?.name ?? modelId;
        if (
            providerId !== null &&
            this.configuration.values.providers[providerId] === undefined &&
            !this.providerIds.includes(providerId)
        )
            throw new VoiceSettingsError("The selected controller account is not configured.");
        const candidates = this.offeredModels.filter(
            (model) => model.id === modelId && model.providerId === providerId,
        );
        if (candidates.length === 0)
            throw new VoiceSettingsError(
                settings.controller_provider === undefined
                    ? `No configured account offers ${name}.`
                    : `The selected controller account does not offer ${name}.`,
            );
        const effort = settings.controller_effort;
        if (
            effort !== undefined &&
            !candidates.some((model) => model.effortLevels.some((level) => level === effort))
        )
            throw new VoiceSettingsError(`${name} does not accept ${effort} effort.`);
    }

    /**
     * Live alone requires a frozen route: smart routing must not rotate its controller account.
     * A pool chooses once, at call start: the call's own voice credential account when the pool
     * includes it, otherwise an account without a recent sign-in or usage failure.
     */
    async liveControllerRoute(voiceProviderId?: string): Promise<{
        provider: BaseProvider;
        model: AgentModel;
        effort: SessionReasoningEffort;
        serviceTier?: "priority";
        signal: AbortSignal;
    }> {
        const selection = this.voiceController();
        const effort = selection.model?.effortLevels.find((level) => level === selection.effort);
        if (selection.providerId === null || selection.model === undefined || effort === undefined)
            throw new VoiceControllerRouteError(
                selection.notice ?? "Voice cannot use the selected controller model.",
            );
        let model: AgentModel = { ...selection.model, defaultEffort: effort };
        let provider = await this.providers.resolve(model.providerId, model.id);
        if (provider instanceof RoundRobinRouterProvider) {
            const account = provider.selectAccount({
                ...(voiceProviderId === undefined ? {} : { preferred: voiceProviderId }),
                failed: (id) => this.#accountFailures.has(id) || this.#credentialFailures.has(id),
            });
            if (account === undefined)
                throw new Error("The controller account pool has no enabled account for voice.");
            model = { ...model, providerId: account };
            // Resolve through the ordinary registry so shutdown and account disablement still apply.
            provider = await this.providers.resolve(account, model.id);
        }
        if (provider === null) throw new Error("The controller account is unavailable for voice.");
        // The registry initialized enablement above. Freeze both the logical and concrete lifetimes
        // for this call without changing the concrete provider shared by unrelated sessions.
        const enablement = this.#providerEnablement!;
        const signal = AbortSignal.any([
            this.#providerLifetime.signal,
            enablement.signal(selection.providerId),
            enablement.signal(model.providerId),
        ]);
        if (signal.aborted)
            throw new Error("The controller account was disabled before voice could start.");
        return {
            provider,
            model,
            effort,
            ...(selection.serviceTier === null ? {} : { serviceTier: selection.serviceTier }),
            signal,
        };
    }

    /** Reload only the selected account from its provider-owned store, without network refresh or fallback. */
    async liveCredential(selection: LiveCredential): Promise<{
        type: LiveCredential["type"];
        token: string;
        accountId?: string;
    }> {
        const provider = await this.providers.resolve(selection.providerId, undefined);
        if (provider instanceof RoundRobinRouterProvider) throw new VoiceCredentialPoolError();
        if (!(provider instanceof CodexProvider) || provider.bedrockTransport !== undefined) {
            throw new Error("Select an enabled OpenAI account for voice.");
        }
        const endpoint = new URL(provider.endpoint);
        const native = selection.type === "codex_subscription";
        const expected = native ? "https://chatgpt.com" : "https://api.openai.com";
        if (endpoint.origin !== expected || endpoint.username || endpoint.password) {
            throw new Error(
                "Voice requires an official OpenAI account endpoint; custom endpoints are not supported.",
            );
        }
        const credential = provider.credential;
        if (native && credential.name === "codex-session") {
            const current = await credential.reloadForUnauthorized();
            if (current === undefined)
                throw new Error("Sign in to the selected Codex account again.");
            const { accessToken, accountId } = current.credential;
            if (!accessToken.trim())
                throw new Error("The selected voice account is not signed in.");
            return {
                type: selection.type,
                token: accessToken,
                ...(accountId === undefined ? {} : { accountId }),
            };
        }
        if (!native && credential.name === "codex-api-key") {
            if (!credential.credential.apiKey.trim())
                throw new Error("The selected voice account has no API key.");
            return { type: selection.type, token: credential.credential.apiKey };
        }
        throw new Error("The selected account does not hold the requested voice credential type.");
    }

    /** The current daemon-owned Tailcat setting, including live runtime mutations. */
    get tailcatEnabled(): boolean {
        return this.#tailcatEnabled;
    }

    /** Initial node identity comes only from machine config, never from P2P or a repository. */
    async initialNodeName(): Promise<string> {
        return this.configuration.values.node.name ?? (await resolveDefaultNodeName());
    }

    /** Durable node work calls this after its database intent commits. */
    async writeRuntimeNodeName(ctx: Context, name: string): Promise<void> {
        if (!Value.Check(nodeNameSchema, name)) throw new Error("The node name is invalid.");
        await this.#runtimeLock.runInLock(ctx, async () => {
            const next = structuredClone(this.#runtimeValues);
            next.node = { name };
            await writeRuntimeConfigurationFile(this.configuration.paths.runtimeConfigPath, next);
            this.#runtimeValues = next;
        });
    }

    /** The fixed loopback and remote service port selected for Tailcat. */
    get tailcatPort(): number {
        return this.configuration.values.feature.tailcat.port;
    }

    /**
     * Private files for one additional named Tailcat exposure. Each name has its own stable
     * identity key beside the default one, so its address is independent of `[feature.tailcat]`.
     */
    tailcatExposurePaths(name: string): TailcatExposurePaths {
        if (!TAILCAT_EXPOSURE_NAME_PATTERN.test(name) || name === "default") {
            throw new Error("The Tailcat exposure name is invalid.");
        }
        const home = this.configuration.paths.tailcatHome;
        return {
            addressPath: join(home, `${name}.address`),
            home,
            keyPath: join(home, `${name}.private.json`),
            portPath: join(home, `${name}.port`),
        };
    }

    /** Whether phones may pair and connect directly; machine configuration only. */
    get mobileConnectorEnabled(): boolean {
        return this.configuration.values.feature.mobileConnector.enabled;
    }

    /** The fixed loopback and remote service port of the mobile connector's own Tailcat socket. */
    get mobileConnectorPort(): number {
        return this.configuration.values.feature.mobileConnector.port;
    }

    /**
     * The Linux users this machine's work runs as, or undefined when the daemon runs it as itself.
     * `executable` is the program each user's runner starts from, as sudo is allowed to run it.
     */
    get execution():
        | {
              readonly user: string;
              readonly executable: string;
              readonly bots: Readonly<Record<string, string>>;
          }
        | undefined {
        const execution = this.configuration.values.execution;
        if (execution === undefined) return undefined;
        return {
            user: execution.user,
            executable: execution.executable ?? process.execPath,
            bots: Object.fromEntries(
                Object.entries(execution.bots).map(([botId, bot]) => [botId, bot.user]),
            ),
        };
    }

    /**
     * The runners this installation works on, and the one new folders go to. Empty when none are
     * configured, which is when this machine still runs its own work.
     */
    get runners(): {
        readonly defaultId?: string;
        readonly entries: Readonly<Record<string, RunnerConfig>>;
    } {
        const runners = this.configuration.values.runners;
        if (runners === undefined) return { entries: {} };
        return {
            ...(runners.default === undefined ? {} : { defaultId: runners.default }),
            entries: structuredClone(runners.entries),
        };
    }

    /**
     * The Telegram Bot API server every Telegram export talks to: `[telegram] api_url` in the
     * user `happy.toml`, for a self-hosted server, or Telegram's own. A project cannot set it,
     * because it decides where bot tokens are sent.
     */
    get telegramApiUrl(): string {
        return this.configuration.values.telegram?.apiUrl ?? DEFAULT_TELEGRAM_API_URL;
    }

    /** Machine-owned remote roster; callers never receive mutable configuration state. */
    get connections(): Readonly<Record<string, RemoteConnectionEntry>> {
        return structuredClone(this.#connections);
    }

    get remoteConnectionEntrySchema() {
        return remoteConnectionEntrySchema;
    }

    get peerMessaging(): PeerMessagingConfig {
        return structuredClone(this.#peerMessaging);
    }

    validatePeerMessaging(settings: PeerMessagingConfig): void {
        validatePeerMessagingConfig(settings);
    }

    async updateRuntimePeerMessaging(ctx: Context, settings: PeerMessagingConfig): Promise<void> {
        validatePeerMessagingConfig(settings);
        await this.#runtimeLock.runInLock(ctx, async () => {
            const next = structuredClone(this.#runtimeValues);
            next.peer_messaging = structuredClone(settings);
            await writeRuntimeConfigurationFile(this.configuration.paths.runtimeConfigPath, next);
            this.#runtimeValues = next;
            this.#peerMessaging = structuredClone(settings);
        });
    }

    async updateRuntimeConnection(
        ctx: Context,
        id: string,
        entry: RemoteConnectionEntry,
    ): Promise<void> {
        if (
            !Value.Check(connectionIdSchema, id) ||
            !Value.Check(remoteConnectionEntrySchema, entry)
        ) {
            throw new Error("The remote connection configuration is invalid.");
        }
        await this.#runtimeLock.runInLock(ctx, async () => {
            const connections = { ...this.#connections, [id]: structuredClone(entry) };
            if (!Value.Check(remoteConnectionsConfigSchema, connections)) {
                throw new Error("At most 100 remote connections may be configured.");
            }
            const next = structuredClone(this.#runtimeValues);
            next.connections = { ...next.connections, [id]: structuredClone(entry) };
            await writeRuntimeConfigurationFile(this.configuration.paths.runtimeConfigPath, next);
            this.#runtimeValues = next;
            this.#connections = connections;
        });
    }

    /** Whether the account is on and may be routed to. Hiding never changes this. */
    isProviderEnabled(providerId: string): boolean {
        return this.#isAccountEnabled(providerId);
    }

    /** Display-only: a hidden provider stays out of model pickers and new-subagent choices. */
    isProviderHidden(providerId: string): boolean {
        return this.configuration.values.providers[providerId]?.hidden === true;
    }

    /**
     * Display-only, like a hidden provider: an opt-in model the account's `include_models` does not
     * name stays routable for existing sessions but out of pickers and new-subagent choices.
     */
    isModelHidden(providerId: string, modelId: string): boolean {
        return this.#hiddenModelRoutes().has(modelRouteKey(providerId, modelId));
    }

    /** Scripted providers own their complete catalog, so none of their routes is opt-in. */
    #hiddenModelRoutes(): ReadonlySet<string> {
        const scripted = new Set(this.#scriptedModels()?.map((model) => model.providerId) ?? []);
        return new Set(
            agentModelCatalog(this.configuration)
                .filter((route) => route.hidden && !scripted.has(route.providerId))
                .map((route) => modelRouteKey(route.providerId, route.id)),
        );
    }

    /** Friendly account label, independent of credentials, provider type, and routing identity. */
    providerName(providerId: string): string {
        return (
            this.configuration.values.providers[providerId]?.name ??
            providerId
                .replaceAll(/[_-]+/gu, " ")
                .replaceAll(/\b\w/gu, (character) => character.toUpperCase())
        );
    }

    /** The harness running `modelId` on `providerId`: a foreign agent's, or Happy's own loop. */
    harnessOf(providerId: string, modelId: string | undefined): string {
        return (
            foreignAgentRouteForModel(this.configuration, providerId, modelId)?.harnessId ?? "happy"
        );
    }

    /** What a harness is called: its table's `name`, the built-in name, or its ID. */
    harnessName(harnessId: string): string {
        return (
            this.configuration.values.harnesses[harnessId]?.name ??
            BUILT_IN_HARNESS_NAMES[harnessId] ??
            harnessId
        );
    }

    /**
     * The quota a foreign agent with its own login reports for its account, read at most every
     * few minutes and only when an agent asks for its options. Only Antigravity reports one;
     * undefined means no reading.
     */
    async harnessUsage(providerId: string): Promise<readonly HarnessUsageWindow[] | undefined> {
        const harness = this.configuration.values.harnesses[providerId];
        if (harness?.type !== "antigravity" || !this.isProviderEnabled(providerId))
            return undefined;
        const cached = this.#harnessUsage.get(providerId);
        if (cached !== undefined && Date.now() - cached.at < HARNESS_USAGE_MAX_AGE_MS) {
            return await cached.reading;
        }
        const route = foreignAgentRoutes(this.configuration).find(
            (candidate) => candidate.providerId === providerId,
        );
        if (route === undefined) return undefined;
        // The account the agent itself signs in with: the machine's environment and its harness's.
        const reading = readAntigravityUsage({
            ...process.env,
            ...foreignAgentStart(route).env,
        }).catch(() => undefined);
        this.#harnessUsage.set(providerId, { at: Date.now(), reading });
        return await reading;
    }

    /** Whether an agent on harness `creatorId` may create sub-agents on harness `targetId`. */
    harnessAllowsSubagents(creatorId: string, targetId: string): boolean {
        return harnessAllowsSubagents(this.configuration.values.harnesses, creatorId, targetId);
    }

    /** The enabled models a picker offers, which leaves out hidden providers and models. */
    get visibleModels(): readonly AgentModel[] {
        const hidden = this.#hiddenModelRoutes();
        return this.models.filter(
            (model) =>
                !this.isProviderHidden(model.providerId) &&
                !hidden.has(modelRouteKey(model.providerId, model.id)),
        );
    }

    /**
     * The provider type every client sees for an account, such as `claude` for `claude_extra`.
     *
     * A configured account reports its own type; a smart alias, or an account only the registry
     * knows, reports the type it is compatible with. Null when no such provider exists.
     */
    providerType(providerId: string): string | null {
        const configured = this.configuration.values.providers[providerId]?.type;
        if (configured !== undefined && configured !== "smart") return configured;
        const compatibility = this.providers.typeOf(providerId);
        return compatibility === "gym" ? "codex" : compatibility;
    }

    #isAccountEnabled(providerId: string): boolean {
        return this.#providerEnabled.get(providerId) === true;
    }

    #isModelSelectable(model: AgentModel): boolean {
        if (!this.isProviderEnabled(model.providerId)) return false;
        if (this.configuration.values.providers[model.providerId]?.type !== "smart") return true;
        return (
            smartProviderRoute(this.configuration, model.providerId)
                ?.models.find((route) => route.model.id === model.id)
                ?.candidates.some((id) => this.#isAccountEnabled(id)) === true
        );
    }

    /**
     * Whether one otherwise available provider/model route may be chosen for a new subagent. A
     * hidden model is allowed only when `include_subagent_models` names it.
     */
    isSubagentModelAllowed(providerId: string, modelId: string): boolean {
        const provider = this.configuration.values.providers[providerId];
        return (
            !this.isProviderHidden(providerId) &&
            (provider?.includeSubagentModels?.includes(modelId) ??
                !this.isModelHidden(providerId, modelId)) &&
            provider?.excludeSubagentModels?.includes(modelId) !== true
        );
    }

    setProviderEnabled(providerId: string, enabled: boolean): void {
        if (!this.#providerEnabled.has(providerId)) {
            throw new Error(`Provider "${providerId}" is not configured.`);
        }
        this.#providerEnabled.set(providerId, enabled);
        if (!enabled) this.#serviceTiers.clear(providerId);
        this.#providerEnablement?.setEnabled(providerId, enabled);
    }

    /** A configuration-file setting is explicit and always outranks automatic discovery. */
    configuredProviderOverride(providerId: string): boolean | undefined {
        let explicitDefault: boolean | undefined;
        // Writing a harness table for an agent with its own login is an explicit choice.
        const harness = this.configuration.values.harnesses[providerId];
        let explicitProvider: boolean | undefined =
            harness !== undefined && isOwnLoginHarness(harness) ? harness.enabled : undefined;
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

    /** Atomically persist and publish the machine's live Tailcat enablement. */
    async updateRuntimeTailcatEnabled(ctx: Context, enabled: boolean): Promise<void> {
        await this.#runtimeLock.runInLock(ctx, async () => {
            const next = structuredClone(this.#runtimeValues);
            next.feature = {
                ...next.feature,
                tailcat: {
                    ...next.feature?.tailcat,
                    enabled,
                },
            };
            if (!Value.Check(partialValuesSchema, next)) {
                throw new Error("The generated runtime configuration is invalid.");
            }
            await writeRuntimeConfigurationFile(this.configuration.paths.runtimeConfigPath, next);
            this.#runtimeValues = next;
            this.#tailcatEnabled = enabled;
        });
    }

    /** Resolve an account without consulting direct selection, for bounded scans and verification. */
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
        if (configured.type === "smart") {
            const route = smartProviderRoute(this.configuration, providerId);
            const candidates = new Set(route?.models.flatMap((model) => model.candidates) ?? []);
            for (const candidate of candidates) {
                if ((await this.#probeConfiguredProviderCredentials(candidate)) === "available") {
                    return "available";
                }
            }
            return "missing";
        }
        return await this.#probeConfiguredProviderCredentials(providerId);
    }

    async #probeConfiguredProviderCredentials(
        providerId: string,
    ): Promise<"available" | "missing"> {
        const configured = this.configuration.values.providers[providerId];
        if (configured === undefined || configured.type === "smart") return "missing";
        if (configured.type === "bedrock") {
            return (await this.#hasLocalBedrockCredential(configured)) ? "available" : "missing";
        }
        try {
            return (await this.resolveProviderUnchecked(providerId, undefined)) === null
                ? "missing"
                : "available";
        } catch (error: unknown) {
            if (error instanceof ProviderCredentialsUnavailableError) return "missing";
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

    /**
     * Watch what ordinary work proves about each concrete account's sign-in: a provider found with
     * no credential, a vendor rejecting the credential after its own renewal failed, or a vendor
     * accepting it. Returns the function that ends the subscription.
     */
    onProviderSignIn(
        listener: (providerId: string, signIn: ProviderSignInObservation) => void,
    ): () => void {
        this.#signInListeners.add(listener);
        return () => this.#signInListeners.delete(listener);
    }

    /** Sign-in state is bookkeeping too; a listener that throws never breaks inference. */
    #reportSignIn(providerId: string, signIn: ProviderSignInObservation): void {
        for (const listener of this.#signInListeners) {
            try {
                listener(providerId, signIn);
            } catch {
                // A sign-in listener never decides whether inference continues.
            }
        }
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
        this.#serviceTiers.clear();
    }

    /** Invalidate connected clients when ephemeral account capabilities change. */
    onProviderServiceTiersChanged(listener: () => void): () => void {
        this.#serviceTierListeners.add(listener);
        return () => {
            this.#serviceTierListeners.delete(listener);
        };
    }

    /** Local eligibility guard also covers saved selections restored without an API mutation. */
    async validateProviderServiceTier(
        providerId: string,
        model: string | undefined,
        tier: string | undefined,
        provider?: BaseProvider,
    ): Promise<void> {
        if (tier !== "ultrafast") return;
        const scripted = this.#scriptedModels();
        if (scripted?.some((candidate) => candidate.providerId === providerId)) {
            if (
                scripted.some(
                    (candidate) =>
                        candidate.providerId === providerId &&
                        candidate.id === model &&
                        candidate.serviceTiers?.includes(tier),
                )
            )
                return;
            throw new Error(
                "Ultrafast is unavailable for this account and model. Choose Regular or Fast and try again.",
            );
        }
        await this.#serviceTiers.validate(providerId, model, provider);
    }

    /** Refresh only tier metadata for fixed curated routes; no model discovery or inference. */
    async refreshProviderServiceTiers(ctx: Context): Promise<void> {
        if (this.#serviceTierRefresh !== undefined) return await this.#serviceTierRefresh;
        const pass = this.#refreshProviderServiceTiers(ctx);
        this.#serviceTierRefresh = pass;
        try {
            await pass;
        } finally {
            if (this.#serviceTierRefresh === pass) this.#serviceTierRefresh = undefined;
        }
    }

    async #refreshProviderServiceTiers(ctx: Context): Promise<void> {
        const signal =
            ctx.lifetime === undefined
                ? this.#providerLifetime.signal
                : AbortSignal.any([ctx.lifetime, this.#providerLifetime.signal]);
        const models = this.offeredModels;
        await Promise.all(
            Object.entries(this.configuration.values.providers).map(async ([id, configured]) => {
                if (
                    configured.type !== "codex" ||
                    configured.apiKey !== undefined ||
                    this.#scripted !== undefined
                )
                    return;
                if (signal.aborted || !this.#isAccountEnabled(id)) {
                    this.#serviceTiers.clear(id);
                    return;
                }
                try {
                    const provider = await this.resolveProviderUnchecked(id, undefined);
                    if (!(provider instanceof CodexProvider)) {
                        this.#serviceTiers.clear(id);
                        return;
                    }
                    await this.#serviceTiers.refresh(
                        id,
                        provider,
                        models.filter((model) => model.providerId === id).map((model) => model.id),
                        signal,
                    );
                } catch {
                    this.#serviceTiers.clear(id);
                }
                if (signal.aborted || !this.#isAccountEnabled(id)) this.#serviceTiers.clear(id);
            }),
        );
    }

    /** Renew enabled Codex/Grok logins without creating a session or making an inference call. */
    async refreshProviderCredentials(ctx: Context): Promise<void> {
        await Promise.all(
            Object.entries(this.configuration.values.providers).map(async ([id, configured]) => {
                if (
                    ctx.lifetime?.aborted ||
                    this.#providerLifetime.signal.aborted ||
                    !this.#isAccountEnabled(id)
                )
                    return;
                if (configured.type !== "codex" && configured.type !== "grok") return;
                if (configured.apiKey !== undefined) return;
                try {
                    // Use exactly the same account construction, isolation, and credential precedence
                    // as inference. Scripted providers and static keys have no maintenance surface.
                    const provider = await this.resolveProviderUnchecked(id, undefined);
                    if (!this.#isAccountEnabled(id)) return;
                    const credential =
                        provider instanceof CodexProvider &&
                        provider.credential instanceof CodexSessionCredential
                            ? provider.credential
                            : provider instanceof GrokProvider &&
                                provider.credential instanceof GrokSessionCredential
                              ? provider.credential
                              : undefined;
                    if (credential === undefined) return;
                    const signal =
                        ctx.lifetime === undefined
                            ? this.#providerLifetime.signal
                            : AbortSignal.any([ctx.lifetime, this.#providerLifetime.signal]);
                    const refreshed = await credential.refreshForMaintenance({ signal });
                    if (!refreshed && !signal.aborted) {
                        ctx.log.warn(
                            `Could not refresh the sign-in for provider "${id}" in the background.`,
                        );
                    }
                } catch {
                    // Vendor diagnostics and credential-file parse failures can contain secrets.
                    // Maintenance is advisory: never disable an account or fail an agent turn here.
                    if (!ctx.lifetime?.aborted && !this.#providerLifetime.signal.aborted) {
                        ctx.log.warn(
                            `Could not refresh the sign-in for provider "${id}" in the background.`,
                        );
                    }
                }
            }),
        );
    }

    /**
     * Whether an enabled account has any source of account usage to ask. Smart aliases, Bedrock,
     * API keys, and disabled accounts have none.
     */
    hasProviderUsageSource(providerId: string): boolean {
        return (
            this.#isAccountEnabled(providerId) &&
            hasConfiguredProviderUsageSource(this.configuration.values.providers, providerId)
        );
    }

    /** Ask one configured account for its complete normalized vendor usage reading. */
    async readProviderUsage(
        ctx: Context,
        providerId: string,
        method?: ProviderUsageReadMethod,
    ): Promise<import("@slopus/happy-providers").ProviderUsage | null> {
        if (!this.#isAccountEnabled(providerId)) return null;
        return await this.readProviderUsageUnchecked(ctx, providerId, method);
    }

    /** Authenticated usage probe that bypasses enablement for explicit verification. */
    async readProviderUsageUnchecked(
        ctx: Context,
        providerId: string,
        method?: ProviderUsageReadMethod,
    ): Promise<import("@slopus/happy-providers").ProviderUsage | null> {
        return await loadConfiguredProviderUsage({
            ...(method === undefined ? {} : { method }),
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
                models: agentModels(
                    this.configuration,
                    (message) => this.#catalogNotices.push(message),
                    (id) => this.configuration.values.providers[id]?.enabled !== false,
                ),
                providers: agentProviders(
                    this.configuration,
                    undefined,
                    (id) => this.#isAccountEnabled(id),
                    (id) => this.#providerEnablement?.signal(id),
                    undefined,
                    this.#executionObservations,
                    this.#credentialFailures,
                    this.#accountFailures,
                ),
            },
            this.configuration,
        );
        return this.#resolvedScripted;
    }

    /**
     * Ask each enabled OpenAI-compatible account's `/models` endpoint about its configured models,
     * in the background. It only refines context windows, image input, and efforts; it never
     * decides which models exist. Until it answers, configuration and defaults stand.
     */
    #refreshOpenAICompatibleMetadata(ctx: Context): void {
        if (this.#scripted !== undefined) return;
        for (const [id, provider] of Object.entries(this.configuration.values.providers)) {
            if (provider.type !== "openai_compatible" || !this.isProviderEnabled(id)) continue;
            void refreshOpenAICompatibleMetadata(this.configuration, id, provider).catch(
                (error: unknown) => {
                    ctx.log.warn(
                        `Could not read model details for provider "${id}": ${error instanceof Error ? error.message : String(error)}`,
                    );
                },
            );
        }
    }

    /**
     * Ask each enabled foreign agent which models its account serves, in the background. Until
     * an agent answers, its catalog is the last answer it gave or its curated list. A daemon with
     * a test-owned catalog never starts one.
     */
    #refreshForeignAgentModels(ctx: Context): void {
        if (this.#scripted !== undefined) return;
        for (const route of foreignAgentRoutes(this.configuration)) {
            if (!this.isProviderEnabled(route.providerId)) continue;
            const id = route.providerId;
            void refreshForeignAgentModels(this.configuration, route).catch((error: unknown) => {
                ctx.log.warn(`Could not read the models of provider "${id}": ${String(error)}`);
            });
        }
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
            const scripted = this.#resolveScripted()?.providers;
            this.#sourceProviders = agentProviders(
                this.configuration,
                (usage) => this.#reportAccountUsage(usage),
                (id) => this.#isAccountEnabled(id),
                (id) => this.#providerEnablement?.signal(id),
                scripted,
                this.#executionObservations,
                this.#credentialFailures,
                this.#accountFailures,
            );
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
            await ensurePrivateDirectory(directory);
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
     * The shared secret for symmetric JWT team authentication, read from the configured
     * environment variable. `undefined` when JWT authentication does not use a secret or the
     * variable is unset. The value is never logged or exposed.
     */
    get teamJwtSecret(): Uint8Array | undefined {
        const team = this.configuration.values.feature.team;
        const key = "jwt" in team ? team.jwt?.key : undefined;
        if (key?.type !== "secret") return undefined;
        const value = this.#environmentValue(key.env);
        return value === undefined ? undefined : new TextEncoder().encode(value);
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

    /** Private data root for a locally onboarded member's mobile connection. */
    happyMobileDataDirectory(userId: string): string {
        if (!Value.Check(Type.String({ pattern: "^[a-z][a-z0-9]{1,31}$" }), userId)) {
            throw new Error("The mobile connection owner is invalid.");
        }
        return join(this.configuration.paths.agentHome, "users", userId);
    }

    /**
     * The process-level Happy settings used to find and authorize the mobile integration.
     *
     * The Happy CLI login lives in this installation's own root unless `HAPPY_HOME_DIR` names
     * another one. A daemon's root is `HAPPY_HOME_DIR` or `~/.happy`, so that is the same folder in
     * production; an installation loaded from any other root, such as a test's temporary folder,
     * must never fall back to the person's real `~/.happy` and publish to their account.
     */
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
        if (!environment.HAPPY_HOME_DIR?.trim()) {
            environment.HAPPY_HOME_DIR = this.configuration.paths.happyHome;
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

    /**
     * The folder projects cloned onto a runner live under, given that runner's home.
     *
     * The daemon's own environment describes the daemon's machine, so its overrides never move a
     * folder on a runner.
     */
    projectsHomeOn(home: string): string {
        return getManagedProjectsDirectory({}, home);
    }

    /**
     * A bot's folder on a runner with this home and platform, laid out the way this installation
     * lays out its own public folder.
     */
    botPathOn(home: string, platform: NodeJS.Platform, username: string): string {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(username)) {
            throw new Error("The bot username cannot name a folder.");
        }
        return join(home, platform === "darwin" ? "Happy" : "happy", "Bots", username);
    }

    /** A task's folder on a runner with this home and platform, laid out like bot folders. */
    taskPathOn(home: string, platform: NodeJS.Platform, folderName: string): string {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(folderName)) {
            throw new Error("The task folder name cannot name a folder.");
        }
        return join(home, platform === "darwin" ? "Happy" : "happy", "Tasks", folderName);
    }

    /** A Surface chat folder on a runner with this home and platform, laid out like task folders. */
    surfacePathOn(home: string, platform: NodeJS.Platform, surfaceId: string): string {
        if (!/^[a-z][a-z0-9]{23}$/.test(surfaceId)) {
            throw new Error("The Surface ID cannot name a folder.");
        }
        return join(home, platform === "darwin" ? "Happy" : "happy", "Surfaces", surfaceId);
    }

    /** The folder managed workspaces live under on a runner with this home and platform. */
    workspacesHomeOn(home: string, platform: NodeJS.Platform): string {
        return getManagedWorkspacesDirectory({}, home, platform);
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

    /** The actual user catalog location, home-relative when it belongs to this user's home. */
    userMcpConfigLocation(): string {
        const path = this.configuration.paths.mcpConfigPath;
        const home = this.#environmentValue("HOME")?.trim() || homedir();
        const fromHome = relative(home, path);
        return fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome)
            ? fromHome === ""
                ? "~"
                : `~${sep}${fromHome}`
            : path;
    }

    /** Read the Happy-owned MCP catalog fresh so an online reload sees edits immediately. */
    async readMcpServers(): Promise<HappyAgentConfigValues["mcpServers"]> {
        const servers = await readMcpConfigurationFile(this.configuration.paths.mcpConfigPath);
        this.#mcpServers = servers;
        return servers;
    }

    /**
     * Read the MCP catalog owned by one workspace without merging it into machine settings, from
     * the machine the workspace is on when that is not this one.
     */
    async readWorkspaceMcpServers(
        workspacePath: string,
        machine?: Compute,
    ): Promise<HappyAgentConfigValues["mcpServers"]> {
        const path = this.workspaceMcpConfigPath(workspacePath);
        if (machine === undefined) return await readMcpConfigurationFile(path);
        let text: string;
        try {
            const bytes = await machine.fs.readFileBuffer(computePermissions("full_access"), path, {
                maxBytes: MAX_CONFIG_FILE_BYTES,
            });
            text = Buffer.from(bytes).toString("utf8");
        } catch (error) {
            if (isMissingFile(error)) return mcpServersFromSource({ values: {} });
            throw new Error(
                `Could not read Happy Agent configuration '${path}'. ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
        return mcpServersFromSource(parseHappyAgentConfigToml(text));
    }

    /** The MCP catalog of a workspace or of a bot's or task's folder: `mcp.toml` at its root. */
    workspaceMcpConfigPath(workspacePath: string): string {
        if (workspacePath.length === 0 || workspacePath.length > MAX_PATH_LENGTH) {
            throw new Error("Workspace path is invalid.");
        }
        return join(resolve(workspacePath), "mcp.toml");
    }

    /**
     * Canonically add, replace, or remove one server in a folder's own catalog, on the machine the
     * folder is on when that is not this one. Like the user's catalog, the file is rewritten from
     * its parsed values, so comments in it do not survive.
     */
    async updateWorkspaceMcpServer(
        ctx: Context,
        workspacePath: string,
        name: string,
        server: HappyAgentConfigValues["mcpServers"][string] | undefined,
        machine?: Compute,
    ): Promise<HappyAgentConfigValues["mcpServers"]> {
        if (name.length === 0 || name.length > 128) throw new Error("MCP server name is invalid.");
        const path = this.workspaceMcpConfigPath(workspacePath);
        return await this.#mcpLock.runInLock(ctx, async () => {
            const current = structuredClone(
                await this.readWorkspaceMcpServers(workspacePath, machine),
            ) as Record<string, unknown>;
            if (server === undefined) delete current[name];
            else current[name] = structuredClone(server);
            if (!Value.Check(resolvedValuesSchema.properties.mcpServers, current)) {
                throw new Error("MCP server configuration is invalid.");
            }
            const servers = current as HappyAgentConfigValues["mcpServers"];
            if (machine === undefined) await writeMcpConfigurationFile(path, servers);
            else {
                await machine.fs.writeFile(
                    computePermissions("full_access"),
                    path,
                    renderMcpConfiguration(servers),
                );
            }
            return deepFreeze(current) as HappyAgentConfigValues["mcpServers"];
        });
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

/** Replace an MCP catalog file on this machine atomically after rendering its normalized values. */
async function writeMcpConfigurationFile(
    path: string,
    servers: HappyAgentConfigValues["mcpServers"],
): Promise<void> {
    const contents = renderMcpConfiguration(servers);
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
    }
}

/** One provider/model route as a set key. */
function modelRouteKey(providerId: string, modelId: string): string {
    return `${providerId}\u0000${modelId}`;
}

/** The canonical TOML for an MCP catalog, bounded like every configuration file. */
function renderMcpConfiguration(servers: HappyAgentConfigValues["mcpServers"]): string {
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
    return contents;
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
    const table = parse(source.replace(/^\uFEFF/u, ""));
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
        "skill_enablement",
        "api",
        "connections",
        "peer_messaging",
        "defaults",
        "docker",
        "runners",
        "execution",
        "feature",
        "features",
        "mcp_servers",
        "network",
        "node",
        "observation",
        "p2p",
        "permissions",
        "presence",
        "profile",
        "harnesses",
        "providers",
        "settings",
        "skills",
        "telegram",
        "theme",
        "voice",
        "workspace",
    ]);
    for (const key of Object.keys(table)) {
        if (!knownTopLevel.has(key)) recordUnknown(key);
    }
    const defaults = readDefaults(table.defaults, recordUnknown);
    const providers = readProviders(table.providers, recordUnknown);
    const harnesses = readHarnesses(table.harnesses);
    const settings = readSettings(table.settings, recordUnknown);
    const skills = readSkills(table.skills, recordUnknown);
    const features = readFeatures(table.features, recordUnknown);
    const feature = readFeature(table.feature, recordUnknown);
    const gemini = readGemini(table.gemini, recordUnknown);
    const telegram = readTelegram(table.telegram, recordUnknown);
    const workspace = readWorkspace(table.workspace, recordUnknown);
    const docker = readDocker(table.docker, recordUnknown);
    const runners = readRunners(table.runners);
    const execution = readExecution(table.execution);
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
        ...(table.skill_enablement === undefined
            ? {}
            : { skill_enablement: table.skill_enablement }),
        ...(table.node === undefined ? {} : { node: table.node }),
        ...(table.voice === undefined ? {} : { voice: table.voice }),
        ...(table.profile === undefined ? {} : { profile: table.profile }),
        ...(table.api === undefined ? {} : { api: table.api }),
        ...(table.connections === undefined ? {} : { connections: table.connections }),
        ...(table.peer_messaging === undefined ? {} : { peer_messaging: table.peer_messaging }),
        ...(runners === undefined ? {} : { runners }),
        ...(execution === undefined ? {} : { execution }),
        ...(harnesses === undefined ? {} : { harnesses }),
        ...(defaults === undefined ? {} : { defaults }),
        ...(features === undefined ? {} : { features }),
        ...(feature === undefined ? {} : { feature }),
        ...(docker === undefined ? {} : { docker }),
        ...(gemini === undefined ? {} : { gemini }),
        ...(telegram === undefined ? {} : { telegram }),
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
        ...(skills === undefined ? {} : { skills }),
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
    return mcpServersFromSource(await readConfigSource(path, "global"));
}

function mcpServersFromSource(source: {
    readonly values: PartialValues;
}): HappyAgentConfigValues["mcpServers"] {
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
        ...(values.node === undefined ? {} : { node: values.node }),
        ...(values.voice === undefined ? {} : { voice: values.voice }),
        ...(values.profile === undefined ? {} : { profile: values.profile }),
        ...(values.docker === undefined ? {} : { docker: normalizeDocker(values.docker) }),
        ...(values.defaults === undefined ? {} : { defaults: normalizeDefaults(values.defaults) }),
        ...(values.features === undefined ? {} : { features: normalizeFeatures(values.features) }),
        ...(values.feature === undefined ? {} : { feature: normalizeFeature(values.feature) }),
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
        ...(values.skills === undefined ? {} : { skills: normalizeSkills(values.skills) }),
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
    const publicHome = join(dirname(happyHome), process.platform === "darwin" ? "Happy" : "happy");
    const agentHome = join(happyHome, "agent");
    const configHome = join(publicHome, process.platform === "darwin" ? "Config" : "config");
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
        // Claude Code reads the directory it starts in. Rig runs every tool itself, so Claude Code
        // gets an empty private folder rather than wherever the daemon happened to start.
        claudeWorkingDirectory: join(agentHome, "claude-cwd"),
        configHome,
        databasePath: join(agentHome, "agent.sqlite"),
        dataVersionPath: join(agentHome, "data-version.json"),
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
        // The native skills this release ships, installed and kept current by daemon startup.
        skillsHome: join(happyHome, "skills"),
        socketPath: localAgentSocketPath(agentHome),
        tailcatAddressPath: join(agentHome, "tailcat", "address"),
        tailcatHome: join(agentHome, "tailcat"),
        tailcatKeyPath: join(agentHome, "tailcat", "default.private.json"),
        tailcatPortPath: join(agentHome, "tailcat", "port"),
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

/** How long one foreign agent's quota reading answers before it is read again. */
const HARNESS_USAGE_MAX_AGE_MS = 5 * 60_000;

/** What the built-in agents with their own login are called when their table names nothing. */
const BUILT_IN_HARNESS_NAMES: Readonly<Record<string, string>> = {
    happy: "Happy",
    claude_code: "Claude Code",
    codex_cli: "Codex CLI",
    antigravity: "Antigravity",
    opencode: "OpenCode",
};

function mergeValues(...partials: readonly PartialValues[]): HappyAgentConfigValues {
    const merged = structuredClone(DEFAULT_VALUES) as MutableResolvedValues;
    const explicitProviderEnabled = new Set<string>();
    let teamWorkOSConfigured = false;
    for (const partial of partials) {
        if (partial.profile !== undefined) merged.profile = { ...partial.profile };
        if (partial.api !== undefined) merged.api = { ...merged.api, ...partial.api };
        if (partial.connections !== undefined)
            merged.connections = { ...merged.connections, ...partial.connections };
        if (partial.peer_messaging !== undefined) {
            merged.peer_messaging = {
                ...merged.peer_messaging,
                ...partial.peer_messaging,
                peers: { ...merged.peer_messaging?.peers, ...partial.peer_messaging.peers },
            };
        }
        if (partial.runners !== undefined) {
            merged.runners = {
                ...(merged.runners?.default === undefined
                    ? {}
                    : { default: merged.runners.default }),
                ...(partial.runners.default === undefined
                    ? {}
                    : { default: partial.runners.default }),
                entries: { ...merged.runners?.entries, ...partial.runners.entries },
            };
        }
        if (partial.execution !== undefined) merged.execution = structuredClone(partial.execution);
        if (partial.docker !== undefined) merged.docker = normalizeDocker(partial.docker);
        if (partial.defaults !== undefined) {
            const defaults = normalizeDefaults(partial.defaults);
            Object.assign(merged.defaults, defaults);
            if (partial.defaults.service_tier === "default") delete merged.defaults.serviceTier;
        }
        if (partial.features !== undefined)
            Object.assign(merged.features, normalizeFeatures(partial.features));
        if (partial.feature?.codemode !== undefined) {
            Object.assign(merged.feature.codemode, partial.feature.codemode);
        }
        if (partial.feature?.mobile_connector !== undefined) {
            Object.assign(merged.feature.mobileConnector, partial.feature.mobile_connector);
        }
        if (partial.feature?.tailcat !== undefined) {
            Object.assign(merged.feature.tailcat, partial.feature.tailcat);
        }
        if (partial.feature?.team !== undefined) {
            Object.assign(merged.feature.team, normalizeTeam(partial.feature.team));
            const team = partial.feature.team;
            if (
                team.owner_workos_user_id !== undefined ||
                team.workos_client_id !== undefined ||
                team.workos_organization_id !== undefined
            ) {
                teamWorkOSConfigured = true;
            }
        }
        if (partial.gemini !== undefined)
            Object.assign(merged.gemini, normalizeGemini(partial.gemini));
        if (partial.telegram?.api_url !== undefined) {
            merged.telegram = { apiUrl: partial.telegram.api_url };
        }
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
        if (partial.node !== undefined) Object.assign(merged.node, partial.node);
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
        if (partial.harnesses !== undefined) {
            merged.harnesses = mergeHarnesses(merged.harnesses, partial.harnesses);
        }
        if (partial.settings !== undefined) {
            Object.assign(merged.settings, normalizeSettings(partial.settings));
        }
        if (partial.skills?.directories !== undefined) {
            merged.skills.directories = [
                ...new Set([...merged.skills.directories, ...partial.skills.directories]),
            ];
        }
        if (partial.theme !== undefined) Object.assign(merged.theme, partial.theme);
        if (partial.workspace !== undefined) {
            Object.assign(merged.workspace, normalizeWorkspace(partial.workspace));
        }
    }
    // An agent with its own login is offered as an account named after its harness. A generated
    // enablement the daemon stored for that account still decides whether it is on.
    for (const [id, harness] of Object.entries(merged.harnesses)) {
        if (!isOwnLoginHarness(harness)) continue;
        const existing = merged.providers[id];
        if (existing !== undefined && existing.type !== harness.type) {
            throw new Error(`Harness "${id}" has the same ID as provider "${id}".`);
        }
        const name = harness.name ?? BUILT_IN_HARNESS_NAMES[id];
        merged.providers[id] = {
            ...(name === undefined ? {} : { name }),
            ...(harness.hidden === undefined ? {} : { hidden: harness.hidden }),
            ...(harness.includeModels === undefined
                ? {}
                : { includeModels: harness.includeModels }),
            ...(harness.excludeModels === undefined
                ? {}
                : { excludeModels: harness.excludeModels }),
            ...(harness.apiKey === undefined || harness.type === "acp"
                ? {}
                : { apiKey: harness.apiKey }),
            ...(harness.args === undefined ? {} : { args: harness.args }),
            ...(harness.command === undefined ? {} : { command: harness.command }),
            ...(harness.env === undefined || harness.type !== "acp" ? {} : { env: harness.env }),
            enabled:
                explicitProviderEnabled.has(id) && existing !== undefined
                    ? existing.enabled
                    : harness.enabled,
            type: harness.type,
        } as Static<typeof providerSchema>;
        explicitProviderEnabled.add(id);
    }
    for (const [id, provider] of Object.entries(merged.providers)) {
        if (!explicitProviderEnabled.has(id)) {
            provider.enabled = merged.providerDefaultEnable;
        }
    }
    validateHarnesses(merged.harnesses, merged.providers);
    validateOpenAICompatibleProviders(merged.providers);
    assertTeamAuthentication(merged.feature.team, teamWorkOSConfigured);
    if (merged.feature.team.enabled && merged.api?.token !== undefined) {
        throw new Error("Team deployments cannot configure a standalone API token.");
    }
    if (merged.feature.team.enabled && merged.profile !== undefined) {
        throw new Error("Team deployments cannot configure a shared standalone profile.");
    }
    if (merged.runners !== undefined) merged.runners = validateRunners(merged.runners, merged);
    if (merged.execution !== undefined) validateExecution(merged);
    if (merged.peer_messaging !== undefined) validatePeerMessagingConfig(merged.peer_messaging);
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

function normalizeFeature(value: NonNullable<PartialValues["feature"]>): Record<string, unknown> {
    return {
        ...(value.codemode === undefined ? {} : { codemode: { ...value.codemode } }),
        ...(value.mobile_connector === undefined
            ? {}
            : { mobile_connector: { ...value.mobile_connector } }),
        ...(value.tailcat === undefined ? {} : { tailcat: { ...value.tailcat } }),
        ...(value.team === undefined ? {} : { team: normalizeTeam(value.team) }),
    };
}

function normalizeTeam(
    value: NonNullable<NonNullable<PartialValues["feature"]>["team"]>,
): Record<string, unknown> {
    return {
        ...(value.authentication === undefined ? {} : { authentication: value.authentication }),
        ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
        ...(value.host === undefined ? {} : { host: value.host }),
        ...(value.jwt === undefined ? {} : { jwt: resolveTeamJwtConfig(value.jwt) }),
        ...(value.members === undefined
            ? {}
            : { members: resolveTeamMembersConfig(value.members) }),
        ...(value.owner_user_id === undefined ? {} : { ownerUserId: value.owner_user_id }),
        ...(value.owner_workos_user_id === undefined
            ? {}
            : { ownerWorkOSUserId: value.owner_workos_user_id }),
        ...(value.port === undefined ? {} : { port: value.port }),
        ...(value.workos_client_id === undefined ? {} : { workosClientId: value.workos_client_id }),
        ...(value.workos_organization_id === undefined
            ? {}
            : { workosOrganizationId: value.workos_organization_id }),
    };
}

/** Each team authentication method requires its own settings and rejects the other's. */
function assertTeamAuthentication(
    team: MutableResolvedValues["feature"]["team"],
    workosConfigured: boolean,
): void {
    const jwt = "jwt" in team ? team.jwt : undefined;
    const ownerUserId = "ownerUserId" in team ? team.ownerUserId : undefined;
    if (team.authentication === "jwt") {
        if (workosConfigured) {
            throw new Error("JWT team authentication cannot also configure WorkOS settings.");
        }
        if (!team.enabled) return;
        if (jwt === undefined) {
            throw new Error("JWT team authentication requires a [feature.team.jwt] table.");
        }
        if (ownerUserId === undefined) {
            throw new Error("JWT team authentication requires feature.team.owner_user_id.");
        }
        return;
    }
    if (jwt !== undefined || ownerUserId !== undefined) {
        throw new Error(
            'feature.team.jwt and feature.team.owner_user_id require authentication = "jwt".',
        );
    }
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

/** `~` and relative entries belong to the given home; absolute entries stand as written. */
function resolveSkillDirectory(directory: string, home: string): string {
    if (directory === "~") return resolve(home);
    if (directory.startsWith("~/")) return resolve(home, directory.slice(2));
    return resolve(home, directory);
}

function normalizeSkills(value: NonNullable<PartialValues["skills"]>): Record<string, unknown> {
    return value.directories === undefined ? {} : { directories: [...value.directories] };
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
        case "openai_compatible":
            return {
                ...normalizeProviderCommon(value),
                ...(value["api_key"] === undefined ? {} : { apiKey: value["api_key"] }),
                ...(value["api_key_env"] === undefined ? {} : { apiKeyEnv: value["api_key_env"] }),
                ...(value["base_url"] === undefined
                    ? {}
                    : { baseUrl: (value["base_url"] as string).trim().replace(/\/+$/u, "") }),
                ...(value["headers"] === undefined ? {} : { headers: value["headers"] }),
                ...(value["model_metadata"] === undefined
                    ? {}
                    : { modelMetadata: value["model_metadata"] }),
                ...(value["model_overrides"] === undefined
                    ? {}
                    : {
                          modelOverrides: Object.fromEntries(
                              Object.entries(
                                  value["model_overrides"] as Record<
                                      string,
                                      Static<typeof openAICompatibleModelOverrideInputSchema>
                                  >,
                              ).map(([model, override]) => [
                                  model,
                                  {
                                      ...(override.name === undefined
                                          ? {}
                                          : { name: override.name.trim() }),
                                      ...(override.context_window === undefined
                                          ? {}
                                          : { contextWindow: override.context_window }),
                                      ...(override.auto_compact_window === undefined
                                          ? {}
                                          : { autoCompactWindow: override.auto_compact_window }),
                                      ...(override.input === undefined
                                          ? {}
                                          : { input: override.input }),
                                      ...(override.efforts === undefined
                                          ? {}
                                          : { efforts: override.efforts }),
                                      ...(override.default_effort === undefined
                                          ? {}
                                          : { defaultEffort: override.default_effort }),
                                      ...(override.request === undefined
                                          ? {}
                                          : { request: override.request }),
                                  },
                              ]),
                          ),
                      }),
                ...(value["models"] === undefined ? {} : { models: value["models"] }),
                ...(value["reasoning_field"] === undefined
                    ? {}
                    : { reasoningField: value["reasoning_field"] }),
                ...(value["request"] === undefined ? {} : { request: value["request"] }),
                type: inferred,
            };
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
        case "antigravity":
        case "opencode":
        case "acp":
            return {
                ...normalizeProviderCommon(value),
                ...(value["api_key"] === undefined ? {} : { apiKey: value["api_key"] }),
                ...(value["args"] === undefined ? {} : { args: value["args"] }),
                ...(value["command"] === undefined ? {} : { command: value["command"] }),
                ...(value["config_dir"] === undefined ? {} : { configDir: value["config_dir"] }),
                ...(value["env"] === undefined ? {} : { env: value["env"] }),
                ...(value["oauth_token"] === undefined ? {} : { oauthToken: value["oauth_token"] }),
                type: inferred,
            };
        case "smart":
            return {
                ...normalizeProviderCommon(value),
                ...(value["providers"] === undefined ? {} : { providers: value["providers"] }),
                strategy: value["strategy"] ?? "round_robin",
                type: inferred,
            };
    }
}

/**
 * An OpenAI-compatible provider is only as complete as its own table: an endpoint, a key source,
 * and at least one model. A key never sits beside a variable naming another.
 */
function validateOpenAICompatibleProviders(
    providers: Readonly<Record<string, Record<string, unknown>>>,
): void {
    for (const [id, provider] of Object.entries(providers)) {
        if (provider["type"] !== "openai_compatible") continue;
        if (typeof provider["baseUrl"] !== "string") {
            throw new Error(`Provider "${id}" must set base_url.`);
        }
        if (provider["apiKey"] !== undefined && provider["apiKeyEnv"] !== undefined) {
            throw new Error(`Provider "${id}" must set api_key or api_key_env, not both.`);
        }
        if (provider["apiKey"] === undefined && provider["apiKeyEnv"] === undefined) {
            throw new Error(`Provider "${id}" must set api_key or api_key_env.`);
        }
        const models = (provider["models"] as readonly string[] | undefined) ?? [];
        if (models.length === 0) {
            throw new Error(`Provider "${id}" must list models.`);
        }
        const overrides = (provider["modelOverrides"] ?? {}) as Record<
            string,
            { efforts?: readonly string[]; defaultEffort?: string }
        >;
        for (const [model, override] of Object.entries(overrides)) {
            if (!models.includes(model)) {
                throw new Error(
                    `providers.${id}.model_overrides names "${model}", which is not in models.`,
                );
            }
            if (
                override.defaultEffort !== undefined &&
                override.efforts !== undefined &&
                !override.efforts.includes(override.defaultEffort)
            ) {
                throw new Error(
                    `providers.${id}.model_overrides."${model}".default_effort is not one of its efforts.`,
                );
            }
        }
    }
}

function normalizeProviderCommon(value: Record<string, unknown>): Record<string, unknown> {
    return {
        ...(value["name"] === undefined ? {} : { name: (value["name"] as string).trim() }),
        ...(value["auto_enable"] === undefined ? {} : { autoEnable: value["auto_enable"] }),
        ...(value["credential_isolation"] === true ? { credentialIsolation: true } : {}),
        ...(value["enabled"] === undefined ? {} : { enabled: value["enabled"] }),
        ...(value["hidden"] === undefined ? {} : { hidden: value["hidden"] }),
        ...(value["exclude_models"] === undefined
            ? {}
            : { excludeModels: value["exclude_models"] }),
        ...(value["exclude_subagent_models"] === undefined
            ? {}
            : { excludeSubagentModels: value["exclude_subagent_models"] }),
        ...(value["include_models"] === undefined
            ? {}
            : { includeModels: value["include_models"] }),
        ...(value["include_subagent_models"] === undefined
            ? {}
            : { includeSubagentModels: value["include_subagent_models"] }),
        ...(value["p2p_share"] === undefined ? {} : { p2pShare: value["p2p_share"] }),
    };
}

/** Every `type` a provider table may set. */
const CONFIGURED_PROVIDER_TYPES = [
    "codex",
    "claude",
    "grok",
    "bedrock",
    "openai_compatible",
    "antigravity",
    "opencode",
    "acp",
    "smart",
] as const;
type ConfiguredProviderType = (typeof CONFIGURED_PROVIDER_TYPES)[number];
/** The provider types people write; agents with their own login are harnesses instead. */
const CONFIGURED_PROVIDER_TYPE_LIST = [
    "codex",
    "claude",
    "grok",
    "bedrock",
    "openai_compatible",
    "smart",
]
    .map((type) => `"${type}"`)
    .join(", ");

function inferProviderType(id: string, type: unknown): ConfiguredProviderType {
    const builtIn = ["bedrock", "claude", "codex", "grok"].includes(id)
        ? (id as "bedrock" | "claude" | "codex" | "grok")
        : undefined;
    if (type !== undefined && type !== builtIn && builtIn !== undefined) {
        throw new Error(`Built-in provider "${id}" must use type "${builtIn}".`);
    }
    if (type !== undefined && !(CONFIGURED_PROVIDER_TYPES as readonly unknown[]).includes(type)) {
        throw new Error(`Provider "${id}" has an unsupported type.`);
    }
    const inferred = (type ?? builtIn) as ConfiguredProviderType | undefined;
    if (inferred === undefined) {
        throw new Error(`Provider "${id}" must set type to ${CONFIGURED_PROVIDER_TYPE_LIST}.`);
    }
    return inferred;
}

function withoutProjectMachineSettings(values: PartialValues): PartialValues {
    const {
        skill_enablement: _skillEnablement,
        api: _api,
        // The Bot API server receives every bot token, so a checked-in file must not choose it.
        telegram: _telegram,
        connections: _connections,
        peer_messaging: _peerMessaging,
        runners: _runners,
        // Which Linux user runs this machine's work is the machine owner's decision alone: a
        // checked-in file that picked the user would pick what every command may reach.
        execution: _execution,
        docker: _docker,
        // A credential is this machine's, never a repository's: a checked-in project file must not
        // choose which Gemini account this installation's tools bill against.
        gemini: _gemini,
        // Observation is dropped along with the other machine settings, and for a sharper reason:
        // a checked-in project file that turns tracing on and names its own endpoint would send
        // this machine's traces wherever the repository asked.
        observation: _observation,
        p2p: _p2p,
        node: _node,
        // Voice settings choose an account and a prompt for this machine, never for a repository.
        voice: _voice,
        profile: _profile,
        provider_default_enable: _providerDefaultEnable,
        providers: _providers,
        // Which agent runs here, on which account, is this machine's choice.
        harnesses: _harnesses,
        // Project skill folders are relative to the project they sit in and add to the machine's
        // list rather than replacing it. Skill discovery reads them beside each project root
        // through the compute, so they never enter the merged machine configuration.
        skills: _skills,
        defaults,
        feature,
        settings,
        ...rest
    } = values;
    const { permission_mode: _permissionMode, ...projectDefaults } = defaults ?? {};
    const {
        // A repository must not open, move, or close this machine's phone connection socket.
        mobile_connector: _mobileConnector,
        tailcat: _tailcat,
        team: _team,
        ...projectFeature
    } = feature ?? {};
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
        ...(Object.keys(projectFeature).length === 0 ? {} : { feature: projectFeature }),
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
            if (section === "feature") {
                const feature = source.feature;
                if (feature?.codemode !== undefined) {
                    result["feature.codemode"] = name;
                    if (feature.codemode.enabled !== undefined) {
                        result["feature.codemode.enabled"] = name;
                    }
                    if (feature.codemode.engine !== undefined) {
                        result["feature.codemode.engine"] = name;
                    }
                }
                if (feature?.mobile_connector !== undefined) {
                    result["feature.mobileConnector"] = name;
                    if (feature.mobile_connector.enabled !== undefined) {
                        result["feature.mobileConnector.enabled"] = name;
                    }
                    if (feature.mobile_connector.port !== undefined) {
                        result["feature.mobileConnector.port"] = name;
                    }
                }
                if (feature?.tailcat !== undefined) {
                    result["feature.tailcat"] = name;
                    if (feature.tailcat.enabled !== undefined) {
                        result["feature.tailcat.enabled"] = name;
                    }
                    if (feature.tailcat.port !== undefined) {
                        result["feature.tailcat.port"] = name;
                    }
                }
                if (feature?.team !== undefined) {
                    result["feature.team"] = name;
                    if (feature.team.authentication !== undefined) {
                        result["feature.team.authentication"] = name;
                    }
                    if (feature.team.enabled !== undefined) {
                        result["feature.team.enabled"] = name;
                    }
                    if (feature.team.jwt !== undefined) {
                        result["feature.team.jwt"] = name;
                    }
                    if (feature.team.members !== undefined) {
                        result["feature.team.members"] = name;
                    }
                    if (feature.team.owner_user_id !== undefined) {
                        result["feature.team.ownerUserId"] = name;
                    }
                    if (feature.team.host !== undefined) {
                        result["feature.team.host"] = name;
                    }
                    if (feature.team.owner_workos_user_id !== undefined) {
                        result["feature.team.ownerWorkOSUserId"] = name;
                    }
                    if (feature.team.port !== undefined) {
                        result["feature.team.port"] = name;
                    }
                    if (feature.team.workos_client_id !== undefined) {
                        result["feature.team.workosClientId"] = name;
                    }
                    if (feature.team.workos_organization_id !== undefined) {
                        result["feature.team.workosOrganizationId"] = name;
                    }
                }
            }
            if (
                section === "defaults" ||
                section === "settings" ||
                section === "skills" ||
                section === "features" ||
                section === "observation" ||
                section === "profile" ||
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

function readFeature(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["feature"] {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error("feature must be a TOML table.");
    assertTableSize(value, "feature");
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === "mobile_connector") {
            if (!isTable(item)) throw new Error("feature.mobile_connector must be a TOML table.");
            assertTableSize(item, "feature.mobile_connector");
            const mobileConnector: Record<string, unknown> = {};
            for (const [connectorKey, connectorValue] of Object.entries(item)) {
                if (connectorKey !== "enabled" && connectorKey !== "port") {
                    unknown(`feature.mobile_connector.${connectorKey}`);
                    continue;
                }
                mobileConnector[connectorKey] = connectorValue;
            }
            result.mobile_connector = mobileConnector;
            continue;
        }
        if (key === "tailcat") {
            if (!isTable(item)) throw new Error("feature.tailcat must be a TOML table.");
            assertTableSize(item, "feature.tailcat");
            const tailcat: Record<string, unknown> = {};
            for (const [tailcatKey, tailcatValue] of Object.entries(item)) {
                if (tailcatKey !== "enabled" && tailcatKey !== "port") {
                    unknown(`feature.tailcat.${tailcatKey}`);
                    continue;
                }
                tailcat[tailcatKey] = tailcatValue;
            }
            result.tailcat = tailcat;
            continue;
        }
        if (key === "team") {
            if (!isTable(item)) throw new Error("feature.team must be a TOML table.");
            assertTableSize(item, "feature.team");
            const team: Record<string, unknown> = {};
            for (const [teamKey, teamValue] of Object.entries(item)) {
                if (
                    teamKey !== "authentication" &&
                    teamKey !== "enabled" &&
                    teamKey !== "host" &&
                    teamKey !== "jwt" &&
                    teamKey !== "members" &&
                    teamKey !== "owner_user_id" &&
                    teamKey !== "owner_workos_user_id" &&
                    teamKey !== "port" &&
                    teamKey !== "workos_client_id" &&
                    teamKey !== "workos_organization_id"
                ) {
                    unknown(`feature.team.${teamKey}`);
                    continue;
                }
                team[teamKey] = teamValue;
            }
            result.team = team;
            continue;
        }
        if (key !== "codemode") {
            unknown(`feature.${key}`);
            continue;
        }
        if (!isTable(item)) throw new Error("feature.codemode must be a TOML table.");
        assertTableSize(item, "feature.codemode");
        const codemode: Record<string, unknown> = {};
        for (const [codemodeKey, codemodeValue] of Object.entries(item)) {
            if (codemodeKey !== "enabled" && codemodeKey !== "engine") {
                unknown(`feature.codemode.${codemodeKey}`);
                continue;
            }
            codemode[codemodeKey] = codemodeValue;
        }
        result.codemode = codemode;
    }
    if (!Value.Check(partialValuesSchema.properties.feature!, result)) {
        throw new Error("feature contains an invalid value.");
    }
    return result as PartialValues["feature"];
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

function readTelegram(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["telegram"] {
    return readTableValues(
        value,
        "telegram",
        unknown,
        ["api_url"],
        partialValuesSchema.properties.telegram!,
    ) as PartialValues["telegram"];
}

function readSkills(
    value: TomlValue | undefined,
    unknown: (path: string) => void,
): PartialValues["skills"] {
    return readTableValues(
        value,
        "skills",
        unknown,
        ["directories"],
        skillsInputSchema,
    ) as PartialValues["skills"];
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

/**
 * `[runners]` holds the default and one table per runner. Unknown keys are refused rather than
 * reported, because a mistyped runner setting would otherwise leave a machine silently unused.
 */
function readRunners(value: TomlValue | undefined): RunnersConfig | undefined {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error("runners must be a TOML table.");
    let defaultId: string | undefined;
    const entries: Record<string, RunnerConfig> = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === "default") {
            if (typeof item !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(item)) {
                throw new Error("runners.default must name a runner.");
            }
            defaultId = item;
            continue;
        }
        if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(key)) {
            throw new Error(
                `Runner ID "${key.slice(0, 64)}" must start with a lowercase letter and use only lowercase letters, digits, "-", and "_".`,
            );
        }
        if (!isTable(item)) throw new Error(`runners.${key} must be a TOML table.`);
        for (const field of Object.keys(item)) {
            if (field !== "name" && field !== "token") {
                throw new Error(`runners.${key}.${field.slice(0, 64)} is not a runner setting.`);
            }
        }
        if (!Value.Check(runnerConfigSchema.properties.name, item.name)) {
            throw new Error(`runners.${key}.name must be 1 to 128 printable characters.`);
        }
        if (!Value.Check(runnerConfigSchema.properties.token, item.token)) {
            throw new Error(
                `runners.${key}.token must be 43 characters of letters, digits, "-", and "_".`,
            );
        }
        entries[key] = { name: item.name as string, token: item.token as string };
    }
    if (Object.keys(entries).length > MAX_RUNNERS) {
        throw new Error(`At most ${String(MAX_RUNNERS)} runners may be configured.`);
    }
    return { ...(defaultId === undefined ? {} : { default: defaultId }), entries };
}

/** The rules that span runners and the rest of the configuration. */
function validateRunners(
    runners: RunnersConfig,
    values: Static<typeof resolvedValuesSchema>,
): RunnersConfig {
    const ids = Object.keys(runners.entries);
    if (ids.length === 0) {
        if (runners.default !== undefined) {
            throw new Error(
                `runners.default names "${runners.default}", but no runner is configured.`,
            );
        }
        return runners;
    }
    if (runners.default !== undefined && runners.entries[runners.default] === undefined) {
        throw new Error(
            `runners.default names "${runners.default}", which is not a configured runner.`,
        );
    }
    if (runners.default === undefined && ids.length > 1) {
        throw new Error(
            "runners.default must name the default runner when several are configured.",
        );
    }
    const tokens = new Set<string>();
    if (values.api?.token !== undefined) tokens.add(values.api.token);
    for (const entry of Object.values(values.connections ?? {})) {
        if ("token" in entry && entry.token !== undefined) tokens.add(entry.token);
    }
    for (const [id, entry] of Object.entries(runners.entries)) {
        if (tokens.has(entry.token)) {
            throw new Error(
                `runners.${id}.token must differ from the API token, every connection token, and every other runner's token.`,
            );
        }
        tokens.add(entry.token);
    }
    return { default: runners.default ?? (ids[0] as string), entries: runners.entries };
}

/**
 * `[execution]` names the Linux user this machine's work runs as, and `[execution.bots.<botId>]`
 * gives single bots a user of their own. Unknown keys are refused rather than reported, because a
 * mistyped setting here would leave work running as a user nobody chose.
 */
function readExecution(value: TomlValue | undefined): ExecutionConfig | undefined {
    if (value === undefined) return undefined;
    if (!isTable(value)) throw new Error("execution must be a TOML table.");
    for (const key of Object.keys(value)) {
        if (key !== "user" && key !== "executable" && key !== "bots") {
            throw new Error(`execution.${key.slice(0, 64)} is not an execution setting.`);
        }
    }
    if (value.user === undefined) {
        throw new Error("execution.user must name the Linux user agent work runs as.");
    }
    const user = readExecutionUser(value.user, "execution.user");
    let executable: string | undefined;
    if (value.executable !== undefined) {
        if (!Value.Check(executionExecutableSchema, value.executable)) {
            throw new Error(
                "execution.executable must be the absolute path of the happy-agent executable.",
            );
        }
        executable = value.executable as string;
    }
    const bots: Record<string, { user: string }> = {};
    if (value.bots !== undefined) {
        if (!isTable(value.bots)) throw new Error("execution.bots must be a TOML table.");
        for (const [botId, item] of Object.entries(value.bots)) {
            if (!Value.Check(cuid2Schema, botId)) {
                throw new Error(
                    `execution.bots.${String(botId).slice(0, 64)} must be a bot ID, as list_bots shows it.`,
                );
            }
            if (!isTable(item)) throw new Error(`execution.bots.${botId} must be a TOML table.`);
            for (const field of Object.keys(item)) {
                if (field !== "user") {
                    throw new Error(
                        `execution.bots.${botId}.${field.slice(0, 64)} is not a bot execution setting.`,
                    );
                }
            }
            if (item.user === undefined) {
                throw new Error(`execution.bots.${botId}.user must name a Linux user.`);
            }
            bots[botId] = { user: readExecutionUser(item.user, `execution.bots.${botId}.user`) };
        }
        if (Object.keys(bots).length > MAX_EXECUTION_BOTS) {
            throw new Error(
                `At most ${String(MAX_EXECUTION_BOTS)} bots may have a Linux user of their own.`,
            );
        }
    }
    return { user, ...(executable === undefined ? {} : { executable }), bots };
}

function readExecutionUser(value: TomlValue, path: string): string {
    if (!Value.Check(executionUserSchema, value)) {
        throw new Error(
            `${path} must be a Linux user name: a lowercase letter or "_", then up to 31 lowercase letters, digits, "_", or "-".`,
        );
    }
    if (value === "root") {
        throw new Error(`${path} must not be root; agent work runs as an unprivileged user.`);
    }
    return value;
}

/** The rules that span the execution users and the rest of the configuration. */
function validateExecution(values: Static<typeof resolvedValuesSchema>): void {
    if (Object.keys(values.runners?.entries ?? {}).length > 0) {
        throw new Error(
            "execution applies only to work on this machine, and nothing runs here once runners are configured. Choose the user each runner runs as on its own machine instead.",
        );
    }
    if (process.platform === "win32") {
        throw new Error("execution needs sudo, which Windows does not have.");
    }
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
        const schema = (CONFIGURED_PROVIDER_TYPES as readonly unknown[]).includes(type)
            ? providerInputSchemas[type as ConfiguredProviderType]
            : undefined;
        if (schema === undefined) {
            throw new Error(`Provider "${id}" must set type to ${CONFIGURED_PROVIDER_TYPE_LIST}.`);
        }
        if (["bedrock", "claude", "codex", "grok"].includes(id) && type !== id) {
            throw new Error(`Built-in provider "${id}" must use type "${id}".`);
        }
        if (
            ["antigravity", "opencode", "acp"].includes(String(type)) &&
            Object.keys(providerValue).some(
                (key) => !["type", "enabled", "auto_enable"].includes(key),
            )
        ) {
            throw new Error(`Configure "${String(type)}" agents under [harnesses.${id}].`);
        }
        const allowed = Object.keys(schema.properties);
        const parsed = readTableValues(providerValue, `providers.${id}`, unknown, allowed, schema);
        if (
            parsed !== undefined &&
            type === "bedrock" &&
            providerValue.model_overrides !== undefined
        ) {
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
