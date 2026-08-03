import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, relative } from "node:path";

import { isCuid } from "@paralleldrive/cuid2";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parseHostedCapabilities } from "@slopus/rig-execution";

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
    GetMurmurFriendsResponse,
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
    GitStateResponse,
    GitWatchResponse,
    GoalSessionResponse,
    ListModelsResponse,
    ListMurmurContactsResponse,
    ListMurmurFriendRequestsResponse,
    ListFileTreeRequest,
    ListFileTreeResponse,
    ListProjectFilePathsResponse,
    ListProjectsResponse,
    ListProjectWorkspacesResponse,
    ListSessionsResponse,
    ListSubagentsResponse,
    ModelCatalog,
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
    RegisterSecretRequest,
    RegisterSecretResponse,
    SearchFilesResponse,
    SendMurmurFriendRequestResponse,
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
    StartMurmurServiceResponse,
    SteerMessageResponse,
    StopBackgroundProcessResponse,
    StopWorkflowResponse,
    StopMurmurServiceResponse,
    SignupMurmurAccountResponse,
    SubagentSummary,
    SubmitMessageResponse,
    SubmitContextMessageResponse,
    TrimGlobalEventsRequest,
    TrimGlobalEventsResponse,
    TransferSessionRequest,
    TransferSessionResponse,
    UninstallPluginResponse,
    UnregisterSecretResponse,
    UpdateDaemonConfigRequest,
    UpdateDaemonConfigResponse,
    UpdateGlobalInstructionsRequest,
    UpdateGlobalInstructionsResponse,
    UpdateGlobalSecurityPolicyResponse,
    SetSessionDraftRequest,
    UpdateSessionRequest,
    WriteProjectFileRequest,
    WriteProjectFileResponse,
    AnswerMurmurFriendRequestResponse,
    DeleteMurmurAccountResponse,
    GetMurmurAccountResponse,
    GetSessionShareHealthResponse,
    GetSessionSharePeerActivityResponse,
    GetSessionShareReplicaHistoryResponse,
    ListSessionShareReplicaCapabilitiesResponse,
    ListSessionShareReplicasResponse,
    PostSessionShareFriendMessageResponse,
    SessionShareOwnerResponse,
    SessionSharedMetadata,
    RequestSessionSharePeerTerminalResponse,
} from "../protocol/index.js";
import { updateDaemonConfigRequestSchema } from "../protocol/index.js";
import {
    addSessionShareMemberRequestSchema,
    HAPPY_CLOUD_CIPHERTEXT_MAX_LENGTH,
    answerMurmurFriendRequestRequestSchema,
    addScopeShareMemberRequestSchema,
    createScopeShareRequestSchema,
    createSessionShareRequestSchema,
    revokeScopeShareMemberRequestSchema,
    stopScopeShareRequestSchema,
    type GetScopeShareHealthResponse,
    type GetScopeShareReplicaResponse,
    type GetScopeShareSessionHistoryResponse,
    type ListScopeShareReplicasResponse,
    type ScopeShareOwnerResponse,
    type ScopeShareScopeKind,
    discoverPluginCatalogRequestSchema,
    globalSecurityPolicySchema,
    installPluginRequestSchema,
    listFileTreeRequestSchema,
    happyCloudCommandSchema,
    happyCloudSessionIdSchema,
    RIG_PROTOCOL_VERSION,
    registerProjectRequestSchema,
    postSessionShareFriendMessageRequestSchema,
    revokeSessionShareMemberRequestSchema,
    sendMurmurFriendRequestRequestSchema,
    SESSION_DRAFT_MAX_LENGTH,
    signupMurmurAccountRequestSchema,
    startMurmurServiceRequestSchema,
    setSessionShareFriendMessagesRequestSchema,
    requestSessionSharePeerTerminalRequestSchema,
    setSessionShareMemberCapabilitiesRequestSchema,
    setSessionShareToolOutputRequestSchema,
    stopSessionShareRequestSchema,
    submitContextMessageRequestSchema,
    updateProjectSettingsRequestSchema,
    transferSessionRequestSchema,
    writeProjectFileRequestSchema,
} from "../protocol/index.js";
import type { HappyCloudServiceContract } from "../happy-cloud/index.js";
import { HappyCloudPersistenceError } from "../persistence/happy-cloud/HappyCloudPersistenceError.js";
import { MurmurServiceError, type MurmurServiceContract } from "../murmur/index.js";
import { ScopeShareRequestError } from "../scope-sharing/ScopeShareRequestError.js";
import type {
    ScopeShareServiceContract,
    ScopeShareTarget,
} from "../scope-sharing/ScopeShareServiceContract.js";
import type { SessionShareServiceContract } from "../session-sharing/index.js";
import { SessionShareCapabilityRefusalError } from "../session-sharing/SessionShareCapabilityRefusalError.js";
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
import type { ProviderQuota } from "@slopus/rig-providers";
import type { SecretRegistration } from "../secrets/index.js";
import type {
    CreateRemoteTerminalRequest,
    CreateRemoteTerminalResponse,
    ListRemoteTerminalsResponse,
    RemoteTerminalResponse,
    ResizeRemoteTerminalRequest,
} from "../terminal/index.js";
import type { PluginContext } from "../agent/context/PluginContext.js";
import {
    PluginAppError,
    PluginCatalogError,
    PluginIconError,
    PluginNotFoundError,
} from "../plugins/index.js";
import { SlotEntryInvalidError, SlotEntryNotFoundError } from "../slots/index.js";
import {
    describeWebappScopeNotAllowed,
    readWebappFile,
    resolveWebappOpenUrl,
    WebappContextTokenStore,
    WebappInvalidError,
    WebappNotFoundError,
} from "../webapps/index.js";
import { MAX_ATTACHMENT_FILE_BYTES } from "../tools/attachments/prepareAttachment.js";
import {
    createWebappRequestSchema,
    resolveWebappOpenRequestSchema,
    slotNameSchema,
} from "../protocol/index.js";
import type {
    CreateSlotEntryRequest,
    ListSlotEntriesResponse,
    ListWebappsResponse,
    ResolveWebappOpenRequest,
    ResolveWebappOpenResponse,
    RevertWebappRequest,
    SlotEntryResponse,
    SlotManagementErrorCode,
    SlotScope,
    UpdateSlotEntryRequest,
    UpdateWebappRequest,
    Webapp,
    WebappContext,
    WebappManagementErrorCode,
    WebappResponse,
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
    answerP2pVerificationRequestSchema,
    joinP2pInvitationRequestSchema,
    p2pInstanceIdSchema,
    type CreateP2pInvitationResponse,
    type JoinP2pInvitationResponse,
    type P2pPairingState,
} from "../protocol/index.js";
import { proxyP2pHttpRequest } from "./proxyP2pHttpRequest.js";
import { matchP2pPeerRoute } from "./matchP2pPeerRoute.js";

export interface ProtocolHttpServerOptions {
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
    p2pNetwork?: P2pNetwork;
    p2pPairing?: P2pPairingServiceContract;
    p2pNode?: () => DaemonConfig["p2p"];
    p2pStatus?: () => P2pStatus;
    canP2pPeerConfigure?: (peerId: string) => boolean;
    murmur?: MurmurServiceContract;
    /** Workspace and project sharing over Murmur. The daemon always supplies it. */
    scopeShares?: ScopeShareServiceContract;
    /** Session sharing over Murmur. The daemon always supplies it. */
    sessionShares?: SessionShareServiceContract;
    fileSearchService?: FileSearchServiceContract;
    globalEventQueue?: GlobalEventQueue;
    getProviderQuota?: (providerId: string) => Promise<ProviderQuota | undefined>;
    /** Hands out the usage the daemon polls for every configured provider. */
    listProviderUsage?: () => readonly ProviderUsageEntry[];
    onDaemonConfigChange?: (
        config: DaemonConfig,
    ) => AppliedDaemonSettings | undefined | Promise<AppliedDaemonSettings | undefined>;
    onShutdown?: () => void;
    onReloadHappy?: () => boolean | Promise<boolean>;
    onStartInspector?: () => StartInspectorResponse | Promise<StartInspectorResponse>;
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
    secrets?: readonly SecretRegistration[];
    token: string;
}

export function createProtocolHttpServer(
    options: ProtocolHttpServerOptions,
    server: Server = createServer(),
): Server {
    const modelCatalog = options.modelCatalog ?? createModelCatalog();
    const store =
        options.store ??
        new InMemorySessionStore({
            ...(options.defaultDocker === undefined
                ? {}
                : { defaultDocker: options.defaultDocker }),
            modelCatalog,
            ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        });
    const identity = options.identity ?? getDaemonIdentity();
    const fileSearchService = options.fileSearchService ?? new FileSearchService();
    const webappContextTokens = new WebappContextTokenStore();
    const runtimeConfig: ProtocolServerRuntimeConfig = {
        inferenceMaxRetries: options.inferenceMaxRetries ?? DEFAULT_INFERENCE_MAX_RETRIES,
        gitStateTracker: options.gitStateTracker,
        globalEventQueue: options.globalEventQueue ?? store.globalEventQueue,
        globalInstructionsPath: options.globalInstructionsPath ?? getGlobalAgentsMdPath(),
        globalSecurityPolicyPath: options.globalSecurityPolicyPath ?? getGlobalSecurityMdPath(),
        listProviderUsage: options.listProviderUsage,
        p2pNetwork: options.p2pNetwork,
        p2pPairing: options.p2pPairing,
        p2pNode: options.p2pNode,
        p2pStatus: options.p2pStatus,
        canP2pPeerConfigure: options.canP2pPeerConfigure,
        murmur: options.murmur,
        scopeShares: options.scopeShares,
        sessionShares: options.sessionShares,
        happyCloud: options.happyCloud,
        onDaemonConfigChange: options.onDaemonConfigChange,
        onReloadHappy: options.onReloadHappy,
        onStartInspector: options.onStartInspector,
        plugins: options.plugins,
    };
    // The persistent store caches sessions weakly; each open SSE stream needs its own strong lease.
    const sessionEventStreamLeases = new Set<SessionEventStreamLease>();
    const sessionTerminals = new SessionTerminalTracker();
    const p2pNetwork = options.p2pNetwork;
    const sshBridgeEnabled = p2pNetwork?.sshBridgeEnabled;
    const acceptSshBridge =
        p2pNetwork !== undefined &&
        typeof sshBridgeEnabled === "function" &&
        sshBridgeEnabled.call(p2pNetwork) === true
            ? p2pNetwork.acceptSshBridge.bind(p2pNetwork)
            : undefined;

    attachRemoteTerminalWebSocketServer({ server, store, token: options.token });
    attachP2pPeerTunnels({
        ...(p2pNetwork === undefined ? {} : { network: p2pNetwork }),
        server,
        token: options.token,
    });
    attachP2pSshBridge(server, options.token, acceptSshBridge);
    attachHttpConnectProxy(server, options.token, store);
    server.once("close", () => {
        void store.remoteTerminals.close();
    });

    server.on("request", (request, response) => {
        const mutating = isMutatingProtocolRequest(request);
        if (mutating && options.taskDrain?.closing === true) {
            sendJson(response, 503, { error: "The local daemon is shutting down." });
            return;
        }
        const handle = () =>
            handleRequest(
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
                webappContextTokens,
            );
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
        fileSearchService.close();
        sessionTerminals.dispose();
    });
    return server;
}

interface ProtocolServerRuntimeConfig {
    canP2pPeerConfigure: ProtocolHttpServerOptions["canP2pPeerConfigure"];
    inferenceMaxRetries: number;
    gitStateTracker: GitStateTracker | undefined;
    globalEventQueue: GlobalEventQueue;
    globalInstructionsPath: string;
    globalSecurityPolicyPath: string;
    listProviderUsage: (() => readonly ProviderUsageEntry[]) | undefined;
    p2pNetwork: P2pNetwork | undefined;
    p2pPairing: P2pPairingServiceContract | undefined;
    p2pNode: (() => DaemonConfig["p2p"]) | undefined;
    p2pStatus: (() => P2pStatus) | undefined;
    murmur: MurmurServiceContract | undefined;
    scopeShares: ScopeShareServiceContract | undefined;
    sessionShares: SessionShareServiceContract | undefined;
    happyCloud: HappyCloudServiceContract | undefined;
    onDaemonConfigChange: ProtocolHttpServerOptions["onDaemonConfigChange"];
    onStartInspector: (() => StartInspectorResponse | Promise<StartInspectorResponse>) | undefined;
    onReloadHappy: (() => boolean | Promise<boolean>) | undefined;
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
}

interface AppliedDaemonSettings {
    inferenceMaxRetries: number;
    globalEventQueue: GlobalEventQueue;
}

const GLOBAL_SECURITY_POLICY_REQUEST_MAX_BYTES = GLOBAL_SECURITY_MD_MAX_BYTES * 6 + 1024;
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
const hostedCapabilitiesSchema = Type.Array(Type.String());

async function handleRequest(
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
    getProviderQuota: ((providerId: string) => Promise<ProviderQuota | undefined>) | undefined,
    sessionEventStreamLeases: Set<SessionEventStreamLease>,
    sessionTerminals: SessionTerminalTracker,
    webappContextTokens: WebappContextTokenStore,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://unix");
    const route = matchRoute(url.pathname);
    const p2pPeerRoute = matchP2pPeerRoute(url);
    if (route?.name === "webapp-context") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const contextToken = url.searchParams.get("token");
        const context =
            contextToken === null
                ? undefined
                : webappContextTokens.exchange(route.webappName, contextToken);
        if (context === undefined) {
            sendJson(response, 401, { error: "Unauthorized" });
            return;
        }
        response.setHeader("cache-control", "no-store");
        sendJson<WebappContext>(response, 200, context);
        return;
    }
    if (!isAuthorizedProtocolRequest(request, token)) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
    }
    if (p2pPeerRoute !== undefined) {
        if (runtimeConfig.p2pNetwork === undefined) {
            sendJson(response, 503, { error: "P2P networking is unavailable." });
            return;
        }
        await proxyP2pHttpRequest(
            runtimeConfig.p2pNetwork,
            p2pPeerRoute.peerId,
            p2pPeerRoute.path,
            request,
            response,
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

    if (request.method === "GET" && route.name === "p2p-status") {
        sendJson<P2pStatus>(response, 200, runtimeConfig.p2pStatus?.() ?? { transports: [] });
        return;
    }
    if (route.name === "p2p-invitations") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        if (runtimeConfig.p2pPairing === undefined) {
            sendJson(response, 503, { error: "P2P pairing is unavailable." });
            return;
        }
        sendJson<CreateP2pInvitationResponse>(
            response,
            201,
            await runtimeConfig.p2pPairing.createInvitation(),
        );
        return;
    }
    if (route.name === "p2p-joins") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        if (runtimeConfig.p2pPairing === undefined) {
            sendJson(response, 503, { error: "P2P pairing is unavailable." });
            return;
        }
        const body = await readCheckedBody(request, joinP2pInvitationRequestSchema);
        if (body === undefined) {
            sendJson(response, 400, { error: "The P2P invitation request is invalid." });
            return;
        }
        sendJson<JoinP2pInvitationResponse>(
            response,
            202,
            await runtimeConfig.p2pPairing.join(body.invitation),
        );
        return;
    }
    if (route.name === "p2p-pairing") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const state = runtimeConfig.p2pPairing?.get(route.pairingId);
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
        if (runtimeConfig.p2pPairing === undefined) {
            sendJson(response, 503, { error: "P2P pairing is unavailable." });
            return;
        }
        const body = await readCheckedBody(request, answerP2pVerificationRequestSchema);
        if (body === undefined) {
            sendJson(response, 400, { error: "The P2P verification answer is invalid." });
            return;
        }
        sendJson<P2pPairingState>(
            response,
            200,
            runtimeConfig.p2pPairing.answer(route.pairingId, body.accept),
        );
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
            sendJson<HappyCloudStatus>(response, 200, happyCloud.status());
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
                sendJson<HappyCloudCommandResponse>(response, 200, happyCloud.apply(command));
                return;
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                if (error instanceof HappyCloudPersistenceError) {
                    const conflict =
                        error.code === "version_conflict" || error.code === "mutation_reused";
                    sendJson(response, conflict ? 409 : 403, {
                        code: error.code,
                        error: error.message,
                        status: happyCloud.status(),
                    });
                    return;
                }
                throw error;
            }
        }
        if (route.name === "happy-cloud-profile") {
            const profile = happyCloud.getProfile();
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
            const blob = happyCloud.getSessionBlob(cloudSessionId);
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

    if (route.name.startsWith("murmur-")) {
        const murmur = runtimeConfig.murmur;
        if (murmur === undefined) {
            sendJson(response, 503, { error: "Murmur is unavailable while Rig is starting." });
            return;
        }
        try {
            if (request.method === "GET" && route.name === "murmur-account") {
                sendJson<GetMurmurAccountResponse>(response, 200, await murmur.getAccount());
                return;
            }
            if (request.method === "POST" && route.name === "murmur-account") {
                const body = decodeMurmurRequest(
                    signupMurmurAccountRequestSchema,
                    await readJson<unknown>(request, 34 * 1024 * 1024),
                );
                sendJson<SignupMurmurAccountResponse>(response, 201, await murmur.signup(body));
                return;
            }
            if (request.method === "DELETE" && route.name === "murmur-account") {
                sendJson<DeleteMurmurAccountResponse>(response, 200, await murmur.deleteAccount());
                return;
            }
            if (request.method === "POST" && route.name === "murmur-service-start") {
                const body = decodeMurmurRequest(
                    startMurmurServiceRequestSchema,
                    await readJson<unknown>(request, 64 * 1024),
                );
                sendJson<StartMurmurServiceResponse>(response, 200, await murmur.start(body));
                return;
            }
            if (request.method === "POST" && route.name === "murmur-service-stop") {
                sendJson<StopMurmurServiceResponse>(response, 200, await murmur.stop());
                return;
            }
            if (request.method === "POST" && route.name === "murmur-friend-requests") {
                const body = decodeMurmurRequest(
                    sendMurmurFriendRequestRequestSchema,
                    await readJson<unknown>(request, 8 * 1024),
                );
                sendJson<SendMurmurFriendRequestResponse>(
                    response,
                    202,
                    await murmur.sendFriendRequest(body),
                );
                return;
            }
            if (request.method === "GET" && route.name === "murmur-friend-requests") {
                sendJson<ListMurmurFriendRequestsResponse>(
                    response,
                    200,
                    await murmur.listFriendRequests(),
                );
                return;
            }
            if (request.method === "GET" && route.name === "murmur-friends") {
                sendJson<GetMurmurFriendsResponse>(response, 200, await murmur.getFriends());
                return;
            }
            if (request.method === "POST" && route.name === "murmur-friend-request-answer") {
                const body = decodeMurmurRequest(
                    answerMurmurFriendRequestRequestSchema,
                    await readJson<unknown>(request, 8 * 1024),
                );
                sendJson<AnswerMurmurFriendRequestResponse>(
                    response,
                    200,
                    await murmur.answerFriendRequest(route.peerId, body),
                );
                return;
            }
            if (request.method === "GET" && route.name === "murmur-contacts") {
                sendJson<ListMurmurContactsResponse>(response, 200, await murmur.listContacts());
                return;
            }
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (
                error instanceof InvalidJsonBodyError ||
                error instanceof RequestBodyTooLargeError
            ) {
                throw error;
            }
            if (error instanceof InvalidMurmurRequestError) {
                sendJson(response, 400, { error: "The Murmur request is invalid." });
                return;
            }
            if (error instanceof MurmurServiceError) {
                const status =
                    error.code === "invalid_identity_token" || error.code === "invalid_profile"
                        ? 400
                        : error.code === "account_missing" || error.code === "request_not_found"
                          ? 404
                          : error.code === "relay_unavailable"
                            ? 502
                            : 409;
                sendJson(response, status, { code: error.code, error: error.message });
                return;
            }
            sendJson(response, 409, { error: errorToMessage(error) });
            return;
        }
    }

    if (route.name.startsWith("scope-share")) {
        const scopeShares = runtimeConfig.scopeShares;
        if (scopeShares === undefined) {
            sendJson(response, 503, {
                error: "This Rig server was started without project and workspace sharing.",
            });
            return;
        }
        if (
            route.name === "scope-share-scope" ||
            route.name === "scope-share-scope-members" ||
            route.name === "scope-share-scope-member-revoke" ||
            route.name === "scope-share-scope-stop"
        ) {
            // A project share and a workspace share are the same share over a wider
            // subject set, so the route only says which one it named and everything
            // below this line is one path.
            const scope: ScopeShareTarget = { scopeId: route.scopeId, scopeKind: route.scopeKind };
            const subject = route.scopeKind === "project" ? "Project" : "Workspace";
            // The scope has to exist, and a workspace has to be the one this project
            // actually holds. Without this a share could be created for a workspace
            // under any project id at all, or for a project that was never added.
            const exists =
                route.scopeKind === "project"
                    ? store.getProject(route.projectId) !== undefined
                    : store.getWorkspace(route.projectId, route.scopeId) !== undefined;
            if (!exists) {
                sendJson(response, 404, { error: `${subject} not found.` });
                return;
            }
            if (request.method === "GET" && route.name === "scope-share-scope") {
                const share = scopeShares.getOwner(scope);
                if (share === undefined) {
                    sendJson(response, 404, { error: `${subject} share not found.` });
                } else sendJson<ScopeShareOwnerResponse>(response, 200, share);
                return;
            }
            // A refusal the caller can act on — nothing to share with, a scope already
            // covered by another share, no Murmur account yet — is an answer to their
            // request, not a fault in the daemon, so it must not be reported as one.
            try {
                if (request.method === "POST" && route.name === "scope-share-scope") {
                    const body = await readCheckedBody(request, createScopeShareRequestSchema);
                    if (body === undefined) {
                        sendJson(response, 400, {
                            error: `The ${subject.toLowerCase()} share request is invalid.`,
                        });
                        return;
                    }
                    sendJson<ScopeShareOwnerResponse>(
                        response,
                        201,
                        await scopeShares.create(scope, body),
                    );
                    return;
                }
                if (request.method === "POST" && route.name === "scope-share-scope-members") {
                    const body = await readCheckedBody(request, addScopeShareMemberRequestSchema);
                    if (body === undefined) {
                        sendJson(response, 400, { error: "The member request is invalid." });
                        return;
                    }
                    sendJson<ScopeShareOwnerResponse>(
                        response,
                        200,
                        await scopeShares.add(scope, body),
                    );
                    return;
                }
                if (request.method === "POST" && route.name === "scope-share-scope-member-revoke") {
                    const body = await readCheckedBody(
                        request,
                        revokeScopeShareMemberRequestSchema,
                    );
                    if (body === undefined) {
                        sendJson(response, 400, { error: "The revocation request is invalid." });
                        return;
                    }
                    sendJson<ScopeShareOwnerResponse>(
                        response,
                        200,
                        await scopeShares.revoke(scope, route.shareMemberId, body),
                    );
                    return;
                }
                if (request.method === "POST" && route.name === "scope-share-scope-stop") {
                    const body = await readCheckedBody(request, stopScopeShareRequestSchema);
                    if (body === undefined) {
                        sendJson(response, 400, { error: "The stop request is invalid." });
                        return;
                    }
                    sendJson<ScopeShareOwnerResponse>(
                        response,
                        200,
                        await scopeShares.stop(scope, body),
                    );
                    return;
                }
            } catch (error) {
                if (!(error instanceof ScopeShareRequestError)) throw error;
                sendJson(response, scopeShareRequestErrorStatus(error), { error: error.message });
                return;
            }
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        if (request.method === "GET" && route.name === "scope-share-replicas") {
            sendJson<ListScopeShareReplicasResponse>(response, 200, scopeShares.listReplicas());
            return;
        }
        if (request.method === "GET" && route.name === "scope-share-replica") {
            const replica = scopeShares.replica(
                route.shareId,
                url.searchParams.get("after") ?? undefined,
            );
            if (replica === undefined) {
                sendJson(response, 404, { error: "Shared workspace not found." });
            } else sendJson<GetScopeShareReplicaResponse>(response, 200, replica);
            return;
        }
        if (request.method === "GET" && route.name === "scope-share-replica-session") {
            const history = scopeShares.replicaSessionHistory(
                route.shareId,
                route.scopeSessionId,
                url.searchParams.get("after") ?? undefined,
            );
            if (history === undefined) {
                sendJson(response, 404, { error: "Shared workspace not found." });
            } else sendJson<GetScopeShareSessionHistoryResponse>(response, 200, history);
            return;
        }
        if (request.method === "GET" && route.name === "scope-share-health") {
            const health = scopeShares.health(route.shareId);
            if (health === undefined) sendJson(response, 404, { error: "Share not found." });
            else sendJson<GetScopeShareHealthResponse>(response, 200, health);
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }

    if (route.name.startsWith("session-share")) {
        const sessionShares = runtimeConfig.sessionShares;
        if (sessionShares === undefined) {
            sendJson(response, 503, {
                error: "This Rig server was started without session sharing.",
            });
            return;
        }
        if (
            route.name === "session-share" ||
            route.name === "session-share-members" ||
            route.name === "session-share-member-capabilities" ||
            route.name === "session-share-member-revoke" ||
            route.name === "session-share-stop" ||
            route.name === "session-share-friend-messages" ||
            route.name === "session-share-tool-output" ||
            route.name === "session-share-peer-activity"
        ) {
            const ownerSession = store.get(route.sessionId);
            if (ownerSession === undefined) {
                sendJson(response, 404, { error: "Session not found." });
                return;
            }
            if (ownerSession.agentMetadata().type !== "primary") {
                sendJson(response, 409, {
                    error: "Only primary sessions can be shared.",
                });
                return;
            }
        }
        if (request.method === "GET" && route.name === "session-share") {
            const share = sessionShares.getOwner(route.sessionId);
            if (share === undefined) sendJson(response, 404, { error: "Session share not found." });
            else sendJson<SessionShareOwnerResponse>(response, 200, share);
            return;
        }
        if (request.method === "POST" && route.name === "session-share") {
            const body = await readCheckedBody(request, createSessionShareRequestSchema);
            if (body === undefined) {
                sendJson(response, 400, { error: "The session share request is invalid." });
                return;
            }
            sendJson<SessionShareOwnerResponse>(
                response,
                201,
                await sessionShares.create(route.sessionId, body),
            );
            return;
        }
        if (request.method === "POST" && route.name === "session-share-members") {
            const body = await readCheckedBody(request, addSessionShareMemberRequestSchema);
            if (body === undefined) {
                sendJson(response, 400, { error: "The member request is invalid." });
                return;
            }
            sendJson<SessionShareOwnerResponse>(
                response,
                200,
                await sessionShares.add(route.sessionId, body),
            );
            return;
        }
        if (request.method === "POST" && route.name === "session-share-member-revoke") {
            const body = await readCheckedBody(request, revokeSessionShareMemberRequestSchema);
            if (body === undefined) {
                sendJson(response, 400, { error: "The revocation request is invalid." });
                return;
            }
            sendJson<SessionShareOwnerResponse>(
                response,
                200,
                await sessionShares.revoke(route.sessionId, route.shareMemberId, body),
            );
            return;
        }
        if (request.method === "PUT" && route.name === "session-share-member-capabilities") {
            const body = await readCheckedBody(
                request,
                setSessionShareMemberCapabilitiesRequestSchema,
            );
            if (body === undefined) {
                sendJson(response, 400, { error: "The capability request is invalid." });
                return;
            }
            try {
                sendJson<SessionShareOwnerResponse>(
                    response,
                    200,
                    await sessionShares.setMemberCapabilities(
                        route.sessionId,
                        route.shareMemberId,
                        body,
                    ),
                );
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                // A refusal to offer a capability is deliberate and permanent, not a
                // fault of this request, so it is a 4xx a client must not retry rather
                // than a 500 that invites one.
                if (error instanceof SessionShareCapabilityRefusalError) {
                    sendJson(response, 422, { error: error.message });
                    return;
                }
                throw error;
            }
            return;
        }
        if (request.method === "POST" && route.name === "session-share-stop") {
            const body = await readCheckedBody(request, stopSessionShareRequestSchema);
            if (body === undefined) {
                sendJson(response, 400, { error: "The stop request is invalid." });
                return;
            }
            sendJson<SessionShareOwnerResponse>(
                response,
                200,
                await sessionShares.stop(route.sessionId, body),
            );
            return;
        }
        if (request.method === "POST" && route.name === "session-share-friend-messages") {
            const body = await readCheckedBody(request, setSessionShareFriendMessagesRequestSchema);
            if (body === undefined) {
                sendJson(response, 400, { error: "The friend-message setting is invalid." });
                return;
            }
            sendJson<SessionShareOwnerResponse>(
                response,
                200,
                await sessionShares.setFriendMessages(route.sessionId, body),
            );
            return;
        }
        if (request.method === "POST" && route.name === "session-share-tool-output") {
            const body = await readCheckedBody(request, setSessionShareToolOutputRequestSchema);
            if (body === undefined) {
                sendJson(response, 400, { error: "The tool-output setting is invalid." });
                return;
            }
            sendJson<SessionShareOwnerResponse>(
                response,
                200,
                await sessionShares.setToolOutput(route.sessionId, body),
            );
            return;
        }
        if (request.method === "GET" && route.name === "session-share-peer-activity") {
            const activity = sessionShares.peerActivity(
                route.sessionId,
                url.searchParams.get("after") ?? undefined,
            );
            if (activity === undefined)
                sendJson(response, 404, { error: "Session share not found." });
            else sendJson<GetSessionSharePeerActivityResponse>(response, 200, activity);
            return;
        }
        if (request.method === "POST" && route.name === "session-share-post") {
            const body = await readCheckedBody(request, postSessionShareFriendMessageRequestSchema);
            if (body === undefined) {
                sendJson(response, 400, { error: "The friend message is invalid." });
                return;
            }
            sendJson<PostSessionShareFriendMessageResponse>(
                response,
                202,
                await sessionShares.postFriendMessage(body),
            );
            return;
        }
        if (request.method === "GET" && route.name === "session-share-replicas") {
            sendJson<ListSessionShareReplicasResponse>(response, 200, sessionShares.listReplicas());
            return;
        }
        if (request.method === "GET" && route.name === "session-share-replica-history") {
            const history = sessionShares.replicaHistory(
                route.shareId,
                url.searchParams.get("after") ?? undefined,
            );
            if (history === undefined)
                sendJson(response, 404, { error: "Shared session not found." });
            else sendJson<GetSessionShareReplicaHistoryResponse>(response, 200, history);
            return;
        }
        if (request.method === "GET" && route.name === "session-share-replica-capabilities") {
            const capabilities = sessionShares.replicaCapabilities(route.shareId);
            if (capabilities === undefined)
                sendJson(response, 404, { error: "Shared session not found." });
            else sendJson<ListSessionShareReplicaCapabilitiesResponse>(response, 200, capabilities);
            return;
        }
        if (request.method === "POST" && route.name === "session-share-replica-terminal") {
            const body = await readCheckedBody(
                request,
                requestSessionSharePeerTerminalRequestSchema,
            );
            if (body === undefined) {
                sendJson(response, 400, { error: "Request body is invalid." });
                return;
            }
            // This machine is the member here, asking the owner for something. It
            // grants nothing and learns nothing about whether it is allowed: the
            // owner's gates decide, and a refusal is a channel that never opens.
            const result = await sessionShares.requestPeerTerminal(route.shareId, body.terminalId);
            sendJson<RequestSessionSharePeerTerminalResponse>(response, 200, result);
            return;
        }
        if (request.method === "GET" && route.name === "session-share-health") {
            const health = sessionShares.health(route.shareId);
            if (health === undefined)
                sendJson(response, 404, { error: "Session share not found." });
            else sendJson<GetSessionShareHealthResponse>(response, 200, health);
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
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
        sendJson(response, 200, { cursor, ...(await runtimeConfig.plugins.list()) });
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
            const catalog = await plugins.discoverRepository(body, operation.signal);
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
                    ? await plugins.install({
                          fs: createNodeFileSystemContext(body.source.sourceDirectory, {
                              permissionMode: () => "full_access",
                          }),
                          requestId: body.requestId,
                          signal: operation.signal,
                          sourceDirectory: body.source.sourceDirectory,
                      })
                    : await plugins.installFromGitHub(body.source, {
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
            const plugin = await plugins.uninstall({
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
        sendJson(response, 200, { log: await runtimeConfig.plugins.readLog(route.pluginName) });
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
            const icon = await plugins.readIcon(route.pluginId, route.generation, operation.signal);
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
                    keys: await plugins.storageList(route.appId, route.generation),
                });
                return;
            }
            const body = Value.Decode(pluginAppStorageBodySchema, rawBody);
            if (route.operation === "get") {
                sendJson(response, 200, {
                    value: await plugins.storageGet(route.appId, route.generation, body.key),
                });
            } else if (route.operation === "set") {
                if (!Object.hasOwn(body, "value")) {
                    throw new PluginAppError("invalid_input", "Storage set requires a value.");
                }
                await plugins.storageSet(route.appId, route.generation, body.key, body.value);
                sendJson(response, 200, {});
            } else {
                await plugins.storageDelete(route.appId, route.generation, body.key);
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
                entries: store.slots.list({
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
                    entry: store.slots.create(body as CreateSlotEntryRequest),
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
                    entry: store.slots.update(route.slotEntryId, body as UpdateSlotEntryRequest),
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
                    entry: store.slots.remove(route.slotEntryId),
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
    if (route.name === "webapps") {
        if (request.method === "GET") {
            sendJson<ListWebappsResponse>(response, 200, { webapps: store.webapps.list() });
            return;
        }
        if (request.method === "POST") {
            let body: unknown;
            try {
                body = await readJson<unknown>(request, 64 * 1024);
            } catch (error) {
                sendInvalidWebappBody(response, error);
                return;
            }
            if (!Value.Check(createWebappRequestSchema, body)) {
                sendWebappManagementError(
                    response,
                    400,
                    "invalid_request",
                    "A webapp import needs a kebab-case name, description, purpose, author session, source folder path, and 512 by 512 PNG icon path.",
                );
                return;
            }
            try {
                sendJson<WebappResponse>(response, 201, {
                    webapp: await store.webapps.create(body),
                });
            } catch (error) {
                if (error instanceof WebappInvalidError) {
                    sendWebappManagementError(response, 400, "invalid_webapp", error.message);
                    return;
                }
                throw error;
            }
            return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
    }
    if (route.name === "webapp-versions" || route.name === "webapp-revert") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        let body: unknown;
        try {
            body = await readJson<unknown>(request, 64 * 1024);
        } catch (error) {
            sendInvalidWebappBody(response, error);
            return;
        }
        try {
            const webapp =
                route.name === "webapp-versions"
                    ? await store.webapps.update(route.webappName, body as UpdateWebappRequest)
                    : store.webapps.revert(route.webappName, body as RevertWebappRequest);
            sendJson<WebappResponse>(response, 200, { webapp });
        } catch (error) {
            if (error instanceof WebappInvalidError) {
                sendWebappManagementError(response, 400, "invalid_webapp", error.message);
                return;
            }
            if (error instanceof WebappNotFoundError) {
                sendWebappManagementError(response, 404, "webapp_not_found", error.message);
                return;
            }
            throw error;
        }
        return;
    }
    if (route.name === "webapp-open") {
        if (request.method !== "POST") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        let body: unknown;
        try {
            body = await readJson<unknown>(request, 64 * 1024);
        } catch (error) {
            sendInvalidWebappBody(response, error);
            return;
        }
        if (!Value.Check(resolveWebappOpenRequestSchema, body)) {
            sendWebappManagementError(
                response,
                400,
                "invalid_request",
                "A webapp open request must contain only a relative path, string query values, and optional session, project, or workspace ids.",
            );
            return;
        }
        const webapp = store.webapps.get(route.webappName);
        if (webapp === undefined) {
            sendWebappManagementError(
                response,
                404,
                "webapp_not_found",
                `No webapp named ${JSON.stringify(route.webappName)} exists.`,
            );
            return;
        }
        const resolution = resolveWebappContext(store, webapp, body);
        if (resolution.type === "error") {
            sendWebappManagementError(response, 400, resolution.code, resolution.message);
            return;
        }
        sendJson<ResolveWebappOpenResponse>(response, 200, {
            url: resolveWebappOpenUrl(webapp.name, body, resolution.context, webappContextTokens),
        });
        return;
    }
    if (route.name === "webapp-icon") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        if (store.webapps.get(route.webappName) === undefined) {
            sendWebappManagementError(
                response,
                404,
                "webapp_not_found",
                `No webapp named ${JSON.stringify(route.webappName)} exists.`,
            );
            return;
        }
        const icon = await store.webapps.readIcon(route.webappName, route.format);
        if (icon.type !== "file") {
            sendWebappManagementError(response, 404, "webapp_not_found", "Webapp icon not found.");
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
    if (route.name === "webapp-file") {
        if (request.method !== "GET") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        const webapp = store.webapps.get(route.webappName);
        if (webapp === undefined) {
            sendWebappManagementError(
                response,
                404,
                "webapp_not_found",
                `No webapp named ${JSON.stringify(route.webappName)} exists.`,
            );
            return;
        }
        const file = await readWebappFile(
            route.webappName,
            webapp.currentVersion,
            route.webappFilePath,
        );
        if (file.type === "invalid_path") {
            sendWebappManagementError(
                response,
                400,
                "invalid_request",
                "Webapp file paths may not traverse outside the webapp folder or name dotfiles.",
            );
            return;
        }
        if (file.type === "not_found") {
            sendWebappManagementError(response, 404, "webapp_not_found", "Webapp file not found.");
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
    if (request.method === "POST" && route.name === "debug-inspector") {
        if (runtimeConfig.onStartInspector === undefined) {
            sendJson(response, 409, { error: "This daemon cannot start a debugger." });
            return;
        }
        sendJson<StartInspectorResponse>(response, 200, await runtimeConfig.onStartInspector());
        return;
    }

    if (request.method === "POST" && route.name === "happy-reload") {
        if (runtimeConfig.onReloadHappy === undefined) {
            sendJson(response, 409, { error: "This daemon cannot reload Happy credentials." });
            return;
        }
        sendJson(response, 200, { enabled: await runtimeConfig.onReloadHappy() });
        return;
    }

    if (request.method === "GET" && route.name === "models") {
        sendJson<ListModelsResponse>(response, 200, { catalog: modelCatalog });
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

    if (route.name === "projects") {
        if (request.method === "GET") {
            sendJson<ListProjectsResponse>(response, 200, { projects: store.listProjects() });
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
            const project = await store.registerProject(body);
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

    if (request.method === "GET" && route.name === "provider-usage") {
        sendJson<ListProviderUsageResponse>(response, 200, {
            providers: runtimeConfig.listProviderUsage?.() ?? [],
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
        const directory = resolveProjectScopeDirectory(store, route);
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
        const project = store.getProject(route.projectId);
        if (project === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        if (
            route.workspaceId !== undefined &&
            store.getWorkspace(route.projectId, route.workspaceId) === undefined
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
                    const terminal = await store.remoteTerminals.create(scope, body);
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
        const asset = await store.getProjectAvatar(route.assetHash);
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
        const project = store.getProject(route.projectId);
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
                    : store.globalEventQueue
                          .list()
                          ?.find(
                              (entry) =>
                                  entry.event.type === "project_updated" &&
                                  entry.event.projectId === project.id &&
                                  entry.event.data.mutationId === body.mutationId,
                          );
            if (completed !== undefined) {
                sendJson<ProjectResponse>(response, 200, {
                    project: store.getProject(project.id)!,
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
                    project: store.renameProject(
                        project.id,
                        body.name,
                        expectedVersion,
                        body.mutationId,
                    )!,
                });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 409, {
                    error: errorToMessage(error),
                    project: store.getProject(project.id),
                });
            }
            return;
        }
    }

    if (route.name === "project-settings" && request.method === "PUT") {
        const project = store.getProject(route.projectId);
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
                : store.globalEventQueue
                      .list()
                      ?.find(
                          (entry) =>
                              entry.event.type === "project_updated" &&
                              entry.event.projectId === project.id &&
                              entry.event.data.mutationId === body.mutationId,
                      );
        if (completed !== undefined) {
            sendJson<ProjectResponse>(response, 200, {
                project: store.getProject(project.id)!,
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
            sendJson<ProjectResponse>(response, 200, {
                project: store.setProjectSettings(
                    project.id,
                    settings,
                    expectedVersion,
                    mutationId,
                )!,
            });
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            sendJson(response, 409, {
                error: errorToMessage(error),
                project: store.getProject(project.id),
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
            const project = store.getProject(requested.projectId);
            if (project === undefined) continue;
            const workspace =
                typeof requested.workspaceId === "string"
                    ? store.getWorkspace(requested.projectId, requested.workspaceId)
                    : undefined;
            if (typeof requested.workspaceId === "string" && workspace === undefined) continue;
            const entity = resolveGitTrackedEntity(project, workspace);
            if (entity !== undefined) tracker.watch(entity);
        }
        sendJson<GitWatchResponse>(response, 200, { snapshots: tracker.liveSnapshots() });
        return;
    }

    if (route.name === "project-git" || route.name === "project-workspace-git") {
        const tracker = runtimeConfig.gitStateTracker;
        if (tracker === undefined) {
            sendJson(response, 503, { error: "Git tracking is unavailable." });
            return;
        }
        const project = store.getProject(route.projectId);
        if (project === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        const workspace =
            route.name === "project-workspace-git"
                ? store.getWorkspace(route.projectId, route.workspaceId)
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
            if (cached !== undefined && url.searchParams.get("refresh") !== "1") {
                sendJson<GitStateResponse>(response, 200, { git: cached });
                return;
            }
            const fresh = await tracker.refresh(entity);
            if (fresh === undefined) {
                sendJson(response, 503, { error: "Git tracking is unavailable." });
                return;
            }
            sendJson<GitStateResponse>(response, 200, { git: fresh });
            return;
        }
    }

    if (route.name === "project-refresh" && request.method === "POST") {
        try {
            const project = store.refreshProject(route.projectId);
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
            const project = store.reorderProject(route.projectId, body, expectedVersion);
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
            const project = await store.archiveProject(route.projectId, expectedVersion);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            // Archiving a project retires its own share and every workspace share
            // beneath it, because none of those workspaces is there to replicate. The
            // archive is already committed, so a share that cannot be stopped must not
            // turn this into a failure: the share is durably stopped either way, only
            // its relay notice is late, and answering 409 would tell the client to redo
            // an archive that already happened.
            try {
                await runtimeConfig.scopeShares?.stopForArchivedProject(route.projectId);
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
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
            const project = store.clearProjectAvatar(route.projectId);
            if (project === undefined) {
                sendJson(response, 404, { error: "Project not found" });
                return;
            }
            sendJson<ProjectResponse>(response, 200, { project });
            return;
        }
    }

    if (route.name === "project-workspaces") {
        if (store.getProject(route.projectId) === undefined) {
            sendJson(response, 404, { error: "Project not found" });
            return;
        }
        if (request.method === "GET") {
            sendJson<ListProjectWorkspacesResponse>(response, 200, {
                workspaces: store.listWorkspaces(route.projectId),
            });
            return;
        }
        if (request.method === "POST") {
            const body = await readJson<unknown>(request);
            if (
                !hasNoUnknownObjectKeys(body, ["baseRef", "id", "name"]) ||
                typeof body.name !== "string" ||
                (body.baseRef !== undefined && typeof body.baseRef !== "string") ||
                (body.id !== undefined && typeof body.id !== "string")
            ) {
                sendJson(response, 400, { error: "Workspace settings are invalid." });
                return;
            }
            try {
                const workspace = await store.createWorkspace(route.projectId, {
                    ...(body.baseRef === undefined ? {} : { baseRef: body.baseRef }),
                    ...(body.id === undefined ? {} : { id: body.id }),
                    name: body.name,
                });
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
        const workspace = store.getWorkspace(route.projectId, route.workspaceId);
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
                    : store.globalEventQueue
                          .list()
                          ?.find(
                              (entry) =>
                                  entry.event.type === "workspace_updated" &&
                                  entry.event.workspaceId === route.workspaceId &&
                                  entry.event.data.mutationId === body.mutationId,
                          );
            if (completed !== undefined) {
                sendJson<ProjectWorkspaceResponse>(response, 200, {
                    workspace: store.getWorkspace(route.projectId, route.workspaceId)!,
                });
                return;
            }
            try {
                const expectedVersion = parseEntityVersion(request.headers["if-match"]);
                if (expectedVersion === undefined) {
                    sendJson(response, 400, { error: "The workspace version is invalid." });
                    return;
                }
                const renamed = store.renameWorkspace(
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
                    workspace: store.getWorkspace(route.projectId, route.workspaceId),
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
                route.projectId,
                route.workspaceId,
                expectedVersion,
            );
            if (workspace === undefined) {
                sendJson(response, 404, { error: "Workspace not found" });
                return;
            }
            // Archiving one workspace stops its share and nothing else's: a project
            // share above it still covers everything that is left. The archive is
            // already committed, so a share that cannot be stopped is not allowed to
            // report it as failed.
            try {
                await runtimeConfig.scopeShares?.stopForArchivedWorkspace(route.workspaceId);
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
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
            const workspace = store.reorderWorkspace(
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
        const body = await readJson<unknown>(request);
        if (!isSubmitMessageRequest(body)) {
            sendJson(response, 400, { error: "Message settings are invalid." });
            return;
        }
        const broadcast = body as BroadcastMessageRequest;
        const allTargets = broadcast.all === true ? store.list({ limit: 501 }) : undefined;
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
        const sessions = targets.map((id) => store.get(id));
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
        sendJson<BroadcastMessageResponse>(response, 202, {
            submissions: sessions.map((candidate) => candidate!.submit(message)),
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
        const applied = await runtimeConfig.onDaemonConfigChange({
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
        sendJson<GlobalStreamHello>(response, 200, {
            cursor: store.liveEvents.cursor(),
            ...buildGroupCatalog(store, modelCatalog, identity, sessionTerminals),
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
            agents: store.timeline(parsed.request),
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
            const events = globalEventQueue.list({
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
            const result = globalEventQueue.trim(body.through);
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
            calls: store.listExternalToolCalls({
                limit: limit ?? 100,
                status: status as import("../external-tools/index.js").ExternalToolCall["status"],
            }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "secret-registrations") {
        sendJson<ListSecretsResponse>(response, 200, { secrets: store.listSecrets() });
        return;
    }

    if (request.method === "POST" && route.name === "secret-registrations") {
        const body = await readJson<unknown>(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(response, 400, { error: "Secret settings must be a JSON object." });
            return;
        }
        try {
            sendJson<RegisterSecretResponse>(response, 200, {
                secret: store.registerSecret(body as RegisterSecretRequest),
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
            removed: store.unregisterSecret(route.secretId),
        });
        return;
    }

    if (request.method === "POST" && route.name === "sessions") {
        const body = await readJson<CreateSessionRequest | null>(request);
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
        if (body.hostedCapabilities !== undefined) {
            if (!Value.Check(hostedCapabilitiesSchema, body.hostedCapabilities)) {
                sendJson(response, 400, {
                    error: "Hosted capabilities must be provided as a list of names.",
                });
                return;
            }
            try {
                body.hostedCapabilities = parseHostedCapabilities(body.hostedCapabilities);
            } catch (error) {
                sendJson(response, 400, { error: errorToMessage(error) });
                return;
            }
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
        try {
            const sessionRequest = configureSessionRequest(body, defaultDocker, () =>
                store.queryProjectSettings(body.cwd),
            );
            const session =
                body.id === undefined
                    ? store.create(sessionRequest)
                    : store.createWithId(body.id, sessionRequest);
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
        const summaries = store.list();
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

    const session = store.get(sessionId);
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
            const attachment = store.attachment(sessionId, route.attachmentId);
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
                    session.markRead();
                }
                sendJson<SessionTerminalHeartbeatResponse>(response, 200, { connected: true });
            } catch (error) {
                if (isDatabaseFailure(error)) throw error;
                sendJson(response, 400, { error: errorToMessage(error) });
            }
            return;
        }
        if (request.method === "DELETE") {
            if (sessionTerminals.hasFocusedTerminal(sessionId)) session.markRead();
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
        const ownerShare = runtimeConfig.sessionShares?.getOwner(sessionId)?.share;
        const snapshot = session.snapshot();
        sendJson(response, 200, {
            session: limitProtocolSessionMessages(
                ownerShare === undefined ? snapshot : { ...snapshot, shared: ownerShare },
                messageLimit,
            ),
        });
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
                session: store.reorderSession(sessionId, body)!.snapshot(),
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
        session.markRead();
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
            const result = await store.transferSession(sessionId, body as TransferSessionRequest);
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
        if (route.name === "unarchive" && session.snapshot().status === "archived") {
            sendJson(response, 409, {
                error: "A session archived with its workspace cannot be restored.",
            });
            return;
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
        const archived = session.setArchived(route.name === "archive", mutationId);
        if (route.name === "archive") {
            await runtimeConfig.sessionShares?.stopForArchivedSession(sessionId);
        }
        if (route.name === "unarchive") {
            // A visible chat must never sit under a project the user archived.
            store.unarchiveProject(archived.projectId);
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
            session: session.update({
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        });
        return;
    }

    if (request.method === "GET" && route.name === "current-provider-quota") {
        const currentProviderId = session.snapshot().providerId;
        const quota = await getProviderQuota?.(currentProviderId);
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
        const baseHello = sessionStateHello(session, turnLimit, store.listSubagents(sessionId));
        const ownerShare = runtimeConfig.sessionShares?.getOwner(sessionId)?.share;
        const hello =
            ownerShare === undefined || baseHello.session === undefined
                ? baseHello
                : { ...baseHello, session: { ...baseHello.session, shared: ownerShare } };
        // A client catching up says which message it already holds, and receives
        // only the turns from there on. It still gets the whole current session,
        // because a gap leaves the rest of that state uncertain too — but the
        // conversation itself, which is the part that can be colossal, is sent
        // incrementally rather than from the beginning.
        const after = url.searchParams.get("after") ?? undefined;
        const forward = after === undefined ? undefined : session.transcriptSince(after, turnLimit);
        if (after !== undefined && forward !== undefined) {
            sendJson<SessionStateResponse>(response, 200, {
                ...hello,
                append: true,
                cursor,
                transcript: forward,
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
            const forward = session.transcriptSince(after, SESSION_STREAM_TURN_LIMIT);
            if (forward === undefined) {
                sendJson(response, 409, {
                    error: "That part of the conversation is no longer available.",
                });
                return;
            }
            sendJson(response, 200, forward);
            return;
        }
        const before = url.searchParams.get("before") ?? undefined;
        const page = session.transcriptPage(SESSION_STREAM_TURN_LIMIT, before);
        if (page === undefined) {
            // The anchor turn is gone, so the reader's view of the conversation
            // is stale and paging from it would duplicate or misplace content.
            sendJson(response, 409, {
                error: "That part of the conversation is no longer available.",
            });
            return;
        }
        sendJson(response, 200, page);
        return;
    }

    if (request.method === "GET" && route.name === "usage") {
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
        const quotas = (
            await Promise.all(
                providerIds.map(async (providerId) => {
                    const loaded = await getProviderQuota?.(providerId);
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
            subagents: store.listSubagents(sessionId),
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
        const workflow = session.stopWorkflow(route.workflowRunId);
        if (workflow === undefined) {
            sendJson(response, 404, { error: "Workflow not found" });
            return;
        }
        session.recordMutationApplied(mutationId);
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
            const forked = store.fork(sessionId, targetSessionId);
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
        const body = await readJson<unknown>(request);
        if (!isSubmitMessageRequest(body)) {
            sendJson(response, 400, { error: "Message text must be text." });
            return;
        }
        if (body.clientSubmissionId !== undefined) {
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
        if (!sessionMutationCanApply(request, response, session)) return;
        // A user working in an explicitly archived session makes it visible again.
        const mutationId = body.mutationId ?? requestMutationId(request);
        sendJson<SubmitMessageResponse>(
            response,
            202,
            session.submit({
                ...body,
                ...(mutationId === undefined ? {} : { mutationId }),
            }),
        );
        return;
    }

    if (request.method === "POST" && route.name === "context") {
        const body = await readJson<unknown>(request);
        if (!Value.Check(submitContextMessageRequestSchema, body)) {
            sendJson(response, 400, {
                error: "A context note accepts only message text and optional submission identities; run settings are not allowed.",
            });
            return;
        }
        if (body.clientSubmissionId !== undefined) {
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
        if (!sessionMutationCanApply(request, response, session)) return;
        const mutationId = body.mutationId ?? requestMutationId(request);
        sendJson<SubmitContextMessageResponse>(
            response,
            202,
            session.submitContext({
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
            const result = session.resolveExternalToolCall(
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
        const result = session.cancelScheduledMessage(route.scheduledMessageId, mutationId);
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
        const body = await readJson<unknown>(request);
        if (!isSubmitMessageRequest(body)) {
            sendJson(response, 400, { error: "Message text must be text." });
            return;
        }
        try {
            sendJson<SteerMessageResponse>(response, 202, session.steer(body));
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
            const expectedRunId = url.searchParams.get("expectedRunId") ?? undefined;
            const steeringMessageIds = url.searchParams.getAll("steeringMessageId");
            sendJson<AbortRunResponse>(
                response,
                200,
                await session.abort({
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
        const stoppedProcesses = await session.stopBackgroundProcesses();
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
            const process = await session.readBackgroundProcess(route.processSessionId, {
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
            const result = await session.stopBackgroundProcess(route.processSessionId);
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
        const result = await session.runShellCommand(candidate as RunShellCommandRequest);
        session.recordMutationApplied(mutationId);
        sendJson<RunShellCommandResponse>(response, 200, result);
        return;
    }

    if (request.method === "POST" && route.name === "reset") {
        const mutationId = requestMutationId(request);
        if (sessionMutationCompleted(session, mutationId)) {
            sendJson(response, 200, { session: session.snapshot() });
            return;
        }
        if (!sessionMutationCanApply(request, response, session)) return;
        await session.reset();
        session.recordMutationApplied(mutationId);
        sendJson(response, 200, { session: session.snapshot() });
        return;
    }

    if (request.method === "POST" && route.name === "rewind") {
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
            const result = session.rewind(body.messageId);
            session.recordMutationApplied(mutationId);
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
        const result = await session.compact();
        session.recordMutationApplied(mutationId);
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
        sendJson(response, 200, {
            session: session.changeEffort({
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
        sendJson(response, 200, {
            session: session.changeServiceTier({
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
        try {
            sendJson(response, 200, {
                session: session.changeModel({
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
        sendJson(response, 200, {
            session: await session.changePermissionMode({
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
            session: session.setDraft({
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
                    store.attachSecret(session.id, body.secretId, scope, mutationId)?.snapshot() ??
                    session.snapshot(),
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
                store.detachSecret(session.id, route.secretId, scope, mutationId)?.snapshot() ??
                session.snapshot(),
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
            session.setGoal(body, mutationId);
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
            session.changeGoalStatus(body, mutationId === undefined ? {} : { mutationId });
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
        session.clearGoal(mutationId);
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
            const snapshot = session.answerUserInput(route.requestId, {
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
        streamEvents(
            request,
            response,
            session,
            url.searchParams.get("after") ?? undefined,
            sessionEventStreamLeases,
            parseTurnLimit(url.searchParams.get("turns")),
            store.listSubagents(sessionId),
            // Read per event rather than captured once: a stream outlives every
            // change to who is watching, and a stale answer here is exactly the
            // stale answer the disclosure exists to prevent.
            () => runtimeConfig.sessionShares?.getOwner(sessionId)?.share,
        );
        return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
}

function resolveProjectScopeDirectory(
    store: SessionStore,
    scope: ProjectScope,
): { ok: true; path: string } | { error: string; ok: false; status: 404 | 409 } {
    const project = store.getProject(scope.projectId);
    if (project === undefined) return { error: "Project not found", ok: false, status: 404 };
    if (scope.workspaceId === undefined) return { ok: true, path: project.path };
    const workspace = store.getWorkspace(scope.projectId, scope.workspaceId);
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

function resolveWebappContext(
    store: SessionStore,
    webapp: Webapp,
    request: ResolveWebappOpenRequest,
):
    | { context: WebappContext; type: "context" }
    | {
          code: "invalid_request" | "invalid_webapp";
          message: string;
          type: "error";
      } {
    let context: WebappContext;
    let scope: SlotScope;
    if (request.sessionId !== undefined) {
        const session = store.get(request.sessionId);
        if (session === undefined) {
            return {
                code: "invalid_request",
                message: `No session with the id ${request.sessionId} exists.`,
                type: "error",
            };
        }
        const identity = session.projectIdentity();
        if (request.projectId !== undefined && request.projectId !== identity.projectId) {
            return {
                code: "invalid_request",
                message: `The session ${request.sessionId} belongs to project ${identity.projectId}, not project ${request.projectId}.`,
                type: "error",
            };
        }
        if (request.workspaceId !== undefined && request.workspaceId !== identity.workspaceId) {
            return {
                code: "invalid_request",
                message:
                    identity.workspaceId === undefined
                        ? `The session ${request.sessionId} does not belong to a workspace.`
                        : `The session ${request.sessionId} belongs to workspace ${identity.workspaceId}, not workspace ${request.workspaceId}.`,
                type: "error",
            };
        }
        context = {
            webapp: webapp.name,
            version: webapp.currentVersion,
            sessionId: request.sessionId,
            projectId: identity.projectId,
            ...(identity.workspaceId === undefined ? {} : { workspaceId: identity.workspaceId }),
        };
        scope = "session";
    } else {
        if (request.workspaceId !== undefined && request.projectId === undefined) {
            return {
                code: "invalid_request",
                message: "A workspace webapp context also needs its project id.",
                type: "error",
            };
        }
        if (request.projectId !== undefined && store.getProject(request.projectId) === undefined) {
            return {
                code: "invalid_request",
                message: `No project with the id ${request.projectId} exists.`,
                type: "error",
            };
        }
        if (
            request.projectId !== undefined &&
            request.workspaceId !== undefined &&
            store.getWorkspace(request.projectId, request.workspaceId) === undefined
        ) {
            return {
                code: "invalid_request",
                message: `No workspace with the id ${request.workspaceId} exists in project ${request.projectId}.`,
                type: "error",
            };
        }
        context = {
            webapp: webapp.name,
            version: webapp.currentVersion,
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
    if (!webapp.allowedScopes.includes(scope)) {
        return {
            code: "invalid_webapp",
            message: describeWebappScopeNotAllowed(webapp, scope),
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
              | "installation"
              | "p2p-status"
              | "p2p-invitations"
              | "p2p-joins"
              | "happy-cloud-commands"
              | "happy-cloud-profile"
              | "happy-cloud-status"
              | "happy-reload"
              | "messages"
              | "models"
              | "murmur-account"
              | "murmur-contacts"
              | "murmur-friends"
              | "murmur-friend-requests"
              | "murmur-service-start"
              | "murmur-service-stop"
              | "presence"
              | "plugin-catalog"
              | "plugins"
              | "projects"
              | "provider-usage"
              | "scope-share-replicas"
              | "secret-registrations"
              | "session-share-post"
              | "session-share-replicas"
              | "sessions"
              | "shutdown"
              | "slots"
              | "timeline"
              | "webapps";
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
    | {
          name: "murmur-friend-request-answer";
          peerId: string;
          sessionId?: undefined;
      }
    | {
          name: "scope-share-health" | "scope-share-replica";
          sessionId?: undefined;
          shareId: string;
      }
    | {
          name: "scope-share-replica-session";
          scopeSessionId: string;
          sessionId?: undefined;
          shareId: string;
      }
    | {
          name:
              | "session-share-health"
              | "session-share-replica-capabilities"
              | "session-share-replica-history"
              | "session-share-replica-terminal";
          sessionId?: undefined;
          shareId: string;
      }
    | { name: "slot-entry"; sessionId?: undefined; slotEntryId: string }
    | {
          name: "webapp-context" | "webapp-open" | "webapp-revert" | "webapp-versions";
          sessionId?: undefined;
          webappName: string;
      }
    | {
          format: "ico" | "png";
          name: "webapp-icon";
          sessionId?: undefined;
          webappName: string;
      }
    | { name: "webapp-file"; sessionId?: undefined; webappFilePath: string; webappName: string }
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
          name: "scope-share-scope" | "scope-share-scope-members" | "scope-share-scope-stop";
          projectId: string;
          /** The workspace or the project itself, whichever the route named. */
          scopeId: string;
          scopeKind: ScopeShareScopeKind;
          sessionId?: undefined;
      }
    | {
          name: "scope-share-scope-member-revoke";
          projectId: string;
          scopeId: string;
          scopeKind: ScopeShareScopeKind;
          sessionId?: undefined;
          shareMemberId: string;
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
              | "session-share"
              | "session-share-friend-messages"
              | "session-share-members"
              | "session-share-peer-activity"
              | "session-share-stop"
              | "session-share-tool-output"
              | "session"
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
          name: "session-share-member-capabilities" | "session-share-member-revoke";
          sessionId: string;
          shareMemberId: string;
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
    if (pathname === "/installation") return { name: "installation" };
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
    if (pathname === "/murmur/account") return { name: "murmur-account" };
    if (pathname === "/murmur/contacts") return { name: "murmur-contacts" };
    if (pathname === "/murmur/friends") return { name: "murmur-friends" };
    if (pathname === "/murmur/friend-requests") return { name: "murmur-friend-requests" };
    if (pathname === "/murmur/service/start") return { name: "murmur-service-start" };
    if (pathname === "/murmur/service/stop") return { name: "murmur-service-stop" };
    if (pathname === "/git/watch") return { name: "git-watch" };
    if (pathname === "/presence") return { name: "presence" };
    if (pathname === "/plugins") return { name: "plugins" };
    if (pathname === "/plugin-catalogs/github") return { name: "plugin-catalog" };
    if (pathname === "/projects") return { name: "projects" };
    if (pathname === "/provider-usage") return { name: "provider-usage" };
    if (pathname === "/secrets") return { name: "secret-registrations" };
    if (pathname === "/sessions") return { name: "sessions" };
    if (pathname === "/session-shares/friend-messages") return { name: "session-share-post" };
    if (pathname === "/scope-share-replicas") return { name: "scope-share-replicas" };
    if (pathname === "/session-share-replicas") return { name: "session-share-replicas" };
    if (pathname === "/shutdown") return { name: "shutdown" };
    if (pathname === "/slots") return { name: "slots" };
    if (pathname === "/webapps") return { name: "webapps" };

    const webappIcon = /^\/webapps\/([^/]+)\/favicon\.(ico|png)$/u.exec(pathname);
    if (webappIcon !== null) {
        const webappName = decodeUrlComponent(webappIcon[1]);
        if (webappName === undefined) return undefined;
        return {
            format: webappIcon[2] as "ico" | "png",
            name: "webapp-icon",
            webappName,
        };
    }
    const webappFile = /^\/webapps\/([^/]+)\/files(?:\/(.*))?$/u.exec(pathname);
    if (webappFile !== null) {
        const webappName = decodeUrlComponent(webappFile[1]);
        if (webappName === undefined) return undefined;
        const rawSegments = (webappFile[2] ?? "").split("/").filter((segment) => segment !== "");
        const segments = rawSegments.map(decodeUrlComponent);
        if (segments.some((segment) => segment === undefined)) return undefined;
        return { name: "webapp-file", webappFilePath: segments.join("/"), webappName };
    }
    const webappContext = /^\/webapps\/([^/]+)\/context$/u.exec(pathname);
    if (webappContext !== null) {
        const webappName = decodeUrlComponent(webappContext[1]);
        if (webappName === undefined) return undefined;
        return { name: "webapp-context", webappName };
    }
    const webappOpen = /^\/webapps\/([^/]+)\/open$/u.exec(pathname);
    if (webappOpen !== null) {
        const webappName = decodeUrlComponent(webappOpen[1]);
        if (webappName === undefined) return undefined;
        return { name: "webapp-open", webappName };
    }
    const webappOperation = /^\/webapps\/([^/]+)\/(versions|revert)$/u.exec(pathname);
    if (webappOperation !== null) {
        const webappName = decodeUrlComponent(webappOperation[1]);
        if (webappName === undefined) return undefined;
        return {
            name: webappOperation[2] === "versions" ? "webapp-versions" : "webapp-revert",
            webappName,
        };
    }

    const globalParts = pathname.split("/").filter(Boolean);
    if (
        globalParts.length === 3 &&
        globalParts[0] === "scope-shares" &&
        globalParts[2] === "health"
    ) {
        const shareId = decodeUrlComponent(globalParts[1]);
        return shareId === undefined ? undefined : { name: "scope-share-health", shareId };
    }
    if (globalParts.length === 2 && globalParts[0] === "scope-share-replicas") {
        const shareId = decodeUrlComponent(globalParts[1]);
        return shareId === undefined ? undefined : { name: "scope-share-replica", shareId };
    }
    if (
        globalParts.length === 5 &&
        globalParts[0] === "scope-share-replicas" &&
        globalParts[2] === "sessions" &&
        globalParts[4] === "history"
    ) {
        const shareId = decodeUrlComponent(globalParts[1]);
        const scopeSessionId = decodeUrlComponent(globalParts[3]);
        return shareId === undefined || scopeSessionId === undefined
            ? undefined
            : { name: "scope-share-replica-session", scopeSessionId, shareId };
    }
    if (
        globalParts.length === 3 &&
        globalParts[0] === "session-shares" &&
        globalParts[2] === "health"
    ) {
        const shareId = decodeUrlComponent(globalParts[1]);
        return shareId === undefined ? undefined : { name: "session-share-health", shareId };
    }
    if (
        globalParts.length === 3 &&
        globalParts[0] === "session-share-replicas" &&
        globalParts[2] === "history"
    ) {
        const shareId = decodeUrlComponent(globalParts[1]);
        return shareId === undefined
            ? undefined
            : { name: "session-share-replica-history", shareId };
    }
    if (
        globalParts.length === 3 &&
        globalParts[0] === "session-share-replicas" &&
        globalParts[2] === "capabilities"
    ) {
        const shareId = decodeUrlComponent(globalParts[1]);
        return shareId === undefined
            ? undefined
            : { name: "session-share-replica-capabilities", shareId };
    }
    if (
        globalParts.length === 3 &&
        globalParts[0] === "session-share-replicas" &&
        globalParts[2] === "terminal"
    ) {
        const shareId = decodeUrlComponent(globalParts[1]);
        return shareId === undefined
            ? undefined
            : { name: "session-share-replica-terminal", shareId };
    }
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
    if (
        globalParts.length === 4 &&
        globalParts[0] === "murmur" &&
        globalParts[1] === "friend-requests" &&
        globalParts[2] !== undefined &&
        globalParts[3] === "answer"
    ) {
        const peerId = decodeUrlComponent(globalParts[2]);
        return peerId === undefined ? undefined : { name: "murmur-friend-request-answer", peerId };
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
        const projectShare = matchScopeShareRoute(globalParts.slice(2), {
            projectId,
            scopeId: projectId,
            scopeKind: "project",
        });
        if (projectShare !== undefined) return projectShare;
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
            const workspaceShare = matchScopeShareRoute(globalParts.slice(4), {
                projectId,
                scopeId: workspaceId,
                scopeKind: "workspace",
            });
            if (workspaceShare !== undefined) return workspaceShare;
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
    if (parts.length === 3 && parts[2] === "share") {
        return { name: "session-share", sessionId };
    }
    if (parts.length === 4 && parts[2] === "share" && parts[3] === "members") {
        return { name: "session-share-members", sessionId };
    }
    if (parts.length === 4 && parts[2] === "share" && parts[3] === "stop") {
        return { name: "session-share-stop", sessionId };
    }
    if (parts.length === 4 && parts[2] === "share" && parts[3] === "friend-messages") {
        return { name: "session-share-friend-messages", sessionId };
    }
    if (parts.length === 4 && parts[2] === "share" && parts[3] === "tool-output") {
        return { name: "session-share-tool-output", sessionId };
    }
    if (parts.length === 4 && parts[2] === "share" && parts[3] === "peer-activity") {
        return { name: "session-share-peer-activity", sessionId };
    }
    if (
        parts.length === 6 &&
        parts[2] === "share" &&
        parts[3] === "members" &&
        parts[4] !== undefined &&
        parts[5] === "revoke"
    ) {
        return {
            name: "session-share-member-revoke",
            sessionId,
            shareMemberId: decodeURIComponent(parts[4]),
        };
    }
    if (
        parts.length === 6 &&
        parts[2] === "share" &&
        parts[3] === "members" &&
        parts[4] !== undefined &&
        parts[5] === "capabilities"
    ) {
        return {
            name: "session-share-member-capabilities",
            sessionId,
            shareMemberId: decodeURIComponent(parts[4]),
        };
    }
    if (parts.length === 3 && parts[2] === "reorder") {
        return { name: "reorder", sessionId };
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

/**
 * The share routes a project and a workspace both answer, below whichever one they hang off.
 *
 * `/projects/{id}/share` and `/projects/{id}/workspaces/{id}/share` are the same four
 * routes over a different subject, so both are parsed here and the scope they name is
 * decided by the caller rather than by the path they were reached through.
 */
function matchScopeShareRoute(
    parts: readonly (string | undefined)[],
    scope: { projectId: string; scopeId: string; scopeKind: ScopeShareScopeKind },
): ReturnType<typeof matchRoute> {
    if (parts[0] !== "share") return undefined;
    if (parts.length === 1) return { name: "scope-share-scope", ...scope };
    if (parts.length === 2 && parts[1] === "members") {
        return { name: "scope-share-scope-members", ...scope };
    }
    if (parts.length === 2 && parts[1] === "stop") {
        return { name: "scope-share-scope-stop", ...scope };
    }
    if (parts.length === 4 && parts[1] === "members" && parts[3] === "revoke") {
        const shareMemberId = decodeUrlComponent(parts[2]);
        return shareMemberId === undefined
            ? undefined
            : { name: "scope-share-scope-member-revoke", shareMemberId, ...scope };
    }
    return undefined;
}

/** What a scope-share refusal the caller can act on looks like over HTTP. */
function scopeShareRequestErrorStatus(error: ScopeShareRequestError): number {
    if (error.code === "invalid_request") return 400;
    if (error.code === "not_shared") return 404;
    // A missing Murmur account and a scope another share already covers are both
    // states the request conflicts with rather than malformed requests.
    return 409;
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
    if (error.code === "project_id_conflict" || error.code === "managed_workspace_unavailable") {
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

function sendInvalidWebappBody(response: ServerResponse, error: unknown): void {
    if (error instanceof RequestBodyTooLargeError) {
        sendWebappManagementError(
            response,
            413,
            "invalid_request",
            "The webapp request is larger than the allowed limit.",
        );
        return;
    }
    sendWebappManagementError(
        response,
        400,
        "invalid_request",
        "A webapp request must be valid JSON.",
    );
}

function sendWebappManagementError(
    response: ServerResponse,
    status: number,
    code: WebappManagementErrorCode,
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
                "session-share",
                "session-share-friend-messages",
                "session-share-member-revoke",
                "session-share-members",
                "session-share-stop",
                "unarchive",
            ].includes(routeName)) ||
        (method === "POST" && routeName === "workflow-stop") ||
        (["DELETE", "PUT"].includes(method ?? "") && routeName === "terminal-connection") ||
        (method === "PUT" && routeName === "session-share-member-capabilities") ||
        (method === "DELETE" && routeName === "background-process") ||
        (["DELETE", "PATCH", "POST"].includes(method ?? "") && routeName === "goal") ||
        (method === "POST" && routeName === "user-input") ||
        (method === "DELETE" && routeName === "secret") ||
        (method === "PUT" && routeName === "draft") ||
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
    if (route.name === "global-instructions") return request.method === "PUT";
    if (route.name === "global-security-policy") return request.method === "PUT";
    if (route.name === "debug-inspector") return request.method === "POST";
    if (route.name === "global-events-trim") return request.method === "POST";
    if (route.name === "happy-reload") return request.method === "POST";
    if (route.name === "happy-cloud-commands") return request.method === "POST";
    if (route.name === "plugins") return request.method === "POST";
    if (route.name === "plugin-catalog") return false;
    if (
        [
            "murmur-account",
            "murmur-friend-request-answer",
            "murmur-friend-requests",
            "murmur-service-start",
            "murmur-service-stop",
        ].includes(route.name)
    ) {
        return request.method !== "GET";
    }
    if (route.name === "plugin-uninstall") return request.method === "DELETE";
    if (route.name === "plugin-app-tool-call" || route.name === "plugin-app-storage") {
        return request.method === "POST";
    }
    if (route.name === "secret-registrations") return request.method === "POST";
    if (route.name === "slots") return request.method === "POST";
    if (route.name === "slot-entry") return request.method !== "GET";
    if (route.name === "webapps") return request.method === "POST";
    if (route.name === "webapp-versions" || route.name === "webapp-revert") {
        return request.method === "POST";
    }
    if (route.name === "secret-registration") return request.method === "DELETE";
    if (route.name === "messages" && route.sessionId === undefined) {
        return request.method === "POST";
    }
    if (route.name === "sessions") return request.method === "POST";
    if (route.name === "session-share-post") return request.method === "POST";
    if (route.name.startsWith("scope-share-scope")) return request.method !== "GET";
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

class InvalidMurmurRequestError extends Error {}

class RequestBodyTooLargeError extends Error {}

function decodeMurmurRequest<Schema extends TSchema>(
    schema: Schema,
    value: unknown,
): Static<Schema> {
    try {
        return Value.Decode(schema, value);
    } catch {
        throw new InvalidMurmurRequestError();
    }
}

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

function streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    session: SessionEventSource,
    after: string | undefined,
    sessionEventStreamLeases: Set<SessionEventStreamLease>,
    turnLimit: number | undefined,
    subagents: readonly SubagentSummary[],
    ownerShare: () => SessionSharedMetadata | undefined,
): void {
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
    const hello = sessionStreamHello(session, resumed, turnLimit, subagents);

    // A resumed client applies durable history first, then the current overlay.
    // If the connection drops mid-catch-up, its cursor advances only through
    // events it actually received, so the next attempt cannot skip anything.
    if (resumed) {
        for (const event of catchup)
            writeSseEvent(response, decorateSessionEvent(event, ownerShare));
    }
    writeSseHello(response, hello);

    const heartbeat = setInterval(() => {
        response.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref?.();

    const unsubscribe = session.events.subscribe((event) => {
        writeSseEvent(response, decorateSessionEvent(event, ownerShare));
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
    snapshot: () => ProtocolSession;
    transcriptWindow: (turnLimit?: number) => SessionTranscriptWindow;
    usage: (events?: readonly SessionEvent[]) => SessionUsageSummary;
}

interface SessionEventStreamLease {
    readonly session: SessionEventSource;
}

function writeSseHello(response: ServerResponse, hello: SessionStreamHello): void {
    response.write("event: hello\n");
    response.write(`data: ${JSON.stringify(hello)}\n\n`);
}

/**
 * Join the owner's share onto a session snapshot leaving the daemon.
 *
 * Sharing lives beside the session rather than inside it, so the snapshot never
 * carries it and every boundary that hands a session to a client joins it here.
 * The hello frames already do exactly this; a `session_updated` on the stream
 * has to as well, otherwise an attached client's view of who can see it is
 * frozen at the moment it attached.
 */
function decorateSessionEvent(
    event: SessionEvent,
    ownerShare: () => SessionSharedMetadata | undefined,
): SessionEvent {
    if (event.type !== "session_updated") return event;
    const share = ownerShare();
    if (share === undefined) return event;
    return {
        ...event,
        data: { ...event.data, session: { ...event.data.session, shared: share } },
    };
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
function parseTurnLimit(value: string | null): number | undefined {
    if (value === null) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return undefined;
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
function buildGroupCatalog(
    store: SessionStore,
    modelCatalog: ModelCatalog,
    identity: DaemonIdentity,
    sessionTerminals: SessionTerminalTracker,
): Omit<GlobalStreamHello, "cursor"> {
    const inboxItems = new Map<string, ReturnType<SessionStore["listDurableUserInputs"]>>();
    for (const call of store.listDurableUserInputs()) {
        if (!isOpenQuestion(call) && call.response === undefined) continue;
        inboxItems.set(call.sessionId, [...(inboxItems.get(call.sessionId) ?? []), call]);
    }
    const sessions = store
        .listActive()
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
    const projects = store.listProjects().filter((project) => project.archivedAt === undefined);
    const projectIds = new Set(projects.map((project) => project.id));
    const workspaces = store
        .listWorkspaces()
        .filter(
            (workspace) =>
                projectIds.has(workspace.projectId) &&
                workspace.archivedAt === undefined &&
                workspace.status !== "archiving" &&
                workspace.status !== "archived",
        );
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    return {
        catalog: modelCatalog,
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
function sessionStreamHello(
    session: SessionEventSource,
    resumed: boolean,
    turnLimit: number | undefined,
    subagents: readonly SubagentSummary[],
): SessionStreamHello {
    const lastEventId = session.events.lastEventId();
    const partial = session.partialMessage();
    // A resuming client already holds the transcript, so it is sent only to a
    // client attaching fresh. The window is cut on turn boundaries so a tool
    // result never arrives without the call it belongs to.
    const transcript = resumed ? undefined : session.transcriptWindow(turnLimit);
    const currentSession = session.snapshot();
    const full = resumed ? undefined : currentSession;
    // Materialise the durable log once. A long-running session may have many
    // events, and opening a stream must not allocate and walk three separate
    // copies merely to derive current side-state.
    const durableEvents = full === undefined ? undefined : session.events.all();
    const usage =
        full === undefined || durableEvents === undefined
            ? undefined
            : session.usage(durableEvents);
    const snapshot =
        full === undefined || transcript === undefined
            ? undefined
            : {
                  ...full,
                  shellCommands: session.events.shellCommandStates(),
                  subagents,
                  snapshot: { ...full.snapshot, messages: transcript.messages },
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
                      // The daemon-wide readings arrive with the usage request;
                      // what this session itself observed is known right away.
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
 * The session-scoped stream the terminal subscribes to keeps the complete hello,
 * which still carries its transcript; this projection is only for the
 * `GET /sessions/{sessionId}/state` bootstrap.
 */
function sessionStateHello(
    session: SessionEventSource,
    turnLimit: number | undefined,
    subagents: readonly SubagentSummary[],
): SessionStreamHello {
    const hello = sessionStreamHello(session, false, turnLimit, subagents);
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
