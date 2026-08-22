/** The daemon itself: its greeting, health, configuration, and debug surface. */

import { type Static, Type } from "@sinclair/typebox";

import {
    effortSchema,
    Nullable,
    permissionModeSchema,
    serviceTierSchema,
    timestampSchema,
} from "./common.js";

/**
 * The wire protocol this client was built for.
 *
 * A daemon reports its own number through `GET /v0/health`; a client that reads
 * a different one refuses to talk to that daemon.
 */
export const HAPPY_AGENT_PROTOCOL_VERSION = 22;

/** `GET /` — a greeting confirming the caller reached a Happy agent. */
export const greetingResponseSchema = Type.Object({ text: Type.String() });
export type GreetingResponse = Static<typeof greetingResponseSchema>;

/** What a daemon says about itself. */
export const daemonVersionSchema = Type.Object({
    /** The product version string, for display and diagnostics. */
    daemon: Type.String(),
    /** The wire protocol number; the client's compatibility check. */
    protocol: Type.Integer(),
});
export type DaemonVersion = Static<typeof daemonVersionSchema>;

/** A live agent still moving toward its draining edge. */
export const drainWaitingAgentSchema = Type.Object({
    /** Stable agent identity. */
    id: Type.String(),
    /** The durable Agent Base stage the agent is currently finishing. */
    stage: Type.Union([
        Type.Literal("inference"),
        Type.Literal("tools"),
        Type.Literal("compaction"),
        Type.Literal("settlement"),
    ]),
});
export type DrainWaitingAgent = Static<typeof drainWaitingAgentSchema>;

/** One runtime component whose admitted work has not finished draining. */
export const drainWaitingForSchema = Type.Object({
    /** Stable, extensible component name. */
    name: Type.String(),
    /** Exact number of operations still holding this component open. */
    count: Type.Integer({ minimum: 1 }),
    /** Bounded, ID-sorted details for an agent-system component. */
    agents: Type.Optional(Type.Array(drainWaitingAgentSchema, { maxItems: 100 })),
    /** Present only when more agents are waiting than fit in `agents`. */
    truncated: Type.Optional(Type.Literal(true)),
});
export type DrainWaitingFor = Static<typeof drainWaitingForSchema>;

/** `GET /v0/health` */
export const healthResponseSchema = Type.Object({
    /** Always `true`; a daemon that cannot answer does not answer. */
    healthy: Type.Boolean(),
    /** `false` while the agent system is still loading. */
    ready: Type.Boolean(),
    /** `true` after this daemon process has entered its sticky draining mode. */
    draining: Type.Optional(Type.Boolean()),
    /** Structured progress for components that have not reached a safe draining edge. */
    drainWaitingFor: Type.Optional(Type.Array(drainWaitingForSchema)),
    /** `true` while the daemon is completing its graceful-shutdown handlers. */
    shuttingDown: Type.Optional(Type.Boolean()),
    status: Type.Union([Type.Literal("starting"), Type.Literal("ready")]),
    version: daemonVersionSchema,
    /** Stable names of graceful-shutdown handlers that have not finished yet. */
    waitingFor: Type.Optional(Type.Array(Type.String())),
});
export type HealthResponse = Static<typeof healthResponseSchema>;

/** What a new agent gets when it names nothing. */
export const configDefaultsSchema = Type.Object({
    effort: effortSchema,
    modelId: Type.String(),
    permissionMode: permissionModeSchema,
    providerId: Type.String(),
});
export type ConfigDefaults = Static<typeof configDefaultsSchema>;

/** Which optional product areas are switched on. */
export const configFeaturesSchema = Type.Object({
    crossWorkspace: Type.Boolean(),
    workflows: Type.Boolean(),
    workspaces: Type.Boolean(),
});
export type ConfigFeatures = Static<typeof configFeaturesSchema>;

/** A configured MCP server, stripped of everything private. */
export const mcpServerConfigSchema = Type.Object({
    enabled: Type.Boolean(),
    transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
});
export type McpServerConfig = Static<typeof mcpServerConfigSchema>;

/** The sandbox network policy. */
export const networkConfigSchema = Type.Object({
    allowedDomains: Type.Array(Type.String()),
    allowedLoopbackPorts: Type.Array(Type.Integer()),
    allowedPorts: Type.Array(Type.Integer()),
    allowLocalBinding: Type.Boolean(),
    deniedDomains: Type.Array(Type.String()),
});
export type NetworkConfig = Static<typeof networkConfigSchema>;

/** Peer-to-peer identity and transports. */
export const p2pConfigSchema = Type.Object({
    enableDirect: Type.Boolean(),
    enableIroh: Type.Boolean(),
    enableSsh: Type.Boolean(),
    exposeApi: Type.Boolean(),
    name: Type.String(),
    role: Type.String(),
});
export type P2pConfig = Static<typeof p2pConfigSchema>;

/** Permission policy that applies across every project. */
export const permissionsConfigSchema = Type.Object({
    /** Project-relative paths that mutations must not touch unattended. */
    protectedPaths: Type.Array(Type.String()),
});
export type PermissionsConfig = Static<typeof permissionsConfigSchema>;

/** One presence state the person can be in. */
export const presenceStateSchema = Type.Object({
    /** How long a question waits for an answer; `null` waits indefinitely. */
    answerWaitMs: Nullable(Type.Integer()),
    emoji: Type.String(),
    /** What the model is told about the person's availability. */
    prompt: Type.String(),
    title: Type.String(),
});
export type PresenceState = Static<typeof presenceStateSchema>;

/** The person's availability states and which one is current. */
export const presenceConfigSchema = Type.Object({
    current: Type.String(),
    fallback: Type.String(),
    states: Type.Record(Type.String(), presenceStateSchema),
});
export type PresenceConfig = Static<typeof presenceConfigSchema>;

/** Everything a client needs to present a model, defined once. */
export const modelDefinitionSchema = Type.Object({
    /** Maximum measured conversation tokens accepted before provider inference must compact. */
    contextWindow: Nullable(Type.Integer({ minimum: 1 })),
    defaultEffort: effortSchema,
    efforts: Type.Array(effortSchema),
    name: Type.String(),
    /** Empty when the model has no service tiers. */
    serviceTiers: Type.Array(serviceTierSchema),
});
export type ModelDefinition = Static<typeof modelDefinitionSchema>;

/**
 * A provider's reference to a model in the top-level catalog.
 *
 * A provider serving a model with narrower capabilities than the shared
 * definition overrides just those fields.
 */
export const providerModelReferenceSchema = Type.Object({
    defaultEffort: Type.Optional(effortSchema),
    efforts: Type.Optional(Type.Array(effortSchema)),
    enabled: Type.Boolean(),
    id: Type.String(),
    name: Type.Optional(Type.String()),
    serviceTiers: Type.Optional(Type.Array(serviceTierSchema)),
});
export type ProviderModelReference = Static<typeof providerModelReferenceSchema>;

/** One configured inference provider and the models it serves. */
export const providerConfigSchema = Type.Object({
    enabled: Type.Boolean(),
    models: Type.Array(providerModelReferenceSchema),
    /** The canonical provider key: `"claude"`, `"codex"`, `"grok"`, … */
    type: Type.String(),
});
export type ProviderConfig = Static<typeof providerConfigSchema>;

/** Daemon behavior toggles and tunables. */
export const daemonSettingsSchema = Type.Object({
    compactCompletedTurns: Type.Boolean(),
    completionChime: Type.Boolean(),
    inferenceMaxRetries: Type.Integer(),
    showReasoning: Type.Boolean(),
    showUsage: Type.Boolean(),
    toolResultRetentionDays: Type.Integer(),
});
export type DaemonSettings = Static<typeof daemonSettingsSchema>;

/** Terminal color assignments. */
export const themeConfigSchema = Type.Object({
    accent: Type.String(),
    brand: Type.String(),
    error: Type.String(),
    primary: Type.String(),
    secondary: Type.String(),
    success: Type.String(),
    warning: Type.String(),
});
export type ThemeConfig = Static<typeof themeConfigSchema>;

/** Workspace lifecycle configuration. */
export const workspaceConfigSchema = Type.Object({
    keepCopiesOnArchive: Type.Boolean(),
    keepWorktreesOnArchive: Type.Boolean(),
    protectedSync: Type.Array(Type.String()),
    setupCommands: Type.Array(Type.String()),
    /** Files copied into every new workspace. */
    sync: Type.Array(Type.String()),
});
export type WorkspaceConfig = Static<typeof workspaceConfigSchema>;

/** The daemon's effective configuration, with every secret removed. */
export const daemonConfigSchema = Type.Object({
    defaults: configDefaultsSchema,
    features: configFeaturesSchema,
    mcpServers: Type.Record(Type.String(), mcpServerConfigSchema),
    /** Every model the daemon knows, keyed by model ID. */
    models: Type.Record(Type.String(), modelDefinitionSchema),
    network: networkConfigSchema,
    p2p: p2pConfigSchema,
    permissions: permissionsConfigSchema,
    presence: presenceConfigSchema,
    providers: Type.Record(Type.String(), providerConfigSchema),
    settings: daemonSettingsSchema,
    theme: themeConfigSchema,
    workspace: workspaceConfigSchema,
});
export type DaemonConfig = Static<typeof daemonConfigSchema>;

/** `GET /v0/config` */
export const configResponseSchema = Type.Object({ config: daemonConfigSchema });
export type ConfigResponse = Static<typeof configResponseSchema>;

/**
 * `PATCH /v0/config` — a runtime settings change.
 *
 * The specification validates the body against "the mutable subset" without
 * enumerating it, so the request admits a partial of any group and leaves the
 * daemon to refuse what it will not change at runtime.
 */
export const configPatchSchema = Type.Partial(
    Type.Object({
        defaults: Type.Partial(configDefaultsSchema),
        features: Type.Partial(configFeaturesSchema),
        network: Type.Partial(networkConfigSchema),
        p2p: Type.Partial(p2pConfigSchema),
        permissions: Type.Partial(permissionsConfigSchema),
        providers: Type.Record(
            Type.String(),
            Type.Object({
                /** An explicit durable override which takes precedence over provider scans. */
                enabled: Type.Boolean(),
            }),
        ),
        settings: Type.Partial(daemonSettingsSchema),
        theme: Type.Partial(themeConfigSchema),
        workspace: Type.Partial(workspaceConfigSchema),
    }),
);
export type ConfigPatch = Static<typeof configPatchSchema>;

/** What local credential discovery found during this scan. */
export const providerCredentialStatusSchema = Type.Union([
    Type.Literal("available"),
    Type.Literal("missing"),
    Type.Literal("error"),
]);
export type ProviderCredentialStatus = Static<typeof providerCredentialStatusSchema>;

/** Why a provider has its current effective enabled state. */
export const providerEnablementSchema = Type.Union([
    Type.Literal("explicit"),
    Type.Literal("scan"),
    Type.Literal("default"),
]);
export type ProviderEnablement = Static<typeof providerEnablementSchema>;

/** One provider's result from the completed system credential scan. */
export const providerScanResultSchema = Type.Object({
    credentials: providerCredentialStatusSchema,
    enabled: Type.Boolean(),
    enablement: providerEnablementSchema,
    providerId: Type.String(),
    /** Whether this or an earlier scan found the provider configured. */
    remembered: Type.Boolean(),
});
export type ProviderScanResult = Static<typeof providerScanResultSchema>;

/** `POST /v0/providers/scan` */
export const providerScanResponseSchema = Type.Object({
    completedAt: timestampSchema,
    providers: Type.Array(providerScanResultSchema),
});
export type ProviderScanResponse = Static<typeof providerScanResponseSchema>;

/** The strength of a provider verification request. */
export const providerVerificationLevelSchema = Type.Union([
    Type.Literal("credentials"),
    Type.Literal("authentication"),
    Type.Literal("inference"),
]);
export type ProviderVerificationLevel = Static<typeof providerVerificationLevelSchema>;

/** `POST /v0/providers/:providerId/verify` */
export const providerVerificationRequestSchema = Type.Object({
    level: providerVerificationLevelSchema,
});
export type ProviderVerificationRequest = Static<typeof providerVerificationRequestSchema>;

/** The outcome of a completed provider verification. */
export const providerVerificationResponseSchema = Type.Object({
    checkedAt: timestampSchema,
    /** The model used for inference verification; `null` for credential and auth-only checks. */
    modelId: Nullable(Type.String()),
    /** The check that actually ran after any authentication fallback. */
    performedLevel: providerVerificationLevelSchema,
    providerId: Type.String(),
    requestedLevel: providerVerificationLevelSchema,
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
});
export type ProviderVerificationResponse = Static<typeof providerVerificationResponseSchema>;

/** `GET` and `PUT /v0/config/instructions` */
export const instructionsResponseSchema = Type.Object({ instructions: Type.String() });
export type InstructionsResponse = Static<typeof instructionsResponseSchema>;

/** `GET` and `PUT /v0/config/security` */
export const securityPolicyResponseSchema = Type.Object({ policy: Type.String() });
export type SecurityPolicyResponse = Static<typeof securityPolicyResponseSchema>;

/** `POST /v0/drain` */
export const drainResponseSchema = Type.Object({
    /** Always `true` once the daemon has published its sticky draining mode. */
    draining: Type.Literal(true),
    /** The daemon's process ID, so a later stop can confirm the same process exited. */
    pid: Type.Integer(),
});
export type DrainResponse = Static<typeof drainResponseSchema>;

/** `POST /v0/shutdown` */
export const shutdownResponseSchema = Type.Object({
    /** The daemon's process ID, so the caller can confirm the process exited. */
    pid: Type.Integer(),
    shuttingDown: Type.Boolean(),
});
export type ShutdownResponse = Static<typeof shutdownResponseSchema>;

/** `POST /v0/debug/inspector` */
export const inspectorStartedResponseSchema = Type.Object({
    /** The devtools websocket URL a debugger attaches to. */
    inspectorUrl: Type.String(),
});
export type InspectorStartedResponse = Static<typeof inspectorStartedResponseSchema>;

/** `DELETE /v0/debug/inspector` */
export const inspectorStoppedResponseSchema = Type.Object({
    /** `false` when no inspector was running. */
    stopped: Type.Boolean(),
});
export type InspectorStoppedResponse = Static<typeof inspectorStoppedResponseSchema>;

/** `GET /v0/onboarding` */
export const onboardingStateSchema = Type.Object({
    /** Set explicitly when the person finished or dismissed onboarding. */
    completed: Type.Boolean(),
    steps: Type.Object({
        /** The profile has a name. */
        profile: Type.Object({ done: Type.Boolean() }),
        /** At least one project exists. */
        project: Type.Object({ done: Type.Boolean() }),
        /** At least one provider has working credentials. */
        providers: Type.Object({
            done: Type.Boolean(),
            signedIn: Type.Array(Type.String()),
        }),
    }),
});
export type OnboardingState = Static<typeof onboardingStateSchema>;

/** `POST /v0/onboarding/complete` */
export const onboardingCompletedResponseSchema = Type.Object({ completed: Type.Boolean() });
export type OnboardingCompletedResponse = Static<typeof onboardingCompletedResponseSchema>;
