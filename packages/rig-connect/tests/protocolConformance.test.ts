import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { happyComputeErrorSchema } from "../../happy-plugins/sources/computeTypes.js";

// The daemon's own declarations are read from source so this check needs no
// build step and no published type surface. Type-only imports preserve the
// browser bundle boundary; runtime schema imports run only in this Vitest
// conformance check.
import type * as daemon from "../../rig/sources/protocol/index.js";
import {
    CURRENT_ONBOARDING_VERSION as DAEMON_CURRENT_ONBOARDING_VERSION,
    DOCUMENT_STATE_MAX_BYTES as DAEMON_DOCUMENT_STATE_MAX_BYTES,
    DOCUMENT_UPDATE_MAX_BYTES as DAEMON_DOCUMENT_UPDATE_MAX_BYTES,
    DOCUMENT_UPDATE_PAGE_MAX_LIMIT as DAEMON_DOCUMENT_UPDATE_PAGE_MAX_LIMIT,
    DOCUMENT_UPDATE_RETENTION_MAX_BYTES as DAEMON_DOCUMENT_UPDATE_RETENTION_MAX_BYTES,
    DOCUMENT_UPDATE_RETENTION_MAX_COUNT as DAEMON_DOCUMENT_UPDATE_RETENTION_MAX_COUNT,
    PROJECT_ERROR_MAX_LENGTH as DAEMON_PROJECT_ERROR_MAX_LENGTH,
    FOLDER_ICON_MAX_LENGTH as DAEMON_FOLDER_ICON_MAX_LENGTH,
    FOLDER_NAME_MAX_LENGTH as DAEMON_FOLDER_NAME_MAX_LENGTH,
    FOLDER_TEXT_MAX_LENGTH as DAEMON_FOLDER_TEXT_MAX_LENGTH,
    createDocumentRequestSchema as daemonCreateDocumentRequestSchema,
    createFolderItemRequestSchema as daemonCreateFolderItemRequestSchema,
    createFolderRequestSchema as daemonCreateFolderRequestSchema,
    documentCreatedBySchema as daemonDocumentCreatedBySchema,
    documentErrorCodeSchema as daemonDocumentErrorCodeSchema,
    documentErrorResponseSchema as daemonDocumentErrorResponseSchema,
    documentResponseSchema as daemonDocumentResponseSchema,
    documentSchema as daemonDocumentSchema,
    documentUnreadCursorSchema as daemonDocumentUnreadCursorSchema,
    documentUpdatePageSchema as daemonDocumentUpdatePageSchema,
    documentUpdateSchema as daemonDocumentUpdateSchema,
    folderItemSchema as daemonFolderItemSchema,
    folderItemTargetSchema as daemonFolderItemTargetSchema,
    folderSchema as daemonFolderSchema,
    listDocumentUpdatesRequestSchema as daemonListDocumentUpdatesRequestSchema,
    moveFolderItemRequestSchema as daemonMoveFolderItemRequestSchema,
    moveFolderRequestSchema as daemonMoveFolderRequestSchema,
    moveSessionRequestSchema as daemonMoveSessionRequestSchema,
    onboardMurmurRequestSchema as daemonOnboardMurmurRequestSchema,
    onboardMurmurResponseSchema as daemonOnboardMurmurResponseSchema,
    onboardingStatusSchema as daemonOnboardingStatusSchema,
    sessionScopeSchema as daemonSessionScopeSchema,
    updateFolderRequestSchema as daemonUpdateFolderRequestSchema,
    writeDocumentRequestSchema as daemonWriteDocumentRequestSchema,
    discoverPluginCatalogRequestSchema as daemonDiscoverPluginCatalogRequestSchema,
    discoverPluginCatalogResponseSchema as daemonDiscoverPluginCatalogResponseSchema,
    installPluginRequestSchema as daemonInstallPluginRequestSchema,
    providerCredentialProvenanceSchema as daemonProviderCredentialProvenanceSchema,
    rigProfileSchema as daemonRigProfileSchema,
    rigCliInstallationInspectionSchema as daemonRigCliInstallationInspectionSchema,
    rigDaemonInstallationDiscoverySchema as daemonRigDaemonInstallationDiscoverySchema,
    rigDataEpochSchema as daemonRigDataEpochSchema,
    rigInitializedDataSchema as daemonRigInitializedDataSchema,
    rigInstallationDataSchema as daemonRigInstallationDataSchema,
    systemNoticePayloadSchema as daemonSystemNoticePayloadSchema,
} from "../../rig/sources/protocol/index.js";
// Presentation is owned by the agent layer rather than the protocol module, but
// it travels on the wire all the same, so it is checked the same way.
import type * as daemonAgent from "../../rig/sources/agent/index.js";
import type * as local from "@/protocol.js";
import type * as localInstallation from "@/RigInstallationInspection.js";
import {
    CURRENT_ONBOARDING_VERSION,
    DOCUMENT_STATE_MAX_BYTES,
    DOCUMENT_UPDATE_MAX_BYTES,
    DOCUMENT_UPDATE_PAGE_MAX_LIMIT,
    DOCUMENT_UPDATE_RETENTION_MAX_BYTES,
    DOCUMENT_UPDATE_RETENTION_MAX_COUNT,
    FOLDER_ICON_MAX_LENGTH,
    FOLDER_NAME_MAX_LENGTH,
    FOLDER_TEXT_MAX_LENGTH,
    PROJECT_WORKSPACE_ERROR_MAX_LENGTH,
    SERVICE_NOTICE_MESSAGE_MAX_LENGTH,
    computeServiceErrorSchema,
    createDocumentRequestSchema,
    createFolderItemRequestSchema,
    createFolderRequestSchema,
    discoverPluginCatalogRequestSchema,
    documentCreatedBySchema,
    documentErrorCodeSchema,
    documentErrorResponseSchema,
    documentResponseSchema,
    documentSchema,
    documentUnreadCursorSchema,
    documentUpdatePageSchema,
    documentUpdateSchema,
    folderSchema,
    folderItemSchema,
    folderItemTargetSchema,
    githubPluginCatalogSchema,
    installPluginRequestSchema,
    listDocumentUpdatesRequestSchema,
    moveFolderItemRequestSchema,
    moveFolderRequestSchema,
    rigProfileSchema,
    onboardMurmurRequestSchema,
    onboardMurmurResponseSchema,
    onboardingStatusSchema,
    moveSessionRequestSchema,
    projectWorkspaceSchema,
    sessionScopeSchema,
    providerCredentialProvenanceSchema,
    systemNoticePayloadSchema,
    updateFolderRequestSchema,
    writeDocumentRequestSchema,
} from "@/protocol.js";
import {
    rigCliInstallationInspectionSchema,
    rigDaemonInstallationDiscoverySchema,
    rigDataEpochSchema,
    rigInitializedDataSchema,
    rigInstallationCliDataSchema,
} from "@/RigInstallationInspection.js";

/**
 * The protocol types are declared locally so a browser bundle carries no daemon
 * code, which means nothing stops them drifting from the daemon at runtime.
 *
 * These assertions are the guard: each one fails to compile if the daemon
 * changes a shape this library reads. They are checked by `pnpm check`, so a
 * drift is a build error rather than a bug a user finds.
 */

/** Compiles only when `TValue` is assignable to `TExpected`. */
type Assignable<TExpected, TValue extends TExpected> = TValue;
type EventOf<TEvent, TType extends string> = Extract<TEvent, { type: TType }>;

type _Activity = Assignable<local.SessionActivity, daemon.SessionActivity>;
type _ActivityKind = Assignable<local.SessionActivityKind, daemon.SessionActivityKind>;
type _ActivityToolCall = Assignable<local.SessionActivityToolCall, daemon.SessionActivityToolCall>;
type _ActivityPermissionReview = Assignable<
    local.SessionActivityPermissionReview,
    daemon.SessionActivityPermissionReview
>;
type _ActivityCompaction = Assignable<
    local.SessionActivityCompaction,
    daemon.SessionActivityCompaction
>;
type _ActivityRetry = Assignable<local.SessionActivityRetry, daemon.SessionActivityRetry>;
type _Hello = Assignable<local.SessionStreamHello, daemon.SessionStreamHello>;
type _PartialMessage = Assignable<local.SessionPartialMessage, daemon.SessionPartialMessage>;
type _Git = Assignable<local.GitChangeSnapshot, daemon.GitChangeSnapshot>;
type _TokenCount = Assignable<local.SessionTokenCount, daemon.SessionTokenCount>;
type _UnreadState = Assignable<local.SessionUnreadState, daemon.SessionUnreadState>;
type _UnreadReason = Assignable<local.SessionUnreadReason, daemon.SessionUnreadReason>;
type _Event = Assignable<local.SessionEvent, daemon.SessionEvent>;
type _ServiceNotice = Assignable<local.ServiceNotice, daemon.ServiceNotice>;
type _SystemNoticePayload = Assignable<local.SystemNoticePayload, daemon.SystemNoticePayload>;
type _DaemonServiceNotice = Assignable<daemon.ServiceNotice, local.ServiceNotice>;
type _DaemonSystemNoticePayload = Assignable<daemon.SystemNoticePayload, local.SystemNoticePayload>;
type _SystemMessage = Assignable<local.SystemMessage, daemonAgent.SystemMessage>;
type _UserMessage = Assignable<local.UserMessage, daemonAgent.UserMessage>;
type _DaemonUserMessage = Assignable<daemonAgent.UserMessage, local.UserMessage>;
type _RigProfile = Assignable<local.RigProfile, daemon.RigProfile>;
type _DaemonRigProfile = Assignable<daemon.RigProfile, local.RigProfile>;
type _CreateRigProfileRequest = Assignable<
    local.CreateRigProfileRequest,
    daemon.CreateRigProfileRequest
>;
type _UpdateRigProfileRequest = Assignable<
    local.UpdateRigProfileRequest,
    daemon.UpdateRigProfileRequest
>;
type _RigProfileChangedEvent = Assignable<
    local.RigProfileChangedEvent,
    daemon.RigProfileChangedEvent
>;
type _TranscriptNotice = Assignable<local.SessionTranscriptNotice, daemon.SessionTranscriptNotice>;
type ApplicationReadEventType =
    | "session_updated"
    | "session_activity_changed"
    | "session_git_changed"
    | "session_context_changed"
    | "session_configuration_changed"
    | "permission_mode_changed"
    | "session_title_changed"
    | "session_draft_changed"
    | "secrets_changed"
    | "mcp_servers_changed"
    | "user_input_requested"
    | "user_input_resolved"
    | "tasks_changed"
    | "goal_changed"
    | "workflow_changed"
    | "subagent_changed"
    | "shell_command_started"
    | "shell_command_finished"
    | "steering_applied"
    | "message_submitted"
    | "run_started"
    | "agent_message"
    | "agent_event"
    | "provider_quota_observed"
    | "run_finished"
    | "run_error"
    | "session_reset"
    | "session_rewound";
type _ApplicationReadEvents = {
    [TType in ApplicationReadEventType]: Assignable<
        EventOf<local.InterpretedSessionEvent, TType>,
        EventOf<daemon.SessionEvent, TType>
    >;
};
type _Session = Assignable<local.ProtocolSession, daemon.ProtocolSession>;
type _ProviderCredentialProvenance = Assignable<
    local.ProviderCredentialProvenance,
    daemon.ProviderCredentialProvenance
>;
type _DaemonProviderCredentialProvenance = Assignable<
    daemon.ProviderCredentialProvenance,
    local.ProviderCredentialProvenance
>;
type _TranscriptWindow = Assignable<local.SessionTranscriptWindow, daemon.SessionTranscriptWindow>;
type _TranscriptTurn = Assignable<local.SessionTranscriptTurn, daemon.SessionTranscriptTurn>;
type _GlobalHello = Assignable<local.GlobalStreamHello, daemon.GlobalStreamHello>;
type _Project = Assignable<local.Project, daemon.Project>;
type _ProjectRegistrationErrorCode = Assignable<
    local.ProjectRegistrationErrorCode,
    daemon.ProjectRegistrationErrorCode
>;
type _Workspace = Assignable<local.ProjectWorkspace, daemon.ProjectWorkspace>;
type _WorkspaceExact = Assignable<daemon.ProjectWorkspace, local.ProjectWorkspace>;
type _WorkspaceErrorMaxLength = Assignable<
    typeof PROJECT_WORKSPACE_ERROR_MAX_LENGTH,
    typeof DAEMON_PROJECT_ERROR_MAX_LENGTH
>;
type _SessionSummary = Assignable<local.SessionSummary, daemon.SessionSummary>;
type _GlobalEvent = Assignable<local.GlobalEvent, daemon.GlobalEvent>;
type _OnboardingStatus = Assignable<local.OnboardingStatus, daemon.OnboardingStatus>;
type _DaemonOnboardingStatus = Assignable<daemon.OnboardingStatus, local.OnboardingStatus>;
type _OnboardMurmurRequest = Assignable<local.OnboardMurmurRequest, daemon.OnboardMurmurRequest>;
type _DaemonOnboardMurmurRequest = Assignable<
    daemon.OnboardMurmurRequest,
    local.OnboardMurmurRequest
>;
type _OnboardMurmurResponse = Assignable<local.OnboardMurmurResponse, daemon.OnboardMurmurResponse>;
type _DaemonOnboardMurmurResponse = Assignable<
    daemon.OnboardMurmurResponse,
    local.OnboardMurmurResponse
>;
type _Folder = Assignable<local.Folder, daemon.Folder>;
type _FolderExact = Assignable<daemon.Folder, local.Folder>;
type _FolderItem = Assignable<local.FolderItem, daemon.FolderItem>;
type _FolderItemExact = Assignable<daemon.FolderItem, local.FolderItem>;
type _FolderItemTarget = Assignable<local.FolderItemTarget, daemon.FolderItemTarget>;
type _FolderItemTargetExact = Assignable<daemon.FolderItemTarget, local.FolderItemTarget>;
type _FolderItemResponse = Assignable<local.FolderItemResponse, daemon.FolderItemResponse>;
type _FolderEvent = Assignable<local.FolderEvent, daemon.FolderEvent>;
type _FolderErrorCode = Assignable<local.FolderErrorCode, daemon.FolderErrorCode>;
type _FolderErrorResponse = Assignable<local.FolderErrorResponse, daemon.FolderErrorResponse>;
type _ListFoldersResponse = Assignable<local.ListFoldersResponse, daemon.ListFoldersResponse>;
type _FolderResponse = Assignable<local.FolderResponse, daemon.FolderResponse>;
// The other direction too: a request this library sends must be one the daemon accepts.
type _CreateFolderRequest = Assignable<daemon.CreateFolderRequest, local.CreateFolderRequest>;
type _CreateFolderItemRequest = Assignable<
    daemon.CreateFolderItemRequest,
    local.CreateFolderItemRequest
>;
type _UpdateFolderRequest = Assignable<daemon.UpdateFolderRequest, local.UpdateFolderRequest>;
type _MoveFolderRequest = Assignable<daemon.MoveFolderRequest, local.MoveFolderRequest>;
type _MoveFolderItemRequest = Assignable<daemon.MoveFolderItemRequest, local.MoveFolderItemRequest>;
type _Document = Assignable<local.Document, daemon.Document>;
type _DocumentExact = Assignable<daemon.Document, local.Document>;
type _DocumentCreatedBy = Assignable<local.DocumentCreatedBy, daemon.DocumentCreatedBy>;
type _DocumentCreatedByExact = Assignable<daemon.DocumentCreatedBy, local.DocumentCreatedBy>;
type _DocumentUpdate = Assignable<local.DocumentUpdate, daemon.DocumentUpdate>;
type _DocumentUpdateExact = Assignable<daemon.DocumentUpdate, local.DocumentUpdate>;
type _DocumentUpdatePage = Assignable<local.DocumentUpdatePage, daemon.DocumentUpdatePage>;
type _DocumentUpdatePageExact = Assignable<daemon.DocumentUpdatePage, local.DocumentUpdatePage>;
type _DocumentResponse = Assignable<local.DocumentResponse, daemon.DocumentResponse>;
type _DocumentErrorResponse = Assignable<local.DocumentErrorResponse, daemon.DocumentErrorResponse>;
type _DocumentEvent = Assignable<local.DocumentEvent, daemon.DocumentEvent>;
type _CreateDocumentRequest = Assignable<daemon.CreateDocumentRequest, local.CreateDocumentRequest>;
type _WriteDocumentRequest = Assignable<daemon.WriteDocumentRequest, local.WriteDocumentRequest>;
type _ListDocumentUpdatesRequest = Assignable<
    daemon.ListDocumentUpdatesRequest,
    local.ListDocumentUpdatesRequest
>;
type _SessionScope = Assignable<local.SessionScope, daemon.SessionScope>;
type _HappyCloudStatus = Assignable<local.HappyCloudStatus, daemon.HappyCloudStatus>;
type _HappyCloudChangedEvent = Assignable<
    local.HappyCloudChangedEvent,
    daemon.HappyCloudChangedEvent
>;
type _HappyCloudCommand = Assignable<daemon.HappyCloudCommand, local.HappyCloudCommand>;
type _HappyCloudCommandResponse = Assignable<
    local.HappyCloudCommandResponse,
    daemon.HappyCloudCommandResponse
>;
type _HappyCloudProfile = Assignable<
    local.HappyCloudProfileCiphertextResponse,
    daemon.HappyCloudProfileCiphertextResponse
>;
type _HappyCloudSessionBlob = Assignable<
    local.HappyCloudSessionBlobResponse,
    daemon.HappyCloudSessionBlobResponse
>;
type _Attachment = Assignable<local.Attachment, daemon.Attachment>;
type _SecretRegistration = Assignable<local.SecretRegistration, daemon.RegisterSecretRequest>;
type _SecretUpdate = Assignable<local.SecretUpdate, daemon.UpdateSecretRequest>;
type _SecretSummary = Assignable<local.SecretSummary, daemon.SecretSummary>;
type _Applet = Assignable<local.Applet, daemon.Applet>;
type _ResolveAppletOpenRequest = Assignable<
    daemon.ResolveAppletOpenRequest,
    local.ResolveAppletOpenRequest
>;
type _ResolveAppletOpenResponse = Assignable<
    local.ResolveAppletOpenResponse,
    daemon.ResolveAppletOpenResponse
>;
type _AppletContext = Assignable<local.AppletContext, daemon.AppletContext>;
type _SlotAction = Assignable<local.SlotAction, daemon.SlotAction>;
type LocalOpenAppletAction = Extract<local.SlotAction, { type: "open-applet" }>;
type DaemonOpenAppletAction = Extract<daemon.SlotAction, { type: "open-applet" }>;
type _OpenAppletPath = Assignable<DaemonOpenAppletAction["path"], LocalOpenAppletAction["path"]>;
type _OpenAppletQuery = Assignable<DaemonOpenAppletAction["query"], LocalOpenAppletAction["query"]>;
type _PluginSummary = Assignable<local.PluginSummary, daemon.PluginSummary>;
type _PluginLog = Assignable<local.PluginLogSnapshot, daemon.PluginLogSnapshot>;
type _PluginList = Assignable<local.ListPluginsResponse, daemon.ListPluginsResponse>;
type _PluginLogResponse = Assignable<local.PluginLogResponse, daemon.PluginLogResponse>;
type _InstallPluginRequest = Assignable<daemon.InstallPluginRequest, local.InstallPluginRequest>;
type _DiscoverPluginCatalogRequest = Assignable<
    daemon.DiscoverPluginCatalogRequest,
    local.DiscoverPluginCatalogRequest
>;
type _DiscoverPluginCatalogResponse = Assignable<
    local.GitHubPluginCatalog,
    daemon.DiscoverPluginCatalogResponse
>;
type _InstallPluginResponse = Assignable<local.InstallPluginResponse, daemon.InstallPluginResponse>;
type _UninstallPluginResponse = Assignable<
    local.UninstallPluginResponse,
    daemon.UninstallPluginResponse
>;
type _PluginManagementErrorResponse = Assignable<
    local.PluginManagementErrorResponse,
    daemon.PluginManagementErrorResponse
>;
type _TimelineScope = Assignable<local.TimelineScope, daemon.TimelineScope>;
type _TimelineSpan = Assignable<local.TimelineSpan, daemon.TimelineSpan>;
type _TimelineSpanKind = Assignable<local.TimelineSpanKind, daemon.TimelineSpanKind>;
type _TimelineSpanOutcome = Assignable<local.TimelineSpanOutcome, daemon.TimelineSpanOutcome>;
type _TimelineAgent = Assignable<local.TimelineAgent, daemon.TimelineAgent>;
type _TimelineResponse = Assignable<local.GetTimelineResponse, daemon.GetTimelineResponse>;
// The other direction too: a request this library sends must be one the daemon
// accepts, or a chart would ask for something that cannot be answered.
type _TimelineRequest = Assignable<daemon.GetTimelineRequest, local.GetTimelineRequest>;
type _CallPresentation = Assignable<local.ToolCallPresentation, daemonAgent.ToolCallPresentation>;
type _ResultPresentation = Assignable<
    local.ToolResultPresentation,
    daemonAgent.ToolResultPresentation
>;
type _FileDiff = Assignable<local.FileDiff, daemonAgent.FileDiff>;
// Usage is polled rather than streamed, so this is the only shape a view reads
// through a request of its own.
type _ProviderUsage = Assignable<local.ProviderUsage, daemon.ProviderUsage>;
type _ProviderUsageEntry = Assignable<local.ProviderUsageEntry, daemon.ProviderUsageEntry>;
type _ProviderUsageList = Assignable<
    local.ListProviderUsageResponse,
    daemon.ListProviderUsageResponse
>;
type _ExplorationOperation = Assignable<
    local.ExplorationOperation,
    daemonAgent.ExplorationOperation
>;
type _RigCliInstallationInspection = Assignable<
    localInstallation.RigCliInstallationInspection,
    daemon.RigCliInstallationInspection
>;
type _DaemonRigCliInstallationInspection = Assignable<
    daemon.RigCliInstallationInspection,
    localInstallation.RigCliInstallationInspection
>;
type _RigDaemonInstallationDiscovery = Assignable<
    localInstallation.RigDaemonInstallationDiscovery,
    daemon.RigDaemonInstallationDiscovery
>;
type _DaemonRigDaemonInstallationDiscovery = Assignable<
    daemon.RigDaemonInstallationDiscovery,
    localInstallation.RigDaemonInstallationDiscovery
>;

describe("protocol conformance", () => {
    it("keeps credential provenance bounded and identical to the daemon", () => {
        const provenance: local.ProviderCredentialProvenance = {
            bindingId: "rigowner:codex",
            ownerInstanceId: "rigowner",
            ownerName: "Steve's Rig",
            relation: "owner",
            sourceProviderId: "codex",
            visibility: "owner_only",
        };

        expect(providerCredentialProvenanceSchema).toStrictEqual(
            daemonProviderCredentialProvenanceSchema,
        );
        expect(Value.Decode(providerCredentialProvenanceSchema, provenance)).toEqual(provenance);
        expect(Value.Decode(daemonProviderCredentialProvenanceSchema, provenance)).toEqual(
            provenance,
        );
        expect(
            Value.Check(providerCredentialProvenanceSchema, {
                ...provenance,
                visibility: "private",
            }),
        ).toBe(false);
        expect(
            Value.Check(providerCredentialProvenanceSchema, {
                ...provenance,
                unexpected: true,
            }),
        ).toBe(false);
    });

    it("keeps the browser-safe compute error schema structurally identical to the daemon source", () => {
        expect(computeServiceErrorSchema).toEqual(happyComputeErrorSchema);
    });

    it("keeps duplicated installation schemas structurally identical to the daemon", () => {
        expect(rigDataEpochSchema).toStrictEqual(daemonRigDataEpochSchema);
        expect(rigInitializedDataSchema).toStrictEqual(daemonRigInitializedDataSchema);
        expect(rigInstallationCliDataSchema).toStrictEqual(daemonRigInstallationDataSchema);
        expect(rigCliInstallationInspectionSchema).toStrictEqual(
            daemonRigCliInstallationInspectionSchema,
        );
        expect(rigDaemonInstallationDiscoverySchema).toStrictEqual(
            daemonRigDaemonInstallationDiscoverySchema,
        );

        const preIdentityUpgradeRequired = {
            message: "Existing Rig data must be opened by a newer Rig before it has an identity.",
            reason: "pre_identity",
            schemaVersion: 16,
            status: "upgrade_required",
        };
        expect(Value.Check(rigInstallationCliDataSchema, preIdentityUpgradeRequired)).toBe(true);
        expect(Value.Check(daemonRigInstallationDataSchema, preIdentityUpgradeRequired)).toBe(true);
        for (const invalidPreIdentityUpgradeRequired of [
            { ...preIdentityUpgradeRequired, epoch: "must-not-exist" },
            { ...preIdentityUpgradeRequired, unexpected: true },
        ]) {
            expect(
                Value.Check(rigInstallationCliDataSchema, invalidPreIdentityUpgradeRequired),
            ).toBe(false);
            expect(
                Value.Check(daemonRigInstallationDataSchema, invalidPreIdentityUpgradeRequired),
            ).toBe(false);
        }

        const invalidDiscoveryValues = [
            {
                daemonProtocolVersion: 5,
                daemonVersion: "0.0.127",
                data: {
                    epoch: "installation-epoch",
                    schemaCompatibility: "current",
                    schemaVersion: 18,
                    status: "initialized",
                },
                formatVersion: 1,
                source: "daemon",
                unexpected: true,
            },
            {
                daemonProtocolVersion: 5,
                daemonVersion: "0.0.127",
                data: {
                    epoch: "x".repeat(129),
                    schemaCompatibility: "current",
                    schemaVersion: 18,
                    status: "initialized",
                },
                formatVersion: 1,
                source: "daemon",
            },
            {
                daemonProtocolVersion: 5,
                daemonVersion: "0.0.127",
                data: {
                    epoch: "installation-epoch",
                    schemaCompatibility: "current",
                    schemaVersion: -1,
                    status: "initialized",
                },
                formatVersion: 1,
                source: "daemon",
            },
        ];

        for (const value of invalidDiscoveryValues) {
            expect(Value.Check(rigDaemonInstallationDiscoverySchema, value)).toBe(false);
            expect(Value.Check(daemonRigDaemonInstallationDiscoverySchema, value)).toBe(false);
        }
    });

    it("keeps onboarding schemas structurally identical to the daemon", () => {
        expect(CURRENT_ONBOARDING_VERSION).toBe(DAEMON_CURRENT_ONBOARDING_VERSION);
        expect(onboardingStatusSchema).toStrictEqual(daemonOnboardingStatusSchema);
        expect(onboardMurmurRequestSchema).toStrictEqual(daemonOnboardMurmurRequestSchema);
        expect(onboardMurmurResponseSchema).toStrictEqual(daemonOnboardMurmurResponseSchema);

        const profileRequired = {
            onboardingVersion: 2,
            state: "murmur_setup",
        };
        expect(Value.Decode(onboardingStatusSchema, profileRequired)).toEqual(profileRequired);
        expect(Value.Decode(daemonOnboardingStatusSchema, profileRequired)).toEqual(
            profileRequired,
        );
    });

    it("keeps the embedded protocol types assignable from the daemon's own types", () => {
        // The assertions above are compile-time. This case documents that a
        // failure shows up as a type error rather than as a failing expectation.
        expect(true).toBe(true);
    });

    it("round-trips a structured compute notice with its text fallback", () => {
        const payload: local.SystemNoticePayload = {
            structured: {
                computeInstanceId: "compute-1",
                elapsedMs: 45_000,
                error: {
                    code: "preparing_compute",
                    elapsedMs: 45_000,
                    lastProgressAt: 30_000,
                    message: "The compute provider is recovering.",
                    percent: 40,
                    phase: "waiting_for_sandbox",
                    retryable: true,
                    startedAt: 10_000,
                    state: "unavailable",
                },
                kind: "compute_preparation",
                lastProgressAt: 30_000,
                message: "Waiting for the sandbox to start.",
                percent: 40,
                phase: "waiting_for_sandbox",
                provider: "daytona",
                startedAt: 10_000,
                state: "unavailable",
            },
            text: "Preparing compute: Waiting for the sandbox to start. (45s)",
        };

        const serialized = JSON.parse(JSON.stringify(payload));
        const decoded = Value.Decode(systemNoticePayloadSchema, serialized);

        expect(decoded).toEqual(payload);
        expect(Value.Decode(daemonSystemNoticePayloadSchema, serialized)).toEqual(payload);
        expect(decoded.text).toBe("Preparing compute: Waiting for the sandbox to start. (45s)");
    });

    it("validates the exact bounded workspace contract", () => {
        const workspace: local.ProjectWorkspace = {
            branch: "worktree/workspace-1",
            createdAt: 1,
            error: "x".repeat(PROJECT_WORKSPACE_ERROR_MAX_LENGTH),
            gitCommonDir: "/work/project/.git",
            id: "workspace-1",
            kind: "git_worktree",
            name: "Workspace",
            orderKey: "a",
            path: "/work/project/workspace-1",
            presence: "present",
            projectId: "project-1",
            status: "failed",
            storageKey: "workspace-1",
            updatedAt: 2,
            version: 3,
        };

        expect(PROJECT_WORKSPACE_ERROR_MAX_LENGTH).toBe(DAEMON_PROJECT_ERROR_MAX_LENGTH);
        expect(Value.Check(projectWorkspaceSchema, workspace)).toBe(true);
        expect(Value.Decode(projectWorkspaceSchema, workspace)).toEqual(workspace);
        expect(
            Value.Check(projectWorkspaceSchema, {
                ...workspace,
                error: `${workspace.error}x`,
            }),
        ).toBe(false);
        expect(Value.Check(projectWorkspaceSchema, { ...workspace, unexpected: true })).toBe(false);
        expect(() =>
            Value.Decode(projectWorkspaceSchema, {
                ...workspace,
                error: `${workspace.error}x`,
            }),
        ).toThrow();
        expect(() =>
            Value.Decode(projectWorkspaceSchema, { ...workspace, unexpected: true }),
        ).toThrow();
    });

    it("keeps the duplicated folder schemas structurally identical to the daemon", () => {
        expect(FOLDER_NAME_MAX_LENGTH).toBe(DAEMON_FOLDER_NAME_MAX_LENGTH);
        expect(FOLDER_TEXT_MAX_LENGTH).toBe(DAEMON_FOLDER_TEXT_MAX_LENGTH);
        expect(FOLDER_ICON_MAX_LENGTH).toBe(DAEMON_FOLDER_ICON_MAX_LENGTH);
        expect(folderSchema).toStrictEqual(daemonFolderSchema);
        expect(createFolderRequestSchema).toStrictEqual(daemonCreateFolderRequestSchema);
        expect(updateFolderRequestSchema).toStrictEqual(daemonUpdateFolderRequestSchema);
        expect(moveFolderRequestSchema).toStrictEqual(daemonMoveFolderRequestSchema);
        expect(moveSessionRequestSchema).toStrictEqual(daemonMoveSessionRequestSchema);
        expect(sessionScopeSchema).toStrictEqual(daemonSessionScopeSchema);
    });

    it("accepts and refuses exactly the same folder payloads", () => {
        const folder = {
            createdAt: 1,
            description: "Where the videos live.",
            icon: "🎬",
            id: "folder-1",
            name: "Media",
            orderKey: "a0",
            path: "/work/folders/folder-1",
            rules: "Keep the exports out of the working directory.",
            shared: false,
            updatedAt: 2,
            version: 3,
        };
        const move = { afterId: "folder-2", parentId: null };

        const accepts = (local: TSchema, daemonSchema: TSchema, value: unknown) => {
            expect(Value.Decode(local, value)).toEqual(value);
            expect(Value.Decode(daemonSchema, value)).toEqual(value);
        };
        const refuses = (local: TSchema, daemonSchema: TSchema, value: unknown) => {
            expect(Value.Check(local, value)).toBe(false);
            expect(Value.Check(daemonSchema, value)).toBe(false);
        };
        const folders = (value: unknown) => [folderSchema, daemonFolderSchema, value] as const;
        const moves = (value: unknown) =>
            [moveFolderRequestSchema, daemonMoveFolderRequestSchema, value] as const;
        const creates = (value: unknown) =>
            [createFolderRequestSchema, daemonCreateFolderRequestSchema, value] as const;

        accepts(...folders(folder));
        accepts(...folders({ ...folder, archivedAt: 4, parentId: "folder-0" }));
        accepts(...moves(move));
        accepts(...moves({ afterId: null, parentId: null }));
        accepts(...creates({ name: "Media" }));

        refuses(...folders({ ...folder, unexpected: true }));
        refuses(...moves({ parentId: null }));
        // The order key is the daemon's to derive, so a client can never send one.
        refuses(...moves({ ...move, orderKey: "a1" }));
        refuses(...creates({ name: "x".repeat(FOLDER_NAME_MAX_LENGTH + 1) }));
        refuses(...creates({ name: "Media", orderKey: "a1" }));
    });

    it("keeps folder-item and opaque document schemas identical to the daemon", () => {
        expect(createFolderItemRequestSchema).toStrictEqual(daemonCreateFolderItemRequestSchema);
        expect(moveFolderItemRequestSchema).toStrictEqual(daemonMoveFolderItemRequestSchema);
        expect(folderItemTargetSchema).toStrictEqual(daemonFolderItemTargetSchema);
        expect(folderItemSchema).toStrictEqual(daemonFolderItemSchema);
        expect(DOCUMENT_STATE_MAX_BYTES).toBe(DAEMON_DOCUMENT_STATE_MAX_BYTES);
        expect(DOCUMENT_UPDATE_MAX_BYTES).toBe(DAEMON_DOCUMENT_UPDATE_MAX_BYTES);
        expect(DOCUMENT_UPDATE_PAGE_MAX_LIMIT).toBe(DAEMON_DOCUMENT_UPDATE_PAGE_MAX_LIMIT);
        expect(DOCUMENT_UPDATE_RETENTION_MAX_COUNT).toBe(
            DAEMON_DOCUMENT_UPDATE_RETENTION_MAX_COUNT,
        );
        expect(DOCUMENT_UPDATE_RETENTION_MAX_BYTES).toBe(
            DAEMON_DOCUMENT_UPDATE_RETENTION_MAX_BYTES,
        );
        expect(documentUnreadCursorSchema).toStrictEqual(daemonDocumentUnreadCursorSchema);
        expect(documentCreatedBySchema).toStrictEqual(daemonDocumentCreatedBySchema);
        expect(documentSchema).toStrictEqual(daemonDocumentSchema);
        expect(documentUpdateSchema).toStrictEqual(daemonDocumentUpdateSchema);
        expect(createDocumentRequestSchema).toStrictEqual(daemonCreateDocumentRequestSchema);
        expect(writeDocumentRequestSchema).toStrictEqual(daemonWriteDocumentRequestSchema);
        expect(
            Value.Check(writeDocumentRequestSchema, {
                state: {},
                unreadCursor: null,
                update: {},
            }),
        ).toBe(true);
        expect(listDocumentUpdatesRequestSchema).toStrictEqual(
            daemonListDocumentUpdatesRequestSchema,
        );
        expect(documentResponseSchema).toStrictEqual(daemonDocumentResponseSchema);
        expect(documentUpdatePageSchema).toStrictEqual(daemonDocumentUpdatePageSchema);
        expect(documentErrorCodeSchema).toStrictEqual(daemonDocumentErrorCodeSchema);
        expect(documentErrorResponseSchema).toStrictEqual(daemonDocumentErrorResponseSchema);
    });

    it("accepts and refuses exactly the same plugin catalog and installation payloads", () => {
        // The catalog schemas are re-declared here so a browser bundle carries no daemon code,
        // and the two declarations only agree at the type level. These checks are what proves
        // they still agree about the values that actually cross the wire.
        const entry = {
            description: "A small clock.",
            displayName: "Clock",
            name: "clock",
            path: "plugins/clock",
            version: "1.2.0",
        };
        const source = {
            catalogId: "a".repeat(64),
            plugin: entry,
            ref: "release/1.x",
            repository: "happy-dev/plugins",
            revision: "b".repeat(40),
            type: "github",
        };
        const catalog = {
            catalogId: source.catalogId,
            plugins: [
                {
                    availability: "update-available",
                    description: entry.description,
                    displayName: entry.displayName,
                    installed: { folder: "clock", name: "Clock", version: "1.0.0" },
                    name: entry.name,
                    source,
                    version: entry.version,
                },
                {
                    availability: "not-installed",
                    description: entry.description,
                    displayName: entry.displayName,
                    name: entry.name,
                    source,
                    version: entry.version,
                },
            ],
            ref: source.ref,
            repository: source.repository,
            revision: source.revision,
        };
        const discovery = { ref: source.ref, repository: source.repository };
        const localInstall = {
            requestId: "install-1",
            source: { sourceDirectory: "/Users/steve/plugins/clock", type: "local-directory" },
        };
        const githubInstall = { requestId: "install-1", source };

        const accepts = (local: TSchema, daemonSchema: TSchema, value: unknown) => {
            expect(Value.Decode(local, value)).toEqual(value);
            expect(Value.Decode(daemonSchema, value)).toEqual(value);
        };
        const refuses = (local: TSchema, daemonSchema: TSchema, value: unknown) => {
            expect(Value.Check(local, value)).toBe(false);
            expect(Value.Check(daemonSchema, value)).toBe(false);
        };
        const catalogs = (value: unknown) =>
            [githubPluginCatalogSchema, daemonDiscoverPluginCatalogResponseSchema, value] as const;
        const discoveries = (value: unknown) =>
            [
                discoverPluginCatalogRequestSchema,
                daemonDiscoverPluginCatalogRequestSchema,
                value,
            ] as const;
        const installs = (value: unknown) =>
            [installPluginRequestSchema, daemonInstallPluginRequestSchema, value] as const;

        accepts(...catalogs(catalog));
        accepts(...discoveries(discovery));
        accepts(...installs(localInstall));
        accepts(...installs(githubInstall));

        refuses(...catalogs({ ...catalog, revision: "b".repeat(39) }));
        refuses(...catalogs({ ...catalog, catalogId: "A".repeat(64) }));
        refuses(
            ...catalogs({
                ...catalog,
                plugins: [{ ...catalog.plugins[0], availability: "already-installed" }],
            }),
        );
        refuses(...catalogs({ ...catalog, unexpected: true }));
        refuses(...discoveries({ ...discovery, ref: "release/../secrets" }));
        refuses(...discoveries({ repository: "not-a-repository" }));
        refuses(...installs({ source }));
        refuses(
            ...installs({
                requestId: "install-1",
                source: { ...source, plugin: { ...entry, version: "1.2" } },
            }),
        );
    });

    it("decodes the same parent-owned human profile", () => {
        const profile = {
            createdAt: 1,
            email: "steve@example.test",
            id: "aprofile000000000000000001",
            name: "Steve 🧑‍💻",
            parentInstanceId: "aparent0000000000000000001",
            updatedAt: 2,
            version: 3,
        };

        expect(Value.Decode(rigProfileSchema, profile)).toEqual(profile);
        expect(Value.Decode(daemonRigProfileSchema, profile)).toEqual(profile);
        for (const schema of [rigProfileSchema, daemonRigProfileSchema]) {
            expect(Value.Check(schema, { ...profile, name: "" })).toBe(false);
            expect(Value.Check(schema, { ...profile, parentInstanceId: "not a cuid" })).toBe(false);
        }
    });

    it("rejects compute error detail beyond the daemon's canonical bound", () => {
        const payload = {
            structured: {
                computeInstanceId: "compute-1",
                error: {
                    code: "instance_failed",
                    message: "x".repeat(SERVICE_NOTICE_MESSAGE_MAX_LENGTH + 1),
                    retryable: false,
                    state: "failed",
                },
                kind: "compute_preparation",
                message: "Compute failed.",
                phase: "failed",
                provider: "daytona",
                state: "failed",
            },
            text: "Compute preparation failed.",
        };

        expect(() => Value.Decode(systemNoticePayloadSchema, payload)).toThrow();
        expect(() => Value.Decode(daemonSystemNoticePayloadSchema, payload)).toThrow();
    });
});
