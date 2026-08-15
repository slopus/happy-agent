import type { PermissionMode } from "../permissions/index.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import type { ServiceTier } from "../protocol/index.js";
import type { BedrockModelOverrides } from "./bedrock-model-overrides.js";
import type { ConfigPermissions, PartialConfigPermissions } from "./configPermissions.js";
import type { P2pShare } from "../protocol/P2pCredentialProtocol.js";

export interface ConfigDefaults {
    effort?: string;
    instructions?: string;
    modelId: string;
    providerId?: string;
    permissionMode: PermissionMode;
    serviceTier?: ServiceTier;
}

export interface PartialConfigDefaults {
    effort?: string;
    instructions?: string;
    modelId?: string;
    providerId?: string;
    permissionMode?: PermissionMode;
    serviceTier?: ServiceTier | null;
}

export interface ConfigSettings {
    inferenceMaxRetries: number;
    compactCompletedTurns: boolean;
    completionChime: boolean;
    daemonHeapSnapshots: boolean;
    durableGlobalEventQueue: boolean;
    happyIntegration: boolean;
    showReasoning: boolean;
    showUsage: boolean;
    toolResultRetentionDays: number;
}

export interface PartialConfigSettings {
    inferenceMaxRetries?: number;
    compactCompletedTurns?: boolean;
    completionChime?: boolean;
    daemonHeapSnapshots?: boolean;
    durableGlobalEventQueue?: boolean;
    happyIntegration?: boolean;
    showReasoning?: boolean;
    showUsage?: boolean;
    toolResultRetentionDays?: number;
}

export interface ConfigFeatures {
    crossWorkspace: boolean;
    workflows: boolean;
    workspaces: boolean;
}

export interface PartialConfigFeatures {
    crossWorkspace?: boolean;
    workflows?: boolean;
    workspaces?: boolean;
}

export interface ConfigWorkspace {
    /** Project-root paths copied into every workspace and re-copied when the root copy changes. */
    sync: readonly string[];
    /** Synced like `sync`, and additionally protected from writing inside workspaces. */
    protectedSync: readonly string[];
    setupCommands: readonly string[];
}

export interface PartialConfigWorkspace {
    sync?: readonly string[];
    protectedSync?: readonly string[];
    setupCommands?: readonly string[];
}

export interface ConfigPresenceState {
    /** How long a question may wait for an answer. `null` waits indefinitely, `0` never waits. */
    answerWaitMs?: number | null;
    emoji?: string;
    prompt?: string;
    title?: string;
}

export interface ConfigPresence {
    /** Presence the user is in. Written back by the daemon when the user switches. */
    current?: string;
    /** Presence to fall back to when the current one expires. */
    fallback?: string;
    states: Readonly<Record<string, ConfigPresenceState>>;
    /** Expiry of the current presence, in milliseconds since the epoch. */
    until?: number;
}

export interface PartialConfigPresence {
    current?: string;
    fallback?: string;
    states?: Readonly<Record<string, ConfigPresenceState>>;
    until?: number;
}

interface ConfigProviderBase {
    /** Internal: this provider must not inherit authentication or routing from this machine. */
    credentialIsolation?: true;
    enabled: boolean;
    excludeModels?: readonly string[];
    includeModels?: readonly string[];
    p2pShare?: P2pShare;
}

export interface ConfigBedrockProvider extends ConfigProviderBase {
    bearerToken?: string;
    bearerTokenEnvVar?: string;
    modelOverrides?: BedrockModelOverrides;
    region?: string;
    /** Model that answers `bedrock_web_search`. Bedrock hosts Web Search only on its GPT models. */
    searchModelId?: string;
    type: "bedrock";
}

export interface ConfigClaudeProvider extends ConfigProviderBase {
    apiKey?: string;
    authToken?: string;
    configDir?: string;
    executable?: string;
    oauthToken?: string;
    type: "claude";
}

export interface ConfigCodexProvider extends ConfigProviderBase {
    apiKey?: string;
    authFile?: string;
    baseUrl?: string;
    transport?: "auto" | "sse" | "websocket" | "websocket-cached";
    type: "codex";
}

export interface ConfigGrokProvider extends ConfigProviderBase {
    apiKey?: string;
    authFile?: string;
    baseUrl?: string;
    type: "grok";
}

export type ConfigProvider =
    | ConfigBedrockProvider
    | ConfigClaudeProvider
    | ConfigCodexProvider
    | ConfigGrokProvider;

export type ConfigProviders = Readonly<Record<string, ConfigProvider>>;

type WithOptionalEnabled<Provider extends ConfigProvider> = Provider extends ConfigProvider
    ? Omit<Provider, "enabled"> & { enabled?: boolean }
    : never;

export type PartialConfigProvider = WithOptionalEnabled<ConfigProvider>;

export type PartialConfigProviders = Readonly<Record<string, PartialConfigProvider>>;

export interface ConfigTheme {
    accent: string;
    brand: string;
    error: string;
    primary: string;
    secondary: string;
    success: string;
    warning: string;
}

export type PartialConfigTheme = Partial<ConfigTheme>;

export interface ConfigNetwork {
    allowLocalBinding?: boolean;
    allowedDomains?: readonly string[];
    allowedLoopbackPorts?: readonly number[];
    allowedPorts?: readonly number[];
    deniedDomains?: readonly string[];
}

export interface ConfigIrohTransport {
    relayUrl?: string;
}

export type PartialConfigIrohTransport = Partial<ConfigIrohTransport>;

export interface ConfigDirectTransport {
    listen?: string;
}

export type PartialConfigDirectTransport = Partial<ConfigDirectTransport>;

export type P2pNodeRole = "primary" | "secondary";

export interface ConfigP2p {
    direct: ConfigDirectTransport;
    enableDirect: boolean;
    enableIroh: boolean;
    enableSsh: boolean;
    exposeApi: boolean;
    iroh: ConfigIrohTransport;
    name: string;
    primaryId?: string;
    role: P2pNodeRole;
}

export interface PartialConfigP2p {
    direct?: PartialConfigDirectTransport;
    enableDirect?: boolean;
    enableIroh?: boolean;
    enableSsh?: boolean;
    exposeApi?: boolean;
    iroh?: PartialConfigIrohTransport;
    name?: string;
    primaryId?: string;
    role?: P2pNodeRole;
}

export interface RigConfig {
    docker?: DockerExecutionConfig;
    defaults: ConfigDefaults;
    features: ConfigFeatures;
    mcpServers: Readonly<Record<string, McpServerConfig>>;
    network?: ConfigNetwork;
    permissions: ConfigPermissions;
    p2p: ConfigP2p;
    presence: ConfigPresence;
    providerDefaultEnable: boolean;
    providers: ConfigProviders;
    settings: ConfigSettings;
    theme: ConfigTheme;
    workspace: ConfigWorkspace;
}

export interface PartialRigConfig {
    docker?: DockerExecutionConfig;
    defaults?: PartialConfigDefaults;
    features?: PartialConfigFeatures;
    mcpServers?: Readonly<Record<string, McpServerConfig>>;
    network?: ConfigNetwork;
    permissions?: PartialConfigPermissions;
    p2p?: PartialConfigP2p;
    presence?: PartialConfigPresence;
    providerDefaultEnable?: boolean;
    providers?: PartialConfigProviders;
    settings?: PartialConfigSettings;
    theme?: PartialConfigTheme;
    workspace?: PartialConfigWorkspace;
}

export interface ConfigPaths {
    global: string;
    local: string;
    runtime: string;
}

export interface ConfigSource {
    exists: boolean;
    path: string;
    values: PartialRigConfig;
}

export interface LoadedConfig {
    config: RigConfig;
    paths: ConfigPaths;
    sources: {
        global: ConfigSource;
        local: ConfigSource;
        runtime: ConfigSource;
    };
}

export interface LoadConfigOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
}

export interface DaemonSettings {
    inferenceMaxRetries: number;
    daemonHeapSnapshots: boolean;
    durableGlobalEventQueue: boolean;
}
