import { randomUUID } from "node:crypto";
import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";

import {
    RemoteTerminalProtocolClient,
    type RemoteTerminalReconnectState,
} from "@slopus/ghostty-web";
import { Value } from "@sinclair/typebox/value";

import { p2pStatusSchema } from "../protocol/index.js";
import type {
    AbortRunOptions,
    AbortRunResponse,
    BroadcastMessageRequest,
    BroadcastMessageResponse,
    AnswerUserInputRequest,
    CancelScheduledMessageResponse,
    ChangeSessionGoalStatusRequest,
    CompactSessionResponse,
    CreateProjectWorkspaceRequest,
    CreateRemoteProjectRequest,
    CreateSessionRequest,
    CreateSessionResponse,
    DisconnectSessionTerminalResponse,
    EventId,
    ForkSessionResponse,
    GetCurrentProviderQuotaResponse,
    GetDaemonConfigResponse,
    GetPresenceResponse,
    SetPresenceRequestBody,
    SetPresenceResponse,
    GetGlobalInstructionsResponse,
    GetGlobalSecurityPolicyResponse,
    GetSessionUsageResponse,
    ListProviderUsageResponse,
    GlobalStreamHello,
    HealthResponse,
    RigDaemonInstallationDiscovery,
    P2pStatus,
    CreateP2pInvitationResponse,
    JoinP2pInvitationResponse,
    P2pPairingState,
    HappyCloudCommand,
    HappyCloudCommandResponse,
    HappyCloudProfileCiphertextResponse,
    HappyCloudSessionBlobResponse,
    HappyCloudStatus,
    CreateDocumentRequest,
    CreateFolderItemRequest,
    CreateFolderRequest,
    DocumentResponse,
    DocumentUpdatePage,
    FolderItemResponse,
    FolderResponse,
    GoalSessionResponse,
    MoveFolderRequest,
    MoveFolderItemRequest,
    MoveSessionRequest,
    UpdateFolderRequest,
    ListGlobalEventsResponse,
    ListExternalToolCallsResponse,
    ListModelsResponse,
    ListFileTreeRequest,
    ListFileTreeResponse,
    ListProjectFilePathsResponse,
    ListFoldersResponse,
    ListProjectsResponse,
    ListProjectWorkspacesResponse,
    ListSecretsResponse,
    ListSessionsOptions,
    ListSessionsResponse,
    ListSubagentsResponse,
    ProtocolSession,
    ProjectScope,
    ProjectResponse,
    ProjectWorkspaceResponse,
    RenameProjectRequest,
    RenameProjectWorkspaceRequest,
    ReorderRequest,
    RecordSessionActivityResponse,
    ReadBackgroundProcessResponse,
    ReadProjectFileResponse,
    ReadProjectFileRevisionResponse,
    RegisterProjectRequest,
    ResolveExternalToolCallRequest,
    ResolveExternalToolCallResponse,
    RewindSessionResponse,
    RunShellCommandRequest,
    RunShellCommandResponse,
    StopBackgroundProcessResponse,
    RegisterSecretRequest,
    RegisterSecretResponse,
    SearchFilesResponse,
    SecretAttachmentScope,
    SecretSessionResponse,
    SessionEvent,
    SessionStreamHello,
    SessionArchiveResponse,
    SessionReadResponse,
    SessionTerminalHeartbeatRequest,
    SessionTerminalHeartbeatResponse,
    ShutdownServerResponse,
    StartInspectorResponse,
    StopInspectorResponse,
    SetGoalRequest,
    SetSessionDraftRequest,
    SteerMessageRequest,
    SteerMessageResponse,
    StopWorkflowResponse,
    SubmitMessageRequest,
    SubmitMessageResponse,
    SubmitContextMessageRequest,
    SubmitContextMessageResponse,
    TrimGlobalEventsResponse,
    TransferSessionRequest,
    TransferSessionResponse,
    UnregisterSecretResponse,
    UpdateSecretRequest,
    UpdateSecretResponse,
    UpdateDaemonConfigRequest,
    UpdateDaemonConfigResponse,
    UpdateGlobalInstructionsRequest,
    UpdateGlobalInstructionsResponse,
    UpdateGlobalSecurityPolicyRequest,
    UpdateGlobalSecurityPolicyResponse,
    UpdateProjectSettingsRequest,
    UpdateSessionRequest,
    WriteProjectFileRequest,
    WriteProjectFileResponse,
    WriteDocumentRequest,
    ExternalToolCall,
} from "../protocol/index.js";
import { EventStreamHttpError } from "./EventStreamHttpError.js";
import { ProtocolHttpError } from "./ProtocolHttpError.js";
import type {
    CreateRemoteTerminalRequest,
    CreateRemoteTerminalResponse,
    ListRemoteTerminalsResponse,
    RemoteTerminalColorScheme,
    RemoteTerminalResponse,
    ResizeRemoteTerminalRequest,
} from "../terminal/index.js";
import { connectRemoteTerminalWebSocket } from "./connectRemoteTerminalWebSocket.js";
import { RemoteTerminalAttachment } from "./RemoteTerminalAttachment.js";
import { RemoteTerminalClientReplica } from "./RemoteTerminalClientReplica.js";
import { waitForGymSessionEventBarrier } from "./waitForGymSessionEventBarrier.js";
import { SessionTerminalConnection } from "./SessionTerminalConnection.js";

export interface ProtocolHttpClientOptions {
    /** Mounts every daemon route under a local gateway such as a P2P peer prefix. */
    pathPrefix?: string;
    socketPath: string;
    token: string;
}

export interface WatchSessionEventsOptions {
    after?: EventId;
    signal?: AbortSignal;
    sessionId: string;
    onEvent: (event: SessionEvent) => void | Promise<void>;
    /** Receives the opening frame of every connection, including reconnects. */
    onHello?: (hello: SessionStreamHello) => void | Promise<void>;
}

export interface AttachRemoteTerminalOptions {
    clientId?: string;
    colorScheme?: RemoteTerminalColorScheme;
    creditBytes?: number;
    reconnectState?: RemoteTerminalReconnectState;
    replica?: RemoteTerminalClientReplica;
}

export interface ProxyHttpRequestOptions {
    body?: Uint8Array;
    headers?: Readonly<Record<string, string>>;
    method?: string;
    url: string;
}

export interface ProxyHttpResponse {
    body: import("node:http").IncomingMessage;
    headers: IncomingHttpHeaders;
    statusCode: number;
}

export class ProtocolHttpClient {
    readonly socketPath: string;
    readonly token: string;
    readonly #pathPrefix: string;

    constructor(options: ProtocolHttpClientOptions) {
        this.socketPath = options.socketPath;
        this.token = options.token;
        this.#pathPrefix = normalizePathPrefix(options.pathPrefix);
    }

    getHappyCloudStatus(): Promise<HappyCloudStatus> {
        return this.#requestJson("GET", "/happy-cloud/status");
    }

    async getP2pStatus(): Promise<P2pStatus> {
        const status: unknown = await this.#requestJson("GET", "/p2p/status");
        if (!Value.Check(p2pStatusSchema, status)) {
            throw new Error("Rig returned an invalid P2P status.");
        }
        return status;
    }

    createP2pInvitation(): Promise<CreateP2pInvitationResponse> {
        return this.#requestJson("POST", "/p2p/invitations");
    }

    joinP2pInvitation(invitation: string): Promise<JoinP2pInvitationResponse> {
        return this.#requestJson("POST", "/p2p/joins", { invitation });
    }

    getP2pPairing(id: string): Promise<P2pPairingState> {
        return this.#requestJson("GET", `/p2p/pairings/${encodeURIComponent(id)}`);
    }

    answerP2pVerification(id: string, accept: boolean): Promise<P2pPairingState> {
        return this.#requestJson("POST", `/p2p/pairings/${encodeURIComponent(id)}/answer`, {
            accept,
        });
    }

    applyHappyCloudCommand(command: HappyCloudCommand): Promise<HappyCloudCommandResponse> {
        return this.#requestJson("POST", "/happy-cloud/commands", command, {
            "x-rig-mutation-id": command.mutationId,
        });
    }

    getHappyCloudProfile(): Promise<HappyCloudProfileCiphertextResponse | undefined> {
        return this.#requestJson<HappyCloudProfileCiphertextResponse>(
            "GET",
            "/happy-cloud/profile",
        ).catch((error: unknown) => {
            if (error instanceof ProtocolHttpError && error.statusCode === 404) return undefined;
            throw error;
        });
    }

    getHappyCloudSessionBlob(
        sessionId: string,
    ): Promise<HappyCloudSessionBlobResponse | undefined> {
        return this.#requestJson<HappyCloudSessionBlobResponse>(
            "GET",
            `/happy-cloud/session-blobs/${encodeURIComponent(sessionId)}`,
        ).catch((error: unknown) => {
            if (error instanceof ProtocolHttpError && error.statusCode === 404) return undefined;
            throw error;
        });
    }

    steerMessage(sessionId: string, request: SteerMessageRequest): Promise<SteerMessageResponse> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/steer`,
            request,
        );
    }

    abort(sessionId: string, options: AbortRunOptions = {}): Promise<AbortRunResponse> {
        const parameters = new URLSearchParams();
        if (options.continuePendingSteering === true) {
            parameters.set("continuePendingSteering", "1");
        }
        if (options.expectedRunId !== undefined) {
            parameters.set("expectedRunId", options.expectedRunId);
        }
        for (const messageId of options.steeringMessageIds ?? []) {
            parameters.append("steeringMessageId", messageId);
        }
        const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/abort${query}`,
        );
    }

    stopBackgroundProcesses(sessionId: string): Promise<{ stoppedProcesses: number }> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/background-processes/stop`,
        );
    }

    readBackgroundProcess(
        sessionId: string,
        processSessionId: number,
        options: { waitMs?: number } = {},
    ): Promise<ReadBackgroundProcessResponse | undefined> {
        const query =
            options.waitMs === undefined
                ? ""
                : `?waitMs=${encodeURIComponent(String(options.waitMs))}`;
        return this.#requestJson<ReadBackgroundProcessResponse>(
            "GET",
            `/sessions/${encodeURIComponent(sessionId)}/background-processes/${encodeURIComponent(String(processSessionId))}${query}`,
        ).catch((error: unknown) => {
            if (error instanceof ProtocolHttpError && error.statusCode === 404) return undefined;
            throw error;
        });
    }

    stopBackgroundProcess(
        sessionId: string,
        processSessionId: number,
    ): Promise<StopBackgroundProcessResponse> {
        return this.#requestJson(
            "DELETE",
            `/sessions/${encodeURIComponent(sessionId)}/background-processes/${encodeURIComponent(String(processSessionId))}`,
        );
    }

    answerUserInput(
        sessionId: string,
        requestId: string,
        request: AnswerUserInputRequest,
    ): Promise<{ session: ProtocolSession }> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/user-input/${encodeURIComponent(requestId)}`,
            request,
        );
    }

    setSessionDraft(
        sessionId: string,
        request: SetSessionDraftRequest,
    ): Promise<{ session: ProtocolSession }> {
        return this.#requestJson(
            "PUT",
            `/sessions/${encodeURIComponent(sessionId)}/draft`,
            request,
        );
    }

    attachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope = "session",
    ): Promise<SecretSessionResponse> {
        return this.#requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/secrets`, {
            scope,
            secretId,
        });
    }

    detachSecret(
        sessionId: string,
        secretId: string,
        scope: SecretAttachmentScope = "session",
    ): Promise<SecretSessionResponse> {
        return this.#requestJson(
            "DELETE",
            `/sessions/${encodeURIComponent(sessionId)}/secrets/${encodeURIComponent(secretId)}?scope=${scope}`,
        );
    }

    listSecrets(): Promise<ListSecretsResponse> {
        return this.#requestJson("GET", "/secrets");
    }

    registerSecret(request: RegisterSecretRequest): Promise<RegisterSecretResponse> {
        return this.#requestJson("POST", "/secrets", request);
    }

    updateSecret(secretId: string, request: UpdateSecretRequest): Promise<UpdateSecretResponse> {
        return this.#requestJson("PATCH", `/secrets/${encodeURIComponent(secretId)}`, request);
    }

    unregisterSecret(secretId: string): Promise<UnregisterSecretResponse> {
        return this.#requestJson("DELETE", `/secrets/${encodeURIComponent(secretId)}`);
    }

    setGoal(sessionId: string, request: SetGoalRequest): Promise<GoalSessionResponse> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/goal`,
            request,
        );
    }

    changeGoalStatus(
        sessionId: string,
        request: ChangeSessionGoalStatusRequest,
    ): Promise<GoalSessionResponse> {
        return this.#requestJson(
            "PATCH",
            `/sessions/${encodeURIComponent(sessionId)}/goal`,
            request,
        );
    }

    clearGoal(sessionId: string): Promise<GoalSessionResponse> {
        return this.#requestJson("DELETE", `/sessions/${encodeURIComponent(sessionId)}/goal`);
    }

    compact(sessionId: string): Promise<CompactSessionResponse> {
        return this.#requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/compact`);
    }

    createSession(request: CreateSessionRequest): Promise<CreateSessionResponse> {
        return this.#requestJson("POST", "/sessions", request);
    }

    async connectSessionTerminal(
        sessionId: string,
        options: { focused?: boolean; targetPid?: number } = {},
    ): Promise<SessionTerminalConnection> {
        const connectionId = randomUUID();
        let focused = options.focused === true;
        const targetPid = options.targetPid ?? process.pid;
        const heartbeat = () =>
            this.heartbeatSessionTerminal(sessionId, {
                connectionId,
                focused,
                targetPid,
            }).then(() => undefined);
        await heartbeat();
        return new SessionTerminalConnection({
            connectionId,
            disconnect: () =>
                this.disconnectSessionTerminal(sessionId, connectionId).then(() => undefined),
            heartbeat,
            setFocused: (nextFocused) => {
                focused = nextFocused;
            },
        });
    }

    disconnectSessionTerminal(
        sessionId: string,
        connectionId: string,
    ): Promise<DisconnectSessionTerminalResponse> {
        return this.#requestJson(
            "DELETE",
            `/sessions/${encodeURIComponent(sessionId)}/terminal-connections/${encodeURIComponent(connectionId)}`,
        );
    }

    heartbeatSessionTerminal(
        sessionId: string,
        request: SessionTerminalHeartbeatRequest,
    ): Promise<SessionTerminalHeartbeatResponse> {
        return this.#requestJson(
            "PUT",
            `/sessions/${encodeURIComponent(sessionId)}/terminal-connections/${encodeURIComponent(request.connectionId)}`,
            request,
        );
    }

    createRemoteTerminal(
        scope: ProjectScope,
        request: CreateRemoteTerminalRequest = {},
    ): Promise<CreateRemoteTerminalResponse> {
        return this.#requestJson("POST", this.#remoteTerminalCollectionPath(scope), request);
    }

    async attachRemoteTerminal(
        scope: ProjectScope,
        terminalId: string,
        options: AttachRemoteTerminalOptions = {},
    ): Promise<RemoteTerminalAttachment> {
        const replica =
            options.replica ??
            (await RemoteTerminalClientReplica.create(options.colorScheme ?? "dark"));
        let stream: Duplex;
        try {
            stream = await connectRemoteTerminalWebSocket({
                path: this.#path(`${this.#remoteTerminalPath(scope, terminalId)}/attach`),
                socketPath: this.socketPath,
                token: this.token,
            });
        } catch (error) {
            if (options.replica === undefined) replica.close();
            throw error;
        }
        const reconnect = options.reconnectState;
        const clientId = options.clientId ?? randomUUID();
        const attachment = new RemoteTerminalAttachment(
            clientId,
            replica,
            (onExit) =>
                new RemoteTerminalProtocolClient({
                    clientId,
                    ...(options.creditBytes === undefined
                        ? {}
                        : { creditBytes: options.creditBytes }),
                    ...(reconnect?.epoch === undefined ? {} : { epoch: reconnect.epoch }),
                    ...(reconnect?.inputLease === undefined
                        ? {}
                        : { inputLease: reconnect.inputLease }),
                    ...(reconnect === undefined
                        ? {}
                        : {
                              pendingInputs: reconnect.pendingInputs,
                              resumeInputSequence: reconnect.resumeInputSequence,
                              resumeOutputOffset: reconnect.resumeOutputOffset,
                          }),
                    onExit,
                    replica,
                    stream,
                }),
        );
        try {
            await attachment.protocol.ready;
            return attachment;
        } catch (error) {
            attachment.close();
            if (options.replica === undefined) replica.close();
            throw error;
        }
    }

    listRemoteTerminals(scope: ProjectScope): Promise<ListRemoteTerminalsResponse> {
        return this.#requestJson("GET", this.#remoteTerminalCollectionPath(scope));
    }

    resizeRemoteTerminal(
        scope: ProjectScope,
        terminalId: string,
        request: ResizeRemoteTerminalRequest,
    ): Promise<RemoteTerminalResponse> {
        return this.#requestJson("PATCH", this.#remoteTerminalPath(scope, terminalId), request);
    }

    stopRemoteTerminal(scope: ProjectScope, terminalId: string): Promise<RemoteTerminalResponse> {
        return this.#requestJson("DELETE", this.#remoteTerminalPath(scope, terminalId));
    }

    updateSession(
        sessionId: string,
        request: UpdateSessionRequest,
    ): Promise<{ session: ProtocolSession }> {
        return this.#requestJson("PATCH", `/sessions/${encodeURIComponent(sessionId)}`, request);
    }

    transferSession(
        sessionId: string,
        request: TransferSessionRequest,
    ): Promise<TransferSessionResponse> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/transfer`,
            request,
        );
    }

    archiveSession(sessionId: string): Promise<SessionArchiveResponse> {
        return this.#requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/archive`);
    }

    unarchiveSession(sessionId: string): Promise<SessionArchiveResponse> {
        return this.#requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/unarchive`);
    }

    markSessionRead(sessionId: string): Promise<SessionReadResponse> {
        return this.#requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/read`);
    }

    forkSession(sessionId: string): Promise<ForkSessionResponse> {
        return this.#requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/fork`);
    }

    health(): Promise<HealthResponse> {
        return this.#requestJson("GET", "/health");
    }

    installation(): Promise<RigDaemonInstallationDiscovery> {
        return this.#requestJson("GET", "/installation");
    }

    models(): Promise<ListModelsResponse> {
        return this.#requestJson("GET", "/models");
    }

    /**
     * The entity bootstrap: every active project, workspace and session, taken at
     * one point in the event stream so a client can rebase it onto whatever the
     * stream delivered while it was loading.
     */
    catalog(): Promise<GlobalStreamHello> {
        return this.#requestJson("GET", "/catalog");
    }

    listSessions(options?: number | ListSessionsOptions): Promise<ListSessionsResponse> {
        const normalized = typeof options === "number" ? { limit: options } : (options ?? {});
        const parameters = new URLSearchParams();
        if (normalized.limit !== undefined) {
            parameters.set("limit", String(normalized.limit));
        }
        if (normalized.archived !== undefined) {
            parameters.set("archived", String(normalized.archived));
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        return this.#requestJson("GET", `/sessions${suffix}`);
    }

    listFolders(): Promise<ListFoldersResponse> {
        return this.#requestJson("GET", "/folders");
    }

    createFolder(request: CreateFolderRequest): Promise<FolderResponse> {
        return this.#requestJson("POST", "/folders", request);
    }

    getFolder(folderId: string): Promise<FolderResponse> {
        return this.#requestJson("GET", `/folders/${encodeURIComponent(folderId)}`);
    }

    updateFolder(folderId: string, request: UpdateFolderRequest): Promise<FolderResponse> {
        return this.#requestJson("PATCH", `/folders/${encodeURIComponent(folderId)}`, request);
    }

    moveFolder(folderId: string, request: MoveFolderRequest): Promise<FolderResponse> {
        return this.#requestJson("POST", `/folders/${encodeURIComponent(folderId)}/move`, request);
    }

    archiveFolder(folderId: string): Promise<FolderResponse> {
        return this.#requestJson("POST", `/folders/${encodeURIComponent(folderId)}/archive`);
    }

    createFolderItem(
        folderId: string,
        request: CreateFolderItemRequest,
    ): Promise<FolderItemResponse> {
        return this.#requestJson("POST", `/folders/${encodeURIComponent(folderId)}/items`, request);
    }

    getFolderItem(itemId: string): Promise<FolderItemResponse> {
        return this.#requestJson("GET", `/folder-items/${encodeURIComponent(itemId)}`);
    }

    moveFolderItem(
        itemId: string,
        request: MoveFolderItemRequest,
        expectedVersion: number,
    ): Promise<FolderItemResponse> {
        return this.#requestJson(
            "POST",
            `/folder-items/${encodeURIComponent(itemId)}/move`,
            request,
            { "if-match": JSON.stringify(String(expectedVersion)) },
        );
    }

    archiveFolderItem(itemId: string, expectedVersion: number): Promise<FolderItemResponse> {
        return this.#requestJson(
            "POST",
            `/folder-items/${encodeURIComponent(itemId)}/archive`,
            undefined,
            { "if-match": JSON.stringify(String(expectedVersion)) },
        );
    }

    createDocument(request: CreateDocumentRequest): Promise<DocumentResponse> {
        return this.#requestJson("POST", "/documents", request);
    }

    getDocument(documentId: string): Promise<DocumentResponse> {
        return this.#requestJson("GET", `/documents/${encodeURIComponent(documentId)}`);
    }

    listDocumentUpdates(
        documentId: string,
        options: { afterVersion?: number; limit?: number } = {},
    ): Promise<DocumentUpdatePage> {
        const search = new URLSearchParams();
        if (options.afterVersion !== undefined) {
            search.set("afterVersion", String(options.afterVersion));
        }
        if (options.limit !== undefined) search.set("limit", String(options.limit));
        const suffix = search.size === 0 ? "" : `?${search.toString()}`;
        return this.#requestJson(
            "GET",
            `/documents/${encodeURIComponent(documentId)}/updates${suffix}`,
        );
    }

    writeDocument(
        documentId: string,
        request: WriteDocumentRequest,
        expectedVersion: number,
    ): Promise<DocumentResponse> {
        return this.#requestJson(
            "POST",
            `/documents/${encodeURIComponent(documentId)}/write`,
            request,
            { "if-match": JSON.stringify(String(expectedVersion)) },
        );
    }

    moveSessionScope(
        sessionId: string,
        request: MoveSessionRequest,
    ): Promise<{ session: ProtocolSession }> {
        return this.#requestJson(
            "PUT",
            `/sessions/${encodeURIComponent(sessionId)}/scope`,
            request,
        );
    }

    listProjects(): Promise<ListProjectsResponse> {
        return this.#requestJson("GET", "/projects");
    }

    registerProject(request: RegisterProjectRequest): Promise<ProjectResponse> {
        return this.#requestJson("POST", "/projects", request);
    }

    createRemoteProject(
        request: CreateRemoteProjectRequest,
        mutationId?: string,
    ): Promise<ProjectResponse> {
        return this.#requestJson(
            "POST",
            "/projects/clone",
            request,
            mutationId === undefined ? undefined : { "x-rig-mutation-id": mutationId },
        );
    }

    getProject(projectId: string): Promise<ProjectResponse> {
        return this.#requestJson("GET", `/projects/${encodeURIComponent(projectId)}`);
    }

    renameProject(
        projectId: string,
        request: RenameProjectRequest,
        expectedVersion: number,
    ): Promise<ProjectResponse> {
        return this.#requestJson("PATCH", `/projects/${encodeURIComponent(projectId)}`, request, {
            "if-match": `"${String(expectedVersion)}"`,
        });
    }

    updateProjectSettings(
        projectId: string,
        request: UpdateProjectSettingsRequest,
        expectedVersion: number,
    ): Promise<ProjectResponse> {
        return this.#requestJson(
            "PUT",
            `/projects/${encodeURIComponent(projectId)}/settings`,
            request,
            { "if-match": `"${String(expectedVersion)}"` },
        );
    }

    refreshProject(projectId: string): Promise<ProjectResponse> {
        return this.#requestJson("POST", `/projects/${encodeURIComponent(projectId)}/refresh`);
    }

    reorderProject(
        projectId: string,
        request: ReorderRequest,
        expectedVersion: number,
    ): Promise<ProjectResponse> {
        return this.#requestJson(
            "POST",
            `/projects/${encodeURIComponent(projectId)}/reorder`,
            request,
            { "if-match": `"${String(expectedVersion)}"` },
        );
    }

    archiveProject(projectId: string, expectedVersion: number): Promise<ProjectResponse> {
        return this.#requestJson(
            "POST",
            `/projects/${encodeURIComponent(projectId)}/archive`,
            {},
            { "if-match": `"${String(expectedVersion)}"` },
        );
    }

    uploadProjectAvatar(
        projectId: string,
        bytes: Uint8Array,
        mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/tiff" | "image/webp",
        expectedVersion: number,
    ): Promise<ProjectResponse> {
        return this.#requestBytesJson(
            "PUT",
            `/projects/${encodeURIComponent(projectId)}/avatar`,
            bytes,
            {
                "content-type": mediaType,
                "if-match": `"${String(expectedVersion)}"`,
            },
        );
    }

    clearProjectAvatar(projectId: string): Promise<ProjectResponse> {
        return this.#requestJson("DELETE", `/projects/${encodeURIComponent(projectId)}/avatar`);
    }

    listProjectWorkspaces(projectId: string): Promise<ListProjectWorkspacesResponse> {
        return this.#requestJson("GET", `/projects/${encodeURIComponent(projectId)}/workspaces`);
    }

    createProjectWorkspace(
        projectId: string,
        request: CreateProjectWorkspaceRequest,
    ): Promise<ProjectWorkspaceResponse> {
        return this.#requestJson(
            "POST",
            `/projects/${encodeURIComponent(projectId)}/workspaces`,
            request,
        );
    }

    renameProjectWorkspace(
        projectId: string,
        workspaceId: string,
        request: RenameProjectWorkspaceRequest,
        expectedVersion: number,
    ): Promise<ProjectWorkspaceResponse> {
        return this.#requestJson(
            "PATCH",
            `/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`,
            request,
            { "if-match": `"${String(expectedVersion)}"` },
        );
    }

    archiveProjectWorkspace(
        projectId: string,
        workspaceId: string,
        expectedVersion: number,
    ): Promise<ProjectWorkspaceResponse> {
        return this.#requestJson(
            "POST",
            `/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/archive`,
            {},
            { "if-match": `"${String(expectedVersion)}"` },
        );
    }

    reorderProjectWorkspace(
        projectId: string,
        workspaceId: string,
        request: ReorderRequest,
        expectedVersion: number,
    ): Promise<ProjectWorkspaceResponse> {
        return this.#requestJson(
            "POST",
            `/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/reorder`,
            request,
            { "if-match": `"${String(expectedVersion)}"` },
        );
    }

    reorderSession(
        sessionId: string,
        request: ReorderRequest,
    ): Promise<{ session: ProtocolSession }> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/reorder`,
            request,
        );
    }

    listSubagents(sessionId: string): Promise<ListSubagentsResponse> {
        return this.#requestJson("GET", `/sessions/${encodeURIComponent(sessionId)}/subagents`);
    }

    searchFiles(scope: ProjectScope, query: string, limit = 20): Promise<SearchFilesResponse> {
        const parameters = new URLSearchParams({
            limit: String(limit),
            query,
        });
        return this.#requestJson(
            "GET",
            `${this.#projectScopePath(scope)}/files?${parameters.toString()}`,
        );
    }

    listFilePaths(scope: ProjectScope): Promise<ListProjectFilePathsResponse> {
        return this.#requestJson("GET", `${this.#projectScopePath(scope)}/file-paths`);
    }

    listFileTree(scope: ProjectScope, request: ListFileTreeRequest): Promise<ListFileTreeResponse> {
        const parameters = new URLSearchParams({
            path: request.path,
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
        });
        return this.#requestJson(
            "GET",
            `${this.#projectScopePath(scope)}/file-tree?${parameters.toString()}`,
        );
    }

    readFile(scope: ProjectScope, path: string): Promise<ReadProjectFileResponse> {
        return this.#requestJson(
            "GET",
            `${this.#projectScopePath(scope)}/file?path=${encodeURIComponent(path)}`,
        );
    }

    readFileAtRevision(
        scope: ProjectScope,
        path: string,
        revision: string,
    ): Promise<ReadProjectFileRevisionResponse> {
        const parameters = new URLSearchParams({ path, revision });
        return this.#requestJson(
            "GET",
            `${this.#projectScopePath(scope)}/file-revision?${parameters.toString()}`,
        );
    }

    writeFile(
        scope: ProjectScope,
        request: WriteProjectFileRequest,
    ): Promise<WriteProjectFileResponse> {
        return this.#requestJson("PUT", `${this.#projectScopePath(scope)}/file`, request);
    }

    async proxyHttpRequest(
        scope: ProjectScope,
        options: ProxyHttpRequestOptions,
    ): Promise<ProxyHttpResponse> {
        const body = options.body === undefined ? undefined : Buffer.from(options.body);
        const tunnel = await this.openHttpProxy(scope);
        const agent = singleSocketAgent(tunnel);
        return new Promise((resolve, reject) => {
            const request = httpRequest(
                {
                    agent,
                    headers: {
                        ...options.headers,
                        ...(body === undefined ? {} : { "content-length": body.byteLength }),
                    },
                    method: options.method ?? "GET",
                    path: options.url,
                },
                (response) => {
                    response.once("end", () => tunnel.destroy());
                    resolve({
                        body: response,
                        headers: response.headers,
                        statusCode: response.statusCode ?? 500,
                    });
                },
            );
            request.once("error", (error) => {
                tunnel.destroy();
                reject(error);
            });
            request.end(body);
        });
    }

    async connectHttpProxy(scope: ProjectScope, authority: string): Promise<Duplex> {
        const tunnel = await this.openHttpProxy(scope);
        const agent = singleSocketAgent(tunnel);
        return new Promise((resolve, reject) => {
            const request = httpRequest({
                agent,
                method: "CONNECT",
                path: authority,
            });
            request.once("connect", (response, socket, head) => {
                if (response.statusCode !== 200) {
                    socket.destroy();
                    reject(
                        new ProtocolHttpError(
                            response.statusCode ?? 500,
                            `HTTP proxy CONNECT returned ${String(response.statusCode ?? 500)}.`,
                        ),
                    );
                    return;
                }
                if (head.length > 0) socket.unshift(head);
                resolve(socket);
            });
            request.once("response", (response) => {
                response.resume();
                tunnel.destroy();
                reject(
                    new ProtocolHttpError(
                        response.statusCode ?? 500,
                        `HTTP proxy CONNECT returned ${String(response.statusCode ?? 500)}.`,
                    ),
                );
            });
            request.once("error", (error) => {
                tunnel.destroy();
                reject(error);
            });
            request.end();
        });
    }

    openHttpProxy(scope: ProjectScope): Promise<Duplex> {
        return new Promise((resolve, reject) => {
            const request = httpRequest({
                headers: { authorization: `Bearer ${this.token}` },
                method: "CONNECT",
                path: this.#path(`${this.#projectScopePath(scope)}/proxy`),
                socketPath: this.socketPath,
            });
            request.once("connect", (response, socket, head) => {
                if (response.statusCode !== 200) {
                    socket.destroy();
                    reject(
                        new ProtocolHttpError(
                            response.statusCode ?? 500,
                            `HTTP proxy tunnel returned ${String(response.statusCode ?? 500)}.`,
                        ),
                    );
                    return;
                }
                if (head.length > 0) socket.unshift(head);
                resolve(socket);
            });
            request.once("response", (response) => {
                response.resume();
                reject(
                    new ProtocolHttpError(
                        response.statusCode ?? 500,
                        `HTTP proxy tunnel returned ${String(response.statusCode ?? 500)}.`,
                    ),
                );
            });
            request.once("error", reject);
            request.end();
        });
    }

    getSession(
        sessionId: string,
        options: { messageLimit?: number } = {},
    ): Promise<{ session: ProtocolSession }> {
        const parameters = new URLSearchParams();
        if (options.messageLimit !== undefined) {
            parameters.set("message_limit", String(options.messageLimit));
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        return this.#requestJson("GET", `/sessions/${encodeURIComponent(sessionId)}${suffix}`);
    }

    getSessionUsage(sessionId: string): Promise<GetSessionUsageResponse> {
        return this.#requestJson("GET", `/sessions/${encodeURIComponent(sessionId)}/usage`);
    }

    getCurrentProviderQuota(sessionId: string): Promise<GetCurrentProviderQuotaResponse> {
        return this.#requestJson(
            "GET",
            `/sessions/${encodeURIComponent(sessionId)}/current-provider-quota`,
        );
    }

    /** The usage Rig polls for every configured provider. */
    listProviderUsage(): Promise<ListProviderUsageResponse> {
        return this.#requestJson("GET", "/provider-usage");
    }

    getEvents(
        sessionId: string,
        after?: EventId,
        options: { messageLimit?: number } = {},
    ): Promise<{ events: SessionEvent[] }> {
        if (after !== undefined && options.messageLimit !== undefined) {
            return Promise.reject(
                new Error(
                    "A session message limit is only supported while loading initial history.",
                ),
            );
        }
        const parameters = new URLSearchParams();
        if (after !== undefined) parameters.set("after", after);
        if (options.messageLimit !== undefined) {
            parameters.set("message_limit", String(options.messageLimit));
        }
        const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
        const path = `/sessions/${encodeURIComponent(sessionId)}/events${suffix}`;
        return this.#requestJson("GET", path);
    }

    getDaemonConfig(): Promise<GetDaemonConfigResponse> {
        return this.#requestJson("GET", "/config");
    }

    getPresence(): Promise<GetPresenceResponse> {
        return this.#requestJson("GET", "/presence");
    }

    setPresence(request: SetPresenceRequestBody): Promise<SetPresenceResponse> {
        return this.#requestJson("PUT", "/presence", request);
    }

    getGlobalInstructions(): Promise<GetGlobalInstructionsResponse> {
        return this.#requestJson("GET", "/config/instructions");
    }

    getGlobalSecurityPolicy(): Promise<GetGlobalSecurityPolicyResponse> {
        return this.#requestJson("GET", "/config/security");
    }

    getGlobalEvents(after?: string, limit = 100): Promise<ListGlobalEventsResponse> {
        const parameters = new URLSearchParams({ limit: String(limit) });
        if (after !== undefined) parameters.set("after", String(after));
        return this.#requestJson("GET", `/events?${parameters.toString()}`);
    }

    reset(sessionId: string): Promise<{ session: ProtocolSession }> {
        return this.#requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/reset`);
    }

    runShellCommand(
        sessionId: string,
        request: RunShellCommandRequest,
    ): Promise<RunShellCommandResponse> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/shell`,
            request,
        );
    }

    recordSessionActivity(sessionId: string): Promise<RecordSessionActivityResponse> {
        return this.#requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/activity`);
    }

    rewind(sessionId: string, messageId: string): Promise<RewindSessionResponse> {
        return this.#requestJson("POST", `/sessions/${encodeURIComponent(sessionId)}/rewind`, {
            messageId,
        });
    }

    shutdown(): Promise<ShutdownServerResponse> {
        return this.#requestJson("POST", "/shutdown");
    }

    reloadHappy(): Promise<{ enabled: boolean }> {
        return this.#requestJson("POST", "/happy/reload");
    }

    startInspector(): Promise<StartInspectorResponse> {
        return this.#requestJson("POST", "/debug/inspector");
    }

    stopInspector(): Promise<StopInspectorResponse> {
        return this.#requestJson("DELETE", "/debug/inspector");
    }

    submitMessage(
        sessionId: string,
        request: SubmitMessageRequest,
    ): Promise<SubmitMessageResponse> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/messages`,
            request,
        );
    }

    submitContextMessage(
        sessionId: string,
        request: SubmitContextMessageRequest,
    ): Promise<SubmitContextMessageResponse> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/context`,
            request,
        );
    }

    broadcastMessage(request: BroadcastMessageRequest): Promise<BroadcastMessageResponse> {
        return this.#requestJson("POST", "/messages", request);
    }

    listExternalToolCalls(sessionId: string): Promise<{ calls: readonly ExternalToolCall[] }> {
        return this.#requestJson(
            "GET",
            `/sessions/${encodeURIComponent(sessionId)}/external-tool-calls`,
        );
    }

    listPendingExternalToolCalls(limit = 100): Promise<ListExternalToolCallsResponse> {
        return this.#requestJson("GET", `/external-tool-calls?limit=${encodeURIComponent(limit)}`);
    }

    resolveExternalToolCall(
        sessionId: string,
        callId: string,
        request: ResolveExternalToolCallRequest,
    ): Promise<ResolveExternalToolCallResponse> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/external-tool-calls/${encodeURIComponent(callId)}`,
            request,
        );
    }

    cancelScheduledMessage(
        sessionId: string,
        scheduledMessageId: string,
        mutationId?: string,
    ): Promise<CancelScheduledMessageResponse> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/scheduled-messages/${encodeURIComponent(scheduledMessageId)}/cancel`,
            undefined,
            mutationId === undefined ? {} : { "X-Rig-Mutation-Id": mutationId },
        );
    }

    stopWorkflow(sessionId: string, runId: string): Promise<StopWorkflowResponse> {
        return this.#requestJson(
            "POST",
            `/sessions/${encodeURIComponent(sessionId)}/workflows/${encodeURIComponent(runId)}/stop`,
        );
    }

    trimGlobalEvents(through: string): Promise<TrimGlobalEventsResponse> {
        return this.#requestJson("POST", "/events/trim", { through });
    }

    updateDaemonConfig(request: UpdateDaemonConfigRequest): Promise<UpdateDaemonConfigResponse> {
        return this.#requestJson("PATCH", "/config", request);
    }

    updateGlobalInstructions(
        request: UpdateGlobalInstructionsRequest,
    ): Promise<UpdateGlobalInstructionsResponse> {
        return this.#requestJson("PUT", "/config/instructions", request);
    }

    updateGlobalSecurityPolicy(
        request: UpdateGlobalSecurityPolicyRequest,
    ): Promise<UpdateGlobalSecurityPolicyResponse> {
        return this.#requestJson("PUT", "/config/security", request);
    }

    async watchSessionEvents(options: WatchSessionEventsOptions): Promise<void> {
        let after = options.after;
        while (options.signal?.aborted !== true) {
            let consumerFailed = false;
            let consumerError: unknown;
            try {
                after = await this.#watchSessionEventsOnce(after, {
                    ...options,
                    onEvent: async (event) => {
                        try {
                            await options.onEvent(event);
                        } catch (error) {
                            consumerFailed = true;
                            consumerError = error;
                            throw error;
                        }
                        after = event.id;
                    },
                });
            } catch (error) {
                if (consumerFailed) {
                    throw consumerError;
                }
                if (options.signal?.aborted) {
                    return;
                }
                if (
                    error instanceof EventStreamHttpError &&
                    error.statusCode >= 400 &&
                    error.statusCode < 500
                ) {
                    throw error;
                }
                await delay(50, options.signal);
            }
        }
    }

    async #requestJson<T>(
        method: string,
        path: string,
        body?: unknown,
        extraHeaders: Readonly<Record<string, string>> = {},
    ): Promise<T> {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers: Record<string, string | number> = {
            accept: "application/json",
            authorization: `Bearer ${this.token}`,
            ...extraHeaders,
        };
        if (payload !== undefined) {
            headers["content-length"] = Buffer.byteLength(payload);
            headers["content-type"] = "application/json; charset=utf-8";
        }

        return new Promise<T>((resolve, reject) => {
            const request = httpRequest(
                {
                    headers,
                    method,
                    path: this.#path(path),
                    socketPath: this.socketPath,
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer | string) => {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    });
                    response.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        if ((response.statusCode ?? 500) >= 400) {
                            const statusCode = response.statusCode ?? 500;
                            reject(
                                new ProtocolHttpError(
                                    statusCode,
                                    text.length > 0 ? text : `HTTP ${String(statusCode)}`,
                                ),
                            );
                            return;
                        }

                        resolve((text.length === 0 ? {} : JSON.parse(text)) as T);
                    });
                },
            );
            request.on("error", reject);
            if (payload !== undefined) {
                request.write(payload);
            }
            request.end();
        });
    }

    async #requestBytesJson<T>(
        method: string,
        path: string,
        bytes: Uint8Array,
        extraHeaders: Readonly<Record<string, string>>,
    ): Promise<T> {
        const payload = Buffer.from(bytes);
        return await new Promise<T>((resolve, reject) => {
            const request = httpRequest(
                {
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${this.token}`,
                        "content-length": payload.byteLength,
                        ...extraHeaders,
                    },
                    method,
                    path: this.#path(path),
                    socketPath: this.socketPath,
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk: Buffer | string) => {
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    });
                    response.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        const statusCode = response.statusCode ?? 500;
                        if (statusCode >= 400) {
                            reject(
                                new ProtocolHttpError(
                                    statusCode,
                                    text.length > 0 ? text : `HTTP ${String(statusCode)}`,
                                ),
                            );
                            return;
                        }
                        resolve((text.length === 0 ? {} : JSON.parse(text)) as T);
                    });
                },
            );
            request.on("error", reject);
            request.end(payload);
        });
    }

    #watchSessionEventsOnce(
        after: EventId | undefined,
        options: WatchSessionEventsOptions,
    ): Promise<EventId | undefined> {
        return new Promise<EventId | undefined>((resolve, reject) => {
            let application = Promise.resolve();
            let cursor = after;
            let terminalScheduled = false;
            const settle = (error?: unknown) => {
                if (terminalScheduled) return;
                terminalScheduled = true;
                void application.then(
                    () => (error === undefined ? resolve(cursor) : reject(error)),
                    reject,
                );
            };
            const requestPath =
                after === undefined
                    ? `/sessions/${encodeURIComponent(options.sessionId)}/stream`
                    : `/sessions/${encodeURIComponent(options.sessionId)}/stream?after=${encodeURIComponent(after)}`;
            const request = httpRequest(
                {
                    headers: {
                        accept: "text/event-stream",
                        authorization: `Bearer ${this.token}`,
                    },
                    method: "GET",
                    path: this.#path(requestPath),
                    socketPath: this.socketPath,
                },
                (response) => {
                    if ((response.statusCode ?? 500) >= 400) {
                        reject(new EventStreamHttpError(response.statusCode ?? 500));
                        response.resume();
                        return;
                    }

                    let buffer = "";
                    response.setEncoding("utf8");
                    response.on("data", (chunk: string) => {
                        if (terminalScheduled) return;
                        response.pause();
                        buffer += chunk;
                        for (;;) {
                            const boundary = buffer.indexOf("\n\n");
                            if (boundary < 0) {
                                break;
                            }
                            const rawEvent = buffer.slice(0, boundary);
                            buffer = buffer.slice(boundary + 2);
                            const frame = parseSseFrame(rawEvent);
                            if (frame === undefined) {
                                continue;
                            }
                            // The opening frame describes current state rather
                            // than a logged event, so it never advances the
                            // cursor a reconnect resumes from.
                            if (frame.name === "hello") {
                                const hello = frame.data as SessionStreamHello;
                                application = application.then(() => options.onHello?.(hello));
                                void application.catch((error: unknown) => {
                                    response.destroy();
                                    settle(error);
                                });
                                continue;
                            }
                            const event = frame.data as SessionEvent;
                            application = application.then(async () => {
                                await waitForGymSessionEventBarrier(event, options.signal);
                                await options.onEvent(event);
                                cursor = event.id;
                            });
                            void application.catch((error: unknown) => {
                                response.destroy();
                                settle(error);
                            });
                        }
                        const accepted = application;
                        void accepted.then(
                            () => {
                                if (!terminalScheduled) response.resume();
                            },
                            (error: unknown) => {
                                response.destroy();
                                settle(error);
                            },
                        );
                    });
                    response.on("end", () => settle());
                    response.on("error", settle);
                },
            );
            const abort = () => {
                settle();
                request.destroy();
            };
            options.signal?.addEventListener("abort", abort, { once: true });
            request.on("error", settle);
            request.end();
        });
    }

    #projectScopePath(scope: ProjectScope): string {
        const project = `/projects/${encodeURIComponent(scope.projectId)}`;
        return scope.workspaceId === undefined
            ? project
            : `${project}/workspaces/${encodeURIComponent(scope.workspaceId)}`;
    }

    #path(path: string): string {
        return `${this.#pathPrefix}${path}`;
    }

    #remoteTerminalCollectionPath(scope: ProjectScope): string {
        return `${this.#projectScopePath(scope)}/terminals`;
    }

    #remoteTerminalPath(scope: ProjectScope, terminalId: string): string {
        return `${this.#remoteTerminalCollectionPath(scope)}/${encodeURIComponent(terminalId)}`;
    }
}

function normalizePathPrefix(pathPrefix: string | undefined): string {
    if (pathPrefix === undefined || pathPrefix === "" || pathPrefix === "/") return "";
    if (
        !pathPrefix.startsWith("/") ||
        pathPrefix.includes("?") ||
        pathPrefix.includes("#") ||
        hasControlCharacter(pathPrefix)
    ) {
        throw new Error("A protocol HTTP path prefix must be an absolute URL path.");
    }
    return pathPrefix.endsWith("/") ? pathPrefix.slice(0, -1) : pathPrefix;
}

function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

function singleSocketAgent(socket: Duplex): Agent {
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => socket as import("node:net").Socket;
    return agent;
}

/** One parsed SSE frame, keeping the event name so callers can tell frames apart. */
function parseSseFrame(raw: string): { data: unknown; name: string | undefined } | undefined {
    if (raw.startsWith(":")) {
        return undefined;
    }

    const lines = raw.split("\n");
    const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) {
        return undefined;
    }
    const name = lines
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim();

    return { data: JSON.parse(dataLines.join("\n")), name };
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted === true) {
            resolve();
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}
