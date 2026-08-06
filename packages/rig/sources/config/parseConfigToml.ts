import { parse, TomlDate, type TomlTable, type TomlValue } from "smol-toml";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { MAX_INFERENCE_MAX_RETRIES } from "./inferenceRetrySettings.js";

import type {
    ConfigPresenceState,
    PartialConfigProvider,
    PartialConfigDefaults,
    PartialConfigFeatures,
    PartialConfigPresence,
    PartialConfigSettings,
    PartialConfigTheme,
    PartialRigConfig,
} from "./types.js";
import { parseDateMs, parseDurationMs } from "../scheduling/parseScheduleTime.js";
import type { McpServerConfig } from "../mcp/types.js";
import { isPermissionMode, type PermissionMode } from "../permissions/index.js";
import type {
    BedrockModelOverride,
    BedrockModelOverrides,
} from "../executor/bedrock-model-overrides.js";
import type { DockerExecutionConfig, DockerMountConfig } from "../execution/index.js";
import { p2pPeerNameSchema } from "../p2p/P2pPeer.js";
import { p2pInstanceIdSchema } from "../protocol/P2pIdentityProtocol.js";
import { protectedPathsSchema } from "./configPermissions.js";

const irohRelayUrlSchema = Type.String({ pattern: "^https?://" });

/**
 * Settings the parse in progress has discarded, named the way they are written in the file.
 * Parsing is entirely synchronous, so one parse always runs to completion before the next one
 * begins and this cannot mix the keys of two files together.
 */
let droppedSettings: string[] | undefined;

export interface ParsedConfigToml {
    /** Settings Rig does not recognize, in the order they appear, such as `settings.show_useage`. */
    unknownSettings: readonly string[];
    values: PartialRigConfig;
}

export function parseConfigToml(source: string): PartialRigConfig {
    return parseConfigTomlWithUnknownSettings(source).values;
}

/**
 * Reads a configuration document, discarding every setting Rig does not recognize and naming
 * what it discarded.
 *
 * An unrecognized setting is never fatal. Configuration is read before Rig has a terminal to
 * report anything in, so refusing to parse leaves the user at a shell prompt with nothing to
 * read. Rig also writes `runtime.toml` itself, so a setting Rig has since renamed is Rig's own
 * stale output rather than a user mistake.
 */
export function parseConfigTomlWithUnknownSettings(source: string): ParsedConfigToml {
    const collected: string[] = [];
    const enclosing = droppedSettings;
    droppedSettings = collected;
    try {
        const values = parseKnownConfigToml(source);
        return { unknownSettings: collected, values };
    } finally {
        droppedSettings = enclosing;
    }
}

function parseKnownConfigToml(source: string): PartialRigConfig {
    const defaults: PartialConfigDefaults = {};
    const features: PartialConfigFeatures = {};
    const settings: PartialConfigSettings = {};
    const theme: PartialConfigTheme = {};
    const table = parse(source);
    dropUnknownKeys(table, "", [
        "defaults",
        "docker",
        "features",
        "mcp_servers",
        "network",
        "p2p",
        "permissions",
        "presence",
        "providers",
        "settings",
        "theme",
        "workspace",
    ]);
    const docker = readDockerConfig(table.docker);
    const network = readNetworkConfig(table.network);
    const p2p = readP2pConfig(table.p2p);
    const permissions = readPermissionsConfig(table.permissions);
    const presence = readPresenceConfig(table.presence);
    const defaultsTable = readTable(table.defaults, "defaults");

    if (defaultsTable !== undefined) {
        dropUnknownKeys(defaultsTable, "defaults", [
            "effort",
            "instructions",
            "model",
            "permission_mode",
            "provider",
            "service_tier",
        ]);
        const modelId = readString(defaultsTable, "model", "defaults.model");
        if (modelId !== undefined) {
            defaults.modelId = modelId;
        }

        const providerId = readString(defaultsTable, "provider", "defaults.provider");
        if (providerId !== undefined) {
            defaults.providerId = providerId;
        }

        const effort = readString(defaultsTable, "effort", "defaults.effort");
        if (effort !== undefined) {
            defaults.effort = effort;
        }

        const instructions = readString(defaultsTable, "instructions", "defaults.instructions");
        if (instructions !== undefined) {
            defaults.instructions = instructions;
        }

        const permissionMode = readPermissionMode(defaultsTable, "permission_mode");
        if (permissionMode !== undefined) defaults.permissionMode = permissionMode;

        const serviceTier = readString(defaultsTable, "service_tier", "defaults.service_tier");
        if (serviceTier === "fast") defaults.serviceTier = serviceTier;
        else if (serviceTier === "default") defaults.serviceTier = null;
        else if (serviceTier !== undefined) {
            throw new Error('defaults.service_tier must be "fast" or "default".');
        }
    }

    const themeTable = readTable(table.theme, "theme");
    if (themeTable !== undefined) {
        dropUnknownKeys(themeTable, "theme", [
            "accent",
            "brand",
            "error",
            "primary",
            "secondary",
            "success",
            "warning",
        ]);
        for (const role of [
            "accent",
            "brand",
            "error",
            "primary",
            "secondary",
            "success",
            "warning",
        ] as const) {
            const value = readString(themeTable, role, `theme.${role}`);
            if (value !== undefined) theme[role] = value;
        }
    }

    const settingsTable = readTable(table.settings, "settings");
    if (settingsTable !== undefined) {
        dropUnknownKeys(settingsTable, "settings", [
            "inference_max_retries",
            "compact_completed_turns",
            "completion_chime",
            "daemon_heap_snapshots",
            "durable_global_event_queue",
            "happy_integration",
            "show_reasoning",
            "show_usage",
        ]);
        const inferenceMaxRetries = readIntegerInRange(
            settingsTable,
            "inference_max_retries",
            "settings.inference_max_retries",
            0,
            MAX_INFERENCE_MAX_RETRIES,
        );
        if (inferenceMaxRetries !== undefined) {
            settings.inferenceMaxRetries = inferenceMaxRetries;
        }
        const compactCompletedTurns = readBoolean(
            settingsTable,
            "compact_completed_turns",
            "settings.compact_completed_turns",
        );
        if (compactCompletedTurns !== undefined) {
            settings.compactCompletedTurns = compactCompletedTurns;
        }
        const completionChime = readBoolean(
            settingsTable,
            "completion_chime",
            "settings.completion_chime",
        );
        if (completionChime !== undefined) settings.completionChime = completionChime;
        const daemonHeapSnapshots = readBoolean(
            settingsTable,
            "daemon_heap_snapshots",
            "settings.daemon_heap_snapshots",
        );
        if (daemonHeapSnapshots !== undefined) {
            settings.daemonHeapSnapshots = daemonHeapSnapshots;
        }
        const durableGlobalEventQueue = readBoolean(
            settingsTable,
            "durable_global_event_queue",
            "settings.durable_global_event_queue",
        );
        if (durableGlobalEventQueue !== undefined) {
            settings.durableGlobalEventQueue = durableGlobalEventQueue;
        }
        const happyIntegration = readBoolean(
            settingsTable,
            "happy_integration",
            "settings.happy_integration",
        );
        if (happyIntegration !== undefined) settings.happyIntegration = happyIntegration;
        const showReasoning = readBoolean(
            settingsTable,
            "show_reasoning",
            "settings.show_reasoning",
        );
        if (showReasoning !== undefined) {
            settings.showReasoning = showReasoning;
        }
        const showUsage = readBoolean(settingsTable, "show_usage", "settings.show_usage");
        if (showUsage !== undefined) settings.showUsage = showUsage;
    }

    const providerSettings = readProviders(table.providers);

    const mcpServers = readMcpServers(table.mcp_servers);
    const featuresTable = readTable(table.features, "features");
    if (featuresTable !== undefined) {
        dropUnknownKeys(featuresTable, "features", ["cross_workspace", "workflows", "workspaces"]);
        const workflows = readBoolean(featuresTable, "workflows", "features.workflows");
        if (workflows !== undefined) features.workflows = workflows;
        const workspaces = readBoolean(featuresTable, "workspaces", "features.workspaces");
        if (workspaces !== undefined) features.workspaces = workspaces;
        const crossWorkspace = readBoolean(
            featuresTable,
            "cross_workspace",
            "features.cross_workspace",
        );
        if (crossWorkspace !== undefined) features.crossWorkspace = crossWorkspace;
    }
    const workspaceTable = readTable(table.workspace, "workspace");
    const workspace =
        workspaceTable === undefined
            ? undefined
            : (() => {
                  dropUnknownKeys(workspaceTable, "workspace", ["setup_commands"]);
                  return readOptionalStringArray(
                      workspaceTable,
                      "setup_commands",
                      "setupCommands",
                      "workspace.setup_commands",
                  );
              })();

    return {
        ...(docker !== undefined ? { docker } : {}),
        ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
        ...(Object.keys(features).length > 0 ? { features } : {}),
        ...(mcpServers !== undefined ? { mcpServers } : {}),
        ...(network !== undefined ? { network } : {}),
        ...(p2p !== undefined ? { p2p } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
        ...(presence !== undefined ? { presence } : {}),
        ...(providerSettings?.defaultEnable === undefined
            ? {}
            : { providerDefaultEnable: providerSettings.defaultEnable }),
        ...(providerSettings !== undefined && Object.keys(providerSettings.providers).length > 0
            ? { providers: providerSettings.providers }
            : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(Object.keys(theme).length > 0 ? { theme } : {}),
        ...(workspace !== undefined && Object.keys(workspace).length > 0 ? { workspace } : {}),
    };
}

function readPermissionsConfig(
    value: TomlValue | undefined,
): import("./configPermissions.js").PartialConfigPermissions | undefined {
    if (value === undefined) return undefined;
    if (!isTomlTable(value)) throw new Error("permissions must be a TOML table.");
    dropUnknownKeys(value, "permissions", ["protected_paths"]);
    if (value.protected_paths === undefined) return {};
    if (!Value.Check(protectedPathsSchema, value.protected_paths)) {
        throw new Error(
            "permissions.protected_paths must be an array of workspace-relative paths.",
        );
    }
    return { protectedPaths: value.protected_paths };
}

function readP2pConfig(
    value: TomlValue | undefined,
): import("./types.js").PartialConfigP2p | undefined {
    if (value === undefined) return undefined;
    if (!isTomlTable(value)) throw new Error("p2p must be a TOML table.");
    dropUnknownKeys(value, "p2p", [
        "direct",
        "enable_direct",
        "enable_iroh",
        "enable_ssh",
        "expose_api",
        "iroh",
        "name",
        "primary_id",
        "role",
    ]);
    const directTable = readTable(value.direct, "p2p.direct");
    const direct = {
        ...(directTable === undefined
            ? {}
            : readOptionalString(directTable, "listen", "listen", "p2p.direct.listen")),
    };
    if (directTable !== undefined) {
        dropUnknownKeys(directTable, "p2p.direct", ["listen"]);
    }
    const irohTable = readTable(value.iroh, "p2p.iroh");
    const iroh = {
        ...(irohTable === undefined
            ? {}
            : readOptionalString(irohTable, "relay_url", "relayUrl", "p2p.iroh.relay_url")),
    };
    if (irohTable !== undefined) {
        dropUnknownKeys(irohTable, "p2p.iroh", ["relay_url"]);
    }
    if (iroh.relayUrl !== undefined && !Value.Check(irohRelayUrlSchema, iroh.relayUrl)) {
        throw new Error("p2p.iroh.relay_url must be an HTTP or HTTPS URL.");
    }
    const enableDirect = readBoolean(value, "enable_direct", "p2p.enable_direct");
    const enableIroh = readBoolean(value, "enable_iroh", "p2p.enable_iroh");
    const enableSsh = readBoolean(value, "enable_ssh", "p2p.enable_ssh");
    const exposeApi = readBoolean(value, "expose_api", "p2p.expose_api");
    const name = readString(value, "name", "p2p.name");
    const role = readString(value, "role", "p2p.role");
    const primaryId = readString(value, "primary_id", "p2p.primary_id");
    if (role !== undefined && role !== "primary" && role !== "secondary") {
        throw new Error('p2p.role must be "primary" or "secondary".');
    }
    if (name !== undefined && !Value.Check(p2pPeerNameSchema, name)) {
        throw new Error("p2p.name must be 1–128 printable characters.");
    }
    if (
        (role === "secondary" &&
            (primaryId === undefined || !Value.Check(p2pInstanceIdSchema, primaryId))) ||
        (role === "primary" && primaryId !== undefined) ||
        (role === undefined && primaryId !== undefined)
    ) {
        throw new Error(
            "p2p.primary_id requires p2p.role to be secondary and must be a cuid2 instance ID.",
        );
    }
    return {
        ...(Object.keys(direct).length === 0 ? {} : { direct }),
        ...(enableDirect === undefined ? {} : { enableDirect }),
        ...(enableIroh === undefined ? {} : { enableIroh }),
        ...(enableSsh === undefined ? {} : { enableSsh }),
        ...(exposeApi === undefined ? {} : { exposeApi }),
        ...(Object.keys(iroh).length === 0 ? {} : { iroh }),
        ...(name === undefined ? {} : { name }),
        ...(primaryId === undefined ? {} : { primaryId }),
        ...(role === undefined ? {} : { role }),
    };
}

function readNetworkConfig(
    value: TomlValue | undefined,
): import("./types.js").ConfigNetwork | undefined {
    if (value === undefined) return undefined;
    if (!isTomlTable(value)) throw new Error("network must be a TOML table.");
    dropUnknownKeys(value, "network", [
        "allow_local_binding",
        "allowed_domains",
        "allowed_loopback_ports",
        "allowed_ports",
        "denied_domains",
    ]);
    const network = {
        ...readOptionalBoolean(
            value,
            "allow_local_binding",
            "allowLocalBinding",
            "network.allow_local_binding",
        ),
        ...readOptionalStringArray(
            value,
            "allowed_domains",
            "allowedDomains",
            "network.allowed_domains",
        ),
        ...readOptionalPortArray(
            value,
            "allowed_loopback_ports",
            "allowedLoopbackPorts",
            "network.allowed_loopback_ports",
        ),
        ...readOptionalPortArray(value, "allowed_ports", "allowedPorts", "network.allowed_ports"),
        ...readOptionalStringArray(
            value,
            "denied_domains",
            "deniedDomains",
            "network.denied_domains",
        ),
    };
    return Object.keys(network).length === 0 ? undefined : network;
}

function readPresenceConfig(value: TomlValue | undefined): PartialConfigPresence | undefined {
    if (value === undefined) return undefined;
    if (!isTomlTable(value)) throw new Error("presence must be a TOML table.");
    dropUnknownKeys(value, "presence", ["current", "fallback", "states", "until"]);
    const statesTable = readTable(value.states, "presence.states");
    const states: Record<string, ConfigPresenceState> = {};
    for (const [id, rawState] of Object.entries(statesTable ?? {})) {
        if (!/^[a-z0-9_-]+$/u.test(id)) {
            throw new Error(
                `Presence "${id}" must be named with lowercase letters, numbers, dashes, or underscores.`,
            );
        }
        if (!isTomlTable(rawState)) {
            throw new Error(`presence.states.${id} must be a TOML table.`);
        }
        const path = `presence.states.${id}`;
        dropUnknownKeys(rawState, path, ["answer_wait", "emoji", "prompt", "title"]);
        states[id] = {
            ...readPresenceAnswerWait(rawState, path),
            ...readOptionalString(rawState, "emoji", "emoji", `${path}.emoji`),
            ...readOptionalString(rawState, "prompt", "prompt", `${path}.prompt`),
            ...readOptionalString(rawState, "title", "title", `${path}.title`),
        };
    }
    const until = value.until;
    const presence: PartialConfigPresence = {
        ...readOptionalString(value, "current", "current", "presence.current"),
        ...readOptionalString(value, "fallback", "fallback", "presence.fallback"),
        ...(Object.keys(states).length === 0 ? {} : { states }),
        ...(until === undefined ? {} : { until: readPresenceUntil(until) }),
    };
    return Object.keys(presence).length === 0 ? undefined : presence;
}

function readPresenceAnswerWait(table: TomlTable, path: string): ConfigPresenceState {
    const value = table.answer_wait;
    if (value === undefined) return {};
    if (typeof value !== "string") {
        throw new Error(
            `${path}.answer_wait must be a duration such as "15 minutes", "none", or "unlimited".`,
        );
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "unlimited" || normalized === "forever") return { answerWaitMs: null };
    if (normalized === "none" || normalized === "never") return { answerWaitMs: 0 };
    try {
        return { answerWaitMs: parseDurationMs({ duration: normalized }) };
    } catch {
        throw new Error(
            `${path}.answer_wait must be a duration such as "15 minutes", "none", or "unlimited".`,
        );
    }
}

function readPresenceUntil(value: TomlValue): number {
    if (value instanceof TomlDate) return value.getTime();
    if (typeof value === "string" || typeof value === "number") {
        try {
            return parseDateMs(value);
        } catch {
            throw new Error("presence.until must be a date.");
        }
    }
    throw new Error("presence.until must be a date.");
}

function readProviders(
    value: TomlValue | undefined,
): { defaultEnable?: boolean; providers: Record<string, PartialConfigProvider> } | undefined {
    if (value === undefined) return undefined;
    if (!isTomlTable(value)) throw new Error("providers must be a TOML table.");

    const defaultEnable = readBoolean(value, "default_enable", "providers.default_enable");
    const providers: Record<string, PartialConfigProvider> = {};
    for (const [id, rawProvider] of Object.entries(value)) {
        if (id === "default_enable") continue;
        if (!isTomlTable(rawProvider)) {
            throw new Error(`Provider "${id}" must be a TOML table.`);
        }
        const type = readProviderType(id, rawProvider);
        const enabledValue = rawProvider.enabled;
        if (enabledValue !== undefined && typeof enabledValue !== "boolean") {
            throw new Error(`providers.${id}.enabled must be a boolean.`);
        }
        const common = {
            ...(enabledValue === undefined ? {} : { enabled: enabledValue }),
            ...readOptionalStringArray(rawProvider, "exclude_models", "excludeModels"),
            ...readOptionalStringArray(rawProvider, "include_models", "includeModels"),
        };
        if (type === "codex") {
            dropUnknownKeys(rawProvider, `providers.${id}`, [
                "auth_file",
                "base_url",
                "enabled",
                "exclude_models",
                "include_models",
                "transport",
                "type",
            ]);
            const authFile = readProviderString(id, rawProvider, "auth_file");
            const baseUrl = readProviderString(id, rawProvider, "base_url");
            const transport = readProviderString(id, rawProvider, "transport");
            if (
                transport !== undefined &&
                !["auto", "sse", "websocket", "websocket-cached"].includes(transport)
            ) {
                throw new Error(
                    `providers.${id}.transport must be "auto", "sse", "websocket", or "websocket-cached".`,
                );
            }
            providers[id] = {
                ...common,
                ...(authFile === undefined ? {} : { authFile }),
                ...(baseUrl === undefined ? {} : { baseUrl }),
                ...(transport === undefined
                    ? {}
                    : {
                          transport: transport as "auto" | "sse" | "websocket" | "websocket-cached",
                      }),
                type,
            };
            continue;
        }

        if (type === "grok") {
            dropUnknownKeys(rawProvider, `providers.${id}`, [
                "auth_file",
                "base_url",
                "enabled",
                "exclude_models",
                "include_models",
                "type",
            ]);
            const authFile = readProviderString(id, rawProvider, "auth_file");
            const baseUrl = readProviderString(id, rawProvider, "base_url");
            providers[id] = {
                ...common,
                ...(authFile === undefined ? {} : { authFile }),
                ...(baseUrl === undefined ? {} : { baseUrl }),
                type,
            };
            continue;
        }

        if (type === "claude") {
            dropUnknownKeys(rawProvider, `providers.${id}`, [
                "config_dir",
                "enabled",
                "exclude_models",
                "executable",
                "include_models",
                "oauth_token",
                "type",
            ]);
            const configDir = readProviderString(id, rawProvider, "config_dir");
            const executable = readProviderString(id, rawProvider, "executable");
            const oauthToken = readProviderString(id, rawProvider, "oauth_token");
            providers[id] = {
                ...common,
                ...(configDir === undefined ? {} : { configDir }),
                ...(executable === undefined ? {} : { executable }),
                ...(oauthToken === undefined ? {} : { oauthToken }),
                type,
            };
            continue;
        }

        dropUnknownKeys(rawProvider, `providers.${id}`, [
            "bearer_token_env_var",
            "enabled",
            "exclude_models",
            "include_models",
            "model_overrides",
            "region",
            "type",
        ]);
        const bearerTokenEnvVar = readProviderString(id, rawProvider, "bearer_token_env_var");
        const modelOverrides = readBedrockModelOverrides(id, rawProvider);
        const region = readProviderString(id, rawProvider, "region");
        providers[id] = {
            ...common,
            ...(bearerTokenEnvVar === undefined ? {} : { bearerTokenEnvVar }),
            ...(modelOverrides === undefined ? {} : { modelOverrides }),
            ...(region === undefined ? {} : { region }),
            type,
        };
    }
    return {
        ...(defaultEnable === undefined ? {} : { defaultEnable }),
        providers,
    };
}

function readProviderType(id: string, table: TomlTable): "bedrock" | "claude" | "codex" | "grok" {
    const configuredType = readProviderString(id, table, "type");
    const builtInType =
        id === "bedrock" || id === "claude" || id === "codex" || id === "grok" ? id : undefined;
    if (
        configuredType !== undefined &&
        builtInType !== undefined &&
        configuredType !== builtInType
    ) {
        throw new Error(`Built-in provider "${id}" must use type "${builtInType}".`);
    }
    const type = configuredType ?? builtInType;
    if (type !== "bedrock" && type !== "claude" && type !== "codex" && type !== "grok") {
        throw new Error(
            `Provider "${id}" must set type to "codex", "claude", "grok", or "bedrock".`,
        );
    }
    return type;
}

function readProviderString(id: string, table: TomlTable, key: string): string | undefined {
    const value = table[key];
    if (value !== undefined && typeof value !== "string") {
        throw new Error(`providers.${id}.${key} must be a string.`);
    }
    return value;
}

/**
 * Records every setting in this table that Rig does not recognize. The parse then simply never
 * reads them, which leaves them out of the returned configuration.
 */
function dropUnknownKeys(table: TomlTable, path: string, keys: readonly string[]): void {
    for (const key of Object.keys(table)) {
        if (keys.includes(key)) continue;
        droppedSettings?.push(`${path.length === 0 ? "" : `${path}.`}${key}`);
    }
}

function readBedrockModelOverrides(
    providerId: string,
    table: TomlTable,
): BedrockModelOverrides | undefined {
    const value = table.model_overrides;
    if (value === undefined) return undefined;
    if (!isTomlTable(value)) {
        throw new Error(`providers.${providerId}.model_overrides must be a TOML table.`);
    }

    const overrides: Record<string, BedrockModelOverride> = {};
    for (const [modelId, rawOverride] of Object.entries(value)) {
        if (!isTomlTable(rawOverride)) {
            throw new Error(
                `providers.${providerId}.model_overrides.${modelId} must be a TOML table.`,
            );
        }
        dropUnknownKeys(rawOverride, `providers.${providerId}.model_overrides.${modelId}`, [
            "endpoint",
            "region",
            "transport",
        ]);
        const endpoint = readBedrockModelOverrideString(
            providerId,
            modelId,
            rawOverride,
            "endpoint",
        );
        const region = readBedrockModelOverrideString(providerId, modelId, rawOverride, "region");
        const transport = readBedrockModelOverrideString(
            providerId,
            modelId,
            rawOverride,
            "transport",
        );
        if (transport !== undefined && transport !== "mantle" && transport !== "runtime") {
            throw new Error(
                `providers.${providerId}.model_overrides.${modelId}.transport must be "mantle" or "runtime".`,
            );
        }
        overrides[modelId] = {
            ...(endpoint === undefined ? {} : { endpoint }),
            ...(region === undefined ? {} : { region }),
            ...(transport === undefined ? {} : { transport }),
        };
    }
    return overrides;
}

function readBedrockModelOverrideString(
    providerId: string,
    modelId: string,
    table: TomlTable,
    key: "endpoint" | "region" | "transport",
): string | undefined {
    const value = table[key];
    if (value !== undefined && typeof value !== "string") {
        throw new Error(
            `providers.${providerId}.model_overrides.${modelId}.${key} must be a string.`,
        );
    }
    return value;
}

function readDockerConfig(value: TomlValue | undefined): DockerExecutionConfig | undefined {
    if (value === undefined) return undefined;
    if (!isTomlTable(value)) throw new Error("docker must be a TOML table.");
    dropUnknownKeys(value, "docker", [
        "container",
        "env",
        "image",
        "mounts",
        "name",
        "socket_path",
        "workdir",
    ]);

    const container = readString(value, "container", "docker.container");
    const image = readString(value, "image", "docker.image");
    if ((container === undefined) === (image === undefined)) {
        throw new Error('docker must configure exactly one of "container" or "image".');
    }
    const workingDirectory = readString(value, "workdir", "docker.workdir") ?? "/workspace";
    if (!workingDirectory.startsWith("/")) {
        throw new Error("docker.workdir must be an absolute container path.");
    }
    const mounts = readDockerMounts(value.mounts);
    const environment = readOptionalStringRecord(
        value,
        "env",
        "environment",
        "docker.env",
    ).environment;
    const name = readString(value, "name", "docker.name");
    if (
        container !== undefined &&
        (environment !== undefined || mounts !== undefined || name !== undefined)
    ) {
        throw new Error("docker env, mounts, and name can only be used when docker.image is set.");
    }
    return {
        ...(container === undefined ? {} : { container }),
        ...(environment === undefined ? {} : { environment }),
        ...(image === undefined ? {} : { image }),
        ...(mounts === undefined ? {} : { mounts }),
        ...(name === undefined ? {} : { name }),
        ...readOptionalString(value, "socket_path", "socketPath", "docker.socket_path"),
        workingDirectory,
    };
}

function readDockerMounts(value: TomlValue | undefined): readonly DockerMountConfig[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("docker.mounts must be an array of tables.");
    return value.map((entry, index) => {
        if (!isTomlTable(entry)) {
            throw new Error(`docker.mounts[${index}] must be a TOML table.`);
        }
        const path = `docker.mounts[${index}]`;
        dropUnknownKeys(entry, path, ["read_only", "source", "target"]);
        const source = readString(entry, "source", `${path}.source`);
        const target = readString(entry, "target", `${path}.target`);
        if (source === undefined || target === undefined) {
            throw new Error(`docker.mounts[${index}] requires string source and target values.`);
        }
        if (!target.startsWith("/")) {
            throw new Error(`docker.mounts[${index}].target must be an absolute container path.`);
        }
        const readOnly = readBoolean(entry, "read_only", `${path}.read_only`);
        return { source, target, ...(readOnly === undefined ? {} : { readOnly }) };
    });
}

function readMcpServers(value: TomlValue | undefined): Record<string, McpServerConfig> | undefined {
    if (value === undefined) return undefined;
    if (!isTomlTable(value)) throw new Error("mcp_servers must be a TOML table.");
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, rawServer] of Object.entries(value)) {
        if (!isTomlTable(rawServer)) {
            throw new Error(`MCP server "${name}" must be a TOML table.`);
        }
        servers[name] = readMcpServer(name, rawServer);
    }
    return servers;
}

function readMcpServer(name: string, table: TomlTable): McpServerConfig {
    const path = `mcp_servers.${name}`;
    const command = readString(table, "command", `${path}.command`);
    const url = readString(table, "url", `${path}.url`);
    const transport = readString(table, "transport", `${path}.transport`);
    if (transport !== undefined && transport !== "http") {
        throw new Error(`MCP server "${name}" uses unsupported transport "${transport}".`);
    }
    if ((command === undefined) === (url === undefined)) {
        throw new Error(`MCP server "${name}" must configure either command or url.`);
    }

    const common = {
        ...readOptionalBoolean(table, "enabled", "enabled", `${path}.enabled`),
        ...readOptionalSeconds(
            table,
            "startup_timeout_sec",
            "startupTimeoutMs",
            `${path}.startup_timeout_sec`,
        ),
        ...readOptionalSeconds(
            table,
            "tool_timeout_sec",
            "toolTimeoutMs",
            `${path}.tool_timeout_sec`,
        ),
        ...readOptionalStringArray(table, "enabled_tools", "enabledTools", `${path}.enabled_tools`),
        ...readOptionalStringArray(
            table,
            "disabled_tools",
            "disabledTools",
            `${path}.disabled_tools`,
        ),
    };
    if (command !== undefined) {
        dropUnknownKeys(table, path, [
            "args",
            "command",
            "cwd",
            "disabled_tools",
            "enabled",
            "enabled_tools",
            "env",
            "startup_timeout_sec",
            "tool_timeout_sec",
        ]);
        return {
            ...common,
            ...readOptionalStringArray(table, "args", "args", `${path}.args`),
            ...readOptionalStringRecord(table, "env", "env", `${path}.env`),
            ...readOptionalString(table, "cwd", "cwd", `${path}.cwd`),
            command,
            transport: "stdio",
        };
    }
    dropUnknownKeys(table, path, [
        "bearer_token_env_var",
        "disabled_tools",
        "enabled",
        "enabled_tools",
        "http_headers",
        "oauth_client_id_env_var",
        "oauth_client_secret_env_var",
        "oauth_scopes",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "transport",
        "url",
    ]);
    return {
        ...common,
        ...readOptionalStringRecord(table, "http_headers", "headers", `${path}.http_headers`),
        ...readOptionalString(
            table,
            "bearer_token_env_var",
            "bearerTokenEnvVar",
            `${path}.bearer_token_env_var`,
        ),
        ...readOptionalString(
            table,
            "oauth_client_id_env_var",
            "oauthClientIdEnvVar",
            `${path}.oauth_client_id_env_var`,
        ),
        ...readOptionalString(
            table,
            "oauth_client_secret_env_var",
            "oauthClientSecretEnvVar",
            `${path}.oauth_client_secret_env_var`,
        ),
        ...readOptionalStringArray(table, "oauth_scopes", "oauthScopes", `${path}.oauth_scopes`),
        transport: "http",
        url: url ?? "",
    };
}

function readOptionalBoolean<TKey extends string>(
    table: TomlTable,
    key: string,
    outputKey: TKey,
    path = key,
): Partial<Record<TKey, boolean>> {
    const value = table[key];
    if (value === undefined) return {};
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
    return { [outputKey]: value } as Partial<Record<TKey, boolean>>;
}

function readOptionalSeconds<TKey extends "startupTimeoutMs" | "toolTimeoutMs">(
    table: TomlTable,
    key: string,
    outputKey: TKey,
    path = key,
): Partial<Record<TKey, number>> {
    const value = table[key];
    if (value === undefined) return {};
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${path} must be a positive number.`);
    }
    return { [outputKey]: value * 1_000 } as Partial<Record<TKey, number>>;
}

function readOptionalString<TKey extends string>(
    table: TomlTable,
    key: string,
    outputKey: TKey,
    path = key,
): Partial<Record<TKey, string>> {
    const value = readString(table, key, path);
    return value === undefined ? {} : ({ [outputKey]: value } as Partial<Record<TKey, string>>);
}

function readOptionalStringArray<TKey extends string>(
    table: TomlTable,
    key: string,
    outputKey: TKey,
    path = key,
): Partial<Record<TKey, readonly string[]>> {
    const value = table[key];
    if (value === undefined) return {};
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error(`${path} must be an array of strings.`);
    }
    return { [outputKey]: value } as unknown as Partial<Record<TKey, readonly string[]>>;
}

function readOptionalPortArray<TKey extends string>(
    table: TomlTable,
    key: string,
    outputKey: TKey,
    path = key,
): Partial<Record<TKey, readonly number[]>> {
    const value = table[key];
    if (value === undefined) return {};
    if (
        !Array.isArray(value) ||
        value.some(
            (entry) => !Number.isSafeInteger(entry) || Number(entry) < 1 || Number(entry) > 65_535,
        )
    ) {
        throw new Error(`${path} must be an array of ports between 1 and 65535.`);
    }
    return { [outputKey]: value } as unknown as Partial<Record<TKey, readonly number[]>>;
}

function readOptionalStringRecord<TKey extends string>(
    table: TomlTable,
    key: string,
    outputKey: TKey,
    path = key,
): Partial<Record<TKey, Readonly<Record<string, string>>>> {
    const value = table[key];
    if (value === undefined) return {};
    if (!isTomlTable(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
        throw new Error(`${path} must contain string values.`);
    }
    return { [outputKey]: value as Record<string, string> } as Partial<
        Record<TKey, Readonly<Record<string, string>>>
    >;
}

function readPermissionMode(table: TomlTable, key: string): PermissionMode | undefined {
    const value = table[key];
    if (value === undefined) return undefined;
    if (!isPermissionMode(value)) {
        throw new Error(
            'defaults.permission_mode must be "auto", "workspace_write", "read_only", or "full_access".',
        );
    }
    return value;
}

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !(value instanceof TomlDate)
    );
}

function readTable(value: TomlValue | undefined, path: string): TomlTable | undefined {
    if (value === undefined) return undefined;
    if (!isTomlTable(value)) throw new Error(`${path} must be a TOML table.`);
    return value;
}

function readString(table: TomlTable, key: string, path = key): string | undefined {
    const value = table[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`${path} must be a string.`);
    return value;
}

function readBoolean(table: TomlTable, key: string, path = key): boolean | undefined {
    const value = table[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
    return value;
}

function readIntegerInRange(
    table: TomlTable,
    key: string,
    path: string,
    minimum: number,
    maximum: number,
): number | undefined {
    const value = table[key];
    if (value === undefined) return undefined;
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < minimum ||
        value > maximum
    ) {
        throw new Error(`${path} must be a whole number from ${minimum} to ${maximum}.`);
    }
    return value;
}
