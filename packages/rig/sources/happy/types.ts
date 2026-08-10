import { Type, type Static } from "@sinclair/typebox";

import type { ToolCallPresentation } from "../agent/ToolCallPresentation.js";
import type { SessionActivity } from "../protocol/index.js";
export type { HappyWorkspaceCreationResult } from "../happySpawnTiming.js";

export type HappyEncryptionVariant = "dataKey" | "legacy";

export type HappyCredentials =
    | {
          encryption: { secret: Uint8Array; type: "legacy" };
          token: string;
      }
    | {
          encryption: { machineKey: Uint8Array; publicKey: Uint8Array; type: "dataKey" };
          token: string;
      };

export interface HappyConnectionConfiguration {
    credentials: HappyCredentials;
    credentialsPath: string;
    happyHome: string;
    imported: boolean;
    machineId?: string;
    serverUrl: string;
}

export interface HappyMachineMetadata {
    capabilities: {
        newSession: boolean;
        resume: false;
        /** True only when the daemon was given a way to create managed workspaces. */
        worktrees: boolean;
    };
    cliAvailability: {
        agy: false;
        claude: false;
        codex: false;
        detectedAt: number;
        gemini: false;
        openclaw: false;
        rig: true;
    };
    client: { id: "rig"; name: "Rig"; version: string };
    defaults: {
        effort: string;
        modelId: string;
        permissionMode: "auto";
        providerId: string;
    };
    displayName: string;
    happyCliVersion: string;
    happyHomeDir: string;
    happyLibDir: string;
    homeDir: string;
    host: string;
    machineKind: "rig";
    models: HappyPublishedModel[];
    operatingModes: readonly {
        code: string;
        description: string;
        kind: HappyPermissionModeKind;
        value: string;
    }[];
    platform: string;
    providers: HappyProviderDescriptor[];
    resumeSupport: {
        detectedAt: number;
        happyAgentAuthenticated: false;
        requiresHappyAgentAuth: false;
        requiresSameMachine: true;
        rpcAvailable: false;
    };
    sessionCreation: {
        idempotencyKey: "clientRequestId";
        pendingRetryAfterMs: number;
        resultKinds: readonly ["success", "pending", "requestToApproveDirectoryCreation", "error"];
    };
    rigMetadataVersion: 1;
    rigOnly: true;
}

export interface HappyPublishedModel {
    code: string;
    contextWindow?: number;
    defaultThinkingLevel: string;
    id: string;
    name: string;
    provider: HappyProviderDescriptor;
    providerId: string;
    providerKind: string;
    providerName: string;
    serviceTiers: readonly string[];
    thinkingLevels: readonly string[];
    value: string;
}

const boundedHappySelectionSchema = Type.String({ maxLength: 256 });

export const happySpawnSessionRequestSchema = Type.Object(
    {
        agent: Type.Literal("rig"),
        approvedNewDirectoryCreation: Type.Optional(Type.Boolean()),
        clientRequestId: Type.String({ maxLength: 256, minLength: 1, pattern: "\\S" }),
        directory: Type.String({ maxLength: 32_768, minLength: 1, pattern: "\\S" }),
        effort: Type.Optional(boundedHappySelectionSchema),
        modelId: Type.Optional(boundedHappySelectionSchema),
        permissionMode: Type.Optional(boundedHappySelectionSchema),
        providerId: Type.Optional(boundedHappySelectionSchema),
        type: Type.Literal("spawn-in-directory"),
        /**
         * Asks for the session to run in a fresh managed workspace of the project at
         * `directory` rather than in the directory itself. The intentionally narrow
         * name is one portable branch/path segment and cannot be interpreted as shell.
         */
        worktree: Type.Optional(
            Type.Object(
                {
                    name: Type.String({
                        maxLength: 64,
                        minLength: 1,
                        pattern: "^[A-Za-z0-9](?:[A-Za-z0-9_-]|\\.(?=[A-Za-z0-9_-]))*$",
                    }),
                    type: Type.Literal("new"),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);
export type HappySpawnSessionRequest = Static<typeof happySpawnSessionRequestSchema>;

export const happyListWorkspacesRequestSchema = Type.Object(
    {
        directory: Type.String({ maxLength: 32_768, minLength: 1, pattern: "\\S" }),
    },
    { additionalProperties: false },
);
export type HappyListWorkspacesRequest = Static<typeof happyListWorkspacesRequestSchema>;

/** One managed workspace, in the shape Happy's worktree picker needs. */
export interface HappyWorkspaceSummary {
    id: string;
    name: string;
    path: string;
    status: string;
}

export type HappyListWorkspacesResult =
    | { type: "success"; workspaces: readonly HappyWorkspaceSummary[] }
    | { errorMessage: string; type: "error" };

export type HappySpawnSessionResult =
    | { sessionId: string; type: "success" }
    | { clientRequestId: string; retryAfterMs: number; type: "pending" }
    | { directory: string; type: "requestToApproveDirectoryCreation" }
    | { errorMessage: string; type: "error" };

export interface HappySessionMetadata {
    activity: {
        processes: { running: number };
        /** Exact current Rig activity; consumers must not infer it from a boolean. */
        session: SessionActivity;
        subagents: { queued: number; running: number; total: number };
        tasks: { completed: number; inProgress: number; pending: number; total: number };
        workflows: { running: number; total: number };
    };
    capabilities: {
        abort: boolean;
        attachments: { enabled: boolean; maxBytes: number; mediaTypes: readonly string[] };
        files: {
            browse: boolean;
            read: boolean;
            search: boolean;
            write: boolean;
        };
        modelSelection: boolean;
        permissionModeSelection: boolean;
        reasoningSelection: boolean;
        resume: boolean;
        rpcMethods: readonly string[];
        shell: boolean;
        steering: boolean;
    };
    client: { id: "rig"; name: "Rig"; version: string };
    currentModelCode: string;
    currentModelProviderId: string;
    currentOperatingModeCode: string;
    currentThoughtLevelCode?: string;
    flavor: string;
    happyHomeDir: string;
    happyLibDir: string;
    happyToolsDir: string;
    homeDir: string;
    host: string;
    hostPid: number;
    machineId?: string;
    mcpServers: readonly { name: string; status: string }[];
    models: readonly HappyPublishedModel[];
    operatingModes: readonly {
        code: string;
        description: string;
        kind: HappyPermissionModeKind;
        value: string;
    }[];
    name: string;
    os: string;
    path: string;
    model: { id: string; providerId: string };
    permissionMode: string;
    project: { id: string; kind: "home" | "regular"; name: string };
    provider: HappyProviderDescriptor;
    providers: readonly HappyProviderDescriptor[];
    reasoning: { current: string | null; levels: readonly string[] };
    rigMetadataVersion: 1;
    session: {
        modelLocked: boolean;
        permissionMode: string;
        serviceTier?: string;
        status: string;
    };
    skills: readonly string[];
    startedBy: "daemon";
    startedFromDaemon: true;
    summary: { text: string; updatedAt: number };
    thoughtLevels: readonly { code: string; value: string }[];
    tools: readonly string[];
    workspace?: { id: string; kind: "git_worktree"; name: string };
}

export interface HappyProviderDescriptor {
    id: string;
    kind: string;
    name: string;
}

export type HappyRemoteInput =
    | { kind: "echo" }
    | {
          kind: "attachment";
          mimeType?: string;
          name: string;
          ref: string;
          size: number;
      }
    | {
          kind: "text";
          meta: {
              effort?: string;
              modelId?: string;
              permissionMode?: string;
              providerId?: string;
          };
          text: string;
      };

export type HappyPermissionModeKind = "default" | "read-only" | "safe-yolo" | "yolo";

export interface HappyUsage {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    context_window?: number;
    input_tokens: number;
    output_tokens: number;
    service_tier?: string;
}

export type HappySessionEvent =
    | { t: "file"; ref: string; name: string; size: number; mimeType?: string }
    | {
          t: "failure";
          outcome: "retried" | "failed";
          reason: string;
          attempt?: number;
      }
    | { t: "service"; text: string }
    | { t: "start"; title?: string }
    | { t: "stop" }
    | { t: "text"; text: string; thinking?: boolean }
    | { t: "tool-call-end"; call: string }
    | {
          t: "tool-call-start";
          args: Record<string, unknown>;
          call: string;
          description: string;
          name: string;
          presentation?: ToolCallPresentation;
          title: string;
      }
    | {
          t: "turn-end";
          status: "cancelled" | "completed" | "failed";
          elapsedMs: number;
          reason?: "completed" | "steering" | "compaction" | "abort" | "error";
          turnElapsedMs: number;
      }
    | { t: "turn-start" };

export interface HappySessionEnvelope {
    ev: HappySessionEvent;
    id: string;
    role: "agent" | "user";
    time: number;
    turn?: string;
    usage?: HappyUsage;
}

export interface HappySessionProtocolMessage {
    content: HappySessionEnvelope;
    localId: string;
    meta: { sentFrom: "rig" };
    role: "session";
}

export interface HappyStoredCredentials {
    encryption?: { machineKey: string; publicKey: string };
    secret?: string;
    token: string;
}

export interface HappyRemoteMessage {
    content: { c: string; t: "encrypted" };
    createdAt: number;
    id: string;
    localId: string | null;
    seq: number;
    updatedAt: number;
}
