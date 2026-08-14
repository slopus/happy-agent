import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, relative } from "node:path";

import { isCuid } from "@paralleldrive/cuid2";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    recordApiRequest,
    setSpanAttributes,
    spanTraceId,
    withRequestContext,
    withUntracedRequestContext,
} from "../observability/index.js";
import { shouldTraceProtocolRoute } from "./protocolTracing.js";
import { projectP2pApiStatus } from "./projectP2pApiStatus.js";

import type {
    Attachment,
    AbortRunResponse,
    BroadcastMessageRequest,
    BroadcastMessageResponse,
    AnswerUserInputRequest,
    AttachSecretRequest,
    ChangeEffortRequest,
    ChangeModelRequest,
    ChangePermissionModeRequest,
    ChangeServiceTierRequest,
    ChangeSessionGoalStatusRequest,
    CancelScheduledMessageResponse,
    CreateRemoteProjectRequest,
    CompactSessionResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    DaemonConfig,
    DaemonIdentity,
    DisconnectSessionTerminalResponse,
    ForkSessionResponse,
    GetCurrentProviderQuotaResponse,
    GetDaemonConfigResponse,
    GetGlobalInstructionsResponse,
    GetGlobalSecurityPolicyResponse,
    HappyCloudCommand,
    HappyCloudCommandResponse,
    HappyCloudProfileCiphertextResponse,
    HappyCloudSessionBlobResponse,
    HappyCloudStatus,
    GetSessionUsageResponse,
    GetTimelineResponse,
    ListProviderUsageResponse,
    ProviderUsageEntry,
    SessionStateResponse,
    ListGlobalEventsResponse,
    ListExternalToolCallsResponse,
    ListSecretsResponse,
    HealthResponse,
    RigDaemonInstallationDiscovery,
    InstallPluginRequest,
    InstallPluginResponse,
    P2pStatus,
    CreateRigProfileRequest,
    ListRigProfilesResponse,
    ReplicateRigProfileRequest,
    RigProfileResponse,
    UpdateRigProfileRequest,
    GitChangeSnapshot,
    GitRepositoryFacts,
    GitStateResponse,
    GitWatchResponse,
    GoalSessionResponse,
    ListModelsResponse,
    ListFileTreeRequest,
    ListFileTreeResponse,
    ListProjectFilePathsResponse,
    ListProjectsResponse,
    ListProjectWorkspacesResponse,
    ListSessionsResponse,
    ListSubagentsResponse,
    ModelCatalog,
    ProviderCredentialProvenance,
    ProjectResponse,
    ProjectRegistrationErrorResponse,
    ProjectScope,
    ProjectWorkspaceResponse,
    ReorderRequest,
    RewindSessionRequest,
    RewindSessionResponse,
    RecordSessionActivityResponse,
    ReadBackgroundProcessResponse,
    ReadProjectFileResponse,
    ReadProjectFileRevisionResponse,
    RunShellCommandRequest,
    RunShellCommandResponse,
    ResolveExternalToolCallRequest,
    ResolveExternalToolCallResponse,
    RegisterSecretResponse,
    SearchFilesResponse,
    SecretSessionResponse,
    ProtocolSession,
    SessionEvent,
    SessionActivity,
    SessionArchiveResponse,
    SessionPartialMessage,
    SessionReadResponse,
    SessionStreamHello,
    SessionTranscriptWindow,
    SessionTerminalHeartbeatRequest,
    SessionTerminalHeartbeatResponse,
    SetGoalRequest,
    ShutdownServerResponse,
    StartInspectorResponse,
    StopInspectorResponse,
    SteerMessageResponse,
    StopBackgroundProcessResponse,
    StopWorkflowResponse,
    SubagentSummary,
    SubmitMessageResponse,
    SubmitMessageRequest,
    SubmitContextMessageResponse,
    TrimGlobalEventsRequest,
    TrimGlobalEventsResponse,
    TransferSessionRequest,
    TransferSessionResponse,
    UninstallPluginResponse,
    UnregisterSecretResponse,
    UpdateSecretResponse,
    UpdateDaemonConfigRequest,
    UpdateDaemonConfigResponse,
    UpdateGlobalInstructionsRequest,
    UpdateGlobalInstructionsResponse,
    UpdateGlobalSecurityPolicyResponse,
    SetSessionDraftRequest,
    UpdateSessionRequest,
    CreateSharingInvitationResponse,
    CreateFolderShareRequest,
    FolderShareStatus,
    OnboardMurmurRequest,
    OnboardMurmurResponse,
    RequestSharingContactRequest,
    SharingOutgoingContactRequestResponse,
    SharingSnapshot,
    WriteProjectFileRequest,
    WriteProjectFileResponse,
} from "../protocol/index.js";
import { updateDaemonConfigRequestSchema } from "../protocol/index.js";
import {
    HAPPY_CLOUD_CIPHERTEXT_MAX_LENGTH,
    discoverPluginCatalogRequestSchema,
    globalSecurityPolicySchema,
    installPluginRequestSchema,
    listFileTreeRequestSchema,
    happyCloudCommandSchema,
    happyCloudSessionIdSchema,
    RIG_PROTOCOL_VERSION,
    registerProjectRequestSchema,
    createRemoteProjectRequestSchema,
    projectGitSecretSchema,
    SESSION_DRAFT_MAX_LENGTH,
    submitContextMessageRequestSchema,
    updateProjectSettingsRequestSchema,
    createRigProfileRequestSchema,
    replicateRigProfileRequestSchema,
    rigProfileIdSchema,
    updateRigProfileRequestSchema,
    transferSessionRequestSchema,
    writeProjectFileRequestSchema,
    onboardMurmurRequestSchema,
    createFolderShareRequestSchema,
    requestSharingContactRequestSchema,
    sharingIdentitySchema,
} from "../protocol/index.js";
import type { HappyCloudServiceContract } from "../happy-cloud/index.js";
import type { OnboardingServiceContract } from "../onboarding/OnboardingService.js";
import { HappyCloudPersistenceError } from "../persistence/happy-cloud/HappyCloudPersistenceError.js";
import {
    normalizeRigProfilePhoto,
    type RigProfileStore,
    validateRigProfilePhoto,
} from "../profiles/index.js";
import { getDaemonIdentity } from "../daemon/index.js";
import { WorkspaceTransferTargetRestoreError } from "../git/prepareWorkspaceTransfer.js";
import { ProjectRegistrationError } from "../project/ProjectRepository.js";
import { errorToMessage } from "../errorToMessage.js";
import { isOpenQuestion } from "../user-input/index.js";
import type {
    GetPresenceResponse,
    SetPresenceRequestBody,
    SetPresenceResponse,
} from "../protocol/index.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";
import { InMemorySessionStore } from "../session/InMemorySessionStore.js";
import type { SessionUsageSummary } from "../session/usage/index.js";
import { projectClientTranscript } from "../session/projectClientTranscript.js";
import { createModelCatalog } from "../model-catalog/createModelCatalog.js";
import {
    FileSearchService,
    type FileSearchServiceContract,
} from "../file-search/FileSearchService.js";
import type { SessionEventLog } from "../session/SessionEventLog.js";
import { isLiveOnlySessionEvent } from "../session/isLiveOnlySessionEvent.js";
import { isSubmitMessageRequest } from "./isSubmitMessageRequest.js";
import { limitProtocolSessionMessages } from "./limitProtocolSessionMessages.js";
import type { GlobalStreamHello } from "../protocol/index.js";
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import type { SessionStore } from "../session/SessionStore.js";
import { isGlobalEventRoute } from "./isGlobalEventRoute.js";
import { parseGlobalEventCursor } from "../global-event/parseGlobalEventCursor.js";
import { parseGlobalEventLimit } from "./parseGlobalEventLimit.js";
import { selectRecentSessionEvents } from "../session/selectRecentSessionEvents.js";
import { SESSION_STREAM_TURN_LIMIT } from "../protocol/index.js";
import { parseTimelineRequest } from "./parseTimelineRequest.js";
import { sendJson } from "./sendJson.js";
import { streamGlobalEvents } from "./streamGlobalEvents.js";
import { streamLiveEvents } from "./streamLiveEvents.js";
import type { GitStateTracker } from "../git/GitStateTracker.js";
import { resolveGitTrackedEntity } from "../git/resolveGitTrackedEntity.js";
import { INVALID_PERMISSION_MODE_MESSAGE, isPermissionMode } from "../permissions/index.js";
import { isGoalStatus } from "../goals/index.js";
import type { DockerExecutionConfig } from "../execution/index.js";
import { getGeneratedDirectory, resolveGeneratedMediaLocation } from "../generated-media/index.js";
import { configureSessionRequest } from "../session/configureSessionRequest.js";
import { DEFAULT_INFERENCE_MAX_RETRIES } from "../config/inferenceRetrySettings.js";
import { getGlobalAgentsMdPath } from "../config/getGlobalAgentsMdPath.js";
import { GLOBAL_AGENTS_MD_MAX_BYTES } from "../config/globalAgentsMdMaxBytes.js";
import { readGlobalAgentsMd } from "../config/readGlobalAgentsMd.js";
import { writeGlobalAgentsMd } from "../config/writeGlobalAgentsMd.js";
import { getGlobalSecurityMdPath } from "../config/getGlobalSecurityMdPath.js";
import { GLOBAL_SECURITY_MD_MAX_BYTES } from "../config/globalSecurityMdMaxBytes.js";
import { readGlobalSecurityMd } from "../config/readGlobalSecurityMd.js";
import { writeGlobalSecurityMd } from "../config/writeGlobalSecurityMd.js";
import { SessionConfigurationError } from "../session/SessionConfigurationError.js";
import type { TaskDrain } from "../utils/TrackedTaskDrain.js";
import type { ProviderQuota } from "@slopus/happy-providers";
import {
    environmentSecretRegistrationSchema,
    environmentSecretUpdateSchema,
    type EnvironmentSecretRegistration,
} from "../secrets/index.js";
import type {
    CreateRemoteTerminalRequest,
    CreateRemoteTerminalResponse,
    ListRemoteTerminalsResponse,
    RemoteTerminalResponse,
    ResizeRemoteTerminalRequest,
} from "../terminal/index.js";
import type { PluginContext } from "../agent/context/PluginContext.js";
import {
    assertAgentSubmissionOptionsSupported,
    type RigAgentService,
} from "../agent/RigAgentService.js";
import {
    PluginAppError,
    PluginCatalogError,
    PluginIconError,
    PluginNotFoundError,
} from "../plugins/index.js";
import { SlotEntryInvalidError, SlotEntryNotFoundError } from "../slots/index.js";
import {
    describeAppletScopeNotAllowed,
    readAppletFile,
    resolveAppletOpenUrl,
    AppletContextTokenStore,
    AppletInvalidError,
    AppletNotFoundError,
} from "../applets/index.js";
import {
    WorkletInvalidError,
    WorkletNotFoundError,
    type WorkletManager,
} from "../worklets/index.js";
import {
    installWorkletRequestSchema,
    revertWorkletRequestSchema,
    updateWorkletRequestSchema,
    type ListWorkletsResponse,
    type WorkletLogResponse,
    type WorkletManagementErrorCode,
    type WorkletResponse,
} from "../protocol/WorkletProtocol.js";
import { MAX_ATTACHMENT_FILE_BYTES } from "../tools/attachments/prepareAttachment.js";
import {
    createAppletRequestSchema,
    resolveAppletOpenRequestSchema,
    slotNameSchema,
} from "../protocol/index.js";
import type {
    CreateSlotEntryRequest,
    ListSlotEntriesResponse,
    ListAppletsResponse,
    ResolveAppletOpenRequest,
    ResolveAppletOpenResponse,
    RevertAppletRequest,
    SlotEntryResponse,
    SlotManagementErrorCode,
    SlotScope,
    UpdateSlotEntryRequest,
    UpdateAppletRequest,
    Applet,
    AppletContext,
    AppletManagementErrorCode,
    AppletResponse,
} from "../protocol/index.js";
import { isAuthorizedProtocolRequest } from "./isAuthorizedProtocolRequest.js";
import { attachRemoteTerminalWebSocketServer } from "./attachRemoteTerminalWebSocketServer.js";
import { attachP2pPeerTunnels } from "./attachP2pPeerTunnels.js";
import { SessionTerminalTracker } from "../session/SessionTerminalTracker.js";
import { sessionSummaryWithTerminalPresence } from "../session/sessionSummaryWithTerminalPresence.js";
import { attachHttpConnectProxy } from "./attachHttpConnectProxy.js";
import { attachP2pSshBridge } from "./attachP2pSshBridge.js";
import {
    ProjectFileConflictError,
    ProjectFileOutsideScopeError,
    ProjectFileTooLargeError,
    readProjectFile,
    readProjectFileAtRevision,
    writeProjectFile,
} from "./projectFileApi.js";
import { listGitWorkingTreeFiles } from "../git/listGitWorkingTreeFiles.js";
import { serveFolderRequest } from "./folderApi.js";
import { serveFolderItemRequest } from "./folderItemApi.js";
import { serveDocumentRequest } from "./documentApi.js";
import { FolderError } from "../folders/FolderRepository.js";
import { moveSessionRequestSchema, sessionScopeSchema } from "../protocol/index.js";
import { createNodeFileSystemContext } from "../agent/context/createNodeFileSystemContext.js";
import {
    FileTreeChangedError,
    FileTreeInvalidRequestError,
    FileTreeProtectedPathError,
    FileTreeSymlinkTraversalError,
    listFileTree,
} from "../file-tree/index.js";
import type { P2pNetwork } from "../p2p/index.js";
import type { P2pPairingServiceContract } from "../p2p/P2pPairingService.js";
import {
    P2pCredentialVersionConflictError,
    type P2pCredentialReplaceResult,
} from "../credentials/P2pCredentialStore.js";
import {
    answerP2pVerificationRequestSchema,
    joinP2pInvitationRequestSchema,
    p2pEncryptedCredentialSnapshotSchema,
    p2pInstanceIdSchema,
    type CreateP2pInvitationResponse,
    type JoinP2pInvitationResponse,
    type P2pEncryptedCredentialSnapshot,
    type P2pPairingState,
} from "../protocol/index.js";
import { proxyP2pHttpRequest } from "./proxyP2pHttpRequest.js";
import type { PrepareP2pHttpRequest } from "./proxyP2pHttpRequest.js";
import { matchP2pPeerRoute } from "./matchP2pPeerRoute.js";
import type { SharingLifecycleServiceContract } from "../sharing/index.js";

export interface ProtocolHttpServerOptions {
    agents?: RigAgentService;
    inferenceMaxRetries?: number;
    /** Where the user's global AGENTS.md lives. Defaults to the file beside the daemon config. */
    globalInstructionsPath?: string;
    /** Where the user's global SECURITY.md lives. Defaults to the file beside the daemon config. */
    globalSecurityPolicyPath?: string;
    defaultDocker?: DockerExecutionConfig;
    gitStateTracker?: GitStateTracker;
    happyCloud?: HappyCloudServiceContract;
    identity?: DaemonIdentity;
    modelCatalog?: ModelCatalog;
    onboarding?: OnboardingServiceContract;
    resolveModelCatalog?: (ownerInstanceId: string) => ModelCatalog;
    p2pNetwork?: P2pNetwork;
    p2pPairing?: P2pPairingServiceContract;
    resolveP2pNetwork?: () => P2pNetwork | undefined;
    resolveP2pPairing?: () => P2pPairingServiceContract | undefined;
    p2pNode?: () => DaemonConfig["p2p"];
    p2pStatus?: () => P2pStatus;
    canP2pPeerConfigure?: (peerId: string) => boolean;
    canP2pPeerProvision?: (peerId: string) => boolean;
    /** Authorizes a peer to create and operate its remote projects, workspaces, and sessions. */
    canP2pPeerUseRemoteWork?: (peerId: string) => boolean;
    profiles?: RigProfileStore;
    sharing?: SharingLifecycleServiceContract;
    replaceP2pCredentials?: (
        ctx: Context,
        authenticatedOwnerId: string,
        envelope: P2pEncryptedCredentialSnapshot,
    ) => Promise<P2pCredentialReplaceResult>;
    prepareP2pRequest?: PrepareP2pHttpRequest;
    fileSearchService?: FileSearchServiceContract;
    globalEventQueue?: GlobalEventQueue;
    getProviderQuota?: (
        providerId: string,
        ownerInstanceId: string,
        credential?: ProviderCredentialProvenance,
    ) => Promise<ProviderQuota | undefined>;
    /** Hands out the usage the daemon polls for every configured provider. */
    listProviderUsage?: (
        ownerInstanceId?: string,
    ) => readonly ProviderUsageEntry[] | Promise<readonly ProviderUsageEntry[]>;
    onDaemonConfigChange?: (
        ctx: Context,
        config: DaemonConfig,
    ) => AppliedDaemonSettings | undefined | Promise<AppliedDaemonSettings | undefined>;
    onShutdown?: () => void;
    onReloadHappy?: (ctx: Context) => boolean | Promise<boolean>;
    onStartInspector?: (ctx: Context) => StartInspectorResponse | Promise<StartInspectorResponse>;
    onStopInspector?: (ctx: Context) => StopInspectorResponse | Promise<StopInspectorResponse>;
    plugins?: Pick<
        PluginContext,
        | "callAppTool"
        | "discoverRepository"
        | "install"
        | "installFromGitHub"
        | "list"
        | "readAppResource"
        | "readIcon"
        | "readLog"
        | "storageDelete"
        | "storageGet"
        | "storageList"
        | "storageSet"
        | "uninstall"
    >;
    store?: SessionStore;
    taskDrain?: TaskDrain;
    /** The daemon's running worklets. Absent when this daemon runs without them. */
    worklets?: WorkletManager;
    secrets?: readonly EnvironmentSecretRegistration[];
    token: string;
}

export async function createProtocolHttpServer(
    ctx: Context,
    options: ProtocolHttpServerOptions,
    server: Server = createServer(),
): Promise<Server> {
    const p2pProxyShutdown = new AbortController();
    protocolP2pProxyShutdowns.set(server, p2pProxyShutdown);
    const modelCatalog = options.modelCatalog ?? createModelCatalog(ctx);
    const store =
        options.store ??
        (await InMemorySessionStore.open(ctx, {
            ...(options.defaultDocker === undefined
                ? {}
                : { defaultDocker: options.defaultDocker }),
            modelCatalog,
            ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        }));
    const identity = options.identity ?? getDaemonIdentity();
    const fileSearchService = options.fileSearchService ?? new FileSearchService();
    const appletContextTokens = new AppletContextTokenStore();
    const runtimeConfig: ProtocolServerRuntimeConfig = {
        agents: options.agents,
        inferenceMaxRetries: options.inferenceMaxRetries ?? DEFAULT_INFERENCE_MAX_RETRIES,
        gitStateTracker: options.gitStateTracker,
        globalEventQueue: options.globalEventQueue ?? store.globalEventQueue,
        globalInstructionsPath: options.globalInstructionsPath ?? getGlobalAgentsMdPath(),
        globalSecurityPolicyPath: options.globalSecurityPolicyPath ?? getGlobalSecurityMdPath(),
        listProviderUsage: options.listProviderUsage,
        resolveP2pNetwork: options.resolveP2pNetwork ?? (() => options.p2pNetwork),
        resolveP2pPairing: options.resolveP2pPairing ?? (() => options.p2pPairing),
        p2pNode: options.p2pNode,
        p2pStatus: options.p2pStatus,
        canP2pPeerConfigure: options.canP2pPeerConfigure,
        canP2pPeerProvision: options.canP2pPeerProvision,
        canP2pPeerUseRemoteWork: options.canP2pPeerUseRemoteWork,
        profiles: options.profiles,
        sharing: options.sharing,
        replaceP2pCredentials: options.replaceP2pCredentials,
        resolveModelCatalog: options.resolveModelCatalog,
        prepareP2pRequest: options.prepareP2pRequest,
        p2pProxyShutdown: p2pProxyShutdown.signal,
        happyCloud: options.happyCloud,
        onDaemonConfigChange: options.onDaemonConfigChange,
        onboarding: options.onboarding,
        onReloadHappy: options.onReloadHappy,
        onStartInspector: options.onStartInspector,
        onStopInspector: options.onStopInspector,
        plugins: options.plugins,
        ...(options.worklets === undefined ? {} : { worklets: options.worklets }),
    };
    // The persistent store caches sessions weakly; each open SSE stream needs its own strong lease.
    const sessionEventStreamLeases = new Set<SessionEventStreamLease>();
    const sessionTerminals = new SessionTerminalTracker();
    const resolveP2pNetwork = options.resolveP2pNetwork ?? (() => options.p2pNetwork);

    attachRemoteTerminalWebSocketServer({ server, store, token: options.token });
    attachP2pPeerTunnels({
        resolveNetwork: resolveP2pNetwork,
        server,
        token: options.token,
    });
    attachP2pSshBridge(server, options.token, undefined, () => {
        const network = resolveP2pNetwork();
        return network?.sshBridgeEnabled() === true
            ? network.acceptSshBridge.bind(network)
            : undefined;
    });
    attachHttpConnectProxy(server, options.token, store);

    server.on("request", (request, response) => {
        const mutating = isMutatingProtocolRequest(request);
        if (mutating && options.taskDrain?.closing === true) {
            sendJson(response, 503, { error: "The local daemon is shutting down." });
            return;
        }
        const url = new URL(request.url ?? "/", "http://unix");
        const routeName = protocolTraceRoute(url);
        const peerRoute = matchP2pPeerRoute(url);
        const rejectedPeerPoll =
            peerRoute !== undefined &&
            resolveP2pNetwork()?.peerApiAvailable?.(peerRoute.peerId) === false;
        const traced = shouldTraceProtocolRoute(routeName) && !rejectedPeerPoll;
        const handle = async () => {
            const startedAt = performance.now();
            try {
                const run = (requestCtx: Context) =>
                    handleRequest(
                        requestCtx,
                        request,
                        response,
                        store,
                        modelCatalog,
                        identity,
                        fileSearchService,
                        runtimeConfig,
                        options.token,
                        options.onShutdown,
                        options.defaultDocker,
                        options.taskDrain,
                        options.getProviderQuota,
                        sessionEventStreamLeases,
                        sessionTerminals,
                        appletContextTokens,
                    );
                const logContext = {
                    method: request.method ?? "UNKNOWN",
                    route: routeName,
                };
                const runRequest = traced ? withRequestContext : withUntracedRequestContext;
                await runRequest(routeName, logContext, async (requestCtx) => {
                    if (traced) {
                        setSpanAttributes(requestCtx, {
                            "http.request.method": request.method ?? "UNKNOWN",
                            "rig.api.route": routeName,
                        });
                        const traceId = spanTraceId(requestCtx);
                        if (traceId !== undefined) response.setHeader("x-rig-trace-id", traceId);
                    }
                    await run(requestCtx);
                });
            } finally {
                recordApiRequest(
                    routeName,
                    request.method ?? "UNKNOWN",
                    response.statusCode,
                    performance.now() - startedAt,
                );
            }
        };
        const handling =
            mutating && options.taskDrain !== undefined ? options.taskDrain.run(handle) : handle();
        void handling.catch((error: unknown) => {
            // A database failure must reach the process-level rejection handler.
            if (isDatabaseFailure(error)) throw error;
            const invalidJson = error instanceof InvalidJsonBodyError;
            const bodyTooLarge = error instanceof RequestBodyTooLargeError;
            const status = bodyTooLarge
                ? 413
                : invalidJson
                  ? 400
                  : mutating && options.taskDrain?.closing === true
                    ? 503
                    : 500;
            sendJson(response, status, {
                error: bodyTooLarge
                    ? "Request body is larger than the allowed limit."
                    : invalidJson
                      ? "Request body must be valid JSON."
                      : errorToMessage(error),
            });
        });
    });
    server.once("close", () => {
        p2pProxyShutdown.abort();
        protocolP2pProxyShutdowns.delete(server);
        fileSearchService.close();
        sessionTerminals.dispose();
    });
    return server;
}

const protocolP2pProxyShutdowns = new WeakMap<Server, AbortController>();

export function beginProtocolHttpServerShutdown(server: Server): void {
    protocolP2pProxyShutdowns.get(server)?.abort();
}

function protocolApiArea(pathname: string): string {
    const area = pathname.split("/").find((part) => part.length > 0);
    return area !== undefined && /^[a-z][a-z0-9-]*$/u.test(area) ? area : "unknown";
}

function protocolTraceRoute(url: URL): string {
    const peerRoute = matchP2pPeerRoute(url);
    if (peerRoute === undefined) {
        return matchRoute(url.pathname)?.name ?? protocolApiArea(url.pathname);
    }
    const peerPathname = new URL(peerRoute.path, "http://rig.peer").pathname;
    const peerOperation = matchRoute(peerPathname)?.name ?? protocolApiArea(peerPathname);
    return `peer.${peerOperation}`;
}

interface ProtocolServerRuntimeConfig {
    agents: RigAgentService | undefined;
    canP2pPeerConfigure: ProtocolHttpServerOptions["canP2pPeerConfigure"];
    canP2pPeerProvision: ProtocolHttpServerOptions["canP2pPeerProvision"];
    canP2pPeerUseRemoteWork: ProtocolHttpServerOptions["canP2pPeerUseRemoteWork"];
    inferenceMaxRetries: number;
    gitStateTracker: GitStateTracker | undefined;
    globalEventQueue: GlobalEventQueue;
    globalInstructionsPath: string;
    globalSecurityPolicyPath: string;
    listProviderUsage: ProtocolHttpServerOptions["listProviderUsage"];
    resolveP2pNetwork: () => P2pNetwork | undefined;
    resolveP2pPairing: () => P2pPairingServiceContract | undefined;
    p2pNode: (() => DaemonConfig["p2p"]) | undefined;
    p2pStatus: (() => P2pStatus) | undefined;
    profiles: RigProfileStore | undefined;
    sharing: SharingLifecycleServiceContract | undefined;
    replaceP2pCredentials: ProtocolHttpServerOptions["replaceP2pCredentials"];
    resolveModelCatalog: ProtocolHttpServerOptions["resolveModelCatalog"];
    prepareP2pRequest: PrepareP2pHttpRequest | undefined;
    p2pProxyShutdown: AbortSignal;
    happyCloud: HappyCloudServiceContract | undefined;
    onDaemonConfigChange: ProtocolHttpServerOptions["onDaemonConfigChange"];
    onboarding: OnboardingServiceContract | undefined;
    onStartInspector: ProtocolHttpServerOptions["onStartInspector"];
    onStopInspector: ProtocolHttpServerOptions["onStopInspector"];
    onReloadHappy: ProtocolHttpServerOptions["onReloadHappy"];
    plugins:
        | Pick<
              PluginContext,
              | "callAppTool"
              | "discoverRepository"
              | "install"
              | "installFromGitHub"
              | "list"
              | "readAppResource"
              | "readIcon"
              | "readLog"
              | "storageDelete"
              | "storageGet"
              | "storageList"
              | "storageSet"
              | "uninstall"
          >
        | undefined;
    worklets?: WorkletManager;
}

interface AppliedDaemonSettings {
    inferenceMaxRetries: number;
    globalEventQueue: GlobalEventQueue;
}

function rejectUnsupportedAgentSubmissionOptions(
    response: ServerResponse,
    runtimeConfig: ProtocolServerRuntimeConfig,
    request: SubmitMessageRequest,
): boolean {
    if (runtimeConfig.agents === undefined) return false;
    try {
        assertAgentSubmissionOptionsSupported(request);
        return false;
    } catch (error) {
        sendJson(response, 400, { error: errorToMessage(error) });
        return true;
    }
}

function sendAgentsModeUnavailable(response: ServerResponse, capability: string): void {
    sendJson(response, 503, {
        error: `${capability} is unavailable while this session uses Agent Base agents.`,
    });
}

const GLOBAL_SECURITY_POLICY_REQUEST_MAX_BYTES = GLOBAL_SECURITY_MD_MAX_BYTES * 6 + 1024;
const temporaryGitSecretSchema = Type.Object(
    {
        kind: Type.Literal("github"),
        token: Type.String({ maxLength: 65_536, minLength: 1 }),
    },
    { additionalProperties: false },
);
const remoteProjectCreationTransportSchema = Type.Object(
    {
        ...createRemoteProjectRequestSchema.properties,
        temporaryGitSecret: Type.Optional(temporaryGitSecretSchema),
    },
    { additionalProperties: false },
);
const pluginAppResourceReadBodySchema = Type.Object(
    { uri: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
const pluginAppToolCallBodySchema = Type.Object(
    {
        arguments: Type.Unknown(),
        name: Type.String({ minLength: 1 }),
        server: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
const pluginAppStorageBodySchema = Type.Object(
    { key: Type.String({ minLength: 1 }), value: Type.Optional(Type.Unknown()) },
    { additionalProperties: false },
);
const emptyObjectSchema = Type.Object({}, { additionalProperties: false });

async function handleRequest(
    ctx: Context,
    request: IncomingMessage,
    response: ServerResponse,
    store: SessionStore,
    modelCatalog: ModelCatalog,
    identity: DaemonIdentity,
    fileSearchService: FileSearchServiceContract,
    runtimeConfig: ProtocolServerRuntimeConfig,
    token: string,
    onShutdown: (() => void) | undefined,
    defaultDocker: DockerExecutionConfig | undefined,
    taskDrain: TaskDrain | undefined,
    getProviderQuota:
        | ((
              providerId: string,
              ownerInstanceId: string,
              credential?: ProviderCredentialProvenance,
          ) => Promise<ProviderQuota | undefined>)
        | undefined,
    sessionEventStreamLeases: Set<SessionEventStreamLease>,
    sessionTerminals: SessionTerminalTracker,
    appletContextTokens: AppletContextTokenStore,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://unix");
    const route = matchRoute(url.pathname);
    const p2pPeerRoute = matchP2pPeerRoute(url);
    if (route?.name === "applet-context") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const contextToken = url.searchParams.get("token");
        const context =
            contextToken === null
                ? undefined
                : appletContextTokens.exchange(route.appletName, contextToken);
        if (context === undefined) {
            sendJson(response, 401, { error: "Unauthorized" });
            return;
        }
        response.setHeader("cache-control", "no-store");
        sendJson<AppletContext>(response, 200, context);
        return;
    }
    if (!isAuthorizedProtocolRequest(request, token)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
    }
    if (p2pPeerRoute !== undefined) {
        if (runtimeConfig.p2pProxyShutdown.aborted) {
            sendJson(response, 503, { error: "The local daemon is shutting down." });
            return;
        }
        const p2pNetwork = runtimeConfig.resolveP2pNetwork();
        if (p2pNetwork === undefined) {
            sendJson(response, 503, { error: "P2P networking is unavailable." });
            return;
        }
        if (p2pNetwork.peerApiAvailable?.(p2pPeerRoute.peerId) === false) {
            sendJson(response, 403, {
                error: "P2P API sharing is disabled for that peer connection.",
            });
            return;
        }
        await proxyP2pHttpRequest(
            ctx,
            p2pNetwork,
            p2pPeerRoute.peerId,
            p2pPeerRoute.path,
            request,
            response,
            runtimeConfig.prepareP2pRequest,
            runtimeConfig.p2pProxyShutdown,
        );
        return;
    }
    if (route === undefined) {
        sendJson(response, 404, { error: "Not found" });
        return;
    }

    if (request.method === "GET" && route.name === "health") {
        sendJson<HealthResponse>(
            response,
            200,
            healthResponse(modelCatalog, identity, runtimeConfig.globalEventQueue.durable),
        );
        return;
    }
    if (route.name === "onboarding" || route.name === "onboarding-murmur") {
        const expectedMethod = route.name === "onboarding" ? "GET" : "PUT";
        if (request.method !== expectedMethod) {
            response.setHeader("allow", expectedMethod);
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        if (p2pPeerId(request) !== undefined) {
            sendJson(response, 403, { error: "Onboarding is available only on the local Rig." });
            return;
        }
        const onboarding = runtimeConfig.onboarding;
        if (onboarding === undefined) {
            sendJson(response, 503, { error: "Rig onboarding is unavailable." });
            return;
        }
        if (route.name === "onboarding") {
            sendJson(response, 200, await onboarding.status(ctx));
            return;
        }
        const body = await readJson<unknown>(request, 8 * 1024);
        if (!Value.Check(onboardMurmurRequestSchema, body)) {
            sendJson(response, 400, { error: "The Murmur onboarding choice is invalid." });
            return;
        }
        try {
            sendJson<OnboardMurmurResponse>(
                response,
                200,
                await onboarding.onboardMurmur(ctx, body as OnboardMurmurRequest),
            );
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (request.method === "GET" && route.name === "p2p-status") {
        const status = runtimeConfig.p2pStatus?.() ?? {
            name: runtimeConfig.p2pNode?.().name ?? "Rig",
            transports: [],
        };
        const network = runtimeConfig.resolveP2pNetwork();
        sendJson<P2pStatus>(
            response,
            200,
            projectP2pApiStatus(
                status,
                network === undefined ? undefined : (peerId) => network.peerApiAvailable(peerId),
                p2pPeerId(request),
            ),
        );
        return;
    }
    if (route.name === "inference-credentials") {
        if (request.method !== "PUT") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const authenticatedOwnerId = p2pPeerId(request);
        if (authenticatedOwnerId === undefined) {
            sendJson(response, 403, {
                error: "Inference credentials must arrive from an authenticated peer Rig.",
            });
            return;
        }
        if (runtimeConfig.replaceP2pCredentials === undefined) {
            sendJson(response, 503, { error: "P2P inference credentials are unavailable." });
            return;
        }
        const body = await readJson<unknown>(request, 8 * 1024 * 1024);
        if (!Value.Check(p2pEncryptedCredentialSnapshotSchema, body)) {
            sendJson(response, 400, { error: "The encrypted credential snapshot is invalid." });
            return;
        }
        try {
            sendJson(
                response,
                200,
                await runtimeConfig.replaceP2pCredentials(ctx, authenticatedOwnerId, body),
            );
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (error instanceof P2pCredentialVersionConflictError) {
                sendJson(response, 409, {
                    error: errorToMessage(error),
                    version: error.currentVersion,
                });
                return;
            }
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }
    if (
        route.name === "sharing" ||
        route.name === "sharing-invitations" ||
        route.name === "sharing-folder-shares" ||
        route.name === "sharing-contact-requests" ||
        route.name === "sharing-contact-request" ||
        route.name === "sharing-contact"
    ) {
        if (p2pPeerId(request) !== undefined) {
            sendJson(response, 403, { error: "Sharing is available only on the local Rig." });
            return;
        }
        const sharing = runtimeConfig.sharing;
        if (sharing === undefined) {
            sendJson(response, 503, { error: "Sharing is unavailable." });
            return;
        }
        try {
            if (route.name === "sharing" && request.method === "GET") {
                sendJson<SharingSnapshot>(response, 200, await sharing.snapshot(ctx));
                return;
            }
            if (route.name === "sharing" && request.method === "DELETE") {
                sendJson<SharingSnapshot>(response, 200, await sharing.reset(ctx));
                return;
            }
            if (route.name === "sharing-invitations" && request.method === "POST") {
                sendJson<CreateSharingInvitationResponse>(
                    response,
                    201,
                    await sharing.createInvitation(ctx),
                );
                return;
            }
            if (route.name === "sharing-folder-shares" && request.method === "POST") {
                const body = await readJson<unknown>(request, 64 * 1024);
                if (!Value.Check(createFolderShareRequestSchema, body)) {
                    sendJson(response, 400, {
                        error: "A folder share needs a folder and at least one contact.",
                    });
                    return;
                }
                const input = body as CreateFolderShareRequest;
                sendJson<FolderShareStatus>(
                    response,
                    201,
                    await sharing.createFolderShare(ctx, input.folderId, input.contacts),
                );
                return;
            }
            if (route.name === "sharing-contact-requests" && request.method === "POST") {
                const body = await readJson<unknown>(request, 8 * 1024);
                if (!Value.Check(requestSharingContactRequestSchema, body)) {
                    sendJson(response, 400, { error: "The contact invitation is invalid." });
                    return;
                }
                sendJson<SharingOutgoingContactRequestResponse>(response, 202, {
                    request: await sharing.requestContact(
                        ctx,
                        (body as RequestSharingContactRequest).invitation,
                    ),
                });
                return;
            }
            if (
                route.name === "sharing-contact-request" &&
                route.operation === "accept" &&
                request.method === "POST"
            ) {
                await sharing.acceptContact(ctx, route.requestId);
                sendJson<SharingSnapshot>(response, 200, await sharing.snapshot(ctx));
                return;
            }
            if (
                route.name === "sharing-contact-request" &&
                route.operation === undefined &&
                request.method === "DELETE"
            ) {
                await sharing.rejectContact(ctx, route.requestId);
                sendJson<SharingSnapshot>(response, 200, await sharing.snapshot(ctx));
                return;
            }
            if (route.name === "sharing-contact" && request.method === "DELETE") {
                await sharing.removeContact(ctx, route.identity);
                sendJson<SharingSnapshot>(response, 200, await sharing.snapshot(ctx));
                return;
            }
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            const message = errorToMessage(error);
            sendJson(response, message === "Contact request not found." ? 404 : 409, {
                error: message,
            });
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }
    if (route.name === "profiles" || route.name === "profile") {
        const profiles = runtimeConfig.profiles;
        if (profiles === undefined) {
            sendJson(response, 503, { error: "Rig profiles are unavailable." });
            return;
        }
        const authenticatedPeerId = p2pPeerId(request);
        if (
            authenticatedPeerId !== undefined &&
            (runtimeConfig.canP2pPeerProvision?.(authenticatedPeerId) ??
                runtimeConfig.canP2pPeerConfigure?.(authenticatedPeerId)) !== true
        ) {
            sendJson(response, 403, {
                error: "That Rig is not trusted to provision its human profiles.",
            });
            return;
        }
        if (request.method === "GET" && route.name === "profiles") {
            sendJson<ListRigProfilesResponse>(response, 200, {
                profiles: [...(await profiles.list(ctx))],
            });
            return;
        }
        if (request.method === "GET" && route.name === "profile") {
            const profile = await profiles.get(ctx, route.profileId);
            if (profile === undefined) {
                sendJson(response, 404, { error: "Rig profile not found." });
                return;
            }
            sendJson<RigProfileResponse>(response, 200, { profile });
            return;
        }
        if (request.method === "POST" && route.name === "profiles") {
            if (
                authenticatedPeerId !== undefined ||
                runtimeConfig.p2pNode?.().role === "secondary"
            ) {
                sendJson(response, 403, {
                    error: "Profiles are created by their primary Rig.",
                });
                return;
            }
            const body = await readJson<unknown>(request, 34 * 1024 * 1024);
            if (!Value.Check(createRigProfileRequestSchema, body)) {
                sendJson(response, 400, { error: "The Rig profile is invalid." });
                return;
            }
            try {
                const input = body as CreateRigProfileRequest;
                const photo =
                    input.photo === undefined
                        ? undefined
                        : await normalizeRigProfilePhoto(input.photo);
                sendJson<RigProfileResponse>(response, 201, {
                    profile: await profiles.create(ctx, {
                        email: input.email,
                        name: input.name,
                        ...(photo === undefined ? {} : { photo }),
                    }),
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 400, { error: errorToMessage(error) });
            }
            return;
        }
        if (request.method === "PATCH" && route.name === "profile") {
            if (
                authenticatedPeerId !== undefined ||
                runtimeConfig.p2pNode?.().role === "secondary"
            ) {
                sendJson(response, 403, {
                    error: "Only a profile's primary Rig may change it.",
                });
                return;
            }
            const body = await readJson<unknown>(request, 34 * 1024 * 1024);
            if (!Value.Check(updateRigProfileRequestSchema, body)) {
                sendJson(response, 400, { error: "The Rig profile update is invalid." });
                return;
            }
            try {
                const input = body as UpdateRigProfileRequest;
                const photo =
                    input.photo === undefined || input.photo === null
                        ? input.photo
                        : await normalizeRigProfilePhoto(input.photo);
                const profile = await profiles.update(ctx, route.profileId, {
                    ...(input.email === undefined ? {} : { email: input.email }),
                    ...(input.name === undefined ? {} : { name: input.name }),
                    ...(photo === undefined ? {} : { photo }),
                });
                if (profile === undefined) {
                    sendJson(response, 404, { error: "Rig profile not found." });
                    return;
                }
                sendJson<RigProfileResponse>(response, 200, { profile });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 400, { error: errorToMessage(error) });
            }
            return;
        }
        if (request.method === "PUT" && route.name === "profile") {
            if (authenticatedPeerId === undefined) {
                sendJson(response, 403, {
                    error: "A replicated profile must arrive from its authenticated parent Rig.",
                });
                return;
            }
            const body = await readJson<unknown>(request, 512 * 1024);
            if (!Value.Check(replicateRigProfileRequestSchema, body)) {
                sendJson(response, 400, { error: "The replicated Rig profile is invalid." });
                return;
            }
            const input = body as ReplicateRigProfileRequest;
            if (input.profile.id !== route.profileId) {
                sendJson(response, 400, {
                    error: "The replicated Rig profile identity does not match its route.",
                });
                return;
            }
            if (input.profile.photo !== undefined) {
                try {
                    await validateRigProfilePhoto(input.profile.photo);
                } catch {
                    sendJson(response, 400, {
                        error: "The replicated Rig profile photo is invalid.",
                    });
                    return;
                }
            }
            try {
                sendJson<RigProfileResponse>(response, 200, {
                    profile: await profiles.replicate(ctx, input.profile, authenticatedPeerId),
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 409, { error: errorToMessage(error) });
            }
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }
    if (route.name === "p2p-invitations") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const p2pPairing = runtimeConfig.resolveP2pPairing();
        if (p2pPairing === undefined) {
            sendJson(response, 503, { error: "P2P pairing is unavailable." });
            return;
        }
        sendJson<CreateP2pInvitationResponse>(response, 201, await p2pPairing.createInvitation());
        return;
    }
    if (route.name === "p2p-joins") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const p2pPairing = runtimeConfig.resolveP2pPairing();
        if (p2pPairing === undefined) {
            sendJson(response, 503, { error: "P2P pairing is unavailable." });
            return;
        }
        const body = await readCheckedBody(request, joinP2pInvitationRequestSchema);
        if (body === undefined) {
            sendJson(response, 400, { error: "The P2P invitation request is invalid." });
            return;
        }
        sendJson<JoinP2pInvitationResponse>(response, 202, await p2pPairing.join(body.invitation));
        return;
    }
    if (route.name === "p2p-pairing") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const state = runtimeConfig.resolveP2pPairing()?.get(route.pairingId);
        if (state === undefined) {
            sendJson(response, 404, { error: "P2P pairing not found." });
            return;
        }
        sendJson<P2pPairingState>(response, 200, state);
        return;
    }
    if (route.name === "p2p-pairing-answer") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const p2pPairing = runtimeConfig.resolveP2pPairing();
        if (p2pPairing === undefined) {
            sendJson(response, 503, { error: "P2P pairing is unavailable." });
            return;
        }
        const body = await readCheckedBody(request, answerP2pVerificationRequestSchema);
        if (body === undefined) {
            sendJson(response, 400, { error: "The P2P verification answer is invalid." });
            return;
        }
        sendJson<P2pPairingState>(response, 200, p2pPairing.answer(route.pairingId, body.accept));
        return;
    }

    if (request.method === "GET" && route.name === "installation") {
        sendJson<RigDaemonInstallationDiscovery>(response, 200, {
            daemonProtocolVersion: RIG_PROTOCOL_VERSION,
            daemonVersion: identity.version,
            data: {
                epoch: store.dataEpoch,
                schemaCompatibility: "current",
                schemaVersion: store.dataSchemaVersion,
                status: "initialized",
            },
            formatVersion: 1,
            source: "daemon",
        });
        return;
    }
    if (route.name.startsWith("happy-cloud-")) {
        const allowedMethod = route.name === "happy-cloud-commands" ? "POST" : "GET";
        if (request.method !== allowedMethod) {
            response.setHeader("allow", allowedMethod);
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const happyCloud = runtimeConfig.happyCloud;
        if (happyCloud === undefined) {
            sendJson(response, 503, { error: "Happy Cloud settings are unavailable." });
            return;
        }
        if (route.name === "happy-cloud-status") {
            sendJson<HappyCloudStatus>(response, 200, await happyCloud.status(ctx));
            return;
        }
        if (route.name === "happy-cloud-commands") {
            let command: HappyCloudCommand;
            try {
                command = Value.Decode(
                    happyCloudCommandSchema,
                    await readJson<unknown>(request, HAPPY_CLOUD_CIPHERTEXT_MAX_LENGTH + 4_096),
                );
            } catch (error) {
                if (
                    error instanceof InvalidJsonBodyError ||
                    error instanceof RequestBodyTooLargeError
                ) {
                    throw error;
                }
                sendJson(response, 400, { error: "The Happy Cloud command is invalid." });
                return;
            }
            const headerMutationId = requestMutationId(request);
            if (headerMutationId === undefined || headerMutationId !== command.mutationId) {
                sendJson(response, 400, {
                    error: "The Happy Cloud mutation id header is required and must match the body.",
                });
                return;
            }
            try {
                sendJson<HappyCloudCommandResponse>(
                    response,
                    200,
                    await happyCloud.apply(ctx, command),
                );
                return;
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                if (error instanceof HappyCloudPersistenceError) {
                    const conflict =
                        error.code === "version_conflict" || error.code === "mutation_reused";
                    sendJson(response, conflict ? 409 : 403, {
                        code: error.code,
                        error: error.message,
                        status: await happyCloud.status(ctx),
                    });
                    return;
                }
                throw error;
            }
        }
        if (route.name === "happy-cloud-profile") {
            const profile = await happyCloud.getProfile(ctx);
            if (profile === undefined) {
                sendJson(response, 404, { error: "No encrypted Happy Profile is stored." });
                return;
            }
            sendJson<HappyCloudProfileCiphertextResponse>(response, 200, profile);
            return;
        }
        if (route.name === "happy-cloud-session-blob") {
            let cloudSessionId: string;
            try {
                cloudSessionId = Value.Decode(happyCloudSessionIdSchema, route.cloudSessionId);
            } catch {
                sendJson(response, 400, {
                    error: "The encrypted mobile session blob id is invalid.",
                });
                return;
            }
            const blob = await happyCloud.getSessionBlob(ctx, cloudSessionId);
            if (blob === undefined) {
                sendJson(response, 404, {
                    error: "No encrypted mobile session blob is stored.",
                });
                return;
            }
            sendJson<HappyCloudSessionBlobResponse>(response, 200, blob);
            return;
        }
    }

    if (request.method === "POST" && route.name === "shutdown") {
        taskDrain?.beginClose();
        sendJson<ShutdownServerResponse>(response, 202, {
            pid: process.pid,
            shuttingDown: true,
        });
        setImmediate(() => onShutdown?.());
        return;
    }

    if (request.method === "GET" && route.name === "plugins") {
        if (runtimeConfig.plugins === undefined) {
            sendJson(response, 503, { error: "Plugins are unavailable while Rig is starting." });
            return;
        }
        const cursor = store.liveEvents.cursor();
        sendJson(response, 200, { cursor, ...(await runtimeConfig.plugins.list(ctx)) });
        return;
    }
    if (request.method === "POST" && route.name === "plugin-catalog") {
        const plugins = runtimeConfig.plugins;
        if (plugins === undefined) {
            sendPluginManagementError(
                response,
                503,
                "plugins_unavailable",
                "Plugins are unavailable while Rig is starting.",
            );
            return;
        }
        let body;
        try {
            body = Value.Decode(
                discoverPluginCatalogRequestSchema,
                await readJson<unknown>(request, 64 * 1024),
            );
        } catch (error) {
            if (error instanceof InvalidJsonBodyError) {
                sendPluginManagementError(
                    response,
                    400,
                    "invalid_request",
                    "Plugin discovery settings must be valid JSON.",
                );
                return;
            }
            if (error instanceof RequestBodyTooLargeError) {
                sendPluginManagementError(
                    response,
                    413,
                    "invalid_request",
                    "Plugin discovery settings are larger than the allowed limit.",
                );
                return;
            }
            sendPluginManagementError(
                response,
                400,
                "invalid_request",
                "Plugin discovery settings are invalid.",
            );
            return;
        }
        const operation = requestOperationSignal(request, response);
        try {
            const catalog = await plugins.discoverRepository(ctx, body, operation.signal);
            if (!response.destroyed) sendJson(response, 200, catalog);
        } catch (error) {
            if (!response.destroyed && !operation.signal.aborted) {
                if (error instanceof PluginCatalogError) {
                    const status =
                        error.code === "catalog_not_found" || error.code === "repository_not_found"
                            ? 404
                            : error.code === "invalid_source"
                              ? 400
                              : 422;
                    sendPluginManagementError(
                        response,
                        status,
                        error.code === "invalid_source" ? "invalid_request" : error.code,
                        error.message,
                    );
                } else {
                    sendPluginManagementError(
                        response,
                        502,
                        "source_unavailable",
                        errorToMessage(error),
                    );
                }
            }
        } finally {
            operation.detach();
        }
        return;
    }
    if (request.method === "POST" && route.name === "plugins") {
        const plugins = runtimeConfig.plugins;
        if (plugins === undefined) {
            sendPluginManagementError(
                response,
                503,
                "plugins_unavailable",
                "Plugins are unavailable while Rig is starting.",
            );
            return;
        }
        let body: InstallPluginRequest;
        try {
            body = Value.Decode(
                installPluginRequestSchema,
                await readJson<unknown>(request, 64 * 1024),
            );
            if (
                body.source.type === "local-directory" &&
                !isAbsolute(body.source.sourceDirectory)
            ) {
                sendPluginManagementError(
                    response,
                    400,
                    "invalid_request",
                    "Plugin sourceDirectory must be an absolute path on the machine running Rig.",
                );
                return;
            }
        } catch (error) {
            if (error instanceof InvalidJsonBodyError) {
                sendPluginManagementError(
                    response,
                    400,
                    "invalid_request",
                    "Plugin installation settings must be valid JSON.",
                );
                return;
            }
            if (error instanceof RequestBodyTooLargeError) {
                sendPluginManagementError(
                    response,
                    413,
                    "invalid_request",
                    "Plugin installation settings are larger than the allowed limit.",
                );
                return;
            }
            sendPluginManagementError(
                response,
                400,
                "invalid_request",
                "Plugin installation settings are invalid.",
            );
            return;
        }
        const operation = requestOperationSignal(request, response);
        try {
            const plugin =
                body.source.type === "local-directory"
                    ? await plugins.install(ctx, {
                          fs: createNodeFileSystemContext(body.source.sourceDirectory, {
                              permissionMode: () => "full_access",
                          }),
                          requestId: body.requestId,
                          signal: operation.signal,
                          sourceDirectory: body.source.sourceDirectory,
                      })
                    : await plugins.installFromGitHub(ctx, body.source, {
                          fs: createNodeFileSystemContext(process.cwd(), {
                              permissionMode: () => "full_access",
                          }),
                          requestId: body.requestId,
                          signal: operation.signal,
                      });
            if (!response.destroyed) {
                sendJson<InstallPluginResponse>(response, 201, { plugin });
            }
        } catch (error) {
            if (!response.destroyed && !operation.signal.aborted) {
                if (error instanceof PluginCatalogError) {
                    const status = error.code === "invalid_source" ? 400 : 409;
                    sendPluginManagementError(
                        response,
                        status,
                        error.code === "invalid_source" ? "invalid_request" : error.code,
                        error.message,
                    );
                } else {
                    sendPluginManagementError(
                        response,
                        422,
                        "install_failed",
                        errorToMessage(error),
                    );
                }
            }
        } finally {
            operation.detach();
        }
        return;
    }
    if (request.method === "DELETE" && route.name === "plugin-uninstall") {
        const plugins = runtimeConfig.plugins;
        if (plugins === undefined) {
            sendPluginManagementError(
                response,
                503,
                "plugins_unavailable",
                "Plugins are unavailable while Rig is starting.",
            );
            return;
        }
        const operation = requestOperationSignal(request, response);
        try {
            const plugin = await plugins.uninstall(ctx, {
                fs: createNodeFileSystemContext(process.cwd(), {
                    permissionMode: () => "full_access",
                }),
                name: route.pluginName,
                signal: operation.signal,
            });
            if (!response.destroyed) {
                sendJson<UninstallPluginResponse>(response, 200, { plugin });
            }
        } catch (error) {
            if (!response.destroyed && !operation.signal.aborted) {
                if (error instanceof PluginNotFoundError) {
                    sendPluginManagementError(response, 404, "plugin_not_found", error.message);
                } else {
                    sendPluginManagementError(
                        response,
                        500,
                        "uninstall_failed",
                        errorToMessage(error),
                    );
                }
            }
        } finally {
            operation.detach();
        }
        return;
    }
    if (request.method === "GET" && route.name === "plugin-log") {
        if (runtimeConfig.plugins === undefined) {
            sendJson(response, 503, { error: "Plugins are unavailable while Rig is starting." });
            return;
        }
        sendJson(response, 200, {
            log: await runtimeConfig.plugins.readLog(ctx, route.pluginName),
        });
        return;
    }
    if (request.method === "GET" && route.name === "plugin-icon") {
        const plugins = runtimeConfig.plugins;
        if (plugins === undefined) {
            sendJson(response, 503, { error: "Plugins are unavailable while Rig is starting." });
            return;
        }
        const operation = requestOperationSignal(request, response);
        try {
            const icon = await plugins.readIcon(
                ctx,
                route.pluginId,
                route.generation,
                operation.signal,
            );
            if (!response.destroyed) {
                response.statusCode = 200;
                response.setHeader("cache-control", "private, max-age=31536000, immutable");
                response.setHeader("content-length", String(icon.body.byteLength));
                response.setHeader("content-type", icon.mediaType);
                response.setHeader("x-content-type-options", "nosniff");
                response.end(icon.body);
            }
        } catch (error) {
            if (response.destroyed || operation.signal.aborted) return;
            if (!(error instanceof PluginIconError)) throw error;
            const status =
                error.code === "plugin_not_found"
                    ? 404
                    : error.code === "stale_generation"
                      ? 409
                      : 422;
            sendJson(response, status, { error: { code: error.code, message: error.message } });
        } finally {
            operation.detach();
        }
        return;
    }
    if (request.method === "POST" && route.name === "plugin-app-resource-read") {
        const plugins = runtimeConfig.plugins;
        if (plugins === undefined) {
            sendJson(response, 503, { error: "Plugins are unavailable while Rig is starting." });
            return;
        }
        try {
            const body = Value.Decode(
                pluginAppResourceReadBodySchema,
                await readJson<unknown>(request, 64 * 1024),
            );
            const resource = plugins.readAppResource(route.appId, route.generation, body.uri);
            sendJson(response, 200, { contents: [resource] });
        } catch (error) {
            sendPluginAppError(response, error);
        }
        return;
    }
    if (request.method === "POST" && route.name === "plugin-app-tool-call") {
        const plugins = runtimeConfig.plugins;
        if (plugins === undefined) {
            sendJson(response, 503, { error: "Plugins are unavailable while Rig is starting." });
            return;
        }
        let body: { arguments: unknown; name: string; server: string };
        try {
            body = Value.Decode(
                pluginAppToolCallBodySchema,
                await readJson<unknown>(request, 1024 * 1024),
            );
        } catch (error) {
            if (
                error instanceof InvalidJsonBodyError ||
                error instanceof RequestBodyTooLargeError
            ) {
                throw error;
            }
            sendJson(response, 400, { error: "MCP App tool input is invalid." });
            return;
        }
        const controller = new AbortController();
        const abort = () => {
            if (!response.writableEnded) controller.abort();
        };
        response.once("close", abort);
        try {
            const result = await plugins.callAppTool(
                ctx,
                route.appId,
                route.generation,
                body.server,
                body.name,
                body.arguments,
                controller.signal,
            );
            sendJson(response, 200, { result });
        } catch (error) {
            if (!response.destroyed) sendPluginAppError(response, error);
        } finally {
            response.off("close", abort);
        }
        return;
    }
    if (request.method === "POST" && route.name === "plugin-app-storage") {
        const plugins = runtimeConfig.plugins;
        if (plugins === undefined) {
            sendJson(response, 503, { error: "Plugins are unavailable while Rig is starting." });
            return;
        }
        try {
            const rawBody = await readJson<unknown>(request, 128 * 1024);
            if (route.operation === "list") {
                Value.Decode(emptyObjectSchema, rawBody);
                sendJson(response, 200, {
                    keys: await plugins.storageList(ctx, route.appId, route.generation),
                });
                return;
            }
            const body = Value.Decode(pluginAppStorageBodySchema, rawBody);
            if (route.operation === "get") {
                sendJson(response, 200, {
                    value: await plugins.storageGet(ctx, route.appId, route.generation, body.key),
                });
            } else if (route.operation === "set") {
                if (!Object.hasOwn(body, "value")) {
                    throw new PluginAppError("invalid_input", "Storage set requires a value.");
                }
                await plugins.storageSet(ctx, route.appId, route.generation, body.key, body.value);
                sendJson(response, 200, {});
            } else {
                await plugins.storageDelete(ctx, route.appId, route.generation, body.key);
                sendJson(response, 200, {});
            }
        } catch (error) {
            sendPluginAppError(response, error);
        }
        return;
    }

    if (route.name === "slots") {
        if (request.method === "GET") {
            const slot = url.searchParams.get("slot") ?? undefined;
            if (slot !== undefined && !Value.Check(slotNameSchema, slot)) {
                sendSlotManagementError(
                    response,
                    400,
                    "invalid_request",
                    `Unknown slot ${JSON.stringify(slot)}.`,
                );
                return;
            }
            const projectId = url.searchParams.get("projectId") ?? undefined;
            const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
            const sessionId = url.searchParams.get("sessionId") ?? undefined;
            sendJson<ListSlotEntriesResponse>(response, 200, {
                entries: await store.slots.list(ctx, {
                    ...(slot === undefined ? {} : { slot }),
                    ...(projectId === undefined ? {} : { projectId }),
                    ...(workspaceId === undefined ? {} : { workspaceId }),
                    ...(sessionId === undefined ? {} : { sessionId }),
                }),
            });
            return;
        }
        if (request.method === "POST") {
            let body: unknown;
            try {
                body = await readJson<unknown>(request, 256 * 1024);
            } catch (error) {
                sendInvalidSlotBody(response, error);
                return;
            }
            try {
                sendJson<SlotEntryResponse>(response, 201, {
                    entry: await store.slots.create(ctx, body as CreateSlotEntryRequest),
                });
            } catch (error) {
                if (error instanceof SlotEntryInvalidError) {
                    sendSlotManagementError(response, 400, "invalid_entry", error.message);
                    return;
                }
                throw error;
            }
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }
    if (route.name === "slot-entry") {
        if (request.method === "PATCH") {
            let body: unknown;
            try {
                body = await readJson<unknown>(request, 256 * 1024);
            } catch (error) {
                sendInvalidSlotBody(response, error);
                return;
            }
            try {
                sendJson<SlotEntryResponse>(response, 200, {
                    entry: await store.slots.update(
                        ctx,
                        route.slotEntryId,
                        body as UpdateSlotEntryRequest,
                    ),
                });
            } catch (error) {
                if (error instanceof SlotEntryInvalidError) {
                    sendSlotManagementError(response, 400, "invalid_entry", error.message);
                    return;
                }
                if (error instanceof SlotEntryNotFoundError) {
                    sendSlotManagementError(response, 404, "entry_not_found", error.message);
                    return;
                }
                throw error;
            }
            return;
        }
        if (request.method === "DELETE") {
            try {
                sendJson<SlotEntryResponse>(response, 200, {
                    entry: await store.slots.remove(ctx, route.slotEntryId),
                });
            } catch (error) {
                if (error instanceof SlotEntryNotFoundError) {
                    sendSlotManagementError(response, 404, "entry_not_found", error.message);
                    return;
                }
                throw error;
            }
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }
    if (route.name === "applets") {
        if (request.method === "GET") {
            sendJson<ListAppletsResponse>(response, 200, {
                applets: await store.applets.list(ctx),
            });
            return;
        }
        if (request.method === "POST") {
            let body: unknown;
            try {
                body = await readJson<unknown>(request, 64 * 1024);
            } catch (error) {
                sendInvalidAppletBody(response, error);
                return;
            }
            if (!Value.Check(createAppletRequestSchema, body)) {
                sendAppletManagementError(
                    response,
                    400,
                    "invalid_request",
                    "An applet import needs a kebab-case name, description, purpose, author session, source folder path, and 512 by 512 PNG icon path.",
                );
                return;
            }
            try {
                sendJson<AppletResponse>(response, 201, {
                    applet: await store.applets.create(ctx, body),
                });
            } catch (error) {
                if (error instanceof AppletInvalidError) {
                    sendAppletManagementError(response, 400, "invalid_applet", error.message);
                    return;
                }
                throw error;
            }
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }
    if (route.name === "applet-versions" || route.name === "applet-revert") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        let body: unknown;
        try {
            body = await readJson<unknown>(request, 64 * 1024);
        } catch (error) {
            sendInvalidAppletBody(response, error);
            return;
        }
        try {
            const applet =
                route.name === "applet-versions"
                    ? await store.applets.update(ctx, route.appletName, body as UpdateAppletRequest)
                    : await store.applets.revert(
                          ctx,
                          route.appletName,
                          body as RevertAppletRequest,
                      );
            sendJson<AppletResponse>(response, 200, { applet });
        } catch (error) {
            if (error instanceof AppletInvalidError) {
                sendAppletManagementError(response, 400, "invalid_applet", error.message);
                return;
            }
            if (error instanceof AppletNotFoundError) {
                sendAppletManagementError(response, 404, "applet_not_found", error.message);
                return;
            }
            throw error;
        }
        return;
    }
    if (route.name === "applet-open") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        let body: unknown;
        try {
            body = await readJson<unknown>(request, 64 * 1024);
        } catch (error) {
            sendInvalidAppletBody(response, error);
            return;
        }
        if (!Value.Check(resolveAppletOpenRequestSchema, body)) {
            sendAppletManagementError(
                response,
                400,
                "invalid_request",
                "An applet open request must contain only a relative path, string query values, and optional session, project, or workspace ids.",
            );
            return;
        }
        const applet = await store.applets.get(ctx, route.appletName);
        if (applet === undefined) {
            sendAppletManagementError(
                response,
                404,
                "applet_not_found",
                `No applet named ${JSON.stringify(route.appletName)} exists.`,
            );
            return;
        }
        const resolution = await resolveAppletContext(ctx, store, applet, body);
        if (resolution.type === "error") {
            sendAppletManagementError(response, 400, resolution.code, resolution.message);
            return;
        }
        sendJson<ResolveAppletOpenResponse>(response, 200, {
            url: resolveAppletOpenUrl(applet.name, body, resolution.context, appletContextTokens),
        });
        return;
    }
    if (route.name === "applet-icon") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        if ((await store.applets.get(ctx, route.appletName)) === undefined) {
            sendAppletManagementError(
                response,
                404,
                "applet_not_found",
                `No applet named ${JSON.stringify(route.appletName)} exists.`,
            );
            return;
        }
        const icon = await store.applets.readIcon(ctx, route.appletName, route.format);
        if (icon.type !== "file") {
            sendAppletManagementError(response, 404, "applet_not_found", "Applet icon not found.");
            return;
        }
        response.writeHead(200, {
            "cache-control": "private, max-age=31536000, immutable",
            "content-length": icon.data.byteLength,
            "content-type": icon.contentType,
            "x-content-type-options": "nosniff",
        });
        response.end(icon.data);
        return;
    }
    if (route.name === "applet-file") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const applet = await store.applets.get(ctx, route.appletName);
        if (applet === undefined) {
            sendAppletManagementError(
                response,
                404,
                "applet_not_found",
                `No applet named ${JSON.stringify(route.appletName)} exists.`,
            );
            return;
        }
        const file = await readAppletFile(
            route.appletName,
            applet.currentVersion,
            route.appletFilePath,
        );
        if (file.type === "invalid_path") {
            sendAppletManagementError(
                response,
                400,
                "invalid_request",
                "Applet file paths may not traverse outside the applet folder or name dotfiles.",
            );
            return;
        }
        if (file.type === "not_found") {
            sendAppletManagementError(response, 404, "applet_not_found", "Applet file not found.");
            return;
        }
        response.writeHead(200, {
            "content-length": file.data.byteLength,
            "content-type": file.contentType,
            "x-content-type-options": "nosniff",
        });
        response.end(file.data);
        return;
    }
    if (route.name === "worklets") {
        await handleWorkletRequest(request, response, { name: "worklets" }, ctx, runtimeConfig);
        return;
    }
    if (
        route.name === "worklet" ||
        route.name === "worklet-versions" ||
        route.name === "worklet-revert" ||
        route.name === "worklet-log" ||
        route.name === "worklet-icon"
    ) {
        await handleWorkletRequest(request, response, route, ctx, runtimeConfig);
        return;
    }
    if (request.method === "POST" && route.name === "debug-inspector") {
        if (runtimeConfig.onStartInspector === undefined) {
            sendJson(response, 409, { error: "This daemon cannot start a debugger." });
            return;
        }
        sendJson<StartInspectorResponse>(response, 200, await runtimeConfig.onStartInspector(ctx));
        return;
    }

    if (request.method === "DELETE" && route.name === "debug-inspector") {
        if (runtimeConfig.onStopInspector === undefined) {
            sendJson(response, 409, { error: "This daemon cannot stop a debugger." });
            return;
        }
        sendJson<StopInspectorResponse>(response, 200, await runtimeConfig.onStopInspector(ctx));
        return;
    }

    if (request.method === "POST" && route.name === "happy-reload") {
        if (runtimeConfig.onReloadHappy === undefined) {
            sendJson(response, 409, { error: "This daemon cannot reload Happy credentials." });
            return;
        }
        sendJson(response, 200, { enabled: await runtimeConfig.onReloadHappy(ctx) });
        return;
    }

    if (request.method === "GET" && route.name === "models") {
        const ownerInstanceId = p2pPeerId(request);
        sendJson<ListModelsResponse>(response, 200, {
            catalog:
                ownerInstanceId === undefined
                    ? modelCatalog
                    : (runtimeConfig.resolveModelCatalog?.(ownerInstanceId) ?? modelCatalog),
        });
        return;
    }

    if (request.method === "GET" && route.name === "presence") {
        sendJson<GetPresenceResponse>(response, 200, { presence: store.presence.state() });
        return;
    }

    if (request.method === "PUT" && route.name === "presence") {
        const body = await readJson<SetPresenceRequestBody>(request);
        if (typeof body.presenceId !== "string" || body.presenceId.trim().length === 0) {
            sendJson(response, 400, { error: "Choose which presence to switch to." });
            return;
        }
        if (
            body.until !== undefined &&
            (typeof body.until !== "number" || !Number.isFinite(body.until))
        ) {
            sendJson(response, 400, { error: "The expiry must be a time." });
            return;
        }
        try {
            const presence = await store.presence.setPresence({
                ...(body.fallbackPresenceId === undefined
                    ? {}
                    : { fallbackPresenceId: body.fallbackPresenceId }),
                presenceId: body.presenceId,
                ...(body.until === undefined ? {} : { until: body.until }),
            });
            sendJson<SetPresenceResponse>(response, 200, { presence });
        } catch (error) {
            sendJson(response, 400, { error: errorToMessage(error) });
        }
        return;
    }

    const routeName = route.name;
    if (
        routeName === "folders" ||
        routeName === "folder" ||
        routeName === "folder-archive" ||
        routeName === "folder-move"
    ) {
        await serveFolderRequest(
            ctx,
            store,
            {
                name: routeName,
                ...("folderId" in route && route.folderId !== undefined
                    ? { folderId: route.folderId }
                    : {}),
            },
            request,
            response,
            (limitBytes) => readJson<unknown>(request, limitBytes),
        );
        return;
    }
    if (
        routeName === "folder-items" ||
        routeName === "folder-item" ||
        routeName === "folder-item-archive" ||
        routeName === "folder-item-move"
    ) {
        await serveFolderItemRequest(
            ctx,
            store,
            {
                name: routeName,
                ...("folderId" in route && route.folderId !== undefined
                    ? { folderId: route.folderId }
                    : {}),
                ...("itemId" in route && route.itemId !== undefined
                    ? { itemId: route.itemId }
                    : {}),
            },
            request,
            response,
            (limitBytes) => readJson<unknown>(request, limitBytes),
        );
        return;
    }
    if (
        routeName === "documents" ||
        routeName === "document" ||
        routeName === "document-updates" ||
        routeName === "document-write"
    ) {
        await serveDocumentRequest(
            ctx,
            store,
            {
                name: routeName,
                ...("documentId" in route && route.documentId !== undefined
                    ? { documentId: route.documentId }
                    : {}),
            },
            request,
            response,
            url.searchParams,
            (limitBytes) => readJson<unknown>(request, limitBytes),
            async (profileId) => {
                if (
                    !(await authorizeMessageProfile(ctx, request, response, runtimeConfig, {
                        identity: profileId ?? null,
                    }))
                ) {
                    return undefined;
                }
                return {
                    instanceId: p2pPeerId(request) ?? store.localInstanceId,
                    ...(profileId === undefined || profileId === null ? {} : { profileId }),
                };
            },
        );
        return;
    }

    if (route.name === "projects") {
        if (request.method === "GET") {
            sendJson<ListProjectsResponse>(response, 200, {
                projects: await store.listProjects(ctx),
            });
            return;
        }
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const body = await readJson<unknown>(request, 20 * 1024);
        if (!Value.Check(registerProjectRequestSchema, body)) {
            sendProjectRegistrationError(
                response,
                400,
                "invalid_request",
                "A project path and optional project ID are required.",
            );
            return;
        }
        try {
            const project = await store.registerProject(ctx, body);
            sendJson<ProjectResponse>(response, 200, { project });
        } catch (error) {
            if (!(error instanceof ProjectRegistrationError)) throw error;
            sendProjectRegistrationError(
                response,
                projectRegistrationStatus(error),
                error.code,
                error.message,
            );
        }
        return;
    }

    if (route.name === "project-clone") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const decoded = decodeRemoteProjectCreation(await readJson<unknown>(request, 128 * 1024));
        if (decoded === undefined) {
            sendProjectRegistrationError(
                response,
                400,
                "invalid_request",
                "Remote project settings are invalid.",
            );
            return;
        }
        const peerId = p2pPeerId(request);
        if (decoded.githubToken !== undefined && peerId === undefined) {
            sendProjectRegistrationError(
                response,
                400,
                "invalid_request",
                "Temporary Git credentials are accepted only from an authenticated peer Rig.",
            );
            return;
        }
        if (
            !(await authorizeRemoteProjectCreator(
                ctx,
                request,
                response,
                runtimeConfig,
                decoded.request,
            ))
        ) {
            return;
        }
        let githubToken = decoded.githubToken;
        if (decoded.request.secret?.kind === "github" && githubToken === undefined) {
            const existing =
                decoded.request.projectId === undefined
                    ? undefined
                    : await store.getProject(ctx, decoded.request.projectId);
            if (peerId !== undefined && existing === undefined) {
                sendProjectRegistrationError(
                    response,
                    409,
                    "secret_unavailable",
                    "The temporary GitHub credential was not shared with this Rig.",
                );
                return;
            }
            if (peerId === undefined)
                try {
                    githubToken = store.resolveSpecialSecret("github").GH_TOKEN;
                } catch {
                    sendProjectRegistrationError(
                        response,
                        409,
                        "secret_unavailable",
                        "GitHub credentials are not available on this Rig.",
                    );
                    return;
                }
        }
        try {
            const mutationId = requestMutationId(request);
            const project = await store.createRemoteProject(ctx, decoded.request, {
                ...(decoded.request.identity === undefined
                    ? {}
                    : {
                          createdBy: {
                              instanceId:
                                  peerId ??
                                  (await runtimeConfig.profiles!.get(
                                      ctx,
                                      decoded.request.identity,
                                  ))!.parentInstanceId,
                              profileId: decoded.request.identity,
                          },
                      }),
                ...(githubToken === undefined ? {} : { githubToken }),
                ...(mutationId === undefined ? {} : { mutationId }),
            });
            sendJson<ProjectResponse>(response, 202, { project });
        } catch (error) {
            if (!(error instanceof ProjectRegistrationError)) throw error;
            sendProjectRegistrationError(
                response,
                projectRegistrationStatus(error),
                error.code,
                error.message,
            );
        }
        return;
    }

    if (request.method === "GET" && route.name === "provider-usage") {
        sendJson<ListProviderUsageResponse>(response, 200, {
            providers: (await runtimeConfig.listProviderUsage?.(p2pPeerId(request))) ?? [],
        });
        return;
    }

    if (
        route.name === "project-file" ||
        route.name === "project-file-paths" ||
        route.name === "project-file-revision" ||
        route.name === "project-file-tree" ||
        route.name === "project-files"
    ) {
        const directory = await resolveProjectScopeDirectory(ctx, store, route);
        if (!directory.ok) {
            sendJson(response, directory.status, { error: directory.error });
            return;
        }
        if (route.name === "project-file-paths") {
            if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            try {
                sendJson<ListProjectFilePathsResponse>(
                    response,
                    200,
                    await listGitWorkingTreeFiles({ path: directory.path }),
                );
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 400, { error: errorToMessage(error) });
            }
            return;
        }
        if (route.name === "project-file-tree") {
            if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            const treeRequest = parseFileTreeRequest(url);
            if (treeRequest === undefined) {
                sendJson(response, 400, { error: "File-tree settings are invalid." });
                return;
            }
            try {
                const fileSystem = createNodeFileSystemContext(directory.path, {
                    permissionMode: () => "read_only",
                });
                sendJson<ListFileTreeResponse>(
                    response,
                    200,
                    await listFileTree(fileSystem, treeRequest),
                );
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                if (error instanceof FileTreeChangedError) {
                    sendJson(response, 409, {
                        error: error.message,
                        reason: "directory_changed",
                    });
                    return;
                }
                if (
                    error instanceof FileTreeProtectedPathError ||
                    error instanceof FileTreeSymlinkTraversalError
                ) {
                    sendJson(response, 403, { error: error.message });
                    return;
                }
                if (error instanceof FileTreeInvalidRequestError) {
                    sendJson(response, 400, { error: error.message });
                    return;
                }
                throw error;
            }
            return;
        }
        if (route.name === "project-files") {
            if (request.method !== "GET") {
                sendJson(response, 405, { error: "Method not allowed" });
                return;
            }
            const query = (url.searchParams.get("query") ?? "").slice(0, 512);
            const files = await fileSearchService.search(
                directory.path,
                query,
                parseFileSearchLimit(url.searchParams.get("limit")),
            );
            sendJson<SearchFilesResponse>(response, 200, { files });
            return;
        }
        // Both remaining routes read; only the working-tree file can also be written. They share the
        // scope check and the error mapping below, which a revision read needs just as much.
        const writable = route.name === "project-file" && request.method === "PUT";
        if (request.method !== "GET" && !writable) {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const fileSystem = createNodeFileSystemContext(directory.path, {
            permissionMode: () => "workspace_write",
        });
        try {
            if (route.name === "project-file-revision") {
                const path = url.searchParams.get("path");
                const revision = url.searchParams.get("revision");
                if (path === null || path.length === 0) {
                    sendJson(response, 400, { error: "A file path is required." });
                    return;
                }
                if (revision === null || revision.length === 0) {
                    sendJson(response, 400, { error: "A Git revision is required." });
                    return;
                }
                sendJson<ReadProjectFileRevisionResponse>(
                    response,
                    200,
                    await readProjectFileAtRevision(fileSystem, { path, revision }),
                );
                return;
            }
            if (request.method === "GET") {
                const path = url.searchParams.get("path");
                if (path === null || path.length === 0) {
                    sendJson(response, 400, { error: "A file path is required." });
                    return;
                }
                sendJson<ReadProjectFileResponse>(
                    response,
                    200,
                    await readProjectFile(fileSystem, path),
                );
                return;
            }

            const body = await readJson<unknown>(request, 44 * 1024 * 1024);
            if (!Value.Check(writeProjectFileRequestSchema, body)) {
                sendJson(response, 400, { error: "File update settings are invalid." });
                return;
            }
            sendJson<WriteProjectFileResponse>(
                response,
                200,
                await writeProjectFile(fileSystem, body as WriteProjectFileRequest),
            );
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            const status =
                error instanceof ProjectFileConflictError
                    ? 409
                    : error instanceof ProjectFileTooLargeError
                      ? 413
                      : error instanceof ProjectFileOutsideScopeError ||
                          (error instanceof Error &&
                              (error.message.includes("cannot modify files outside") ||
                                  error.message.includes("cannot modify Git control files") ||
                                  error.message.includes("cannot modify the project")))
                        ? 403
                        : 400;
            sendJson(response, status, { error: errorToMessage(error) });
        }
        return;
    }

    if (route.name === "project-terminals" || route.name === "project-terminal") {
        const scope = {
            projectId: route.projectId,
            ...(route.workspaceId === undefined ? {} : { workspaceId: route.workspaceId }),
        };
        const project = await store.getProject(ctx, route.projectId);
        if (project === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        if (
            route.workspaceId !== undefined &&
            (await store.getWorkspace(ctx, route.projectId, route.workspaceId)) === undefined
        ) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
        }
        if (route.name === "project-terminals") {
            if (request.method === "GET") {
                sendJson<ListRemoteTerminalsResponse>(response, 200, {
                    terminals: store.remoteTerminals
                        .list(scope)
                        .map((terminal) => terminal.summary()),
                });
                return;
            }
            if (request.method === "POST") {
                const body = await readJson<CreateRemoteTerminalRequest | null>(request);
                if (body === null || typeof body !== "object" || Array.isArray(body)) {
                    sendJson(response, 400, {
                        error: "Terminal settings must be a JSON object.",
                    });
                    return;
                }
                try {
                    const terminal = await store.remoteTerminals.create(ctx, scope, body);
                    sendJson<CreateRemoteTerminalResponse>(response, 201, {
                        terminal: terminal.summary(),
                    });
                } catch (error) {
                    if (isDatabaseFailure(error)) throw error;
                    sendJson(response, 400, { error: errorToMessage(error) });
                }
                return;
            }
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const terminal = store.remoteTerminals.get(scope, route.terminalId);
        if (terminal === undefined) {
            sendJson(response, 404, { error: "Terminal not found" });
            return;
        }
        if (request.method === "DELETE") {
            sendJson<RemoteTerminalResponse>(response, 200, { terminal: await terminal.stop() });
            return;
        }
        if (request.method === "PATCH") {
            const body = await readJson<ResizeRemoteTerminalRequest>(request);
            try {
                sendJson<RemoteTerminalResponse>(response, 200, {
                    terminal: await terminal.resize(body.cols, body.rows),
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 400, { error: errorToMessage(error) });
            }
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    if (request.method === "GET" && route.name === "project-asset") {
        const asset = await store.getProjectAvatar(ctx, route.assetHash);
        if (asset === undefined) {
            sendJson(response, 404, { error: "Project avatar not found" });
            return;
        }
        response.writeHead(200, {
            "cache-control": "public, max-age=31536000, immutable",
            "content-length": String(asset.bytes.byteLength),
            "content-type": asset.mediaType,
            etag: `"${asset.hash}"`,
        });
        response.end(asset.bytes);
        return;
    }

    if (route.name === "project") {
        const project = await store.getProject(ctx, route.projectId);
        if (project === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        if (request.method === "GET") {
            sendJson<ProjectResponse>(response, 200, { project });
            return;
        }
        if (request.method === "PATCH") {
            const body = await readJson<unknown>(request);
            if (
                (!hasOnlyObjectKeys(body, ["name"]) &&
                    !hasOnlyObjectKeys(body, ["mutationId", "name"])) ||
                typeof body.name !== "string" ||
                (body.mutationId !== undefined && typeof body.mutationId !== "string")
            ) {
                sendJson(response, 400, { error: "Project name must be text." });
                return;
            }
            const completed =
                body.mutationId === undefined
                    ? undefined
                    : (await store.globalEventQueue.list(ctx))?.find(
                          (entry) =>
                              entry.event.type === "project_updated" &&
                              entry.event.projectId === project.id &&
                              entry.event.data.mutationId === body.mutationId,
                      );
            if (completed !== undefined) {
                sendJson<ProjectResponse>(response, 200, {
                    project: (await store.getProject(ctx, project.id))!,
                });
                return;
            }
            const expectedVersion = parseEntityVersion(request.headers["if-match"]);
            if (expectedVersion === undefined) {
                sendJson(response, 400, { error: "The project version is invalid." });
                return;
            }
            try {
                sendJson<ProjectResponse>(response, 200, {
                    project: (await store.renameProject(
                        ctx,
                        project.id,
                        body.name,
                        expectedVersion,
                        body.mutationId,
                    ))!,
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 409, {
                    error: errorToMessage(error),
                    project: await store.getProject(ctx, project.id),
                });
            }
            return;
        }
    }

    if (route.name === "project-settings" && request.method === "PUT") {
        const project = await store.getProject(ctx, route.projectId);
        if (project === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        const body = await readJson<unknown>(request);
        if (!Value.Check(updateProjectSettingsRequestSchema, body)) {
            sendJson(response, 400, {
                error: "Project settings are invalid. Choose local compute, a Docker image, or leave the default unset.",
            });
            return;
        }
        const completed =
            body.mutationId === undefined
                ? undefined
                : (await store.globalEventQueue.list(ctx))?.find(
                      (entry) =>
                          entry.event.type === "project_updated" &&
                          entry.event.projectId === project.id &&
                          entry.event.data.mutationId === body.mutationId,
                  );
        if (completed !== undefined) {
            sendJson<ProjectResponse>(response, 200, {
                project: (await store.getProject(ctx, project.id))!,
            });
            return;
        }
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendJson(response, 400, { error: "The project version is invalid." });
            return;
        }
        try {
            const { mutationId, ...settings } = body;
            const updated = await store.setProjectSettings(
                ctx,
                project.id,
                settings,
                expectedVersion,
                mutationId,
            );
            if (updated === undefined) {
                sendJson(response, 404, { error: "Project not found." });
                return;
            }
            sendJson<ProjectResponse>(response, 200, { project: updated });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: errorToMessage(error),
                project: await store.getProject(ctx, project.id),
            });
        }
        return;
    }

    if (route.name === "git-watch" && request.method === "POST") {
        const tracker = runtimeConfig.gitStateTracker;
        if (tracker === undefined) {
            sendJson(response, 503, { error: "Git tracking is unavailable." });
            return;
        }
        const body = await readJson<unknown>(request);
        if (!hasOnlyObjectKeys(body, ["entities"]) || !Array.isArray(body.entities)) {
            sendJson(response, 400, { error: "The watch request is invalid." });
            return;
        }
        for (const requested of body.entities as { projectId?: unknown; workspaceId?: unknown }[]) {
            if (typeof requested?.projectId !== "string") continue;
            const project = await store.getProject(ctx, requested.projectId);
            if (project === undefined) continue;
            const workspace =
                typeof requested.workspaceId === "string"
                    ? await store.getWorkspace(ctx, requested.projectId, requested.workspaceId)
                    : undefined;
            if (typeof requested.workspaceId === "string" && workspace === undefined) continue;
            const entity = resolveGitTrackedEntity(project, workspace);
            if (entity !== undefined) tracker.watch(entity);
        }
        sendJson<GitWatchResponse>(response, 200, {
            snapshots: tracker.liveSnapshots(),
        });
        return;
    }

    if (route.name === "project-git" || route.name === "project-workspace-git") {
        const tracker = runtimeConfig.gitStateTracker;
        if (tracker === undefined) {
            sendJson(response, 503, { error: "Git tracking is unavailable." });
            return;
        }
        const project = await store.getProject(ctx, route.projectId);
        if (project === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        const workspace =
            route.name === "project-workspace-git"
                ? await store.getWorkspace(ctx, route.projectId, route.workspaceId)
                : undefined;
        if (route.name === "project-workspace-git" && workspace === undefined) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
        }
        const entity = resolveGitTrackedEntity(project, workspace);
        if (entity === undefined) {
            sendJson(response, 409, {
                error: "This folder is not available for Git tracking right now.",
            });
            return;
        }
        if (request.method === "GET") {
            // Asking for a snapshot is itself the demand signal, so the entity stays warm.
            tracker.watch(entity);
            const cached = tracker.snapshot(entity);
            if (cached !== undefined) {
                // Legacy clients may still append `refresh=1`, but reads never manufacture Git
                // work. The filesystem watcher and bounded reconciliation loop own freshness;
                // turning every poll into a scan lets one view continuously rescan every project.
                sendJson<GitStateResponse>(response, 200, { git: cached });
                return;
            }
            // The first scan stays on the bounded background queue. Git counts are optional UI
            // enrichment and the live channel publishes the real snapshot as soon as it is ready,
            // so a cold catalog must not wait behind every repository on the machine.
            sendJson<GitStateResponse>(response, 200, {
                git: pendingGitSnapshot(tracker.generation, (workspace ?? project).git),
            });
            return;
        }
    }

    if (route.name === "project-refresh" && request.method === "POST") {
        try {
            const project = await store.refreshProject(ctx, route.projectId);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            sendJson<ProjectResponse>(response, 202, { project });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (route.name === "project-reorder" && request.method === "POST") {
        const body = await readJson<unknown>(request);
        if (!isReorderRequest(body)) {
            sendJson(response, 400, {
                error: "The preceding project ID must be text or null.",
            });
            return;
        }
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendJson(response, 400, { error: "The project version is invalid." });
            return;
        }
        try {
            const project = await store.reorderProject(ctx, route.projectId, body, expectedVersion);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            sendJson<ProjectResponse>(response, 200, { project });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (route.name === "project-archive" && request.method === "POST") {
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendJson(response, 400, { error: "The project version is invalid." });
            return;
        }
        try {
            const project = await store.archiveProject(ctx, route.projectId, expectedVersion);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            sendJson<ProjectResponse>(response, 202, { project });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (route.name === "project-avatar") {
        if (request.method === "PUT") {
            const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
            if (
                contentType === undefined ||
                !["image/png", "image/jpeg", "image/webp", "image/gif", "image/tiff"].includes(
                    contentType,
                )
            ) {
                sendJson(response, 415, { error: "This project avatar format is not supported." });
                return;
            }
            const expectedVersion = parseEntityVersion(request.headers["if-match"]);
            if (expectedVersion === undefined) {
                sendJson(response, 400, {
                    error: "The project avatar update requires a valid project version.",
                });
                return;
            }
            try {
                const bytes = await readBuffer(request, 8 * 1024 * 1024);
                const project = await store.setProjectAvatar(
                    ctx,
                    route.projectId,
                    bytes,
                    expectedVersion,
                );
                if (project === undefined) {
                    sendJson(response, 404, { error: "Project not found" });
                    return;
                }
                sendJson<ProjectResponse>(response, 200, { project });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                const message = errorToMessage(error);
                sendJson(
                    response,
                    error instanceof RequestBodyTooLargeError
                        ? 413
                        : message.includes("changed before")
                          ? 409
                          : 400,
                    { error: message },
                );
            }
            return;
        }
        if (request.method === "DELETE") {
            const project = await store.clearProjectAvatar(ctx, route.projectId);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            sendJson<ProjectResponse>(response, 200, { project });
            return;
        }
    }

    if (route.name === "project-workspaces") {
        if ((await store.getProject(ctx, route.projectId)) === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        if (request.method === "GET") {
            sendJson<ListProjectWorkspacesResponse>(response, 200, {
                workspaces: await store.listWorkspaces(ctx, route.projectId),
            });
            return;
        }
        if (request.method === "POST") {
            const transport = decodeTemporaryGitCredential(await readJson<unknown>(request));
            if (transport === undefined) {
                sendJson(response, 400, { error: "Temporary Git credentials are invalid." });
                return;
            }
            if (transport.githubToken !== undefined && p2pPeerId(request) === undefined) {
                sendJson(response, 400, {
                    error: "Temporary Git credentials are accepted only from an authenticated peer Rig.",
                });
                return;
            }
            const body = transport.body;
            if (
                !hasNoUnknownObjectKeys(body, [
                    "baseRef",
                    "id",
                    "identity",
                    "name",
                    "nameConfigured",
                    "secret",
                ]) ||
                typeof body.name !== "string" ||
                (body.baseRef !== undefined && typeof body.baseRef !== "string") ||
                (body.id !== undefined && typeof body.id !== "string") ||
                (body.identity !== undefined && !Value.Check(rigProfileIdSchema, body.identity)) ||
                (body.nameConfigured !== undefined && typeof body.nameConfigured !== "boolean") ||
                (body.secret !== undefined && !Value.Check(projectGitSecretSchema, body.secret))
            ) {
                sendJson(response, 400, { error: "Workspace settings are invalid." });
                return;
            }
            if (!(await authorizeMessageProfile(ctx, request, response, runtimeConfig, body)))
                return;
            try {
                const peerId = p2pPeerId(request);
                const createdBy =
                    body.identity === undefined
                        ? undefined
                        : {
                              instanceId:
                                  peerId ??
                                  (await runtimeConfig.profiles!.get(ctx, body.identity))!
                                      .parentInstanceId,
                              profileId: body.identity,
                          };
                let githubToken = transport.githubToken;
                if (
                    githubToken === undefined &&
                    peerId === undefined &&
                    body.secret?.kind === "github"
                ) {
                    try {
                        githubToken = store.resolveSpecialSecret("github").GH_TOKEN;
                    } catch {
                        sendJson(response, 409, {
                            code: "secret_unavailable",
                            error: "GitHub credentials are not available on this Rig.",
                        });
                        return;
                    }
                }
                const workspace = await store.createWorkspace(
                    ctx,
                    route.projectId,
                    {
                        ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
                        ...(body.id === undefined ? {} : { id: body.id }),
                        ...(body.identity === undefined ? {} : { identity: body.identity }),
                        name: body.name,
                        // A client that sends a placeholder name leaves this unset, and the first
                        // chat inside the workspace names it instead.
                        ...(body.nameConfigured === undefined
                            ? {}
                            : { nameConfigured: body.nameConfigured }),
                        ...(body.secret === undefined ? {} : { secret: body.secret }),
                    },
                    {
                        ...(createdBy === undefined ? {} : { createdBy }),
                        ...(githubToken === undefined ? {} : { githubToken }),
                    },
                );
                if (workspace === undefined) {
                    sendJson(response, 404, { error: "Project not found" });
                    return;
                }
                sendJson<ProjectWorkspaceResponse>(response, 202, { workspace });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                const message = errorToMessage(error);
                sendJson(response, message.includes("already names") ? 409 : 400, {
                    error: message,
                });
            }
            return;
        }
    }

    if (route.name === "project-workspace") {
        const workspace = await store.getWorkspace(ctx, route.projectId, route.workspaceId);
        if (workspace === undefined) {
            sendJson(response, 404, { error: "Workspace not found" });
            return;
        }
        if (request.method === "PATCH") {
            const body = await readJson<unknown>(request);
            if (
                (!hasOnlyObjectKeys(body, ["name"]) &&
                    !hasOnlyObjectKeys(body, ["mutationId", "name"])) ||
                typeof body.name !== "string" ||
                (body.mutationId !== undefined && typeof body.mutationId !== "string")
            ) {
                sendJson(response, 400, { error: "Workspace name must be text." });
                return;
            }
            const completed =
                body.mutationId === undefined
                    ? undefined
                    : (await store.globalEventQueue.list(ctx))?.find(
                          (entry) =>
                              entry.event.type === "workspace_updated" &&
                              entry.event.workspaceId === route.workspaceId &&
                              entry.event.data.mutationId === body.mutationId,
                      );
            if (completed !== undefined) {
                sendJson<ProjectWorkspaceResponse>(response, 200, {
                    workspace: (await store.getWorkspace(ctx, route.projectId, route.workspaceId))!,
                });
                return;
            }
            try {
                const expectedVersion = parseEntityVersion(request.headers["if-match"]);
                if (expectedVersion === undefined) {
                    sendJson(response, 400, { error: "The workspace version is invalid." });
                    return;
                }
                const renamed = await store.renameWorkspace(
                    ctx,
                    route.projectId,
                    route.workspaceId,
                    body.name,
                    expectedVersion,
                    body.mutationId,
                );
                if (renamed === undefined) {
                    sendJson(response, 404, { error: "Workspace not found" });
                    return;
                }
                sendJson<ProjectWorkspaceResponse>(response, 200, {
                    workspace: renamed,
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 409, {
                    error: errorToMessage(error),
                    workspace: await store.getWorkspace(ctx, route.projectId, route.workspaceId),
                });
            }
            return;
        }
    }

    if (route.name === "project-workspace-archive" && request.method === "POST") {
        try {
            const expectedVersion = parseEntityVersion(request.headers["if-match"]);
            if (expectedVersion === undefined) {
                sendJson(response, 400, { error: "The workspace version is invalid." });
                return;
            }
            const workspace = await store.archiveWorkspace(
                ctx,
                route.projectId,
                route.workspaceId,
                expectedVersion,
            );
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Workspace not found" });
                return;
            }
            sendJson<ProjectWorkspaceResponse>(response, 202, { workspace });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (route.name === "project-workspace-reorder" && request.method === "POST") {
        const body = await readJson<unknown>(request);
        if (!isReorderRequest(body)) {
            sendJson(response, 400, {
                error: "The preceding workspace ID must be text or null.",
            });
            return;
        }
        const expectedVersion = parseEntityVersion(request.headers["if-match"]);
        if (expectedVersion === undefined) {
            sendJson(response, 400, { error: "The workspace version is invalid." });
            return;
        }
        try {
            const workspace = await store.reorderWorkspace(
                ctx,
                route.projectId,
                route.workspaceId,
                body,
                expectedVersion,
            );
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Workspace not found" });
                return;
            }
            sendJson<ProjectWorkspaceResponse>(response, 200, { workspace });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (request.method === "POST" && route.name === "messages" && route.sessionId === undefined) {
        const transport = decodeTemporaryGitCredential(await readJson<unknown>(request));
        if (transport === undefined) {
            sendJson(response, 400, { error: "Temporary Git credentials are invalid." });
            return;
        }
        if (transport.githubToken !== undefined && p2pPeerId(request) === undefined) {
            sendJson(response, 400, {
                error: "Temporary Git credentials are accepted only from an authenticated peer Rig.",
            });
            return;
        }
        const body = transport.body;
        if (!isSubmitMessageRequest(body)) {
            sendJson(response, 400, { error: "Message settings are invalid." });
            return;
        }
        if (rejectUnsupportedAgentSubmissionOptions(response, runtimeConfig, body)) return;
        if (!(await authorizeMessageProfile(ctx, request, response, runtimeConfig, body))) return;
        const broadcast = body as BroadcastMessageRequest;
        const authenticatedOwnerId = p2pPeerId(request);
        const allTargets =
            broadcast.all === true ? await store.list(ctx, { limit: 501 }) : undefined;
        if (allTargets !== undefined && allTargets.length > 500) {
            sendJson(response, 409, {
                error: "A single broadcast can target at most 500 sessions.",
            });
            return;
        }
        const targets = allTargets?.map((summary) => summary.id) ?? broadcast.sessionIds;
        if (
            (broadcast.all === true) === (broadcast.sessionIds !== undefined) ||
            targets === undefined ||
            !Array.isArray(targets) ||
            targets.length === 0 ||
            targets.some((id) => typeof id !== "string")
        ) {
            sendJson(response, 400, {
                error: "Choose either all sessions or a non-empty list of session IDs.",
            });
            return;
        }
        if (targets.length > 500) {
            sendJson(response, 409, {
                error: "A single broadcast can target at most 500 sessions.",
            });
            return;
        }
        if (new Set(targets).size !== targets.length) {
            sendJson(response, 400, { error: "Session IDs must be unique." });
            return;
        }
        const sessions = await Promise.all(targets.map((id) => store.get(ctx, id)));
        if (sessions.some((candidate) => candidate === undefined)) {
            sendJson(response, 404, { error: "One or more sessions were not found." });
            return;
        }
        if (sessions.some((candidate) => candidate!.isSubagent())) {
            sendJson(response, 409, { error: "Subagent sessions cannot receive broadcasts." });
            return;
        }
        // Each session has its own model and provider, so one configuration cannot be meaningfully
        // applied to all of them at once.
        if (
            broadcast.effort !== undefined ||
            broadcast.modelId !== undefined ||
            broadcast.providerId !== undefined ||
            broadcast.serviceTier !== undefined
        ) {
            sendJson(response, 400, {
                error: "A broadcast cannot change the model, reasoning effort, or fast mode. Send those to one session at a time.",
            });
            return;
        }
        const { all: _all, sessionIds: _sessionIds, ...message } = broadcast;
        const githubToken = transport.githubToken;
        if (
            githubToken !== undefined &&
            authenticatedOwnerId !== undefined &&
            body.identity !== undefined &&
            body.identity !== null
        ) {
            await Promise.all(
                sessions.map((candidate) =>
                    store.refreshSessionGitCredential(
                        ctx,
                        candidate!.id,
                        { instanceId: authenticatedOwnerId, profileId: body.identity! },
                        githubToken,
                    ),
                ),
            );
        }
        sendJson<BroadcastMessageResponse>(response, 202, {
            submissions: await Promise.all(
                sessions.map((candidate) =>
                    runtimeConfig.agents === undefined
                        ? candidate!.submit(ctx, message)
                        : runtimeConfig.agents.submit(ctx, candidate!, message),
                ),
            ),
        });
        return;
    }

    if (request.method === "GET" && route.name === "global-instructions") {
        if (!authorizeP2pConfigurationRequest(request, response, runtimeConfig)) return;
        sendJson<GetGlobalInstructionsResponse>(response, 200, {
            instructions: (await readGlobalAgentsMd(runtimeConfig.globalInstructionsPath)) ?? "",
        });
        return;
    }

    if (request.method === "PUT" && route.name === "global-instructions") {
        if (!authorizeP2pConfigurationRequest(request, response, runtimeConfig)) return;
        const body = await readJson<UpdateGlobalInstructionsRequest>(request);
        const instructions = body.instructions;
        if (typeof instructions !== "string") {
            sendJson(response, 400, { error: "Global instructions must be text." });
            return;
        }
        if (Buffer.byteLength(instructions, "utf8") > GLOBAL_AGENTS_MD_MAX_BYTES) {
            sendJson(response, 400, {
                error: `Global instructions must be smaller than ${GLOBAL_AGENTS_MD_MAX_BYTES / 1024} KB.`,
            });
            return;
        }
        await writeGlobalAgentsMd(instructions, runtimeConfig.globalInstructionsPath);
        // Reading the file back states what sessions will actually pick up before their next turn.
        sendJson<UpdateGlobalInstructionsResponse>(response, 200, {
            instructions: (await readGlobalAgentsMd(runtimeConfig.globalInstructionsPath)) ?? "",
        });
        return;
    }

    if (request.method === "GET" && route.name === "global-security-policy") {
        if (!authorizeP2pConfigurationRequest(request, response, runtimeConfig)) return;
        sendJson<GetGlobalSecurityPolicyResponse>(response, 200, {
            policy: (await readGlobalSecurityMd(runtimeConfig.globalSecurityPolicyPath)) ?? "",
        });
        return;
    }

    if (request.method === "PUT" && route.name === "global-security-policy") {
        if (!authorizeP2pConfigurationRequest(request, response, runtimeConfig)) return;
        const body = await readJson<unknown>(request, GLOBAL_SECURITY_POLICY_REQUEST_MAX_BYTES);
        if (!Value.Check(globalSecurityPolicySchema, body)) {
            sendJson(response, 400, { error: "Global security policy must be text." });
            return;
        }
        if (Buffer.byteLength(body.policy, "utf8") > GLOBAL_SECURITY_MD_MAX_BYTES) {
            sendJson(response, 400, {
                error: `Global security policy must be smaller than ${GLOBAL_SECURITY_MD_MAX_BYTES / 1024} KB.`,
            });
            return;
        }
        await writeGlobalSecurityMd(body.policy, runtimeConfig.globalSecurityPolicyPath);
        sendJson<UpdateGlobalSecurityPolicyResponse>(response, 200, {
            policy: (await readGlobalSecurityMd(runtimeConfig.globalSecurityPolicyPath)) ?? "",
        });
        return;
    }

    if (request.method === "GET" && route.name === "config") {
        if (!authorizeP2pConfigurationRequest(request, response, runtimeConfig)) return;
        sendJson<GetDaemonConfigResponse>(response, 200, {
            config: {
                p2p: runtimeConfig.p2pNode?.() ?? {
                    name: "Rig",
                    role: "primary",
                },
                settings: {
                    inferenceMaxRetries: runtimeConfig.inferenceMaxRetries,
                    durableGlobalEventQueue: runtimeConfig.globalEventQueue.durable,
                },
            },
        });
        return;
    }

    if (request.method === "PATCH" && route.name === "config") {
        if (!authorizeP2pConfigurationRequest(request, response, runtimeConfig)) return;
        const rawBody = await readJson<unknown>(request);
        if (!Value.Check(updateDaemonConfigRequestSchema, rawBody)) {
            sendJson(response, 400, { error: "Daemon settings must use valid values." });
            return;
        }
        const body: UpdateDaemonConfigRequest = rawBody;
        const inferenceMaxRetries = body.settings.inferenceMaxRetries;
        const enabled = body.settings.durableGlobalEventQueue;
        if (runtimeConfig.onDaemonConfigChange === undefined) {
            sendJson(response, 409, {
                error: "This daemon cannot change its settings at runtime.",
            });
            return;
        }
        const currentP2p = runtimeConfig.p2pNode?.() ?? {
            name: "Rig",
            role: "primary" as const,
        };
        const applied = await runtimeConfig.onDaemonConfigChange(ctx, {
            p2p: {
                ...currentP2p,
                ...(body.p2p === undefined ? {} : { name: body.p2p.name }),
            },
            settings: {
                inferenceMaxRetries,
                durableGlobalEventQueue: enabled,
            },
        });
        if (
            applied === undefined ||
            applied.inferenceMaxRetries !== inferenceMaxRetries ||
            applied.globalEventQueue.durable !== enabled
        ) {
            throw new Error("The daemon could not apply the requested settings.");
        }
        runtimeConfig.inferenceMaxRetries = applied.inferenceMaxRetries;
        runtimeConfig.globalEventQueue = applied.globalEventQueue;
        sendJson<UpdateDaemonConfigResponse>(response, 200, {
            config: {
                p2p: runtimeConfig.p2pNode?.() ?? {
                    name: body.p2p?.name ?? "Rig",
                    role: "primary",
                },
                settings: {
                    inferenceMaxRetries,
                    durableGlobalEventQueue: enabled,
                },
            },
        });
        return;
    }

    if (request.method === "GET" && route.name === "catalog") {
        // The position is read before the entities, and both happen in one
        // synchronous pass, so the catalog states exactly the point in the stream
        // that it reflects. A client can then say of any event whether this
        // snapshot already contains it, instead of inferring it from what changed.
        const ownerInstanceId = p2pPeerId(request);
        const scopedCatalog =
            ownerInstanceId === undefined
                ? modelCatalog
                : (runtimeConfig.resolveModelCatalog?.(ownerInstanceId) ?? modelCatalog);
        sendJson<GlobalStreamHello>(response, 200, {
            cursor: store.liveEvents.cursor(),
            ...(await buildGroupCatalog(ctx, store, scopedCatalog, identity, sessionTerminals)),
        });
        return;
    }

    if (request.method === "POST" && route.name === "timeline") {
        const parsed = parseTimelineRequest(await readJson<unknown>(request));
        if ("error" in parsed) {
            sendJson(response, 400, { error: parsed.error });
            return;
        }
        // Same ordering as the catalog: the stream position is read before the
        // agents, so a client can tell whether a later event is already included.
        const cursor = store.liveEvents.cursor();
        sendJson<GetTimelineResponse>(response, 200, {
            agents: await store.timeline(ctx, parsed.request),
            cursor,
            scope: parsed.request.scope,
        });
        return;
    }

    // Outside the durable-log gate on purpose: the live stream is the one
    // subscription a local client always has, whether or not events are stored.
    if (request.method === "GET" && route.name === "live-events-stream") {
        streamLiveEvents(request, response, store.liveEvents, url.searchParams.get("after"));
        return;
    }

    if (isGlobalEventRoute(route.name)) {
        if (p2pPeerId(request) !== undefined) {
            sendJson(response, 403, {
                error: "The daemon-wide durable event log is unavailable over P2P.",
            });
            return;
        }
        const globalEventQueue = runtimeConfig.globalEventQueue;

        if (request.method === "GET" && route.name === "global-events") {
            const after = parseGlobalEventCursor(url.searchParams.get("after"));
            if (url.searchParams.has("after") && after === undefined) {
                sendJson(response, 400, { error: "The event cursor must be a UUIDv7 value." });
                return;
            }
            const limit = parseGlobalEventLimit(url.searchParams.get("limit"));
            if (url.searchParams.has("limit") && limit === undefined) {
                sendJson(response, 400, { error: "The event limit must be a positive number." });
                return;
            }
            const events = await globalEventQueue.list(ctx, {
                ...(after === undefined ? {} : { after }),
                limit: limit ?? 100,
            });
            if (events === undefined) {
                sendJson(response, 409, { error: "The global event cursor is not available." });
                return;
            }
            sendJson<ListGlobalEventsResponse>(response, 200, { events });
            return;
        }

        if (request.method === "GET" && route.name === "global-events-stream") {
            await streamGlobalEvents(
                request,
                response,
                ctx,
                globalEventQueue,
                url.searchParams.get("after"),
            );
            return;
        }

        if (request.method === "POST" && route.name === "global-events-trim") {
            const body = await readJson<TrimGlobalEventsRequest>(request);
            if (parseGlobalEventCursor(body.through) === undefined) {
                sendJson(response, 400, { error: "The trim cursor is invalid." });
                return;
            }
            const result = await globalEventQueue.trim(ctx, body.through);
            if (result === undefined) {
                sendJson(response, 409, { error: "The global event cursor is not available." });
                return;
            }
            sendJson<TrimGlobalEventsResponse>(response, 200, result);
            return;
        }

        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    if (
        request.method === "GET" &&
        route.name === "external-tool-calls" &&
        route.sessionId === undefined
    ) {
        const status = url.searchParams.get("status") ?? "pending";
        if (!["pending", "completed", "failed", "cancelled"].includes(status)) {
            sendJson(response, 400, { error: "External function status is invalid." });
            return;
        }
        const limit = parseLimit(url.searchParams.get("limit"));
        if (url.searchParams.has("limit") && limit === undefined) {
            sendJson(response, 400, { error: "External function call limit is invalid." });
            return;
        }
        sendJson<ListExternalToolCallsResponse>(response, 200, {
            calls: await store.listExternalToolCalls(ctx, {
                limit: limit ?? 100,
                status: status as import("../external-tools/index.js").ExternalToolCall["status"],
            }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "secret-registrations") {
        sendJson<ListSecretsResponse>(response, 200, { secrets: await store.listSecrets(ctx) });
        return;
    }

    if (request.method === "POST" && route.name === "secret-registrations") {
        const body = await readJson<unknown>(request);
        if (!Value.Check(environmentSecretRegistrationSchema, body)) {
            sendJson(response, 400, {
                error: "Secret settings must match the environment secret schema.",
            });
            return;
        }
        try {
            sendJson<RegisterSecretResponse>(response, 200, {
                secret: await store.registerSecret(ctx, body),
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 400, {
                error: error instanceof Error ? error.message : "The secret could not be saved.",
            });
        }
        return;
    }

    if (request.method === "DELETE" && route.name === "secret-registration") {
        sendJson<UnregisterSecretResponse>(response, 200, {
            removed: await store.unregisterSecret(ctx, route.secretId),
        });
        return;
    }

    if (request.method === "PATCH" && route.name === "secret-registration") {
        const body = await readJson<unknown>(request);
        if (!Value.Check(environmentSecretUpdateSchema, body)) {
            sendJson(response, 400, {
                error: "Secret changes must match the environment secret update schema.",
            });
            return;
        }
        try {
            const secret = await store.updateSecret(ctx, route.secretId, body);
            if (secret === undefined) {
                sendJson(response, 404, { error: "Secret not found." });
                return;
            }
            sendJson<UpdateSecretResponse>(response, 200, { secret });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 400, {
                error: error instanceof Error ? error.message : "The secret could not be updated.",
            });
        }
        return;
    }

    if (request.method === "POST" && route.name === "sessions") {
        const transport = decodeTemporaryGitCredential(await readJson<unknown>(request));
        if (transport === undefined) {
            sendJson(response, 400, { error: "Temporary Git credentials are invalid." });
            return;
        }
        const authenticatedPeerId = p2pPeerId(request);
        if (transport.githubToken !== undefined && authenticatedPeerId === undefined) {
            sendJson(response, 400, {
                error: "Temporary Git credentials are accepted only from an authenticated peer Rig.",
            });
            return;
        }
        const body = transport.body as unknown as CreateSessionRequest | null;
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(response, 400, { error: "Session settings must be a JSON object." });
            return;
        }
        if (body.permissionMode !== undefined && !isPermissionMode(body.permissionMode)) {
            sendJson(response, 400, {
                error: INVALID_PERMISSION_MODE_MESSAGE,
            });
            return;
        }
        if (body.appendSystemPrompt !== undefined && typeof body.appendSystemPrompt !== "string") {
            sendJson(response, 400, {
                error: "The appended system prompt must be text.",
            });
            return;
        }
        if (body.trackUnread !== undefined && typeof body.trackUnread !== "boolean") {
            sendJson(response, 400, {
                error: "Unread tracking must be true or false.",
            });
            return;
        }
        if (
            body.secretIds !== undefined &&
            (!Array.isArray(body.secretIds) ||
                body.secretIds.some((secretId) => typeof secretId !== "string"))
        ) {
            sendJson(response, 400, {
                error: "Secret IDs must be provided as a list of text IDs.",
            });
            return;
        }
        if (body.id !== undefined && !isCuid(body.id)) {
            sendJson(response, 400, { error: "The session ID must be a cuid2 identity." });
            return;
        }
        if (body.projectId !== undefined && !isCuid(body.projectId)) {
            sendJson(response, 400, { error: "The project ID must be a cuid2 identity." });
            return;
        }
        if (body.identity !== undefined && !Value.Check(rigProfileIdSchema, body.identity)) {
            sendJson(response, 400, { error: "The human profile ID is invalid." });
            return;
        }
        if (
            body.scope !== undefined &&
            (!Value.Check(sessionScopeSchema, body.scope) ||
                (body.scope.kind !== "folder" && body.scope.kind !== "unsorted") ||
                body.workspaceId !== undefined ||
                body.projectId !== undefined)
        ) {
            sendJson(response, 400, {
                error: "Choose exactly one folder, Unsorted, project, or workspace for this chat.",
            });
            return;
        }
        if (!(await authorizeMessageProfile(ctx, request, response, runtimeConfig, body))) return;
        if (!(await authorizeRemoteSessionTarget(ctx, request, response, store, body))) return;
        try {
            const effectiveBody =
                authenticatedPeerId !== undefined &&
                body.scope === undefined &&
                body.projectId === undefined &&
                body.workspaceId === undefined
                    ? { ...body, scope: { kind: "unsorted" as const } }
                    : body;
            const sessionRequest =
                effectiveBody.scope === undefined
                    ? await configureSessionRequest(effectiveBody, defaultDocker, () =>
                          store.queryProjectSettings(ctx, effectiveBody.cwd),
                      )
                    : (() => {
                          const {
                              docker: _docker,
                              local: _local,
                              ...folderRequest
                          } = effectiveBody;
                          return folderRequest;
                      })();
            const authenticatedOwnerId = authenticatedPeerId;
            const creationOptions = {
                ...(authenticatedOwnerId === undefined
                    ? {}
                    : { ownerInstanceId: authenticatedOwnerId }),
                ...(body.identity === undefined ? {} : { profileId: body.identity }),
            };
            const githubToken = transport.githubToken;
            const existingSession =
                body.id === undefined ? undefined : await store.get(ctx, body.id);
            if (
                authenticatedOwnerId !== undefined &&
                transport.gitSecretRequested &&
                githubToken === undefined &&
                existingSession === undefined
            ) {
                sendJson(response, 409, {
                    error: "GitHub credentials are not available for this remote operation.",
                });
                return;
            }
            const session =
                body.id === undefined
                    ? await store.create(ctx, sessionRequest, creationOptions)
                    : await store.createWithId(ctx, body.id, sessionRequest, creationOptions);
            if (
                githubToken !== undefined &&
                authenticatedOwnerId !== undefined &&
                body.identity !== undefined
            ) {
                await store.refreshSessionGitCredential(
                    ctx,
                    session.id,
                    { instanceId: authenticatedOwnerId, profileId: body.identity },
                    githubToken,
                );
            }
            sendJson<CreateSessionResponse>(response, 201, { session: session.snapshot() });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, error instanceof SessionConfigurationError ? 400 : 409, {
                error: error instanceof Error ? error.message : "The session could not be created.",
            });
        }
        return;
    }

    if (request.method === "GET" && route.name === "sessions") {
        const limit = parseLimit(url.searchParams.get("limit"));
        const archived = parseArchivedFilter(url.searchParams.get("archived"));
        if (url.searchParams.has("archived") && archived === undefined) {
            sendJson(response, 400, {
                error: "Archived sessions must be filtered with true, false, or all.",
            });
            return;
        }
        const summaries = await store.list(ctx);
        const filtered =
            archived === "all"
                ? summaries
                : summaries.filter((summary) => summary.archived === (archived ?? false));
        const sessions = filtered.map((summary) =>
            sessionSummaryWithTerminalPresence(summary, sessionTerminals),
        );
        sendJson<ListSessionsResponse>(response, 200, {
            sessions: limit === undefined ? sessions : sessions.slice(0, limit),
        });
        return;
    }

    const sessionId = route.sessionId;
    if (sessionId === undefined) {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    const session = await store.get(ctx, sessionId, {
        loadAgentTree: route.name !== "session-state",
    });
    if (session === undefined) {
        sendJson(response, 404, { error: "Session not found" });
        return;
    }
    if (
        route.name === "session-attachment-download" ||
        route.name === "session-attachment-preview"
    ) {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        try {
            const attachment = await store.attachment(ctx, sessionId, route.attachmentId);
            const file =
                attachment === undefined
                    ? undefined
                    : route.name === "session-attachment-preview"
                      ? await readSessionAttachmentPreview(attachment)
                      : await readSessionAttachmentFile(attachment);
            if (file === undefined) {
                sendJson(response, 404, { error: "Attachment not found" });
                return;
            }
            response.writeHead(200, {
                "cache-control": "private, no-store",
                "content-disposition":
                    route.name === "session-attachment-preview"
                        ? "inline"
                        : attachmentContentDisposition(file.name),
                "content-length": file.data.byteLength,
                "content-type": file.mediaType,
                "x-content-type-options": "nosniff",
            });
            response.end(file.data);
        } catch {
            sendJson(response, 404, { error: "Attachment not found" });
        }
        return;
    }

    if (route.name === "terminal-connection") {
        if (session.isSubagent()) {
            sendJson(response, 409, {
                error: "Subagent histories are read-only and cannot accept terminal connections.",
            });
            return;
        }
        if (request.method === "PUT") {
            const body = await readJson<SessionTerminalHeartbeatRequest | null>(request);
            if (
                body === null ||
                typeof body !== "object" ||
                Array.isArray(body) ||
                body.connectionId !== route.connectionId
            ) {
                sendJson(response, 400, { error: "Terminal heartbeat settings are invalid." });
                return;
            }
            try {
                const hadFocusedTerminal = sessionTerminals.hasFocusedTerminal(sessionId);
                sessionTerminals.heartbeat(sessionId, body);
                if (hadFocusedTerminal || sessionTerminals.hasFocusedTerminal(sessionId)) {
                    await session.markRead(ctx);
                }
                sendJson<SessionTerminalHeartbeatResponse>(response, 200, { connected: true });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 400, { error: errorToMessage(error) });
            }
            return;
        }
        if (request.method === "DELETE") {
            if (sessionTerminals.hasFocusedTerminal(sessionId)) await session.markRead(ctx);
            sendJson<DisconnectSessionTerminalResponse>(response, 200, {
                disconnected: sessionTerminals.disconnect(sessionId, route.connectionId),
            });
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    if (request.method === "GET" && route.name === "session") {
        const messageLimit = parseLimit(url.searchParams.get("message_limit"));
        if (url.searchParams.has("message_limit") && messageLimit === undefined) {
            sendJson(response, 400, { error: "Session message limit is invalid." });
            return;
        }
        const snapshot = session.snapshot();
        sendJson(response, 200, {
            session: limitProtocolSessionMessages(snapshot, messageLimit),
        });
        return;
    }

    if (request.method === "PUT" && route.name === "session-scope") {
        const body = await readJson<unknown>(request, 8 * 1024);
        if (!Value.Check(moveSessionRequestSchema, body)) {
            sendJson(response, 400, {
                error: "Choose a folder or Unsorted location and a preceding chat.",
            });
            return;
        }
        const headerMutationId = requestMutationId(request);
        if (
            body.mutationId !== undefined &&
            headerMutationId !== undefined &&
            body.mutationId !== headerMutationId
        ) {
            sendJson(response, 400, {
                error: "The mutation id header must match the request body.",
            });
            return;
        }
        const mutationId = body.mutationId ?? headerMutationId;
        try {
            if (
                sessionMutationCompleted(session, mutationId) ||
                (mutationId !== undefined &&
                    (await store.sessionScopeMutationApplied(ctx, sessionId, mutationId)))
            ) {
                sendJson(response, 200, { session: session.snapshot() });
                return;
            }
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 400, { error: errorToMessage(error) });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            const filed = await store.setSessionFolder(
                ctx,
                sessionId,
                body.scope.kind === "folder" ? body.scope.folderId : null,
                body.afterId,
                mutationId,
            );
            if (filed === undefined) {
                sendJson(response, 404, { error: "That chat is gone." });
                return;
            }
            await filed.recordMutationApplied(ctx, mutationId);
            sendJson(response, 200, { session: filed.snapshot() });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (error instanceof FolderError) {
                sendJson(response, error.code === "folder_not_found" ? 404 : 400, {
                    error: error.message,
                });
                return;
            }
            sendJson(response, 400, { error: errorToMessage(error) });
        }
        return;
    }

    if (request.method === "POST" && route.name === "reorder") {
        if (session.isSubagent()) {
            sendJson(response, 409, {
                error: "Subagent histories are read-only and cannot be reordered.",
            });
            return;
        }
        const body = await readJson<unknown>(request);
        if (!isReorderRequest(body)) {
            sendJson(response, 400, {
                error: "The preceding chat ID must be text or null.",
            });
            return;
        }
        try {
            sendJson(response, 200, {
                session: (await store.reorderSession(ctx, sessionId, body))!.snapshot(),
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (request.method === "POST" && route.name === "read") {
        if (session.isSubagent()) {
            sendJson(response, 409, {
                error: "Subagent histories are read-only and are never unread.",
            });
            return;
        }
        /*
         * Marking a chat read is what a client without a terminal uses in place
         * of focusing one. It is idempotent: a session that was already read
         * answers with its current state rather than failing, so a repeated
         * request after a retry is harmless.
         */
        await session.markRead(ctx);
        sendJson<SessionReadResponse>(response, 200, { session: session.snapshot() });
        return;
    }

    if (request.method === "POST" && route.name === "transfer") {
        const body = await readJson<unknown>(request);
        if (!Value.Check(transferSessionRequestSchema, body)) {
            sendJson(response, 400, {
                error: "Choose an existing target workspace.",
            });
            return;
        }
        try {
            const result = await store.transferSession(
                ctx,
                sessionId,
                body as TransferSessionRequest,
            );
            if (result === undefined) {
                sendJson(response, 404, { error: "Session not found" });
                return;
            }
            sendJson<TransferSessionResponse>(response, 200, result);
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, error instanceof WorkspaceTransferTargetRestoreError ? 500 : 409, {
                error: errorToMessage(error),
            });
        }
        return;
    }

    if (request.method === "POST" && (route.name === "archive" || route.name === "unarchive")) {
        if (session.isSubagent()) {
            sendJson(response, 409, {
                error: "Subagent histories are read-only and cannot be archived.",
            });
            return;
        }
        if (route.name === "unarchive") {
            const snapshot = session.snapshot();
            if (snapshot.status === "archived") {
                sendJson(response, 409, {
                    error: "A session retired with its execution context cannot be restored.",
                });
                return;
            }
            if (snapshot.scope.kind === "folder") {
                const folder = await store.getFolder(ctx, snapshot.scope.folderId);
                if (folder === undefined || folder.archivedAt !== undefined) {
                    sendJson(response, 409, {
                        error: "A chat cannot be restored while its folder is archived.",
                    });
                    return;
                }
            }
        }
        /*
         * Archive state controls listing visibility only. It never stops or deletes a session:
         * running and queued sessions may be hidden, and every archived session remains readable
         * and resumable by ID. Repeating either action is intentionally idempotent.
         */
        const mutationId = requestMutationId(request);
        const completed =
            mutationId === undefined
                ? undefined
                : session.events
                      .since(undefined)
                      ?.find(
                          (event) =>
                              event.type === "session_archived" &&
                              event.data.mutationId === mutationId,
                      );
        if (completed !== undefined) {
            sendJson<SessionArchiveResponse>(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        const archived = await session.setArchived(ctx, route.name === "archive", mutationId);
        if (route.name === "unarchive") {
            // A visible chat must never sit under a project the user archived.
            if (archived.scope.kind === "project" || archived.scope.kind === "workspace") {
                await store.unarchiveProject(ctx, archived.scope.projectId);
            }
        }
        sendJson<SessionArchiveResponse>(response, 200, { session: archived });
        return;
    }

    if (request.method === "PATCH" && route.name === "session") {
        const body = await readJson<UpdateSessionRequest | null>(request);
        if (
            body === null ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            (typeof body.appendSystemPrompt !== "string" && body.appendSystemPrompt !== null)
        ) {
            sendJson(response, 400, {
                error: "The appended system prompt must be text or null.",
            });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        sendJson(response, 200, {
            session: await session.update(ctx, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "current-provider-quota") {
        const snapshot = session.snapshot();
        const currentProviderId = snapshot.providerId;
        const credential = providerCredential(snapshot.modelCatalog, currentProviderId);
        const quota =
            credential === undefined
                ? await getProviderQuota?.(currentProviderId, snapshot.ownerInstanceId)
                : await getProviderQuota?.(currentProviderId, snapshot.ownerInstanceId, credential);
        sendJson<GetCurrentProviderQuotaResponse>(response, 200, {
            currentProviderId,
            ...(quota === undefined ? {} : { quota }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "session-state") {
        // The position is read before the session is described, so the payload
        // states the point in the live stream it reflects. Everything after that
        // position arrives on the global stream and is replayed on top of this.
        const cursor = store.liveEvents.cursor();
        const turnLimit = parseTurnLimit(url.searchParams.get("turns"));
        const baseHello = await sessionStateHello(
            ctx,
            session,
            turnLimit,
            await store.listSubagents(ctx, sessionId),
        );
        const hello = baseHello;
        // A client catching up says which message it already holds, and receives
        // only the turns from there on. It still gets the whole current session,
        // because a gap leaves the rest of that state uncertain too — but the
        // conversation itself, which is the part that can be colossal, is sent
        // incrementally rather than from the beginning.
        const after = url.searchParams.get("after") ?? undefined;
        const forward =
            after === undefined ? undefined : await session.transcriptSince(ctx, after, turnLimit);
        if (after !== undefined && forward !== undefined) {
            sendJson<SessionStateResponse>(response, 200, {
                ...hello,
                append: true,
                cursor,
                transcript: projectClientTranscript(forward),
            });
            return;
        }
        // No anchor, or one too old to page from: the newest turns instead, which
        // the client takes as a replacement rather than an addition.
        sendJson<SessionStateResponse>(response, 200, { cursor, ...hello });
        return;
    }

    if (request.method === "GET" && route.name === "transcript") {
        // Paging forward is how a client that missed events catches up; paging
        // backward is how it reads further into the past.
        const after = url.searchParams.get("after") ?? undefined;
        if (after !== undefined) {
            const forward = await session.transcriptSince(ctx, after, SESSION_STREAM_TURN_LIMIT);
            if (forward === undefined) {
                sendJson(response, 409, {
                    error: "That part of the conversation is no longer available.",
                });
                return;
            }
            sendJson(response, 200, projectClientTranscript(forward));
            return;
        }
        const before = url.searchParams.get("before") ?? undefined;
        const page = await session.transcriptPage(ctx, SESSION_STREAM_TURN_LIMIT, before);
        if (page === undefined) {
            // The anchor turn is gone, so the reader's view of the conversation
            // is stale and paging from it would duplicate or misplace content.
            sendJson(response, 409, {
                error: "That part of the conversation is no longer available.",
            });
            return;
        }
        sendJson(response, 200, projectClientTranscript(page));
        return;
    }

    if (request.method === "GET" && route.name === "usage") {
        const ownerInstanceId = session.snapshot().ownerInstanceId;
        const sessionEvents = session.events.all();
        const usage = session.usage(sessionEvents);
        const currentProviderId = session.snapshot().providerId;
        const providerIds = [
            ...new Set([
                ...usage.groups.flatMap((group) =>
                    group.providerId === null ? [] : [group.providerId],
                ),
                currentProviderId,
            ]),
        ];
        const observedQuotas = session.events.latestProviderQuotas();
        const modelCatalog = session.snapshot().modelCatalog;
        const quotas = (
            await Promise.all(
                providerIds.map(async (providerId) => {
                    const credential = providerCredential(modelCatalog, providerId);
                    const loaded =
                        credential === undefined
                            ? await getProviderQuota?.(providerId, ownerInstanceId)
                            : await getProviderQuota?.(providerId, ownerInstanceId, credential);
                    // What this session saw the provider say during its own run
                    // can be newer than the daemon's last reading.
                    const observed = observedQuotas.get(providerId);
                    const quota =
                        observed !== undefined &&
                        (loaded === undefined || observed.capturedAt >= loaded.capturedAt)
                            ? observed
                            : loaded;
                    return quota === undefined ? undefined : { providerId, quota };
                }),
            )
        ).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
        sendJson<GetSessionUsageResponse>(response, 200, {
            currentProviderId,
            groups: usage.groups,
            quotas,
            sessionTokenCount: usage.sessionTokenCount,
            ...(usage.currentContext === undefined ? {} : { context: usage.currentContext }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "subagents") {
        sendJson<ListSubagentsResponse>(response, 200, {
            subagents: await store.listSubagents(ctx, sessionId),
        });
        return;
    }

    if (request.method === "POST" && route.name === "workflow-stop") {
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            const workflow = session
                .listWorkflows()
                .find((candidate) => candidate.runId === route.workflowRunId);
            sendJson(
                response,
                workflow === undefined ? 404 : 200,
                workflow === undefined ? { error: "Workflow not found" } : { workflow },
            );
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        const workflow = session.stopWorkflow(ctx, route.workflowRunId);
        if (workflow === undefined) {
            sendJson(response, 404, { error: "Workflow not found" });
            return;
        }
        await session.recordMutationApplied(ctx, mutationId);
        sendJson<StopWorkflowResponse>(response, 200, { workflow });
        return;
    }

    if (request.method === "POST" && route.name === "fork") {
        if (session.isSubagent()) {
            sendJson(response, 409, { error: "Subagent histories cannot be forked." });
            return;
        }
        const targetSessionId = requestMutationId(request);
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            const forked = await store.fork(ctx, sessionId, targetSessionId);
            if (forked === undefined) {
                sendJson(response, 404, { error: "Session not found" });
                return;
            }
            sendJson<ForkSessionResponse>(response, 201, { session: forked.snapshot() });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The session could not be forked.",
            });
        }
        return;
    }

    if (
        session.isSubagent() &&
        route.name !== "context" &&
        isSessionMutation(route.name, request.method)
    ) {
        sendJson(response, 409, {
            error: "Subagent histories are read-only and cannot be resumed.",
        });
        return;
    }

    if (request.method === "POST" && route.name === "messages") {
        const transport = decodeTemporaryGitCredential(await readJson<unknown>(request));
        if (transport === undefined) {
            sendJson(response, 400, { error: "Temporary Git credentials are invalid." });
            return;
        }
        const body = transport.body;
        if (!isSubmitMessageRequest(body)) {
            sendJson(response, 400, { error: "Message text must be text." });
            return;
        }
        if (rejectUnsupportedAgentSubmissionOptions(response, runtimeConfig, body)) return;
        if (!(await authorizeMessageProfile(ctx, request, response, runtimeConfig, body))) return;
        if (runtimeConfig.agents === undefined && body.clientSubmissionId !== undefined) {
            const submitted = session.events.messageSubmission(body.clientSubmissionId);
            if (submitted !== undefined) {
                sendJson<SubmitMessageResponse>(response, 202, {
                    eventId: submitted.id,
                    runId: submitted.data.runId,
                    sessionId: session.id,
                });
                return;
            }
        }
        if (
            !(await prepareSessionGitCredential(
                ctx,
                request,
                response,
                store,
                session.id,
                body.identity,
                transport.githubToken,
            ))
        ) {
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        // A user working in an explicitly archived session makes it visible again.
        const mutationId = body.mutationId ?? requestMutationId(request);
        sendJson<SubmitMessageResponse>(
            response,
            202,
            runtimeConfig.agents === undefined
                ? await session.submit(ctx, {
                      ...body,
                      ...(mutationId === undefined ? {} : { mutationId }),
                  })
                : await runtimeConfig.agents.submit(ctx, session, {
                      ...body,
                      ...(mutationId === undefined ? {} : { mutationId }),
                  }),
        );
        return;
    }

    if (request.method === "POST" && route.name === "context") {
        const transport = decodeTemporaryGitCredential(await readJson<unknown>(request));
        if (transport === undefined) {
            sendJson(response, 400, { error: "Temporary Git credentials are invalid." });
            return;
        }
        const body = transport.body;
        if (!Value.Check(submitContextMessageRequestSchema, body)) {
            sendJson(response, 400, {
                error: "A context note accepts only message text and optional submission identities; run settings are not allowed.",
            });
            return;
        }
        if (runtimeConfig.agents !== undefined) {
            sendAgentsModeUnavailable(response, "Context messaging");
            return;
        }
        if (!(await authorizeMessageProfile(ctx, request, response, runtimeConfig, body))) return;
        if (runtimeConfig.agents === undefined && body.clientSubmissionId !== undefined) {
            const submitted = session.events.messageSubmission(body.clientSubmissionId);
            if (submitted?.data.delivery === "context") {
                sendJson<SubmitContextMessageResponse>(response, 202, {
                    delivery: "context",
                    eventId: submitted.id,
                    messageId: submitted.data.message.id,
                    sessionId: session.id,
                });
                return;
            }
        }
        if (
            !(await prepareSessionGitCredential(
                ctx,
                request,
                response,
                store,
                session.id,
                body.identity,
                transport.githubToken,
            ))
        ) {
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        const mutationId = body.mutationId ?? requestMutationId(request);
        sendJson<SubmitContextMessageResponse>(
            response,
            202,
            await session.submitContext(ctx, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        );
        return;
    }

    if (request.method === "GET" && route.name === "external-tool-calls") {
        sendJson(response, 200, { calls: session.externalToolCalls() });
        return;
    }

    if (request.method === "POST" && route.name === "external-tool-call") {
        const body = await readJson<unknown>(request, 1_048_576);
        if (!isExternalToolCallResolution(body)) {
            sendJson(response, 400, { error: "External function result is invalid." });
            return;
        }
        try {
            const result = await session.resolveExternalToolCall(
                ctx,
                route.externalToolCallId,
                body as ResolveExternalToolCallRequest,
            );
            if (result === undefined) {
                sendJson(response, 404, { error: "External function call not found." });
                return;
            }
            sendJson<ResolveExternalToolCallResponse>(response, 200, result);
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, { error: errorToMessage(error) });
        }
        return;
    }

    if (request.method === "POST" && route.name === "scheduled-message-cancel") {
        const mutationId = requestMutationId(request);
        const result = await session.cancelScheduledMessage(
            ctx,
            route.scheduledMessageId,
            mutationId,
        );
        if (result.message === undefined) {
            sendJson(response, 404, { error: "Scheduled message not found." });
            return;
        }
        sendJson<CancelScheduledMessageResponse>(response, 200, result);
        return;
    }

    if (request.method === "POST" && route.name === "activity") {
        session.recordUserActivity();
        sendJson<RecordSessionActivityResponse>(response, 200, { recorded: true });
        return;
    }

    if (request.method === "POST" && route.name === "steer") {
        const transport = decodeTemporaryGitCredential(await readJson<unknown>(request));
        if (transport === undefined) {
            sendJson(response, 400, { error: "Temporary Git credentials are invalid." });
            return;
        }
        const body = transport.body;
        if (!isSubmitMessageRequest(body)) {
            sendJson(response, 400, { error: "Message text must be text." });
            return;
        }
        if (rejectUnsupportedAgentSubmissionOptions(response, runtimeConfig, body)) return;
        if (!(await authorizeMessageProfile(ctx, request, response, runtimeConfig, body))) return;
        if (runtimeConfig.agents === undefined && body.clientSubmissionId !== undefined) {
            const submitted = session.events.messageSubmission(body.clientSubmissionId);
            if (submitted !== undefined) {
                sendJson<SteerMessageResponse>(response, 202, {
                    delivery: submitted.data.delivery === "steer" ? "steer" : "run",
                    eventId: submitted.id,
                    runId: submitted.data.runId,
                    sessionId: session.id,
                });
                return;
            }
        }
        if (
            !(await prepareSessionGitCredential(
                ctx,
                request,
                response,
                store,
                session.id,
                body.identity,
                transport.githubToken,
            ))
        ) {
            return;
        }
        try {
            sendJson<SteerMessageResponse>(
                response,
                202,
                runtimeConfig.agents === undefined
                    ? await session.steer(ctx, body)
                    : await runtimeConfig.agents.steer(ctx, session, body),
            );
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The active run cannot be steered.",
            });
        }
        return;
    }

    if (request.method === "POST" && route.name === "abort") {
        const mutationId = requestMutationId(request);
        const completed =
            mutationId === undefined
                ? undefined
                : session.events
                      .since(undefined)
                      ?.find(
                          (event): event is Extract<SessionEvent, { type: "abort_requested" }> =>
                              event.type === "abort_requested" &&
                              event.data.mutationId === mutationId,
                      );
        if (completed !== undefined) {
            sendJson<AbortRunResponse>(response, 200, {
                aborted: true,
                ...(completed.data.continuePendingSteering === true ? { continued: true } : {}),
                eventId: completed.id,
            });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            if (runtimeConfig.agents !== undefined) {
                const expectedRunId = url.searchParams.get("expectedRunId") ?? undefined;
                const steeringMessageIds = url.searchParams.getAll("steeringMessageId");
                sendJson<AbortRunResponse>(
                    response,
                    200,
                    await runtimeConfig.agents.abort(ctx, session, {
                        continuePendingSteering:
                            url.searchParams.get("continuePendingSteering") === "1",
                        ...(expectedRunId === undefined ? {} : { expectedRunId }),
                        ...(mutationId === undefined ? {} : { mutationId }),
                        ...(steeringMessageIds.length === 0 ? {} : { steeringMessageIds }),
                    }),
                );
                return;
            }
            const expectedRunId = url.searchParams.get("expectedRunId") ?? undefined;
            const steeringMessageIds = url.searchParams.getAll("steeringMessageId");
            sendJson<AbortRunResponse>(
                response,
                200,
                await session.abort(ctx, {
                    continuePendingSteering:
                        url.searchParams.get("continuePendingSteering") === "1",
                    ...(expectedRunId === undefined ? {} : { expectedRunId }),
                    ...(mutationId === undefined ? {} : { mutationId }),
                    ...(steeringMessageIds.length === 0 ? {} : { steeringMessageIds }),
                }),
            );
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The run could not be aborted.",
            });
        }
        return;
    }

    if (request.method === "POST" && route.name === "background-processes-stop") {
        const stoppedProcesses = await session.stopBackgroundProcesses(ctx);
        sendJson(response, 200, { stoppedProcesses });
        return;
    }

    if (route.name === "background-process") {
        if (request.method === "GET") {
            const rawWaitMs = url.searchParams.get("waitMs");
            const waitMs =
                rawWaitMs === null
                    ? 0
                    : Math.max(0, Math.min(30_000, Number.parseInt(rawWaitMs, 10) || 0));
            const process = await session.readBackgroundProcess(ctx, route.processSessionId, {
                waitMs,
            });
            if (process === undefined) {
                sendJson(response, 404, { error: "The background terminal was not found." });
                return;
            }
            sendJson<ReadBackgroundProcessResponse>(response, 200, process);
            return;
        }
        if (request.method === "DELETE") {
            const result = await session.stopBackgroundProcess(ctx, route.processSessionId);
            sendJson<StopBackgroundProcessResponse>(response, 200, result);
            return;
        }
    }

    if (request.method === "POST" && route.name === "shell") {
        const body = await readJson<unknown>(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(response, 400, { error: "Enter a shell command after !." });
            return;
        }
        const candidate = body as Partial<RunShellCommandRequest>;
        if (
            typeof candidate.command !== "string" ||
            candidate.command.trim().length === 0 ||
            typeof candidate.commandId !== "string" ||
            candidate.commandId.length === 0
        ) {
            sendJson(response, 400, { error: "Enter a shell command after !." });
            return;
        }
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, {});
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        const result = await session.runShellCommand(ctx, candidate as RunShellCommandRequest);
        await session.recordMutationApplied(ctx, mutationId);
        sendJson<RunShellCommandResponse>(response, 200, result);
        return;
    }

    if (request.method === "POST" && route.name === "reset") {
        if (runtimeConfig.agents !== undefined) {
            sendAgentsModeUnavailable(response, "Session reset");
            return;
        }
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        await session.reset(ctx);
        await session.recordMutationApplied(ctx, mutationId);
        sendJson(response, 200, { session: session.snapshot() });
        return;
    }

    if (request.method === "POST" && route.name === "rewind") {
        if (runtimeConfig.agents !== undefined) {
            sendAgentsModeUnavailable(response, "Session rewind");
            return;
        }
        const body = await readJson<RewindSessionRequest>(request);
        if (typeof body.messageId !== "string" || body.messageId.length === 0) {
            sendJson(response, 400, { error: "Choose a user message to rewind to." });
            return;
        }
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            const result = await session.rewind(ctx, body.messageId);
            await session.recordMutationApplied(ctx, mutationId);
            sendJson<RewindSessionResponse>(response, 200, {
                ...result,
                session: session.snapshot(),
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The session could not be rewound.",
            });
        }
        return;
    }

    if (request.method === "POST" && route.name === "compact") {
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        if (runtimeConfig.agents !== undefined) {
            try {
                const result = await runtimeConfig.agents.compact(ctx, session);
                await session.recordMutationApplied(ctx, mutationId);
                sendJson<CompactSessionResponse>(response, 200, {
                    result,
                    session: session.snapshot(),
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 409, { error: errorToMessage(error) });
            }
            return;
        }
        const result = await session.compact(ctx);
        await session.recordMutationApplied(ctx, mutationId);
        sendJson<CompactSessionResponse>(response, 200, {
            result,
            session: session.snapshot(),
        });
        return;
    }

    if (request.method === "PATCH" && route.name === "effort") {
        const body = await readJson<ChangeEffortRequest>(request);
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        if (runtimeConfig.agents !== undefined) {
            try {
                sendJson(response, 200, {
                    session: await runtimeConfig.agents.changeEffort(ctx, session, {
                        ...body,
                        ...(mutationId === undefined ? {} : { mutationId }),
                    }),
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 409, { error: errorToMessage(error) });
            }
            return;
        }
        sendJson(response, 200, {
            session: await session.changeEffort(ctx, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "PATCH" && route.name === "service-tier") {
        const body = await readJson<ChangeServiceTierRequest>(request);
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        if (runtimeConfig.agents !== undefined) {
            try {
                sendJson(response, 200, {
                    session: await runtimeConfig.agents.changeServiceTier(ctx, session, {
                        ...body,
                        ...(mutationId === undefined ? {} : { mutationId }),
                    }),
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 409, { error: errorToMessage(error) });
            }
            return;
        }
        sendJson(response, 200, {
            session: await session.changeServiceTier(ctx, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "PATCH" && route.name === "model") {
        const body = await readJson<ChangeModelRequest>(request);
        const mutationId = body.mutationId ?? requestMutationId(request);
        const completed =
            mutationId === undefined
                ? undefined
                : session.events
                      .since(undefined)
                      ?.find(
                          (event) =>
                              event.type === "session_configuration_changed" &&
                              event.data.mutationId === mutationId,
                      );
        if (completed !== undefined) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        if (runtimeConfig.agents !== undefined) {
            try {
                sendJson(response, 200, {
                    session: await runtimeConfig.agents.changeModel(ctx, session, {
                        ...body,
                        ...(mutationId === undefined ? {} : { mutationId }),
                    }),
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 409, {
                    error: errorToMessage(error),
                    session: session.snapshot(),
                });
            }
            return;
        }
        try {
            sendJson(response, 200, {
                session: await session.changeModel(ctx, {
                    ...body,
                    ...(mutationId === undefined ? {} : { mutationId }),
                }),
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: errorToMessage(error),
                session: session.snapshot(),
            });
        }
        return;
    }

    if (request.method === "PATCH" && route.name === "permissions") {
        const body = await readJson<ChangePermissionModeRequest>(request);
        if (!isPermissionMode(body.permissionMode)) {
            sendJson(response, 400, {
                error: INVALID_PERMISSION_MODE_MESSAGE,
            });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        if (runtimeConfig.agents !== undefined) {
            try {
                sendJson(response, 200, {
                    session: await runtimeConfig.agents.changePermissionMode(ctx, session, {
                        ...body,
                        ...(mutationId === undefined ? {} : { mutationId }),
                    }),
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 409, { error: errorToMessage(error) });
            }
            return;
        }
        sendJson(response, 200, {
            session: await session.changePermissionMode(ctx, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "PUT" && route.name === "draft") {
        const body = await readJson<SetSessionDraftRequest | null>(request);
        if (
            body === null ||
            typeof body !== "object" ||
            (body.draft !== null && typeof body.draft !== "string") ||
            (body.updatedAt !== undefined && typeof body.updatedAt !== "number")
        ) {
            sendJson(response, 400, { error: "A draft must be text." });
            return;
        }
        if (typeof body.draft === "string" && body.draft.length > SESSION_DRAFT_MAX_LENGTH) {
            sendJson(response, 400, {
                error: "This draft is too long to sync. It stays on this terminal only.",
            });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        sendJson(response, 200, {
            session: await session.setDraft(ctx, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "POST" && route.name === "secrets") {
        const body = await readJson<AttachSecretRequest | null>(request);
        if (
            body === null ||
            typeof body !== "object" ||
            typeof body.secretId !== "string" ||
            body.secretId.length === 0
        ) {
            sendJson(response, 400, { error: "Choose a secret to attach." });
            return;
        }
        const scope = body.scope ?? "session";
        if (scope !== "session" && scope !== "project") {
            sendJson(response, 400, { error: "Secret scope must be Session or Project." });
            return;
        }
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            sendJson<SecretSessionResponse>(response, 200, {
                session:
                    (
                        await store.attachSecret(ctx, session.id, body.secretId, scope, mutationId)
                    )?.snapshot() ?? session.snapshot(),
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The secret could not be attached.",
            });
        }
        return;
    }

    if (request.method === "DELETE" && route.name === "secret") {
        const scope = url.searchParams.get("scope") ?? "session";
        if (scope !== "session" && scope !== "project") {
            sendJson(response, 400, { error: "Secret scope must be Session or Project." });
            return;
        }
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        sendJson<SecretSessionResponse>(response, 200, {
            session:
                (
                    await store.detachSecret(ctx, session.id, route.secretId, scope, mutationId)
                )?.snapshot() ?? session.snapshot(),
        });
        return;
    }

    if (request.method === "POST" && route.name === "goal") {
        const body = await readJson<SetGoalRequest>(request);
        if (typeof body.objective !== "string") {
            sendJson(response, 400, { error: "Goal objective must be text." });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            await session.setGoal(ctx, body, mutationId);
            sendJson<GoalSessionResponse>(response, 200, { session: session.snapshot() });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The goal could not be started.",
            });
        }
        return;
    }

    if (request.method === "PATCH" && route.name === "goal") {
        const body = await readJson<ChangeSessionGoalStatusRequest>(request);
        if (!isGoalStatus(body.status)) {
            sendJson(response, 400, {
                error: "Goal status must be Active, Paused, Blocked, or Complete.",
            });
            return;
        }
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            await session.changeGoalStatus(
                ctx,
                body,
                mutationId === undefined ? {} : { mutationId },
            );
            sendJson<GoalSessionResponse>(response, 200, { session: session.snapshot() });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: error instanceof Error ? error.message : "The goal could not be updated.",
            });
        }
        return;
    }

    if (request.method === "DELETE" && route.name === "goal") {
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        await session.clearGoal(ctx, mutationId);
        sendJson<GoalSessionResponse>(response, 200, { session: session.snapshot() });
        return;
    }

    if (request.method === "POST" && route.name === "user-input") {
        const body = await readJson<AnswerUserInputRequest>(request);
        const mutationId = body.mutationId ?? requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        try {
            const snapshot = await session.answerUserInput(ctx, route.requestId, {
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            });
            if (snapshot === undefined) {
                sendJson(response, 409, {
                    error: "This question is no longer waiting for an answer.",
                });
                return;
            }
            sendJson(response, 200, { session: snapshot });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 400, {
                error: error instanceof Error ? error.message : "The answer is invalid.",
            });
        }
        return;
    }

    if (request.method === "GET" && route.name === "events") {
        const after = url.searchParams.get("after") ?? undefined;
        if (after !== undefined && url.searchParams.has("message_limit")) {
            sendJson(response, 400, {
                error: "A session message limit is only supported while loading initial history.",
            });
            return;
        }
        const messageLimit = parseLimit(url.searchParams.get("message_limit"));
        if (url.searchParams.has("message_limit") && messageLimit === undefined) {
            sendJson(response, 400, { error: "Session message limit is invalid." });
            return;
        }
        const events = session.events.since(after);
        if (events === undefined) {
            sendJson(response, 409, { error: "Event cursor not found" });
            return;
        }
        sendJson(response, 200, {
            events: selectRecentSessionEvents(
                after === undefined
                    ? events.filter((event) => !isLiveOnlySessionEvent(event))
                    : events,
                after === undefined ? messageLimit : undefined,
            ),
        });
        return;
    }

    if (request.method === "GET" && route.name === "stream") {
        await streamEvents(
            ctx,
            request,
            response,
            session,
            url.searchParams.get("after") ?? undefined,
            sessionEventStreamLeases,
            parseTurnLimit(url.searchParams.get("turns")),
            await store.listSubagents(ctx, sessionId),
        );
        return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
}

function pendingGitSnapshot(
    generation: string,
    facts: GitRepositoryFacts | undefined,
): GitChangeSnapshot {
    return {
        changedFiles: 0,
        comparison: "unavailable",
        conflicted: false,
        countsExact: false,
        deletions: 0,
        error: "Git state is loading.",
        facts: facts ?? { ahead: 0, behind: 0, detached: false },
        files: [],
        filesTruncated: false,
        generation,
        insertions: 0,
        scannedAt: Date.now(),
        version: 0,
    };
}

function providerCredential(
    catalog: ModelCatalog,
    providerId: string,
): ProviderCredentialProvenance | undefined {
    return catalog.providers.find((provider) => provider.providerId === providerId)?.credential;
}

async function resolveProjectScopeDirectory(
    ctx: Context,
    store: SessionStore,
    scope: ProjectScope,
): Promise<{ ok: true; path: string } | { error: string; ok: false; status: 404 | 409 }> {
    const project = await store.getProject(ctx, scope.projectId);
    if (project === undefined) return { error: "Project not found", ok: false, status: 404 };
    if (scope.workspaceId === undefined) return { ok: true, path: project.path };
    const workspace = await store.getWorkspace(ctx, scope.projectId, scope.workspaceId);
    if (workspace === undefined) {
        return { error: "Workspace not found", ok: false, status: 404 };
    }
    if (workspace.status !== "ready" || workspace.presence !== "present") {
        return {
            error: "Only ready, available workspaces can access files.",
            ok: false,
            status: 409,
        };
    }
    return { ok: true, path: workspace.path };
}

function healthResponse(
    catalog: ModelCatalog,
    identity: DaemonIdentity,
    durableGlobalEventQueue: boolean,
): HealthResponse {
    return {
        catalog,
        durableGlobalEventQueue,
        healthy: true,
        identity,
        protocolVersion: RIG_PROTOCOL_VERSION,
        ready: true,
        status: "ready",
    };
}

function parseLimit(value: string | null): number | undefined {
    if (value === null) {
        return undefined;
    }

    const limit = Number.parseInt(value, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
        return undefined;
    }
    return Math.min(limit, 500);
}

function parseArchivedFilter(value: string | null): boolean | "all" | undefined {
    if (value === null || value === "false") return false;
    if (value === "true") return true;
    if (value === "all") return "all";
    return undefined;
}

async function resolveAppletContext(
    ctx: Context,
    store: SessionStore,
    applet: Applet,
    request: ResolveAppletOpenRequest,
): Promise<
    | { context: AppletContext; type: "context" }
    | {
          code: "invalid_request" | "invalid_applet";
          message: string;
          type: "error";
      }
> {
    let context: AppletContext;
    let scope: SlotScope;
    if (request.sessionId !== undefined) {
        const session = await store.get(ctx, request.sessionId);
        if (session === undefined) {
            return {
                code: "invalid_request",
                message: `No session with the id ${request.sessionId} exists.`,
                type: "error",
            };
        }
        const identity = session.projectIdentity();
        if (request.projectId !== undefined && request.projectId !== identity?.projectId) {
            return {
                code: "invalid_request",
                message:
                    identity === undefined
                        ? `The session ${request.sessionId} does not belong to a project.`
                        : `The session ${request.sessionId} belongs to project ${identity.projectId}, not project ${request.projectId}.`,
                type: "error",
            };
        }
        if (request.workspaceId !== undefined && request.workspaceId !== identity?.workspaceId) {
            return {
                code: "invalid_request",
                message:
                    identity?.workspaceId === undefined
                        ? `The session ${request.sessionId} does not belong to a workspace.`
                        : `The session ${request.sessionId} belongs to workspace ${identity.workspaceId}, not workspace ${request.workspaceId}.`,
                type: "error",
            };
        }
        context = {
            applet: applet.name,
            version: applet.currentVersion,
            sessionId: request.sessionId,
            ...(identity === undefined ? {} : { projectId: identity.projectId }),
            ...(identity?.workspaceId === undefined ? {} : { workspaceId: identity.workspaceId }),
        };
        scope = "session";
    } else {
        if (request.workspaceId !== undefined && request.projectId === undefined) {
            return {
                code: "invalid_request",
                message: "A workspace applet context also needs its project id.",
                type: "error",
            };
        }
        if (
            request.projectId !== undefined &&
            (await store.getProject(ctx, request.projectId)) === undefined
        ) {
            return {
                code: "invalid_request",
                message: `No project with the id ${request.projectId} exists.`,
                type: "error",
            };
        }
        if (
            request.projectId !== undefined &&
            request.workspaceId !== undefined &&
            (await store.getWorkspace(ctx, request.projectId, request.workspaceId)) === undefined
        ) {
            return {
                code: "invalid_request",
                message: `No workspace with the id ${request.workspaceId} exists in project ${request.projectId}.`,
                type: "error",
            };
        }
        context = {
            applet: applet.name,
            version: applet.currentVersion,
            ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
            ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
        };
        scope =
            request.workspaceId !== undefined
                ? "workspace"
                : request.projectId !== undefined
                  ? "project"
                  : "everywhere";
    }
    if (!applet.allowedScopes.includes(scope)) {
        return {
            code: "invalid_applet",
            message: describeAppletScopeNotAllowed(applet, scope),
            type: "error",
        };
    }
    return { context, type: "context" };
}

function parseFileSearchLimit(value: string | null): number {
    if (value === null) {
        return 20;
    }

    const limit = Number.parseInt(value, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
        return 20;
    }
    return Math.min(limit, 50);
}

function parseFileTreeRequest(url: URL): ListFileTreeRequest | undefined {
    const candidate: Record<string, unknown> = Object.fromEntries(url.searchParams);
    candidate.path ??= "";
    if (typeof candidate.limit === "string") {
        candidate.limit = Number(candidate.limit);
    }
    return Value.Check(listFileTreeRequestSchema, candidate)
        ? (candidate as ListFileTreeRequest)
        : undefined;
}

function matchRoute(pathname: string):
    | {
          name:
              | "global-events"
              | "git-watch"
              | "global-events-stream"
              | "live-events-stream"
              | "catalog"
              | "global-events-trim"
              | "external-tool-calls"
              | "config"
              | "global-instructions"
              | "global-security-policy"
              | "debug-inspector"
              | "health"
              | "inference-credentials"
              | "installation"
              | "onboarding"
              | "onboarding-murmur"
              | "p2p-status"
              | "p2p-invitations"
              | "p2p-joins"
              | "happy-cloud-commands"
              | "happy-cloud-profile"
              | "happy-cloud-status"
              | "happy-reload"
              | "messages"
              | "models"
              | "presence"
              | "profiles"
              | "sharing"
              | "sharing-invitations"
              | "sharing-folder-shares"
              | "sharing-contact-requests"
              | "plugin-catalog"
              | "documents"
              | "folders"
              | "plugins"
              | "projects"
              | "project-clone"
              | "provider-usage"
              | "secret-registrations"
              | "sessions"
              | "shutdown"
              | "slots"
              | "timeline"
              | "applets"
              | "worklets";
          sessionId?: undefined;
      }
    | {
          cloudSessionId: string;
          name: "happy-cloud-session-blob";
          sessionId?: undefined;
      }
    | {
          name: "p2p-pairing" | "p2p-pairing-answer";
          pairingId: string;
          sessionId?: undefined;
      }
    | { name: "profile"; profileId: string; sessionId?: undefined }
    | {
          name: "sharing-contact-request";
          operation?: "accept";
          requestId: string;
          sessionId?: undefined;
      }
    | {
          identity: string;
          name: "sharing-contact";
          sessionId?: undefined;
      }
    | { name: "slot-entry"; sessionId?: undefined; slotEntryId: string }
    | {
          name: "applet-context" | "applet-open" | "applet-revert" | "applet-versions";
          sessionId?: undefined;
          appletName: string;
      }
    | {
          format: "ico" | "png";
          name: "applet-icon";
          sessionId?: undefined;
          appletName: string;
      }
    | { name: "applet-file"; sessionId?: undefined; appletFilePath: string; appletName: string }
    | {
          name: "worklet-log" | "worklet-revert" | "worklet-versions" | "worklet";
          sessionId?: undefined;
          workletName: string;
      }
    | {
          name: "worklet-icon";
          sessionId?: undefined;
          format: "ico" | "png";
          workletName: string;
      }
    | { assetHash: string; name: "project-asset"; sessionId?: undefined }
    | {
          name: "plugin-log" | "plugin-uninstall";
          pluginName: string;
          sessionId?: undefined;
      }
    | {
          generation: string;
          name: "plugin-icon";
          pluginId: string;
          sessionId?: undefined;
      }
    | {
          appId: string;
          generation: string;
          name: "plugin-app-resource-read" | "plugin-app-tool-call";
          sessionId?: undefined;
      }
    | {
          appId: string;
          generation: string;
          name: "plugin-app-storage";
          operation: "delete" | "get" | "list" | "set";
          sessionId?: undefined;
      }
    | {
          folderId: string;
          name: "folder" | "folder-archive" | "folder-move";
          sessionId?: undefined;
      }
    | {
          folderId: string;
          name: "folder-items";
          sessionId?: undefined;
      }
    | {
          itemId: string;
          name: "folder-item" | "folder-item-archive" | "folder-item-move";
          sessionId?: undefined;
      }
    | {
          documentId: string;
          name: "document" | "document-updates" | "document-write";
          sessionId?: undefined;
      }
    | {
          name:
              | "project"
              | "project-archive"
              | "project-avatar"
              | "project-git"
              | "project-refresh"
              | "project-reorder"
              | "project-settings"
              | "project-workspaces";
          projectId: string;
          sessionId?: undefined;
      }
    | {
          name:
              | "project-workspace"
              | "project-workspace-archive"
              | "project-workspace-git"
              | "project-workspace-reorder";
          projectId: string;
          sessionId?: undefined;
          workspaceId: string;
      }
    | {
          name:
              | "project-file"
              | "project-file-paths"
              | "project-file-revision"
              | "project-file-tree"
              | "project-files";
          projectId: string;
          sessionId?: undefined;
          workspaceId?: string;
      }
    | {
          name: "project-terminals";
          projectId: string;
          sessionId?: undefined;
          workspaceId?: string;
      }
    | {
          name: "project-terminal";
          projectId: string;
          sessionId?: undefined;
          terminalId: string;
          workspaceId?: string;
      }
    | { name: "secret-registration"; secretId: string; sessionId?: undefined }
    | {
          name:
              | "abort"
              | "activity"
              | "archive"
              | "background-processes-stop"
              | "compact"
              | "context"
              | "current-provider-quota"
              | "draft"
              | "effort"
              | "events"
              | "external-tool-calls"
              | "fork"
              | "goal"
              | "messages"
              | "model"
              | "permissions"
              | "read"
              | "reorder"
              | "reset"
              | "rewind"
              | "shell"
              | "secrets"
              | "service-tier"
              | "session"
              | "session-scope"
              | "stream"
              | "session-state"
              | "steer"
              | "transcript"
              | "transfer"
              | "subagents"
              | "unarchive"
              | "usage";
          sessionId: string;
      }
    | {
          connectionId: string;
          name: "terminal-connection";
          sessionId: string;
      }
    | {
          attachmentId: string;
          name: "session-attachment-download" | "session-attachment-preview";
          sessionId: string;
      }
    | { name: "user-input"; requestId: string; sessionId: string }
    | { name: "external-tool-call"; externalToolCallId: string; sessionId: string }
    | { name: "scheduled-message-cancel"; scheduledMessageId: string; sessionId: string }
    | { name: "secret"; secretId: string; sessionId: string }
    | { name: "background-process"; processSessionId: number; sessionId: string }
    | { name: "workflow-stop"; sessionId: string; workflowRunId: string }
    | undefined {
    if (pathname === "/health") return { name: "health" };
    if (pathname === "/inference-credentials") return { name: "inference-credentials" };
    if (pathname === "/installation") return { name: "installation" };
    if (pathname === "/onboarding") return { name: "onboarding" };
    if (pathname === "/onboarding/murmur") return { name: "onboarding-murmur" };
    if (pathname === "/p2p/status") return { name: "p2p-status" };
    if (pathname === "/p2p/invitations") return { name: "p2p-invitations" };
    if (pathname === "/p2p/joins") return { name: "p2p-joins" };
    const p2pPairing = /^\/p2p\/pairings\/([^/]+)(?:\/(answer))?$/.exec(pathname);
    if (
        p2pPairing !== null &&
        p2pPairing[1] !== undefined &&
        Value.Check(p2pInstanceIdSchema, p2pPairing[1])
    ) {
        return {
            name: p2pPairing[2] === "answer" ? "p2p-pairing-answer" : "p2p-pairing",
            pairingId: p2pPairing[1],
        };
    }
    if (pathname === "/happy-cloud/commands") return { name: "happy-cloud-commands" };
    if (pathname === "/happy-cloud/profile") return { name: "happy-cloud-profile" };
    if (pathname === "/happy-cloud/status") return { name: "happy-cloud-status" };
    if (pathname === "/happy/reload") return { name: "happy-reload" };
    if (pathname === "/config") return { name: "config" };
    if (pathname === "/config/instructions") return { name: "global-instructions" };
    if (pathname === "/config/security") return { name: "global-security-policy" };
    if (pathname === "/debug/inspector") return { name: "debug-inspector" };
    if (pathname === "/events") return { name: "global-events" };
    if (pathname === "/events/stream") return { name: "global-events-stream" };
    if (pathname === "/events/live") return { name: "live-events-stream" };
    if (pathname === "/catalog") return { name: "catalog" };
    if (pathname === "/timeline") return { name: "timeline" };
    if (pathname === "/events/trim") return { name: "global-events-trim" };
    if (pathname === "/external-tool-calls") return { name: "external-tool-calls" };
    if (pathname === "/models") return { name: "models" };
    if (pathname === "/messages") return { name: "messages" };
    if (pathname === "/git/watch") return { name: "git-watch" };
    if (pathname === "/presence") return { name: "presence" };
    if (pathname === "/profiles") return { name: "profiles" };
    if (pathname === "/sharing") return { name: "sharing" };
    if (pathname === "/sharing/invitations") return { name: "sharing-invitations" };
    if (pathname === "/sharing/folders") return { name: "sharing-folder-shares" };
    if (pathname === "/sharing/contact-requests") {
        return { name: "sharing-contact-requests" };
    }
    const sharingContactRequest = /^\/sharing\/contact-requests\/([^/]+)(?:\/(accept))?$/u.exec(
        pathname,
    );
    if (sharingContactRequest !== null) {
        const requestId = decodeUrlComponent(sharingContactRequest[1]);
        if (requestId !== undefined && requestId.length <= 256) {
            return {
                name: "sharing-contact-request",
                ...(sharingContactRequest[2] === "accept" ? { operation: "accept" as const } : {}),
                requestId,
            };
        }
    }
    const sharingContact = /^\/sharing\/contacts\/([^/]+)$/u.exec(pathname);
    if (
        sharingContact !== null &&
        sharingContact[1] !== undefined &&
        Value.Check(sharingIdentitySchema, sharingContact[1])
    ) {
        return { identity: sharingContact[1], name: "sharing-contact" };
    }
    const profile = /^\/profiles\/([^/]+)$/u.exec(pathname);
    if (
        profile !== null &&
        profile[1] !== undefined &&
        Value.Check(rigProfileIdSchema, profile[1])
    ) {
        return { name: "profile", profileId: profile[1] };
    }
    if (pathname === "/plugins") return { name: "plugins" };
    if (pathname === "/plugin-catalogs/github") return { name: "plugin-catalog" };
    if (pathname === "/documents") return { name: "documents" };
    if (pathname === "/folders") return { name: "folders" };
    if (pathname === "/projects") return { name: "projects" };
    if (pathname === "/projects/clone") return { name: "project-clone" };
    if (pathname === "/provider-usage") return { name: "provider-usage" };
    if (pathname === "/secrets") return { name: "secret-registrations" };
    if (pathname === "/sessions") return { name: "sessions" };
    if (pathname === "/shutdown") return { name: "shutdown" };
    if (pathname === "/slots") return { name: "slots" };
    if (pathname === "/applets") return { name: "applets" };
    if (pathname === "/worklets") return { name: "worklets" };

    const workletIcon = /^\/worklets\/([^/]+)\/favicon\.(ico|png)$/u.exec(pathname);
    if (workletIcon !== null) {
        const workletName = decodeUrlComponent(workletIcon[1]);
        if (workletName === undefined) return undefined;
        return { format: workletIcon[2] as "ico" | "png", name: "worklet-icon", workletName };
    }
    const workletOperation = /^\/worklets\/([^/]+)(?:\/(versions|revert|log))?$/u.exec(pathname);
    if (workletOperation !== null) {
        const workletName = decodeUrlComponent(workletOperation[1]);
        if (workletName === undefined) return undefined;
        const operation = workletOperation[2];
        return {
            name:
                operation === "versions"
                    ? "worklet-versions"
                    : operation === "revert"
                      ? "worklet-revert"
                      : operation === "log"
                        ? "worklet-log"
                        : "worklet",
            workletName,
        };
    }

    const appletIcon = /^\/applets\/([^/]+)\/favicon\.(ico|png)$/u.exec(pathname);
    if (appletIcon !== null) {
        const appletName = decodeUrlComponent(appletIcon[1]);
        if (appletName === undefined) return undefined;
        return {
            format: appletIcon[2] as "ico" | "png",
            name: "applet-icon",
            appletName,
        };
    }
    const appletFile = /^\/applets\/([^/]+)\/files(?:\/(.*))?$/u.exec(pathname);
    if (appletFile !== null) {
        const appletName = decodeUrlComponent(appletFile[1]);
        if (appletName === undefined) return undefined;
        const rawSegments = (appletFile[2] ?? "").split("/").filter((segment) => segment !== "");
        const segments = rawSegments.map(decodeUrlComponent);
        if (segments.some((segment) => segment === undefined)) return undefined;
        return { name: "applet-file", appletFilePath: segments.join("/"), appletName };
    }
    const appletContext = /^\/applets\/([^/]+)\/context$/u.exec(pathname);
    if (appletContext !== null) {
        const appletName = decodeUrlComponent(appletContext[1]);
        if (appletName === undefined) return undefined;
        return { name: "applet-context", appletName };
    }
    const appletOpen = /^\/applets\/([^/]+)\/open$/u.exec(pathname);
    if (appletOpen !== null) {
        const appletName = decodeUrlComponent(appletOpen[1]);
        if (appletName === undefined) return undefined;
        return { name: "applet-open", appletName };
    }
    const appletOperation = /^\/applets\/([^/]+)\/(versions|revert)$/u.exec(pathname);
    if (appletOperation !== null) {
        const appletName = decodeUrlComponent(appletOperation[1]);
        if (appletName === undefined) return undefined;
        return {
            name: appletOperation[2] === "versions" ? "applet-versions" : "applet-revert",
            appletName,
        };
    }

    const globalParts = pathname.split("/").filter(Boolean);
    if (
        globalParts.length === 3 &&
        globalParts[0] === "happy-cloud" &&
        globalParts[1] === "session-blobs" &&
        globalParts[2] !== undefined
    ) {
        const cloudSessionId = decodeUrlComponent(globalParts[2]);
        return cloudSessionId === undefined
            ? undefined
            : { cloudSessionId, name: "happy-cloud-session-blob" };
    }
    const appOperation =
        /^\/plugin-apps\/([^/]+)\/generations\/([^/]+)\/(resources\/read|tools\/call|extensions\/io\.slopus\.happy\/storage\/(get|set|delete|list))$/u.exec(
            pathname,
        );
    if (appOperation !== null) {
        const appId = decodeUrlComponent(appOperation[1]);
        const generation = decodeUrlComponent(appOperation[2]);
        if (appId === undefined || generation === undefined) return undefined;
        if (appOperation[3] === "resources/read") {
            return { appId, generation, name: "plugin-app-resource-read" };
        }
        if (appOperation[3] === "tools/call") {
            return { appId, generation, name: "plugin-app-tool-call" };
        }
        const operation = appOperation[4] as "delete" | "get" | "list" | "set" | undefined;
        if (operation === undefined) return undefined;
        return { appId, generation, name: "plugin-app-storage", operation };
    }
    const pluginIcon = /^\/plugins\/([^/]+)\/generations\/([^/]+)\/icon$/u.exec(pathname);
    if (pluginIcon !== null) {
        const pluginId = decodeUrlComponent(pluginIcon[1]);
        const generation = decodeUrlComponent(pluginIcon[2]);
        if (pluginId === undefined || generation === undefined) return undefined;
        return { generation, name: "plugin-icon", pluginId };
    }
    if (
        globalParts.length === 3 &&
        globalParts[0] === "plugins" &&
        globalParts[1] !== undefined &&
        globalParts[2] === "log"
    ) {
        return { name: "plugin-log", pluginName: decodeURIComponent(globalParts[1]) };
    }
    if (globalParts.length === 2 && globalParts[0] === "slots" && globalParts[1] !== undefined) {
        const slotEntryId = decodeUrlComponent(globalParts[1]);
        return slotEntryId === undefined ? undefined : { name: "slot-entry", slotEntryId };
    }
    if (globalParts.length === 2 && globalParts[0] === "plugins" && globalParts[1] !== undefined) {
        const pluginName = decodeUrlComponent(globalParts[1]);
        return pluginName === undefined ? undefined : { name: "plugin-uninstall", pluginName };
    }
    if (
        globalParts.length === 2 &&
        globalParts[0] === "project-assets" &&
        globalParts[1] !== undefined
    ) {
        return {
            assetHash: decodeURIComponent(globalParts[1]),
            name: "project-asset",
        };
    }
    if (globalParts[0] === "folders" && globalParts[1] !== undefined) {
        const folderId = decodeURIComponent(globalParts[1]);
        if (globalParts.length === 2) return { folderId, name: "folder" };
        if (globalParts.length === 3 && globalParts[2] === "items") {
            return { folderId, name: "folder-items" };
        }
        if (globalParts.length === 3 && globalParts[2] === "archive") {
            return { folderId, name: "folder-archive" };
        }
        if (globalParts.length === 3 && globalParts[2] === "move") {
            return { folderId, name: "folder-move" };
        }
        return undefined;
    }
    if (globalParts[0] === "folder-items" && globalParts[1] !== undefined) {
        const itemId = decodeURIComponent(globalParts[1]);
        if (globalParts.length === 2) return { itemId, name: "folder-item" };
        if (globalParts.length === 3 && globalParts[2] === "archive") {
            return { itemId, name: "folder-item-archive" };
        }
        if (globalParts.length === 3 && globalParts[2] === "move") {
            return { itemId, name: "folder-item-move" };
        }
        return undefined;
    }
    if (globalParts[0] === "documents" && globalParts[1] !== undefined) {
        const documentId = decodeURIComponent(globalParts[1]);
        if (globalParts.length === 2) return { documentId, name: "document" };
        if (globalParts.length === 3 && globalParts[2] === "updates") {
            return { documentId, name: "document-updates" };
        }
        if (globalParts.length === 3 && globalParts[2] === "write") {
            return { documentId, name: "document-write" };
        }
        return undefined;
    }
    if (globalParts[0] === "projects" && globalParts[1] !== undefined) {
        const projectId = decodeURIComponent(globalParts[1]);
        if (globalParts.length === 2) return { name: "project", projectId };
        if (globalParts.length === 3 && globalParts[2] === "archive") {
            return { name: "project-archive", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "avatar") {
            return { name: "project-avatar", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "file") {
            return { name: "project-file", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "file-paths") {
            return { name: "project-file-paths", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "file-revision") {
            return { name: "project-file-revision", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "file-tree") {
            return { name: "project-file-tree", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "files") {
            return { name: "project-files", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "refresh") {
            return { name: "project-refresh", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "reorder") {
            return { name: "project-reorder", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "settings") {
            return { name: "project-settings", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "terminals") {
            return { name: "project-terminals", projectId };
        }
        if (
            globalParts.length === 4 &&
            globalParts[2] === "terminals" &&
            globalParts[3] !== undefined
        ) {
            return {
                name: "project-terminal",
                projectId,
                terminalId: decodeURIComponent(globalParts[3]),
            };
        }
        if (globalParts.length === 3 && globalParts[2] === "git") {
            return { name: "project-git", projectId };
        }
        if (globalParts.length === 3 && globalParts[2] === "workspaces") {
            return { name: "project-workspaces", projectId };
        }
        if (
            globalParts.length >= 4 &&
            globalParts[2] === "workspaces" &&
            globalParts[3] !== undefined
        ) {
            const workspaceId = decodeURIComponent(globalParts[3]);
            if (globalParts.length === 4) {
                return { name: "project-workspace", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "archive") {
                return { name: "project-workspace-archive", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "file") {
                return { name: "project-file", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "file-paths") {
                return { name: "project-file-paths", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "file-revision") {
                return { name: "project-file-revision", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "file-tree") {
                return { name: "project-file-tree", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "files") {
                return { name: "project-files", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "reorder") {
                return { name: "project-workspace-reorder", projectId, workspaceId };
            }
            if (globalParts.length === 5 && globalParts[4] === "terminals") {
                return { name: "project-terminals", projectId, workspaceId };
            }
            if (
                globalParts.length === 6 &&
                globalParts[4] === "terminals" &&
                globalParts[5] !== undefined
            ) {
                return {
                    name: "project-terminal",
                    projectId,
                    terminalId: decodeURIComponent(globalParts[5]),
                    workspaceId,
                };
            }
            if (globalParts.length === 5 && globalParts[4] === "git") {
                return { name: "project-workspace-git", projectId, workspaceId };
            }
        }
    }
    if (globalParts.length === 2 && globalParts[0] === "secrets") {
        return {
            name: "secret-registration",
            secretId: decodeURIComponent(globalParts[1] ?? ""),
        };
    }

    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "sessions" || parts[1] === undefined) {
        return undefined;
    }

    const sessionId = decodeURIComponent(parts[1]);
    if (parts.length === 2) return { name: "session", sessionId };
    if (parts.length === 3 && parts[2] === "reorder") {
        return { name: "reorder", sessionId };
    }
    if (parts.length === 3 && parts[2] === "scope") {
        return { name: "session-scope", sessionId };
    }
    if (parts.length === 4 && parts[2] === "terminal-connections" && parts[3] !== undefined) {
        return {
            connectionId: decodeURIComponent(parts[3]),
            name: "terminal-connection",
            sessionId,
        };
    }
    if (parts.length === 4 && parts[2] === "user-input" && parts[3] !== undefined) {
        return {
            name: "user-input",
            requestId: decodeURIComponent(parts[3]),
            sessionId,
        };
    }
    if (parts.length === 4 && parts[2] === "external-tool-calls" && parts[3] !== undefined) {
        return {
            name: "external-tool-call",
            externalToolCallId: decodeURIComponent(parts[3]),
            sessionId,
        };
    }
    if (
        parts.length === 5 &&
        parts[2] === "attachments" &&
        parts[3] !== undefined &&
        (parts[4] === "download" || parts[4] === "preview")
    ) {
        return {
            attachmentId: decodeURIComponent(parts[3]),
            name:
                parts[4] === "download"
                    ? "session-attachment-download"
                    : "session-attachment-preview",
            sessionId,
        };
    }
    if (
        parts.length === 5 &&
        parts[2] === "scheduled-messages" &&
        parts[3] !== undefined &&
        parts[4] === "cancel"
    ) {
        return {
            name: "scheduled-message-cancel",
            scheduledMessageId: decodeURIComponent(parts[3]),
            sessionId,
        };
    }
    if (
        parts.length === 5 &&
        parts[2] === "workflows" &&
        parts[3] !== undefined &&
        parts[4] === "stop"
    ) {
        return {
            name: "workflow-stop",
            sessionId,
            workflowRunId: decodeURIComponent(parts[3]),
        };
    }
    if (parts.length === 4 && parts[2] === "background-processes" && parts[3] === "stop") {
        return { name: "background-processes-stop", sessionId };
    }
    if (parts.length === 4 && parts[2] === "background-processes" && parts[3] !== undefined) {
        const processSessionId = Number(parts[3]);
        if (!Number.isSafeInteger(processSessionId) || processSessionId <= 0) return undefined;
        return { name: "background-process", processSessionId, sessionId };
    }
    if (parts.length === 4 && parts[2] === "secrets" && parts[3] !== undefined) {
        return { name: "secret", secretId: decodeURIComponent(parts[3]), sessionId };
    }
    if (parts.length !== 3) return undefined;

    if (parts[2] === "abort") return { name: "abort", sessionId };
    if (parts[2] === "activity") return { name: "activity", sessionId };
    if (parts[2] === "archive") return { name: "archive", sessionId };
    if (parts[2] === "compact") return { name: "compact", sessionId };
    if (parts[2] === "context") return { name: "context", sessionId };
    if (parts[2] === "current-provider-quota") {
        return { name: "current-provider-quota", sessionId };
    }
    if (parts[2] === "draft") return { name: "draft", sessionId };
    if (parts[2] === "effort") return { name: "effort", sessionId };
    if (parts[2] === "events") return { name: "events", sessionId };
    if (parts[2] === "external-tool-calls") {
        return { name: "external-tool-calls", sessionId };
    }
    if (parts[2] === "fork") return { name: "fork", sessionId };
    if (parts[2] === "goal") return { name: "goal", sessionId };
    if (parts[2] === "messages") return { name: "messages", sessionId };
    if (parts[2] === "model") return { name: "model", sessionId };
    if (parts[2] === "permissions") return { name: "permissions", sessionId };
    if (parts[2] === "read") return { name: "read", sessionId };
    if (parts[2] === "reset") return { name: "reset", sessionId };
    if (parts[2] === "rewind") return { name: "rewind", sessionId };
    if (parts[2] === "secrets") return { name: "secrets", sessionId };
    if (parts[2] === "service-tier") return { name: "service-tier", sessionId };
    if (parts[2] === "shell") return { name: "shell", sessionId };
    if (parts[2] === "stream") return { name: "stream", sessionId };
    if (parts[2] === "state") return { name: "session-state", sessionId };
    if (parts[2] === "steer") return { name: "steer", sessionId };
    if (parts[2] === "transcript") return { name: "transcript", sessionId };
    if (parts[2] === "transfer") return { name: "transfer", sessionId };
    if (parts[2] === "subagents") return { name: "subagents", sessionId };
    if (parts[2] === "usage") return { name: "usage", sessionId };
    if (parts[2] === "unarchive") return { name: "unarchive", sessionId };
    return undefined;
}

function decodeUrlComponent(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    try {
        return decodeURIComponent(value);
    } catch {
        return undefined;
    }
}

type DownloadableAttachment = Extract<Attachment, { kind: "audio" | "file" | "image" | "video" }>;

async function readSessionAttachmentFile(
    attachment: Attachment,
): Promise<{ data: Buffer; mediaType: string; name: string } | undefined> {
    if (!isDownloadableAttachment(attachment)) return undefined;
    return readGeneratedMediaFile(
        attachment.source,
        attachment.mediaType ?? "application/octet-stream",
        attachment.name,
    );
}

async function readSessionAttachmentPreview(
    attachment: Attachment,
): Promise<{ data: Buffer; mediaType: string; name: string } | undefined> {
    if (attachment.kind !== "video") return undefined;
    return readGeneratedMediaFile(
        attachment.preview.path,
        attachment.preview.mediaType,
        `${basename(attachment.name, extname(attachment.name))}-preview.png`,
    );
}

async function readGeneratedMediaFile(
    location: string,
    mediaType: string,
    name: string,
): Promise<{ data: Buffer; mediaType: string; name: string } | undefined> {
    const hostGenerated = getGeneratedDirectory();
    const mapped = resolveGeneratedMediaLocation(location, hostGenerated);
    if (mapped === undefined) return undefined;
    const root = await realpath(hostGenerated);
    const target = await realpath(mapped);
    if (!isPathInsideDirectory(root, target)) return undefined;
    const data = await readBoundedAttachmentFile(target);
    if (data === undefined) return undefined;
    return { data, mediaType, name };
}

async function readBoundedAttachmentFile(path: string): Promise<Buffer | undefined> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const chunks: Buffer[] = [];
    let length = 0;
    try {
        const details = await file.stat();
        if (!details.isFile() || details.size > MAX_ATTACHMENT_FILE_BYTES) return undefined;
        while (length <= MAX_ATTACHMENT_FILE_BYTES) {
            const chunk = Buffer.allocUnsafe(
                Math.min(64 * 1024, MAX_ATTACHMENT_FILE_BYTES + 1 - length),
            );
            const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) return Buffer.concat(chunks, length);
            chunks.push(chunk.subarray(0, bytesRead));
            length += bytesRead;
        }
        return undefined;
    } finally {
        await file.close();
    }
}

function isDownloadableAttachment(attachment: Attachment): attachment is DownloadableAttachment {
    return (
        attachment.kind === "audio" ||
        attachment.kind === "file" ||
        attachment.kind === "image" ||
        attachment.kind === "video"
    );
}

function isPathInsideDirectory(directory: string, path: string): boolean {
    const pathFromDirectory = relative(directory, path);
    return (
        pathFromDirectory === "" ||
        (!pathFromDirectory.startsWith("..") && !isAbsolute(pathFromDirectory))
    );
}

function attachmentContentDisposition(name: string): string {
    const safeName = basename(name).replaceAll("\\", "_").replaceAll('"', "_");
    return `attachment; filename="${safeName || "attachment"}"`;
}

function sendProjectRegistrationError(
    response: ServerResponse,
    status: number,
    code: ProjectRegistrationError["code"],
    message: string,
): void {
    sendJson<ProjectRegistrationErrorResponse>(response, status, {
        error: { code, message },
    });
}

function projectRegistrationStatus(error: ProjectRegistrationError): number {
    if (error.code === "path_missing") return 404;
    if (error.code === "path_inaccessible") return 403;
    if (error.code === "invalid_request") return 400;
    if (
        error.code === "project_id_conflict" ||
        error.code === "project_path_conflict" ||
        error.code === "managed_workspace_unavailable" ||
        error.code === "secret_unavailable"
    ) {
        return 409;
    }
    return 422;
}

function sendPluginAppError(response: ServerResponse, error: unknown): void {
    if (error instanceof PluginAppError) {
        const status =
            error.code === "stale_generation"
                ? 409
                : error.code === "plugin_not_running" || error.code === "tool_not_found"
                  ? 404
                  : error.code === "storage_full"
                    ? 507
                    : error.code === "timeout"
                      ? 504
                      : 400;
        sendJson(response, status, { error: { code: error.code, message: error.message } });
        return;
    }
    throw error;
}

function sendSlotManagementError(
    response: ServerResponse,
    status: number,
    code: SlotManagementErrorCode,
    message: string,
): void {
    sendJson(response, status, { error: { code, message } });
}

function sendInvalidSlotBody(response: ServerResponse, error: unknown): void {
    if (error instanceof RequestBodyTooLargeError) {
        sendSlotManagementError(
            response,
            413,
            "invalid_request",
            "The slot entry is larger than the allowed limit.",
        );
        return;
    }
    sendSlotManagementError(response, 400, "invalid_request", "A slot entry must be valid JSON.");
}

async function handleWorkletRequest(
    request: IncomingMessage,
    response: ServerResponse,
    route:
        | { name: "worklets" }
        | Extract<
              NonNullable<ReturnType<typeof matchRoute>>,
              {
                  name:
                      | "worklet"
                      | "worklet-icon"
                      | "worklet-log"
                      | "worklet-revert"
                      | "worklet-versions";
              }
          >,
    ctx: Context,
    runtimeConfig: ProtocolServerRuntimeConfig,
): Promise<void> {
    const worklets = runtimeConfig.worklets;
    if (worklets === undefined) {
        sendWorkletManagementError(
            response,
            503,
            "worklet_not_found",
            "This Rig daemon is running without worklets.",
        );
        return;
    }
    if (route.name === "worklets") {
        if (request.method === "GET") {
            sendJson<ListWorkletsResponse>(response, 200, await worklets.catalog(ctx));
            return;
        }
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        let body: unknown;
        try {
            body = await readJson<unknown>(request, 64 * 1024);
        } catch (error) {
            sendInvalidWorkletBody(response, error);
            return;
        }
        if (!Value.Check(installWorkletRequestSchema, body)) {
            sendWorkletManagementError(
                response,
                400,
                "invalid_request",
                "A worklet install needs a kebab-case name, description, purpose, author session, source folder path, and 512 by 512 PNG icon path.",
            );
            return;
        }
        try {
            sendJson<WorkletResponse>(response, 201, {
                worklet: await worklets.install(ctx, body),
            });
        } catch (error) {
            sendWorkletFailure(response, error);
        }
        return;
    }
    if (route.name === "worklet-icon") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const icon = await worklets.readIcon(ctx, route.workletName, route.format);
        if (icon.type !== "file") {
            sendWorkletManagementError(
                response,
                404,
                "worklet_not_found",
                "Worklet icon not found.",
            );
            return;
        }
        response.writeHead(200, {
            "cache-control": "private, max-age=31536000, immutable",
            "content-length": icon.data.byteLength,
            "content-type": icon.contentType,
            "x-content-type-options": "nosniff",
        });
        response.end(icon.data);
        return;
    }
    if (route.name === "worklet-log") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        try {
            const log = await worklets.readLog(ctx, route.workletName);
            sendJson<WorkletLogResponse>(response, 200, log);
        } catch (error) {
            sendWorkletFailure(response, error);
        }
        return;
    }
    if (route.name === "worklet") {
        if (request.method === "GET") {
            const worklet = await worklets.get(ctx, route.workletName);
            if (worklet === undefined) {
                sendWorkletManagementError(
                    response,
                    404,
                    "worklet_not_found",
                    `No worklet named ${JSON.stringify(route.workletName)} exists.`,
                );
                return;
            }
            sendJson<WorkletResponse>(response, 200, { worklet });
            return;
        }
        if (request.method !== "DELETE") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        try {
            await worklets.uninstall(ctx, route.workletName);
            sendJson(response, 200, {});
        } catch (error) {
            sendWorkletFailure(response, error);
        }
        return;
    }
    if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }
    let body: unknown;
    try {
        body = await readJson<unknown>(request, 64 * 1024);
    } catch (error) {
        sendInvalidWorkletBody(response, error);
        return;
    }
    if (route.name === "worklet-versions") {
        if (!Value.Check(updateWorkletRequestSchema, body)) {
            sendWorkletManagementError(
                response,
                400,
                "invalid_request",
                "A worklet update needs the source folder path and a description of what changed.",
            );
            return;
        }
        try {
            sendJson<WorkletResponse>(response, 200, {
                worklet: await worklets.update(ctx, route.workletName, body),
            });
        } catch (error) {
            sendWorkletFailure(response, error);
        }
        return;
    }
    if (!Value.Check(revertWorkletRequestSchema, body)) {
        sendWorkletManagementError(
            response,
            400,
            "invalid_request",
            "A worklet revert needs the existing version to make current.",
        );
        return;
    }
    try {
        sendJson<WorkletResponse>(response, 200, {
            worklet: await worklets.revert(ctx, route.workletName, body),
        });
    } catch (error) {
        sendWorkletFailure(response, error);
    }
}

function sendWorkletFailure(response: ServerResponse, error: unknown): void {
    if (error instanceof WorkletInvalidError) {
        sendWorkletManagementError(response, 400, "invalid_worklet", error.message);
        return;
    }
    if (error instanceof WorkletNotFoundError) {
        sendWorkletManagementError(response, 404, "worklet_not_found", error.message);
        return;
    }
    throw error;
}

function sendInvalidWorkletBody(response: ServerResponse, error: unknown): void {
    if (error instanceof RequestBodyTooLargeError) {
        sendWorkletManagementError(
            response,
            413,
            "invalid_request",
            "The worklet request is larger than the allowed limit.",
        );
        return;
    }
    sendWorkletManagementError(
        response,
        400,
        "invalid_request",
        "A worklet request must be valid JSON.",
    );
}

function sendWorkletManagementError(
    response: ServerResponse,
    status: number,
    code: WorkletManagementErrorCode,
    message: string,
): void {
    sendJson(response, status, { error: { code, message } });
}

function sendInvalidAppletBody(response: ServerResponse, error: unknown): void {
    if (error instanceof RequestBodyTooLargeError) {
        sendAppletManagementError(
            response,
            413,
            "invalid_request",
            "The applet request is larger than the allowed limit.",
        );
        return;
    }
    sendAppletManagementError(
        response,
        400,
        "invalid_request",
        "An applet request must be valid JSON.",
    );
}

function sendAppletManagementError(
    response: ServerResponse,
    status: number,
    code: AppletManagementErrorCode,
    message: string,
): void {
    sendJson(response, status, { error: { code, message } });
}

function sendPluginManagementError(
    response: ServerResponse,
    status: number,
    code:
        | "catalog_invalid"
        | "catalog_not_found"
        | "install_failed"
        | "invalid_request"
        | "plugin_not_found"
        | "plugins_unavailable"
        | "repository_not_found"
        | "source_changed"
        | "source_unavailable"
        | "uninstall_failed",
    message: string,
): void {
    sendJson(response, status, { error: { code, message } });
}

function requestOperationSignal(
    request: IncomingMessage,
    response: ServerResponse,
): { detach: () => void; signal: AbortSignal } {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortIfIncomplete = () => {
        if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", abort);
    response.once("close", abortIfIncomplete);
    return {
        detach: () => {
            request.off("aborted", abort);
            response.off("close", abortIfIncomplete);
        },
        signal: controller.signal,
    };
}

function isSessionMutation(routeName: string, method: string | undefined): boolean {
    return (
        (method === "PATCH" && routeName === "session") ||
        (method === "POST" &&
            [
                "abort",
                "activity",
                "archive",
                "background-processes-stop",
                "compact",
                "context",
                "external-tool-call",
                "fork",
                "messages",
                "read",
                "reorder",
                "reset",
                "rewind",
                "scheduled-message-cancel",
                "secrets",
                "shell",
                "steer",
                "unarchive",
            ].includes(routeName)) ||
        (method === "POST" && routeName === "workflow-stop") ||
        (["DELETE", "PUT"].includes(method ?? "") && routeName === "terminal-connection") ||
        (method === "DELETE" && routeName === "background-process") ||
        (["DELETE", "PATCH", "POST"].includes(method ?? "") && routeName === "goal") ||
        (method === "POST" && routeName === "user-input") ||
        (method === "DELETE" && routeName === "secret") ||
        (method === "PUT" && routeName === "draft") ||
        (method === "PUT" && routeName === "session-scope") ||
        (method === "PATCH" &&
            ["effort", "model", "permissions", "service-tier"].includes(routeName))
    );
}

function isMutatingProtocolRequest(request: IncomingMessage): boolean {
    const url = new URL(request.url ?? "/", "http://unix");
    const route = matchRoute(url.pathname);
    if (route === undefined) return false;
    if (
        route.name === "p2p-invitations" ||
        route.name === "p2p-joins" ||
        route.name === "p2p-pairing-answer"
    ) {
        return request.method === "POST";
    }
    if (route.name === "config") return request.method === "PATCH";
    if (route.name === "onboarding") return request.method === "GET";
    if (route.name === "onboarding-murmur") return request.method === "PUT";
    if (route.name === "global-instructions") return request.method === "PUT";
    if (route.name === "global-security-policy") return request.method === "PUT";
    if (route.name === "debug-inspector") {
        return request.method === "POST" || request.method === "DELETE";
    }
    if (route.name === "global-events-trim") return request.method === "POST";
    if (route.name === "happy-reload") return request.method === "POST";
    if (route.name === "happy-cloud-commands") return request.method === "POST";
    if (route.name === "plugins") return request.method === "POST";
    if (route.name === "profiles") return request.method === "POST";
    if (route.name === "profile") return request.method === "PATCH" || request.method === "PUT";
    if (route.name === "sharing") return request.method === "DELETE";
    if (route.name === "sharing-invitations") return request.method === "POST";
    if (route.name === "sharing-folder-shares") return request.method === "POST";
    if (route.name === "sharing-contact-requests") return request.method === "POST";
    if (route.name === "sharing-contact-request") {
        return request.method === "POST" || request.method === "DELETE";
    }
    if (route.name === "sharing-contact") return request.method === "DELETE";
    if (route.name === "plugin-catalog") return false;
    if (route.name === "plugin-uninstall") return request.method === "DELETE";
    if (route.name === "plugin-app-tool-call" || route.name === "plugin-app-storage") {
        return request.method === "POST";
    }
    if (route.name === "secret-registrations") return request.method === "POST";
    if (route.name === "slots") return request.method === "POST";
    if (route.name === "slot-entry") return request.method !== "GET";
    if (route.name === "applets") return request.method === "POST";
    if (route.name === "worklets") return request.method === "POST";
    if (route.name === "worklet") return request.method === "DELETE";
    if (route.name === "worklet-versions" || route.name === "worklet-revert") {
        return request.method === "POST";
    }
    if (route.name === "applet-versions" || route.name === "applet-revert") {
        return request.method === "POST";
    }
    if (route.name === "secret-registration") {
        return request.method === "DELETE" || request.method === "PATCH";
    }
    if (route.name === "messages" && route.sessionId === undefined) {
        return request.method === "POST";
    }
    if (route.name === "sessions") return request.method === "POST";
    if (route.name === "documents") return request.method === "POST";
    if (route.name === "document-write") return request.method === "POST";
    if (route.name === "document" || route.name === "document-updates") return false;
    if (route.name === "folders") return request.method !== "GET";
    if (["folder", "folder-archive", "folder-move"].includes(route.name)) {
        return request.method !== "GET";
    }
    if (route.name === "folder-items") return request.method === "POST";
    if (["folder-item", "folder-item-archive", "folder-item-move"].includes(route.name)) {
        return request.method !== "GET";
    }
    if (route.name === "projects") return request.method !== "GET";
    if (
        [
            "project",
            "project-archive",
            "project-avatar",
            "project-file",
            "project-file-paths",
            "project-file-revision",
            "project-file-tree",
            "project-files",
            "project-refresh",
            "project-reorder",
            "project-terminal",
            "project-terminals",
            "project-workspace",
            "project-workspace-archive",
            "project-workspace-reorder",
            "project-workspaces",
        ].includes(route.name)
    ) {
        return request.method !== "GET";
    }
    if (route.sessionId === undefined) return false;
    return isSessionMutation(route.name, request.method);
}

async function readCheckedBody<T extends TSchema>(
    request: IncomingMessage,
    schema: T,
): Promise<Static<T> | undefined> {
    const value = await readJson<unknown>(request, 512 * 1024);
    return Value.Check(schema, value) ? (value as Static<T>) : undefined;
}

async function readJson<T>(request: IncomingMessage, maximumBytes?: number): Promise<T> {
    const body = (await readBuffer(request, maximumBytes)).toString("utf8");
    try {
        return (body.length === 0 ? {} : JSON.parse(body)) as T;
    } catch {
        throw new InvalidJsonBodyError();
    }
}

function hasOnlyObjectKeys(
    value: unknown,
    expectedKeys: readonly string[],
): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key));
}

/** Like `hasOnlyObjectKeys`, for a body where some of those keys are optional. */
function hasNoUnknownObjectKeys(
    value: unknown,
    allowedKeys: readonly string[],
): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isReorderRequest(value: unknown): value is ReorderRequest {
    return (
        hasOnlyObjectKeys(value, ["afterId"]) &&
        (typeof value.afterId === "string" || value.afterId === null)
    );
}

async function readBuffer(request: IncomingMessage, maximumBytes?: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (maximumBytes !== undefined && receivedBytes > maximumBytes) {
            throw new RequestBodyTooLargeError();
        }
        chunks.push(buffer);
    }

    return Buffer.concat(chunks);
}

function parseEntityVersion(value: string | readonly string[] | undefined): number | undefined {
    const selected = Array.isArray(value) ? value.at(-1) : value;
    if (selected === undefined) return undefined;
    const match = /^"?(\d+)"?$/u.exec(selected.trim());
    if (match === null) return undefined;
    const version = Number(match[1]);
    return Number.isSafeInteger(version) && version > 0 ? version : undefined;
}

function sessionMutationCanApply(
    request: IncomingMessage,
    response: ServerResponse,
    session: Pick<SessionEventSource, "events" | "snapshot">,
): boolean {
    const header = request.headers["if-match"];
    if (header === undefined) return true;
    const expected = parseExpectedEventId(header);
    if (expected === undefined) {
        sendJson(response, 400, { error: "The session version is invalid." });
        return false;
    }
    if (expected === session.events.lastEventId()) return true;
    sendJson(response, 409, {
        error: "The session changed before this action could be applied.",
        session: session.snapshot(),
    });
    return false;
}

function sessionMutationCompleted(
    session: Pick<SessionEventSource, "events">,
    mutationId: string | undefined,
): boolean {
    if (mutationId === undefined) return false;
    return (
        session.events.since(undefined)?.some((event) => {
            if (event.data === null || typeof event.data !== "object") return false;
            return (event.data as { mutationId?: unknown }).mutationId === mutationId;
        }) === true
    );
}

function parseExpectedEventId(value: string | readonly string[] | undefined): string | undefined {
    const selected = Array.isArray(value) ? value.at(-1) : value;
    if (selected === undefined) return undefined;
    const trimmed = selected.trim();
    const unquoted =
        trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
    return unquoted.length === 0 ? undefined : unquoted;
}

function requestMutationId(request: IncomingMessage): string | undefined {
    const value = request.headers["x-rig-mutation-id"];
    const selected = Array.isArray(value) ? value.at(-1) : value;
    return selected === undefined || selected.length === 0 || selected.length > 256
        ? undefined
        : selected;
}

class InvalidJsonBodyError extends Error {}

class RequestBodyTooLargeError extends Error {}

function isExternalToolCallResolution(value: unknown): value is ResolveExternalToolCallRequest {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (JSON.stringify(value).length > 1_048_576) return false;
    const candidate = value as Record<string, unknown>;
    if (candidate.status === "failed") {
        if (candidate.error === null || typeof candidate.error !== "object") return false;
        const error = candidate.error as Record<string, unknown>;
        return (
            typeof error.message === "string" &&
            (error.code === undefined || typeof error.code === "string")
        );
    }
    if (candidate.status !== "completed") return false;
    if (candidate.content === undefined) return true;
    return (
        Array.isArray(candidate.content) &&
        candidate.content.every((block) => {
            if (block === null || typeof block !== "object" || Array.isArray(block)) return false;
            const content = block as Record<string, unknown>;
            return content.type === "text"
                ? typeof content.text === "string"
                : content.type === "image" &&
                      typeof content.mediaType === "string" &&
                      typeof content.data === "string";
        })
    );
}

async function streamEvents(
    ctx: Context,
    request: IncomingMessage,
    response: ServerResponse,
    session: SessionEventSource,
    after: string | undefined,
    sessionEventStreamLeases: Set<SessionEventStreamLease>,
    turnLimit: number | undefined,
    subagents: readonly SubagentSummary[],
): Promise<void> {
    const cursor = request.headers["last-event-id"];
    const eventId = Array.isArray(cursor) ? cursor.at(-1) : cursor;
    const resumeFrom = eventId ?? after;
    const resumed = resumeFrom !== undefined;
    // A client attaching without a cursor is already caught up by the snapshot
    // in the hello frame, which reflects every event through `lastEventId`.
    // Replaying the log on top of it would send the conversation twice.
    const catchup = resumed ? session.events.since(resumeFrom) : [];
    if (catchup === undefined) {
        sendJson(response, 409, { error: "Event cursor not found" });
        return;
    }

    response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
    });
    // The hello frame is written before the catch-up batch so a client can apply
    // everything that follows without asking the daemon anything else.
    const hello = await sessionStreamHello(ctx, session, resumed, turnLimit, subagents);

    // A resumed client applies durable history first, then the current overlay.
    // If the connection drops mid-catch-up, its cursor advances only through
    // events it actually received, so the next attempt cannot skip anything.
    if (resumed) for (const event of catchup) writeSseEvent(response, event);
    writeSseHello(response, hello);

    const heartbeat = setInterval(() => {
        response.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref?.();

    const unsubscribe = session.events.subscribe((event) => {
        writeSseEvent(response, event);
    });
    const lease = { session };
    sessionEventStreamLeases.add(lease);

    request.once("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        sessionEventStreamLeases.delete(lease);
        response.end();
    });
}

interface SessionEventSource {
    readonly events: SessionEventLog;
    activity: () => SessionActivity;
    partialMessage: () => SessionPartialMessage | undefined;
    clientSnapshot: () => ProtocolSession;
    snapshot: () => ProtocolSession;
    transcriptWindow: (ctx: Context, turnLimit?: number) => Promise<SessionTranscriptWindow>;
    usage: () => SessionUsageSummary;
}

interface SessionEventStreamLease {
    readonly session: SessionEventSource;
}

function writeSseHello(response: ServerResponse, hello: SessionStreamHello): void {
    response.write("event: hello\n");
    response.write(`data: ${JSON.stringify(hello)}\n\n`);
}

function writeSseEvent(response: ServerResponse, event: SessionEvent): void {
    response.write(`id: ${event.id}\n`);
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * How many turns an opening frame should carry.
 *
 * A client may ask for fewer than the default, which is how a reader with a
 * short viewport avoids paying for history it will not draw. Anything that is
 * not a positive whole number is ignored in favour of the default rather than
 * failing the stream.
 */
function parseTurnLimit(value: string | null): number {
    if (value === null) return SESSION_STREAM_TURN_LIMIT;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return SESSION_STREAM_TURN_LIMIT;
    return Math.min(parsed, SESSION_STREAM_TURN_LIMIT);
}

/**
 * The whole local catalog in one answer: projects, their workspaces, the active
 * sessions inside them, and the terminals attached to each group.
 *
 * This is the request-response half of sync. A client opens the live stream
 * first and loads this second, so anything that changes while it loads still
 * arrives on the stream with a cursor that says whether it is newer.
 */
async function buildGroupCatalog(
    ctx: Context,
    store: SessionStore,
    modelCatalog: ModelCatalog,
    identity: DaemonIdentity,
    sessionTerminals: SessionTerminalTracker,
): Promise<Omit<GlobalStreamHello, "cursor">> {
    const inboxItems = new Map<
        string,
        Awaited<ReturnType<SessionStore["listDurableUserInputs"]>>
    >();
    for (const call of await store.listDurableUserInputs(ctx)) {
        if (!isOpenQuestion(call) && call.response === undefined) continue;
        inboxItems.set(call.sessionId, [...(inboxItems.get(call.sessionId) ?? []), call]);
    }
    const sessions = (await store.listActive(ctx))
        .map((summary) => ({
            ...summary,
            inboxItems: (inboxItems.get(summary.id) ?? []).map((call) => ({
                ...(call.response === undefined ? {} : { answers: call.response.answers }),
                createdAt: call.createdAt,
                questions: call.request.questions,
                requestId: call.request.requestId,
                ...(call.resolvedAt === undefined ? {} : { resolvedAt: call.resolvedAt }),
                status: call.response === undefined ? ("pending" as const) : ("answered" as const),
            })),
        }))
        .map((summary) => sessionSummaryWithTerminalPresence(summary, sessionTerminals))
        .filter((summary) => !summary.archived);
    const projects = (await store.listProjects(ctx)).filter(
        (project) => project.archivedAt === undefined,
    );
    const projectIds = new Set(projects.map((project) => project.id));
    const workspaces = (await store.listWorkspaces(ctx)).filter(
        (workspace) =>
            projectIds.has(workspace.projectId) &&
            workspace.archivedAt === undefined &&
            workspace.status !== "archiving" &&
            workspace.status !== "archived",
    );
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    return {
        catalog: modelCatalog,
        folders: (await store.listFolders(ctx)).filter((folder) => folder.archivedAt === undefined),
        folderItems: (await store.folderCatalog(ctx)).items.filter(
            (item) => item.archivedAt === undefined,
        ),
        identity,
        presence: store.presence.state(),
        protocolVersion: RIG_PROTOCOL_VERSION,
        projects,
        terminalGroups: store.remoteTerminals.groups().flatMap((group) =>
            !projectIds.has(group.scope.projectId) ||
            (group.scope.workspaceId !== undefined && !workspaceIds.has(group.scope.workspaceId))
                ? []
                : [
                      {
                          projectId: group.scope.projectId,
                          terminals: group.terminals,
                          ...(group.scope.workspaceId === undefined
                              ? {}
                              : { workspaceId: group.scope.workspaceId }),
                      },
                  ],
        ),
        sessions,
        sessionsComplete: true,
        workspaces,
    };
}

/**
 * Everything a client needs to start showing a session.
 *
 * A resuming client already holds the transcript and receives only the current
 * overlay; a client starting fresh receives the conversation itself. One
 * builder serves both the stream and the request-response bootstrap, so the two
 * cannot drift into describing the same session differently.
 */
async function sessionStreamHello(
    ctx: Context,
    session: SessionEventSource,
    resumed: boolean,
    turnLimit: number | undefined,
    subagents: readonly SubagentSummary[],
): Promise<SessionStreamHello> {
    const lastEventId = session.events.lastEventId();
    const partial = session.partialMessage();
    // A resuming client already holds the transcript, so it is sent only to a
    // client attaching fresh. The window is cut on turn boundaries so a tool
    // result never arrives without the call it belongs to.
    const transcript = resumed
        ? undefined
        : projectClientTranscript(await session.transcriptWindow(ctx, turnLimit));
    const currentSession = session.clientSnapshot();
    const full = resumed ? undefined : currentSession;
    const usage = full === undefined ? undefined : session.usage();
    const snapshot =
        full === undefined || transcript === undefined
            ? undefined
            : {
                  ...full,
                  shellCommands: session.events.shellCommandStates(),
                  subagents,
                  // The bounded transcript is the single copy of visible history.
                  snapshot: { ...full.snapshot, messages: [] },
              };
    const hello: SessionStreamHello = {
        activity: session.activity(),
        resumed,
        ...(resumed
            ? {
                  current: {
                      ...(currentSession.draft === undefined
                          ? {}
                          : { draft: currentSession.draft }),
                      ...(currentSession.draftUpdatedAt === undefined
                          ? {}
                          : { draftUpdatedAt: currentSession.draftUpdatedAt }),
                      ...(currentSession.git === undefined ? {} : { git: currentSession.git }),
                      ...(currentSession.interruption === undefined
                          ? {}
                          : { interruption: currentSession.interruption }),
                      ...(currentSession.externalTools === undefined
                          ? {}
                          : { externalTools: currentSession.externalTools }),
                      mcpServers: currentSession.mcpServers,
                      ...(currentSession.pendingExternalToolCalls === undefined
                          ? {}
                          : {
                                pendingExternalToolCalls: currentSession.pendingExternalToolCalls,
                            }),
                      projectSecretIds: currentSession.projectSecretIds,
                      secretIds: currentSession.secretIds,
                      sessionSecretIds: currentSession.sessionSecretIds,
                      ...(currentSession.skills === undefined
                          ? {}
                          : { skills: currentSession.skills }),
                      ...(currentSession.scheduledMessages === undefined
                          ? {}
                          : { scheduledMessages: currentSession.scheduledMessages }),
                      ...(currentSession.sessionTokenCount === undefined
                          ? {}
                          : { sessionTokenCount: currentSession.sessionTokenCount }),
                      ...(currentSession.titleError === undefined
                          ? {}
                          : { titleError: currentSession.titleError }),
                      titleStatus: currentSession.titleStatus,
                      ...(currentSession.workflows === undefined
                          ? {}
                          : { workflows: currentSession.workflows }),
                      ...(currentSession.workflowsEnabled === undefined
                          ? {}
                          : { workflowsEnabled: currentSession.workflowsEnabled }),
                  },
              }
            : {}),
        ...(full === undefined || usage === undefined
            ? {}
            : {
                  usage: {
                      currentProviderId: full.providerId,
                      groups: usage.groups,
                      quotas: [...session.events.latestProviderQuotas().entries()].map(
                          ([providerId, quota]) => ({ providerId, quota }),
                      ),
                      sessionTokenCount: usage.sessionTokenCount,
                      ...(usage.currentContext === undefined
                          ? {}
                          : { context: usage.currentContext }),
                  },
              }),
        ...(snapshot === undefined || transcript === undefined
            ? {}
            : { session: snapshot, transcript }),
        ...(partial === undefined ? {} : { partial }),
        ...(lastEventId === undefined ? {} : { lastEventId }),
    };
    return hello;
}

/**
 * The request-response bootstrap has a dedicated transcript field, so its
 * current-state snapshot carries no second copy of conversation history.
 *
 * The session-scoped stream uses the same single-copy transcript projection.
 * This request-response variant additionally drops completed shell commands.
 */
async function sessionStateHello(
    ctx: Context,
    session: SessionEventSource,
    turnLimit: number | undefined,
    subagents: readonly SubagentSummary[],
): Promise<SessionStreamHello> {
    const hello = await sessionStreamHello(ctx, session, false, turnLimit, subagents);
    if (hello.session === undefined) return hello;
    const { contextMessages: _contextMessages, ...agentSnapshot } = hello.session.snapshot;
    return {
        ...hello,
        session: {
            ...hello.session,
            // Completed commands are transcript history. Only commands that are
            // still executing are part of the current state bootstrap.
            shellCommands: (hello.session.shellCommands ?? []).filter(
                (command) => command.status === "running",
            ),
            snapshot: { ...agentSnapshot, messages: [] },
        },
    };
}

function authorizeP2pConfigurationRequest(
    request: IncomingMessage,
    response: ServerResponse,
    runtimeConfig: ProtocolServerRuntimeConfig,
): boolean {
    const peerId = request.headers["x-rig-p2p-peer"];
    if (typeof peerId !== "string") return true;
    if (runtimeConfig.canP2pPeerConfigure?.(peerId) === true) return true;
    sendJson(response, 403, {
        error: "Only this secondary Rig's primary may change its configuration.",
    });
    return false;
}

function p2pPeerId(request: IncomingMessage): string | undefined {
    const value = request.headers["x-rig-p2p-peer"];
    return typeof value === "string" ? value : undefined;
}

function decodeRemoteProjectCreation(
    value: unknown,
): { githubToken?: string; request: CreateRemoteProjectRequest } | undefined {
    if (!Value.Check(remoteProjectCreationTransportSchema, value)) return undefined;
    const decoded = Value.Decode(remoteProjectCreationTransportSchema, value);
    const { temporaryGitSecret, ...request } = decoded;
    return {
        ...(temporaryGitSecret === undefined ? {} : { githubToken: temporaryGitSecret.token }),
        request,
    };
}

function decodeTemporaryGitCredential(value: unknown):
    | {
          body: Record<string, unknown>;
          githubToken?: string;
          gitSecretRequested: boolean;
      }
    | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { body: value as never, gitSecretRequested: false };
    }
    const record = value as Record<string, unknown>;
    const hasGitSecret = Object.hasOwn(record, "gitSecret");
    if (hasGitSecret && !Value.Check(projectGitSecretSchema, record.gitSecret)) {
        return undefined;
    }
    const { gitSecret: _gitSecret, temporaryGitSecret, ...body } = record;
    const gitSecretRequested = hasGitSecret || Value.Check(projectGitSecretSchema, body.secret);
    if (temporaryGitSecret === undefined) {
        return { body, gitSecretRequested };
    }
    if (!Value.Check(temporaryGitSecretSchema, temporaryGitSecret)) return undefined;
    if (!gitSecretRequested) return undefined;
    return { body, githubToken: temporaryGitSecret.token, gitSecretRequested };
}

async function authorizeRemoteProjectCreator(
    ctx: Context,
    request: IncomingMessage,
    response: ServerResponse,
    runtimeConfig: ProtocolServerRuntimeConfig,
    body: CreateRemoteProjectRequest,
): Promise<boolean> {
    const peerId = p2pPeerId(request);
    if (peerId !== undefined) {
        if (body.identity === undefined) {
            sendJson(response, 400, {
                code: "profile_required",
                error: "A registered human profile is required to create a remote project.",
            });
            return false;
        }
        if (!authorizeP2pRemoteWork(peerId, response, runtimeConfig)) return false;
        if ((await runtimeConfig.profiles?.owns(ctx, body.identity, peerId)) !== true) {
            sendJson(response, 403, {
                code: "profile_not_owned",
                error: "That human profile is not owned by the authenticated peer Rig.",
            });
            return false;
        }
        return true;
    }
    if (body.identity === undefined) return true;
    if ((await runtimeConfig.profiles?.isLocal(ctx, body.identity)) === true) return true;
    sendJson(response, 403, {
        code: "profile_not_owned",
        error: "That human profile is not owned by this Rig.",
    });
    return false;
}

async function authorizeRemoteSessionTarget(
    ctx: Context,
    request: IncomingMessage,
    response: ServerResponse,
    store: SessionStore,
    body: CreateSessionRequest,
): Promise<boolean> {
    const peerId = p2pPeerId(request);
    if (peerId === undefined) return true;
    if (body.projectId === undefined && body.workspaceId === undefined) return true;
    const workspace =
        body.workspaceId === undefined
            ? undefined
            : (await store.listWorkspaces(ctx)).find(
                  (candidate) => candidate.id === body.workspaceId,
              );
    const projectId = body.projectId ?? workspace?.projectId;
    const project = projectId === undefined ? undefined : await store.getProject(ctx, projectId);
    if (
        project === undefined ||
        (body.workspaceId !== undefined && workspace === undefined) ||
        (body.projectId !== undefined &&
            workspace !== undefined &&
            workspace.projectId !== body.projectId)
    ) {
        sendJson(response, 400, {
            code: "invalid_target",
            error: "The remote session project or workspace does not exist or does not match.",
        });
        return false;
    }
    return true;
}

async function authorizeMessageProfile(
    ctx: Context,
    request: IncomingMessage,
    response: ServerResponse,
    runtimeConfig: ProtocolServerRuntimeConfig,
    body: Pick<SubmitMessageRequest, "identity">,
): Promise<boolean> {
    const peerId = p2pPeerId(request);
    const profileId = body.identity ?? null;
    if (peerId !== undefined) {
        if (profileId === null) {
            sendJson(response, 400, {
                code: "profile_required",
                error: "A registered human profile is required to send to a remote Rig.",
            });
            return false;
        }
        if (!authorizeP2pRemoteWork(peerId, response, runtimeConfig)) return false;
        if ((await runtimeConfig.profiles?.owns(ctx, profileId, peerId)) !== true) {
            sendJson(response, 403, {
                code: "profile_not_owned",
                error: "That human profile is not registered to the authenticated peer Rig.",
            });
            return false;
        }
        return true;
    }
    if (profileId === null) return true;
    if ((await runtimeConfig.profiles?.isLocal(ctx, profileId)) !== true) {
        sendJson(response, 403, {
            code: "profile_not_owned",
            error: "That human profile is not owned by this Rig.",
        });
        return false;
    }
    return true;
}

function authorizeP2pRemoteWork(
    peerId: string,
    response: ServerResponse,
    runtimeConfig: ProtocolServerRuntimeConfig,
): boolean {
    if (runtimeConfig.canP2pPeerUseRemoteWork?.(peerId) === true) return true;
    sendJson(response, 403, {
        code: "remote_work_not_allowed",
        error: "This Rig accepts remote work only from trusted peer Rigs.",
    });
    return false;
}

async function prepareSessionGitCredential(
    ctx: Context,
    request: IncomingMessage,
    response: ServerResponse,
    store: SessionStore,
    sessionId: string,
    identity: string | null | undefined,
    githubToken: string | undefined,
): Promise<boolean> {
    const peerId = p2pPeerId(request);
    if (githubToken === undefined) return true;
    if (peerId === undefined || identity === undefined || identity === null) {
        sendJson(response, 400, {
            error: "Temporary Git credentials are accepted only from an authenticated human profile.",
        });
        return false;
    }
    try {
        await store.refreshSessionGitCredential(
            ctx,
            sessionId,
            { instanceId: peerId, profileId: identity },
            githubToken,
        );
        return true;
    } catch (error) {
        if (isDatabaseFailure(error)) throw error;
        sendJson(response, 409, { error: errorToMessage(error) });
        return false;
    }
}
