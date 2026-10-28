import type { Cuid2, MessageMode } from "./protocol/common.js";
import { Value } from "@sinclair/typebox/value";
import {
    connectionIdSchema,
    type ConnectionListResponse,
    type ReorderConnectionRequest,
    type ReorderConnectionResponse,
} from "./protocol/connections.js";
import type { RunnerListResponse } from "./protocol/runners.js";
import type {
    ArtifactFileContent,
    ArtifactFileRequestOptions,
    ArtifactFileUpload,
    BinaryContent,
    BinaryData,
    ByteRange,
    ConditionalRequestOptions,
    ImageUpload,
    OptionallyVersionedRequestOptions,
    RequestOptions,
    ToolCallMediaContent,
    ToolCallMediaRequestOptions,
    VersionedRequestOptions,
} from "./requestOptions.js";
import type {
    AbortAgentRequest,
    AgentAbortResponse,
    AgentActivityResponse,
    AgentCompactResponse,
    AgentDraftResponse,
    AgentModeResponse,
    AgentResponse,
    CreateAgentRequest,
    FailureResolutionResponse,
    MutationOnlyRequest,
    ReorderAgentRequest,
    ReorderSubtaskRequest,
    RetryFailedTurnRequest,
    SaveAgentDraftRequest,
    SwitchAndContinueRequest,
} from "./protocol/agents.js";
import {
    authenticationMethodSchema,
    type AuthenticationResponse,
} from "./protocol/authentication.js";
import type {
    ArtifactListQuery,
    ArtifactListResponse,
    ArtifactPath,
    ArtifactResponse,
    ArtifactUploadResponse,
    ArtifactVersionListQuery,
    ArtifactVersionListResponse,
    ArtifactVersionResponse,
    ArtifactVersionSelector,
    CreateArtifactRequest,
    DeleteArtifactRequest,
    UpdateArtifactRequest,
} from "./protocol/artifacts.js";
import type { AgentBootstrapResponse, DesktopBootstrapResponse } from "./protocol/bootstrap.js";
import type {
    ArchiveBotRequest,
    BotListResponse,
    BotResponse,
    CreateBotRequest,
    RenameBotRequest,
    ReorderBotRequest,
    UnarchiveBotRequest,
} from "./protocol/bots.js";
import type {
    ArchiveTaskRequest,
    CreateTaskRequest,
    JoinTaskRequest,
    LeaveTaskRequest,
    RenameTaskRequest,
    ReorderTaskRequest,
    TaskListResponse,
    TaskListScope,
    TaskResponse,
    UnarchiveTaskRequest,
} from "./protocol/tasks.js";
import type {
    AcceptSpaceSidebarProposalRequest,
    AcceptSpaceSidebarProposalResponse,
    CreateStemCellRequest,
    CreateStemCellResponse,
    DeclineSpaceSidebarProposalRequest,
    DeclineSpaceSidebarProposalResponse,
    SpaceAttentionRequest,
    SpaceAttentionResponse,
    SpaceBatchListResponse,
    SpaceListResponse,
    SpaceResponse,
    SpaceSectionResponse,
    SpaceSidebarOperationsRequest,
    SpaceSidebarOperationsResponse,
    SpaceSidebarProposalResponse,
    SpaceSidebarResponse,
    UpdateSpaceSidebarRequest,
    UpdateSpaceRequest,
    UpdateSpaceSectionRequest,
} from "./protocol/spaces.js";
import type {
    CreateSurfaceRequest,
    CreateTodoRequest,
    CalendarEventMutationRequest,
    CalendarEventResponse,
    CalendarEventVersionListResponse,
    CalendarEventVersionResponse,
    CalendarRangeResponse,
    SystemMonitorSnapshot,
    CreateCalendarEventRequest,
    EditSurfaceMessageRequest,
    SendSurfaceMessageRequest,
    SurfaceMessageMutationRequest,
    SurfaceMessagePageResponse,
    SurfaceMessageResponse,
    SurfaceMessageVersionListResponse,
    SurfaceMessageVersionResponse,
    UpdateCalendarEventRequest,
    EnsureSurfaceChatRequest,
    ReorderSurfaceRequest,
    ReorderTodoRequest,
    UpdateSurfaceRequest,
    SurfaceId,
    SurfaceListResponse,
    SurfaceMemberRequest,
    SurfaceResponse,
    SurfaceChatResponse,
    SendSurfaceDocumentPresenceRequest,
    SendSurfaceDocumentUpdateRequest,
    SurfaceDocumentChangeListResponse,
    SurfaceDocumentSeqResponse,
    SurfaceDocumentSnapshotResponse,
    SurfaceDocumentStateResponse,
    SurfaceDocumentSubscriptionRequest,
    SurfaceDocumentVersionListResponse,
    SurfaceDocumentVersionResponse,
    TodoListResponse,
    TodoListScope,
    TodoMutationRequest,
    TodoResponse,
    TodoVersionListResponse,
    TodoVersionResponse,
    UpdateTodoRequest,
} from "./protocol/surfaces.js";
import type {
    CloudAccessTokenResponse,
    CloudAuthorizingResponse,
    CloudConnectedResponse,
    CloudDisconnectedResponse,
    CloudMutationRequest,
    CloudOrganizationsResponse,
    CloudResponse,
    CompleteCloudAuthorizationRequest,
    CreateCloudOrganizationRequest,
    CreateCloudOrganizationResponse,
    DeleteCloudOrganizationResponse,
    StartCloudAuthorizationRequest,
} from "./protocol/cloud.js";
import type {
    ConfigPatch,
    ConfigResponse,
    DrainRequest,
    DrainResponse,
    GreetingResponse,
    HealthResponse,
    InspectorStartedResponse,
    InspectorStoppedResponse,
    InstructionsResponse,
    OnboardingCompletedResponse,
    OnboardingState,
    ProviderScanResponse,
    ProviderVerificationRequest,
    ProviderVerificationResponse,
    SecurityPolicyResponse,
    ShutdownResponse,
} from "./protocol/daemon.js";
import type {
    ProviderRouteUseRequest,
    ProviderRouteUseResponse,
    ProviderRoutesResponse,
} from "./protocol/providerRoutes.js";
import type {
    EventPageQuery,
    EventPageResponse,
    EventStreamFrame,
    EventStreamOptions,
} from "./protocol/events.js";
import type {
    FileContentResponse,
    FileRevisionQuery,
    FileRevisionResponse,
    FileSearchQuery,
    FileSearchResponse,
    FileTreeQuery,
    FileTreeResponse,
    WriteFileRequest,
    WriteFileResponse,
} from "./protocol/files.js";
import type { GitStateResponse, WatchGitRequest, WatchGitResponse } from "./protocol/git.js";
import type { HappyIntegrationResponse } from "./protocol/integrations.js";
import type {
    CloseLiveSessionRequest,
    CreateLiveSessionRequest,
    CreateLiveSessionResponse,
    LiveSessionResponse,
} from "./protocol/live.js";
import type {
    MessageHistoryQuery,
    MessageHistoryResponse,
    SendMessageRequest,
    SendMessageResponse,
} from "./protocol/messages.js";
import type { BackgroundProcessResponse } from "./protocol/processes.js";
import type { ProfileResponse, ProfileUpdateRequest } from "./protocol/profile.js";
import { userIdsSchema, type UsersResponse } from "./protocol/users.js";
import {
    userSettingKeySchema,
    type SaveUserSettingRequest,
    type UserSettingKey,
    type UserSettingResponse,
    type UserSettingsResponse,
} from "./protocol/userSettings.js";
import type {
    StickerId,
    StickerPackId,
    StickerPackResponse,
    StickerPacksResponse,
    StickerRecentsResponse,
    StickerSearchQuery,
    StickerSearchResponse,
    UseStickerRequest,
} from "./protocol/stickers.js";
import type {
    CreateStoryRequest,
    PostStoryRequest,
    RepostStoryRequest,
    SetStoryReactionRequest,
    StoriesQuery,
    StoriesResponse,
    StoryFeedbackRequest,
    StoryFeedbackResponse,
    StoryFeedResponse,
    StoryMediaQuery,
    StoryMediaResponse,
    StoryResponse,
    StoryViewersQuery,
    StoryViewersResponse,
    UpdateStoryRequest,
} from "./protocol/stories.js";
import type { MobileConnectorResponse } from "./protocol/mobileConnector.js";
import type {
    ArchiveProjectRequest,
    CloneProjectRequest,
    ProjectListResponse,
    ProjectResponse,
    ProjectSettingsResponse,
    RegisterProjectRequest,
    RenameProjectRequest,
    ReorderProjectRequest,
    ReplaceProjectSettingsRequest,
} from "./protocol/projects.js";
import type {
    AnswerQuestionRequest,
    PendingQuestionResponse,
    QuestionResponse,
} from "./protocol/questions.js";
import type {
    CreateSecretRequest,
    DeleteSecretRequest,
    SecretAttachmentListQuery,
    SecretAttachmentListResponse,
    SecretAttachmentMutationRequest,
    SecretAttachmentTarget,
    SecretAttachResponse,
    SecretAttachResult,
    SecretDetachResponse,
    SecretListQuery,
    SecretListResponse,
    SecretResponse,
    UpdateSecretRequest,
} from "./protocol/secrets.js";
import type {
    OpenTerminalRequest,
    ResizeTerminalRequest,
    TerminalListResponse,
    TerminalResponse,
} from "./protocol/terminals.js";
import type {
    AgentUsageResponse,
    DaemonUsageResponse,
    ProviderUsageRefreshRequest,
    ProviderUsageRefreshResponse,
} from "./protocol/usage.js";
import type {
    StopWorkspaceServiceRequest,
    WorkspaceServiceAccessTokenResponse,
    WorkspaceServiceInputRequest,
    WorkspaceServiceInputResponse,
    WorkspaceServiceListQuery,
    WorkspaceServiceListResponse,
    WorkspaceServiceResponse,
} from "./protocol/services.js";
import type {
    CloseWorkspaceBridgeRequest,
    WorkspaceBridgeListResponse,
    WorkspaceBridgeResponse,
    WorkspacePortBridgeQuery,
    WorkspaceUsbBridgeQuery,
} from "./protocol/bridges.js";
import type {
    InvokeSlashCommandRequest,
    InvokeSlashCommandResponse,
} from "./protocol/slashCommands.js";
import {
    networkIdSchema,
    type ArchiveWorkspaceRequest,
    type CreateWorkspaceRequest,
    type ListWorkspacesQuery,
    type RenameWorkspaceRequest,
    type ReorderWorkspaceRequest,
    type WorkspaceAgentNetworkResponse,
    type WorkspaceListResponse,
    type WorkspaceResponse,
} from "./protocol/workspaces.js";
import type { QueryParameters } from "./endpointUrl.js";
import type {
    GlobalSkillDocumentResponse,
    GlobalSkillFileListResponse,
    GlobalSkillListResponse,
    GlobalSkillResponse,
    SkillPageQuery,
    UpdateGlobalSkillRequest,
} from "./protocol/skills.js";
import { endpointUrl } from "./endpointUrl.js";
import { readApiError } from "./HappyAgentApiError.js";
import { EventStreamProtocolError, readEventStream } from "./readEventStream.js";
import {
    reconnectingUpdates,
    type HappyAgentUpdate,
    type HappyAgentUpdatesOptions,
} from "./updates.js";

/** What the client needs to reach a daemon. */
export interface HappyAgentClientOptions {
    /**
     * Where the daemon answers.
     *
     * The daemon serves HTTP over a Unix domain socket and ignores the `Host`
     * header, so the authority is whatever the transport needs; only the path
     * and query matter. A path prefix here is preserved and every route is
     * resolved beneath it.
     */
    endpoint: string | URL;
    /**
     * The bearer token; every route except authentication discovery requires one.
     *
     * A function is called for every request, so a refreshed token takes effect
     * without a new client. Omit it only to call `getAuthentication()` before
     * signing in.
     */
    token?: string | (() => string | Promise<string>) | undefined;
    /**
     * The `fetch` to make requests with. Defaults to the global one.
     *
     * A caller reaching a Unix socket supplies its own runtime's `fetch` here;
     * nothing else in this package knows how the bytes travel.
     */
    fetch?: typeof globalThis.fetch;
}

/** One request, before it becomes a `fetch` call. */
interface HttpRequest {
    method: string;
    path: string;
    query?: QueryParameters;
    /** A JSON body. */
    json?: unknown;
    /** A binary body, for the picture and artifact upload routes. */
    binary?: { contentType: string; data: BinaryData };
    accept?: string;
    /** A `Range` header, for artifact files. */
    range?: string | undefined;
    ifMatch?: string | undefined;
    ifNoneMatch?: string | undefined;
    lastEventId?: string | undefined;
    signal?: AbortSignal | undefined;
    /** `304` is an answer rather than a failure on the conditional picture routes. */
    allowNotModified?: boolean;
}

/**
 * A thin, faithful client for the Happy agent HTTP API.
 *
 * Every request-response route of `packages/happy-agent/API.md` is one method,
 * and the event journal is available both as pages and as the live stream. The
 * low-level request and stream methods keep no application state. The
 * higher-level `updates` feed owns only its accepted event cursor and
 * connection state so it can resume after transport interruptions.
 *
 * It is built on `fetch`, streams, `AbortController`, and standard timers
 * alone, so one build runs unchanged in Node and in a browser. Nothing is
 * validated at runtime; the types are a promise about what the specification
 * says the daemon sends.
 */
export class HappyAgentClient {
    readonly #endpoint: string;
    readonly #token: HappyAgentClientOptions["token"];
    readonly #fetch: typeof globalThis.fetch;

    constructor(options: HappyAgentClientOptions) {
        this.#endpoint = options.endpoint.toString();
        this.#token = options.token;
        this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    }

    /** Where this client talks, as it was given. */
    get endpoint(): string {
        return this.#endpoint;
    }

    /** `GET /v0/connections` — the main daemon's configured remote roster. */
    async listConnections(options: RequestOptions = {}): Promise<ConnectionListResponse> {
        return await this.#json({ method: "GET", path: "v0/connections", signal: options.signal });
    }

    /** `GET /v0/runners` — the configured runners; older daemons answer `404`. */
    async listRunners(options: RequestOptions = {}): Promise<RunnerListResponse> {
        return await this.#json({ method: "GET", path: "v0/runners", signal: options.signal });
    }

    /** `POST /v0/connections/:id/reorder` — guarded by the complete roster's version. */
    async reorderConnection(
        id: string,
        request: ReorderConnectionRequest,
        options: VersionedRequestOptions,
    ): Promise<ReorderConnectionResponse> {
        if (!Value.Check(connectionIdSchema, id)) {
            throw new Error("The remote connection ID is invalid.");
        }
        return await this.#json({
            method: "POST",
            path: `v0/connections/${id}/reorder`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** A separate client for a remote daemon, using the main daemon's authenticated proxy. */
    connection(id: string): HappyAgentClient {
        if (!Value.Check(connectionIdSchema, id)) {
            throw new Error("The remote connection ID is invalid.");
        }
        return new HappyAgentClient({
            endpoint: endpointUrl(this.#endpoint, `v0/connections/${id}/api/`),
            token: this.#token,
            fetch: this.#fetch,
        });
    }

    // The daemon

    /** `GET /v0/node/avatar` — authenticated image bytes; `null` when unchanged. */
    async getNodeAvatar(options: ConditionalRequestOptions = {}): Promise<BinaryContent | null> {
        return await this.#binary({
            method: "GET",
            path: "v0/node/avatar",
            ifNoneMatch: options.ifNoneMatch,
            signal: options.signal,
        });
    }

    /** `GET /` — a greeting confirming the caller reached a Happy agent. */
    async getGreeting(options: RequestOptions = {}): Promise<GreetingResponse> {
        return await this.#json({ method: "GET", path: "", signal: options.signal });
    }

    /**
     * `GET /v0/health` — whether the daemon is alive and ready to serve.
     *
     * The only route guaranteed to answer during startup; a client polls it
     * until `ready` is `true` before using the rest of the API.
     */
    async getHealth(options: RequestOptions = {}): Promise<HealthResponse> {
        return await this.#json({ method: "GET", path: "v0/health", signal: options.signal });
    }

    /**
     * `GET /v0/authentication` — whether this client is signed in, and how to sign in.
     *
     * Needs no token. Sign in with an `oauth` method through `beginOAuthSignIn`,
     * which talks to the authorization server rather than this daemon.
     */
    async getAuthentication(options: RequestOptions = {}): Promise<AuthenticationResponse> {
        const response = await this.#json<AuthenticationResponse>({
            method: "GET",
            path: "v0/authentication",
            signal: options.signal,
        });
        // Methods this client does not recognize are skipped rather than mistyped.
        return {
            ...response,
            methods: response.methods.filter((method) =>
                Value.Check(authenticationMethodSchema, method),
            ),
        };
    }

    /** `GET /v0/config` — the sanitized effective configuration. */
    async getConfig(options: RequestOptions = {}): Promise<ConfigResponse> {
        return await this.#json({ method: "GET", path: "v0/config", signal: options.signal });
    }

    /**
     * `PATCH /v0/config` — requests a runtime settings change.
     *
     * A daemon that cannot reconfigure itself at runtime answers `409`.
     */
    async patchConfig(patch: ConfigPatch, options: RequestOptions = {}): Promise<ConfigResponse> {
        return await this.#json({
            method: "PATCH",
            path: "v0/config",
            json: patch,
            signal: options.signal,
        });
    }

    /** `POST /v0/providers/scan` — runs or joins bounded local credential discovery. */
    async scanProviders(options: RequestOptions = {}): Promise<ProviderScanResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/providers/scan",
            signal: options.signal,
        });
    }

    /** `POST /v0/providers/:providerId/verify` — checks credentials, auth, or inference. */
    async verifyProvider(
        providerId: string,
        request: ProviderVerificationRequest,
        options: RequestOptions = {},
    ): Promise<ProviderVerificationResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/providers/${encodeURIComponent(providerId)}/verify`,
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/provider-routes` — detects every way this machine can already reach models. */
    async listProviderRoutes(options: RequestOptions = {}): Promise<ProviderRoutesResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/provider-routes",
            signal: options.signal,
        });
    }

    /** `POST /v0/provider-routes/:routeId/use` — sets one route up as its `use` describes. */
    async useProviderRoute(
        routeId: string,
        request: ProviderRouteUseRequest = {},
        options: RequestOptions = {},
    ): Promise<ProviderRouteUseResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/provider-routes/${encodeURIComponent(routeId)}/use`,
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/config/instructions` — the global instructions document. */
    async getInstructions(options: RequestOptions = {}): Promise<InstructionsResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/config/instructions",
            signal: options.signal,
        });
    }

    /** `PUT /v0/config/instructions` — replaces it; the maximum size is 256 KB. */
    async putInstructions(
        instructions: string,
        options: RequestOptions = {},
    ): Promise<InstructionsResponse> {
        return await this.#json({
            method: "PUT",
            path: "v0/config/instructions",
            json: { instructions },
            signal: options.signal,
        });
    }

    /** `GET /v0/config/security` — the security policy document. */
    async getSecurityPolicy(options: RequestOptions = {}): Promise<SecurityPolicyResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/config/security",
            signal: options.signal,
        });
    }

    /** `PUT /v0/config/security` — replaces it; the maximum size is 32 KB. */
    async putSecurityPolicy(
        policy: string,
        options: RequestOptions = {},
    ): Promise<SecurityPolicyResponse> {
        return await this.#json({
            method: "PUT",
            path: "v0/config/security",
            json: { policy },
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/drain` — permanently enters this daemon process's read-only drain mode. The
     * intent, cause, and target version tell every client whether a replacement is coming; with
     * none of them the daemon records a shutdown requested through the API.
     */
    async drain(options: RequestOptions & DrainRequest = {}): Promise<DrainResponse> {
        const { signal, ...request } = options;
        return await this.#json({
            method: "POST",
            path: "v0/drain",
            ...(Object.keys(request).length === 0 ? {} : { json: request }),
            signal,
        });
    }

    /** `POST /v0/shutdown` — asks the daemon to shut down; it answers first. */
    async shutdown(options: RequestOptions = {}): Promise<ShutdownResponse> {
        return await this.#json({ method: "POST", path: "v0/shutdown", signal: options.signal });
    }

    /** `POST /v0/debug/inspector` — starts the Node.js inspector on the daemon. */
    async startInspector(options: RequestOptions = {}): Promise<InspectorStartedResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/debug/inspector",
            signal: options.signal,
        });
    }

    /** `DELETE /v0/debug/inspector` — stops it. */
    async stopInspector(options: RequestOptions = {}): Promise<InspectorStoppedResponse> {
        return await this.#json({
            method: "DELETE",
            path: "v0/debug/inspector",
            signal: options.signal,
        });
    }

    // Cloud

    /** `GET /v0/cloud` — current Happy Cloud authentication state. */
    async getCloud(options: RequestOptions = {}): Promise<CloudResponse> {
        return await this.#json({ method: "GET", path: "v0/cloud", signal: options.signal });
    }

    /** `POST /v0/cloud/auth/start` — starts or joins WorkOS PKCE authorization. */
    async startCloudAuthorization(
        request: StartCloudAuthorizationRequest,
        options: RequestOptions = {},
    ): Promise<CloudAuthorizingResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/cloud/auth/start",
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/cloud/auth/complete` — exchanges and verifies the WorkOS callback. */
    async completeCloudAuthorization(
        request: CompleteCloudAuthorizationRequest,
        options: RequestOptions = {},
    ): Promise<CloudConnectedResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/cloud/auth/complete",
            json: request,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/cloud/auth` — removes daemon-owned Cloud credentials. */
    async disconnectCloud(
        request: CloudMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<CloudDisconnectedResponse> {
        return await this.#json({
            method: "DELETE",
            path: "v0/cloud/auth",
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/cloud/access-token` — refreshes, verifies, and returns one access token. */
    async mintCloudAccessToken(
        request: CloudMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<CloudAccessTokenResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/cloud/access-token",
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/cloud/organizations` — lists the connected user's WorkOS organizations. */
    async listCloudOrganizations(
        options: RequestOptions = {},
    ): Promise<CloudOrganizationsResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/cloud/organizations",
            signal: options.signal,
        });
    }

    /** `POST /v0/cloud/organizations` — creates a WorkOS organization for the Cloud user. */
    async createCloudOrganization(
        request: CreateCloudOrganizationRequest,
        options: RequestOptions = {},
    ): Promise<CreateCloudOrganizationResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/cloud/organizations",
            json: request,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/cloud/organizations/:id` — deletes an administered organization. */
    async deleteCloudOrganization(
        organizationId: string,
        request: CloudMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<DeleteCloudOrganizationResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/cloud/organizations/${encodeURIComponent(organizationId)}`,
            json: request,
            signal: options.signal,
        });
    }

    // Happy integration

    /** `GET /v0/integrations/happy` — current Happy mobile connection state. */
    async getHappyIntegration(options: RequestOptions = {}): Promise<HappyIntegrationResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/integrations/happy",
            signal: options.signal,
        });
    }

    /** `POST /v0/integrations/happy/start` — starts or joins pairing or connection. */
    async startHappyIntegration(options: RequestOptions = {}): Promise<HappyIntegrationResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/integrations/happy/start",
            signal: options.signal,
        });
    }

    /** `POST /v0/integrations/happy/cancel` — cancels active pairing. */
    async cancelHappyIntegration(options: RequestOptions = {}): Promise<HappyIntegrationResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/integrations/happy/cancel",
            signal: options.signal,
        });
    }

    /** `DELETE /v0/integrations/happy` — unlinks this daemon from Happy. */
    async disconnectHappyIntegration(
        options: RequestOptions = {},
    ): Promise<HappyIntegrationResponse> {
        return await this.#json({
            method: "DELETE",
            path: "v0/integrations/happy",
            signal: options.signal,
        });
    }

    /** `POST /v0/integrations/happy/re-pair` — unlinks and starts fresh pairing. */
    async rePairHappyIntegration(options: RequestOptions = {}): Promise<HappyIntegrationResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/integrations/happy/re-pair",
            signal: options.signal,
        });
    }

    // Secrets

    /** `GET /v0/secrets` — global safe metadata, optionally for one direct target. */
    async listSecrets(
        query: SecretListQuery = {},
        options: RequestOptions = {},
    ): Promise<SecretListResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/secrets",
            query: {
                cursor: query.cursor,
                limit: query.limit,
                ...("targetType" in query
                    ? { targetId: query.targetId, targetType: query.targetType }
                    : {}),
            },
            signal: options.signal,
        });
    }

    /** `GET /v0/secrets/:secretId` — safe metadata only. */
    async getSecret(secretId: Cuid2, options: RequestOptions = {}): Promise<SecretResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/secrets/${encodeURIComponent(secretId)}`,
            signal: options.signal,
        });
    }

    /** `POST /v0/secrets` — stores a write-only environment bundle without attaching it. */
    async createSecret(
        request: CreateSecretRequest,
        options: RequestOptions = {},
    ): Promise<SecretResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/secrets",
            json: request,
            signal: options.signal,
        });
    }

    /** `PATCH /v0/secrets/:secretId` — updates metadata or write-only values. */
    async updateSecret(
        secretId: Cuid2,
        request: UpdateSecretRequest,
        options: VersionedRequestOptions,
    ): Promise<SecretResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/secrets/${encodeURIComponent(secretId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /**
     * `DELETE /v0/secrets/:secretId` — removes a user-created secret and every direct grant in one
     * change. The response carries the deleted secret's final safe metadata.
     */
    async deleteSecret(
        secretId: Cuid2,
        request: DeleteSecretRequest = {},
        options: VersionedRequestOptions,
    ): Promise<SecretResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/secrets/${encodeURIComponent(secretId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `GET /v0/secrets/:secretId/attachments` — direct grants only. */
    async listSecretAttachments(
        secretId: Cuid2,
        query: SecretAttachmentListQuery = {},
        options: RequestOptions = {},
    ): Promise<SecretAttachmentListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/secrets/${encodeURIComponent(secretId)}/attachments`,
            query: { cursor: query.cursor, limit: query.limit },
            signal: options.signal,
        });
    }

    /** Attaches one secret directly to a project, workspace, or exact agent. */
    async attachSecret(
        secretId: Cuid2,
        target: SecretAttachmentTarget,
        request: SecretAttachmentMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<SecretAttachResult> {
        return await this.#jsonWithStatus<SecretAttachResponse, 200 | 201>({
            method: "PUT",
            path: secretAttachmentPath(secretId, target),
            json: request,
            signal: options.signal,
        });
    }

    /** Detaches one exact direct grant; inherited access is unaffected. */
    async detachSecret(
        secretId: Cuid2,
        target: SecretAttachmentTarget,
        request: SecretAttachmentMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<SecretDetachResponse> {
        return await this.#json({
            method: "DELETE",
            path: secretAttachmentPath(secretId, target),
            json: request,
            signal: options.signal,
        });
    }

    // Global skills

    /** `GET /v0/skills` — installed global skills, including disabled and broken records. */
    async listGlobalSkills(
        query: SkillPageQuery = {},
        options: RequestOptions = {},
    ): Promise<GlobalSkillListResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/skills",
            query,
            signal: options.signal,
        });
    }

    /** `GET /v0/skills/:skillId` — the summary, original document, and parsed Markdown body. */
    async getGlobalSkill(
        skillId: Cuid2,
        options: RequestOptions = {},
    ): Promise<GlobalSkillDocumentResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/skills/${encodeURIComponent(skillId)}`,
            signal: options.signal,
        });
    }

    /** `PATCH /v0/skills/:skillId` — enable or disable without modifying installed files. */
    async updateGlobalSkill(
        skillId: Cuid2,
        request: UpdateGlobalSkillRequest,
        options: VersionedRequestOptions,
    ): Promise<GlobalSkillResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/skills/${encodeURIComponent(skillId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `GET /v0/skills/:skillId/files` — one version-bound page of supporting files. */
    async listGlobalSkillFiles(
        skillId: Cuid2,
        query: SkillPageQuery = {},
        options: RequestOptions = {},
    ): Promise<GlobalSkillFileListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/skills/${encodeURIComponent(skillId)}/files`,
            query,
            signal: options.signal,
        });
    }

    /** `GET /v0/skills/:skillId/file` — original file bytes, including for disabled skills. */
    async readGlobalSkillFile(
        skillId: Cuid2,
        path: string,
        options: RequestOptions = {},
    ): Promise<BinaryContent> {
        const response = await this.#send({
            method: "GET",
            path: `v0/skills/${encodeURIComponent(skillId)}/file`,
            query: { path },
            accept: "application/octet-stream",
            signal: options.signal,
        });
        return {
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
            data: await response.arrayBuffer(),
            etag: response.headers.get("etag"),
        };
    }

    // Profile

    /**
     * `GET /v0/users` — resolve up to 100 local user IDs to public display information: team
     * members and guests in team mode, guests in standalone mode.
     */
    async getUsers(ids: readonly Cuid2[], options: RequestOptions = {}): Promise<UsersResponse> {
        if (!Value.Check(userIdsSchema, ids)) {
            throw new Error("Provide at most 100 valid Happy user IDs.");
        }
        return await this.#json({
            method: "GET",
            path: "v0/users",
            query: { ids: ids.join(",") },
            signal: options.signal,
        });
    }

    /** `GET /v0/profile` — always succeeds; an untouched profile is all `null`. */
    async getProfile(options: RequestOptions = {}): Promise<ProfileResponse> {
        return await this.#json({ method: "GET", path: "v0/profile", signal: options.signal });
    }

    /** `PATCH /v0/profile` — a partial update; a field set to `null` is cleared. */
    async updateProfile(
        request: ProfileUpdateRequest,
        options: VersionedRequestOptions,
    ): Promise<ProfileResponse> {
        return await this.#json({
            method: "PATCH",
            path: "v0/profile",
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `GET /v0/users/:userId/photo` — a user's photo bytes; `null` when unchanged. */
    async getUserPhoto(
        userId: Cuid2,
        options: ConditionalRequestOptions = {},
    ): Promise<BinaryContent | null> {
        return await this.#binary({
            method: "GET",
            path: `v0/users/${encodeURIComponent(userId)}/photo`,
            ifNoneMatch: options.ifNoneMatch,
            signal: options.signal,
        });
    }

    /** `GET /v0/profile/photo` — the photo bytes; `null` when unchanged. */
    async getProfilePhoto(options: ConditionalRequestOptions = {}): Promise<BinaryContent | null> {
        return await this.#binary({
            method: "GET",
            path: "v0/profile/photo",
            ifNoneMatch: options.ifNoneMatch,
            signal: options.signal,
        });
    }

    /** `PUT /v0/profile/photo` — the daemon computes the ThumbHash. */
    async setProfilePhoto(
        image: ImageUpload,
        options: OptionallyVersionedRequestOptions = {},
    ): Promise<ProfileResponse> {
        return await this.#json({
            method: "PUT",
            path: "v0/profile/photo",
            binary: image,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/profile/photo` */
    async deleteProfilePhoto(
        options: OptionallyVersionedRequestOptions = {},
    ): Promise<ProfileResponse> {
        return await this.#json({
            method: "DELETE",
            path: "v0/profile/photo",
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    // User settings

    /**
     * `GET /v0/user-settings` — the caller's own settings, clears included, and the cursor to
     * follow `user_settings.updated` from. Older daemons answer `404`.
     */
    async getUserSettings(options: RequestOptions = {}): Promise<UserSettingsResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/user-settings",
            signal: options.signal,
        });
    }

    /** `GET /v0/user-settings/:key` — one setting; a key holding nothing is unset, never `404`. */
    async getUserSetting(
        key: UserSettingKey,
        options: RequestOptions = {},
    ): Promise<UserSettingResponse> {
        return await this.#json({
            method: "GET",
            path: userSettingPath(key),
            signal: options.signal,
        });
    }

    /**
     * `PUT /v0/user-settings/:key` — sets a value, or clears it with `value: null`. Last-write-wins
     * by `updatedAt`: the response is the authoritative entry, unchanged when the write was stale.
     */
    async saveUserSetting(
        key: UserSettingKey,
        request: SaveUserSettingRequest,
        options: RequestOptions = {},
    ): Promise<UserSettingResponse> {
        return await this.#json({
            method: "PUT",
            path: userSettingPath(key),
            json: request,
            signal: options.signal,
        });
    }

    // Stories

    /**
     * `GET /v0/stories/feed` — the stories row: the caller's own circle first, then every author
     * in rank order, with their stories. `404` while the caller has Stories off.
     */
    async getStoryFeed(options: RequestOptions = {}): Promise<StoryFeedResponse> {
        return await this.#json({ method: "GET", path: "v0/stories/feed", signal: options.signal });
    }

    /** `GET /v0/stories` — the caller's own stories, newest first; drafts and posted by default. */
    async listStories(
        query: StoriesQuery = {},
        options: RequestOptions = {},
    ): Promise<StoriesResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/stories",
            query: {
                status: query.status === undefined ? undefined : query.status.join(","),
                cursor: query.cursor,
                limit: query.limit,
            },
            signal: options.signal,
        });
    }

    /** `POST /v0/stories` — a draft made by hand; a repeated `id` returns the story unchanged. */
    async createStory(
        request: CreateStoryRequest,
        options: RequestOptions = {},
    ): Promise<StoryResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/stories",
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/stories/media` — images and videos one conversation presented, newest first. */
    async listStoryMedia(
        query: StoryMediaQuery,
        options: RequestOptions = {},
    ): Promise<StoryMediaResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/stories/media",
            query: { agentId: query.agentId, cursor: query.cursor, limit: query.limit },
            signal: options.signal,
        });
    }

    /** `GET /v0/stories/:storyId` — one story from the caller's view. */
    async getStory(storyId: Cuid2, options: RequestOptions = {}): Promise<StoryResponse> {
        return await this.#json({
            method: "GET",
            path: storyPath(storyId),
            signal: options.signal,
        });
    }

    /** `PATCH /v0/stories/:storyId` — the author's edit; a draft stays a draft. */
    async updateStory(
        storyId: Cuid2,
        request: UpdateStoryRequest,
        options: VersionedRequestOptions,
    ): Promise<StoryResponse> {
        return await this.#json({
            method: "PATCH",
            path: storyPath(storyId),
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/stories/:storyId/post` — posts the draft at exactly `artifactVersion`, the version
     * the person saw; `409` when it has changed since.
     */
    async postStory(
        storyId: Cuid2,
        request: PostStoryRequest,
        options: RequestOptions = {},
    ): Promise<StoryResponse> {
        return await this.#json({
            method: "POST",
            path: `${storyPath(storyId)}/post`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/stories/:storyId/delete` — the author's draft or posted story becomes a tombstone. */
    async deleteStory(
        storyId: Cuid2,
        options: VersionedRequestOptions & { mutationId?: string },
    ): Promise<StoryResponse> {
        return await this.#json({
            method: "POST",
            path: `${storyPath(storyId)}/delete`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/stories/:storyId/seen` — the caller has seen this story and the author's earlier ones. */
    async markStorySeen(storyId: Cuid2, options: RequestOptions = {}): Promise<StoryResponse> {
        return await this.#json({
            method: "POST",
            path: `${storyPath(storyId)}/seen`,
            json: {},
            signal: options.signal,
        });
    }

    /** `PUT /v0/stories/:storyId/reaction` — sets or replaces the caller's one reaction. */
    async setStoryReaction(
        storyId: Cuid2,
        request: SetStoryReactionRequest,
        options: RequestOptions = {},
    ): Promise<StoryResponse> {
        return await this.#json({
            method: "PUT",
            path: `${storyPath(storyId)}/reaction`,
            json: request,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/stories/:storyId/reaction` — removes the caller's reaction. */
    async removeStoryReaction(
        storyId: Cuid2,
        options: RequestOptions & { mutationId?: string } = {},
    ): Promise<StoryResponse> {
        return await this.#json({
            method: "DELETE",
            path: `${storyPath(storyId)}/reaction`,
            json: bodyOf(options),
            signal: options.signal,
        });
    }

    /** `GET /v0/stories/:storyId/viewers` — who saw the author's own story, reactors first. */
    async listStoryViewers(
        storyId: Cuid2,
        query: StoryViewersQuery = {},
        options: RequestOptions = {},
    ): Promise<StoryViewersResponse> {
        return await this.#json({
            method: "GET",
            path: `${storyPath(storyId)}/viewers`,
            query: { cursor: query.cursor, limit: query.limit },
            signal: options.signal,
        });
    }

    /** `GET /v0/stories/:storyId/frames/:frameId` — one frame's bytes, or one range of them. */
    async getStoryFrame(
        storyId: Cuid2,
        frameId: Cuid2,
        options: ToolCallMediaRequestOptions = {},
    ): Promise<ToolCallMediaContent | null> {
        const response = await this.#send({
            method: "GET",
            path: storyFramePath(storyId, frameId),
            accept: "*/*",
            ifNoneMatch: options.ifNoneMatch,
            range: options.range === undefined ? undefined : rangeHeader(options.range),
            signal: options.signal,
            allowNotModified: true,
        });
        if (response.status === 304) return null;
        return {
            contentRange: response.status === 206 ? response.headers.get("content-range") : null,
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
            data: await response.arrayBuffer(),
            etag: response.headers.get("etag"),
        };
    }

    /** The URL of one frame, for an element that loads it through a transport adding the token. */
    storyFrameUrl(storyId: Cuid2, frameId: Cuid2): string {
        return endpointUrl(this.#endpoint, storyFramePath(storyId, frameId));
    }

    /** `GET /v0/stories/:storyId/overlays/:overlayId/media` — a round video's bytes, or a range. */
    async getStoryOverlayMedia(
        storyId: Cuid2,
        overlayId: Cuid2,
        options: ToolCallMediaRequestOptions = {},
    ): Promise<ToolCallMediaContent | null> {
        const response = await this.#send({
            method: "GET",
            path: storyOverlayMediaPath(storyId, overlayId),
            accept: "*/*",
            ifNoneMatch: options.ifNoneMatch,
            range: options.range === undefined ? undefined : rangeHeader(options.range),
            signal: options.signal,
            allowNotModified: true,
        });
        if (response.status === 304) return null;
        return {
            contentRange: response.status === 206 ? response.headers.get("content-range") : null,
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
            data: await response.arrayBuffer(),
            etag: response.headers.get("etag"),
        };
    }

    /** The URL of a round video, for an element that loads it through a transport adding the token. */
    storyOverlayMediaUrl(storyId: Cuid2, overlayId: Cuid2): string {
        return endpointUrl(this.#endpoint, storyOverlayMediaPath(storyId, overlayId));
    }

    /**
     * `POST /v0/stories/:storyId/repost` — the caller's own draft, started from an agent's story
     * posted for them; edit it and post it like any draft.
     */
    async repostStory(
        storyId: Cuid2,
        request: RepostStoryRequest = {},
        options: RequestOptions = {},
    ): Promise<StoryResponse> {
        return await this.#json({
            method: "POST",
            path: `${storyPath(storyId)}/repost`,
            json: request,
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/stories/:storyId/feedback` — a message to the agent that posted the story, quoting
     * the frame the viewer was on.
     */
    async sendStoryFeedback(
        storyId: Cuid2,
        request: StoryFeedbackRequest,
        options: RequestOptions = {},
    ): Promise<StoryFeedbackResponse> {
        return await this.#json({
            method: "POST",
            path: `${storyPath(storyId)}/feedback`,
            json: request,
            signal: options.signal,
        });
    }

    // Stickers

    /** `GET /v0/stickers/packs` — every pack in the daemon's sticker folder, in catalog order. */
    async listStickerPacks(options: RequestOptions = {}): Promise<StickerPacksResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/stickers/packs",
            signal: options.signal,
        });
    }

    /** `GET /v0/stickers/packs/:packId` — one pack and its stickers in pack order. */
    async getStickerPack(
        packId: StickerPackId,
        options: RequestOptions = {},
    ): Promise<StickerPackResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/stickers/packs/${encodeURIComponent(packId)}`,
            signal: options.signal,
        });
    }

    /**
     * The URL of one sticker's file, for an element that loads it through a transport adding the
     * token. `lottie` asks for a `tgs` sticker as uncompressed Lottie JSON.
     */
    stickerFileUrl(packId: StickerPackId, stickerId: StickerId, lottie = false): string {
        return endpointUrl(
            this.#endpoint,
            `v0/stickers/packs/${encodeURIComponent(packId)}/stickers/${encodeURIComponent(stickerId)}/file`,
            lottie ? { as: "lottie" } : {},
        );
    }

    /** `GET /v0/stickers/search` — by emoji tag or pack-title word, the caller's recents first. */
    async searchStickers(
        query: StickerSearchQuery,
        options: RequestOptions = {},
    ): Promise<StickerSearchResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/stickers/search",
            query: { q: query.q, emoji: query.emoji, kind: query.kind, limit: query.limit },
            signal: options.signal,
        });
    }

    /** `GET /v0/stickers/recents` — the caller's recently used stickers, most recent first. */
    async getStickerRecents(options: RequestOptions = {}): Promise<StickerRecentsResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/stickers/recents",
            signal: options.signal,
        });
    }

    /** `POST /v0/stickers/recents` — moves one sticker to the front of the caller's recents. */
    async useSticker(
        request: UseStickerRequest,
        options: RequestOptions = {},
    ): Promise<StickerRecentsResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/stickers/recents",
            json: request,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/stickers/recents` — clears the caller's recents. */
    async clearStickerRecents(
        options: RequestOptions & { mutationId?: string } = {},
    ): Promise<StickerRecentsResponse> {
        return await this.#json({
            method: "DELETE",
            path: "v0/stickers/recents",
            json: bodyOf(options),
            signal: options.signal,
        });
    }

    // Mobile connector

    /**
     * `GET /v0/mobile-connector` — the caller's connector socket, pairing, and paired phones.
     * Daemons older than protocol 27 answer `404`.
     */
    async getMobileConnector(options: RequestOptions = {}): Promise<MobileConnectorResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/mobile-connector",
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/mobile-connector/pairing` — replaces any earlier pairing and returns once its QR
     * code is ready, or with a `failed` pairing when the socket could not open.
     */
    async startMobilePairing(options: RequestOptions = {}): Promise<MobileConnectorResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/mobile-connector/pairing",
            signal: options.signal,
        });
    }

    /** `POST /v0/mobile-connector/pairing/confirm` — the person at the desktop says the emoji match. */
    async confirmMobilePairing(
        pairingId: string,
        options: RequestOptions = {},
    ): Promise<MobileConnectorResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/mobile-connector/pairing/confirm",
            json: { pairingId },
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/mobile-connector/pairing/cancel` — ends an active pairing or dismisses a finished
     * one; any other ID changes nothing.
     */
    async cancelMobilePairing(
        pairingId: string,
        options: RequestOptions = {},
    ): Promise<MobileConnectorResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/mobile-connector/pairing/cancel",
            json: { pairingId },
            signal: options.signal,
        });
    }

    /** `DELETE /v0/mobile-connector/devices/:deviceId` — removes a phone and closes its connections. */
    async removeMobileDevice(
        deviceId: string,
        options: RequestOptions = {},
    ): Promise<MobileConnectorResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/mobile-connector/devices/${encodeURIComponent(deviceId)}`,
            signal: options.signal,
        });
    }

    // Onboarding

    /** `GET /v0/onboarding` — what a fresh installation still needs. */
    async getOnboarding(options: RequestOptions = {}): Promise<OnboardingState> {
        return await this.#json({ method: "GET", path: "v0/onboarding", signal: options.signal });
    }

    /** `POST /v0/onboarding/complete` — idempotent. */
    async completeOnboarding(options: RequestOptions = {}): Promise<OnboardingCompletedResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/onboarding/complete",
            signal: options.signal,
        });
    }

    // Projects

    /** `GET /v0/projects` — every project, archived ones included. */
    async listProjects(options: RequestOptions = {}): Promise<ProjectListResponse> {
        return await this.#json({ method: "GET", path: "v0/projects", signal: options.signal });
    }

    /** `POST /v0/projects` — registers an existing local folder. */
    async registerProject(
        request: RegisterProjectRequest,
        options: RequestOptions = {},
    ): Promise<ProjectResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/projects",
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/projects/clone` — the clone itself runs in the background. */
    async cloneProject(
        request: CloneProjectRequest,
        options: RequestOptions = {},
    ): Promise<ProjectResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/projects/clone",
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/projects/:projectId` */
    async getProject(projectId: Cuid2, options: RequestOptions = {}): Promise<ProjectResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/projects/${encodeURIComponent(projectId)}`,
            signal: options.signal,
        });
    }

    /** `PATCH /v0/projects/:projectId` — renames it; `nameSource` becomes `"user"`. */
    async renameProject(
        projectId: Cuid2,
        request: RenameProjectRequest,
        options: VersionedRequestOptions,
    ): Promise<ProjectResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/projects/${encodeURIComponent(projectId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `PUT /v0/projects/:projectId/settings` — replaces the settings. */
    async replaceProjectSettings(
        projectId: Cuid2,
        request: ReplaceProjectSettingsRequest,
        options: VersionedRequestOptions,
    ): Promise<ProjectSettingsResponse> {
        return await this.#json({
            method: "PUT",
            path: `v0/projects/${encodeURIComponent(projectId)}/settings`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/projects/:projectId/refresh` — re-runs project setup. */
    async refreshProject(projectId: Cuid2, options: RequestOptions = {}): Promise<ProjectResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/projects/${encodeURIComponent(projectId)}/refresh`,
            signal: options.signal,
        });
    }

    /** `POST /v0/projects/:projectId/reorder` — neighbours move through events. */
    async reorderProject(
        projectId: Cuid2,
        request: ReorderProjectRequest,
        options: VersionedRequestOptions,
    ): Promise<ProjectResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/projects/${encodeURIComponent(projectId)}/reorder`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/projects/:projectId/archive` — idempotent; cleanup is background work. */
    async archiveProject(
        projectId: Cuid2,
        options: VersionedRequestOptions & ArchiveProjectRequest,
    ): Promise<ProjectResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/projects/${encodeURIComponent(projectId)}/archive`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `GET /v0/projects/:projectId/avatar` — the picture bytes; `null` when unchanged. */
    async getProjectAvatar(
        projectId: Cuid2,
        options: ConditionalRequestOptions = {},
    ): Promise<BinaryContent | null> {
        return await this.#binary({
            method: "GET",
            path: `v0/projects/${encodeURIComponent(projectId)}/avatar`,
            ifNoneMatch: options.ifNoneMatch,
            signal: options.signal,
        });
    }

    /** `PUT /v0/projects/:projectId/avatar` — the limit is 8 MB. */
    async setProjectAvatar(
        projectId: Cuid2,
        image: ImageUpload,
        options: VersionedRequestOptions,
    ): Promise<ProjectResponse> {
        return await this.#json({
            method: "PUT",
            path: `v0/projects/${encodeURIComponent(projectId)}/avatar`,
            binary: image,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/projects/:projectId/avatar` */
    async deleteProjectAvatar(
        projectId: Cuid2,
        options: VersionedRequestOptions,
    ): Promise<ProjectResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/projects/${encodeURIComponent(projectId)}/avatar`,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    // Workspaces

    /** `GET /v0/workspaces` — a flat array; clients build the tree from `parentId`. */
    async listWorkspaces(
        query: ListWorkspacesQuery = {},
        options: RequestOptions = {},
    ): Promise<WorkspaceListResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/workspaces",
            query: { projectId: query.projectId, includeArchived: query.includeArchived },
            signal: options.signal,
        });
    }

    /** `POST /v0/workspaces` — the checkout builds in the background. */
    async createWorkspace(
        request: CreateWorkspaceRequest,
        options: RequestOptions = {},
    ): Promise<WorkspaceResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/workspaces",
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/workspaces/:workspaceId` — a project ID answers with its root workspace. */
    async getWorkspace(
        workspaceId: Cuid2,
        options: RequestOptions = {},
    ): Promise<WorkspaceResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}`,
            signal: options.signal,
        });
    }

    /** `PATCH /v0/workspaces/:workspaceId` — the Git branch moves in the background. */
    async renameWorkspace(
        workspaceId: Cuid2,
        request: RenameWorkspaceRequest,
        options: VersionedRequestOptions,
    ): Promise<WorkspaceResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/workspaces/:workspaceId/archive` — archives it and everything beneath. */
    async archiveWorkspace(
        workspaceId: Cuid2,
        options: VersionedRequestOptions & ArchiveWorkspaceRequest,
    ): Promise<WorkspaceResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/archive`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/workspaces/:workspaceId/reorder` — moves it among its siblings. */
    async reorderWorkspace(
        workspaceId: Cuid2,
        request: ReorderWorkspaceRequest,
        options: VersionedRequestOptions,
    ): Promise<WorkspaceResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/reorder`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    // Bots

    /** `GET /v0/bots` — every bot, archived ones included. */
    async listBots(options: RequestOptions = {}): Promise<BotListResponse> {
        return await this.#json({ method: "GET", path: "v0/bots", signal: options.signal });
    }

    /** `POST /v0/bots` — creates the bot, its dedicated workspace, and its one agent. */
    async createBot(request: CreateBotRequest, options: RequestOptions = {}): Promise<BotResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/bots",
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/bots/:botId` */
    async getBot(botId: Cuid2, options: RequestOptions = {}): Promise<BotResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/bots/${encodeURIComponent(botId)}`,
            signal: options.signal,
        });
    }

    /** `PATCH /v0/bots/:botId` — renames the display name; the username is immutable. */
    async renameBot(
        botId: Cuid2,
        request: RenameBotRequest,
        options: VersionedRequestOptions,
    ): Promise<BotResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/bots/${encodeURIComponent(botId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/bots/:botId/archive` — idempotent; the folder stays on disk. */
    async archiveBot(
        botId: Cuid2,
        options: VersionedRequestOptions & ArchiveBotRequest,
    ): Promise<BotResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/bots/${encodeURIComponent(botId)}/archive`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/bots/:botId/unarchive` — restores the workspace and agent. */
    async unarchiveBot(
        botId: Cuid2,
        options: VersionedRequestOptions & UnarchiveBotRequest,
    ): Promise<BotResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/bots/${encodeURIComponent(botId)}/unarchive`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/bots/:botId/reorder` — moves it in the bot catalog. */
    async reorderBot(
        botId: Cuid2,
        request: ReorderBotRequest,
        options: VersionedRequestOptions,
    ): Promise<BotResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/bots/${encodeURIComponent(botId)}/reorder`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `GET /v0/bots/:botId/avatar` — the picture bytes; `null` when unchanged. */
    async getBotAvatar(
        botId: Cuid2,
        options: ConditionalRequestOptions = {},
    ): Promise<BinaryContent | null> {
        return await this.#binary({
            method: "GET",
            path: `v0/bots/${encodeURIComponent(botId)}/avatar`,
            ifNoneMatch: options.ifNoneMatch,
            signal: options.signal,
        });
    }

    /** `PUT /v0/bots/:botId/avatar` — the limit is 8 MB. */
    async setBotAvatar(
        botId: Cuid2,
        image: ImageUpload,
        options: VersionedRequestOptions,
    ): Promise<BotResponse> {
        return await this.#json({
            method: "PUT",
            path: `v0/bots/${encodeURIComponent(botId)}/avatar`,
            binary: image,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/bots/:botId/avatar` */
    async deleteBotAvatar(botId: Cuid2, options: VersionedRequestOptions): Promise<BotResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/bots/${encodeURIComponent(botId)}/avatar`,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    // Tasks

    /**
     * `GET /v0/tasks` — every task oldest first, or with `scope: "joined"` only the caller's joined
     * tasks in the caller's order. `memberships` is always the caller's whole ordered list.
     */
    async listTasks(
        options: RequestOptions & { readonly scope?: TaskListScope } = {},
    ): Promise<TaskListResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/tasks",
            query: { scope: options.scope },
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/tasks` — create a task the caller owns and joins. Without a name it is `New Task`
     * until it names itself from its first message.
     */
    async createTask(
        request: CreateTaskRequest = {},
        options: RequestOptions = {},
    ): Promise<TaskResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/tasks",
            json: request,
            signal: options.signal,
        });
    }

    /** `PATCH /v0/tasks/:taskId` — rename; ends automatic naming for the task. */
    async renameTask(
        taskId: Cuid2,
        request: RenameTaskRequest,
        options: VersionedRequestOptions,
    ): Promise<TaskResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/tasks/${encodeURIComponent(taskId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `GET /v0/tasks/:taskId` — the task and the caller's membership, or `null`. */
    async getTask(taskId: Cuid2, options: RequestOptions = {}): Promise<TaskResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/tasks/${encodeURIComponent(taskId)}`,
            signal: options.signal,
        });
    }

    /** `POST /v0/tasks/:taskId/join` — idempotent; a new membership goes to the top of the list. */
    async joinTask(
        taskId: Cuid2,
        options: RequestOptions & JoinTaskRequest = {},
    ): Promise<TaskResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/tasks/${encodeURIComponent(taskId)}/join`,
            json: bodyOf(options),
            signal: options.signal,
        });
    }

    /** `POST /v0/tasks/:taskId/read` — clears the caller's `unread`; already read changes nothing. */
    async markTaskRead(
        taskId: Cuid2,
        options: RequestOptions & JoinTaskRequest = {},
    ): Promise<TaskResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/tasks/${encodeURIComponent(taskId)}/read`,
            json: bodyOf(options),
            signal: options.signal,
        });
    }

    /** `POST /v0/tasks/:taskId/leave` — idempotent; the task and its owner are unchanged. */
    async leaveTask(
        taskId: Cuid2,
        options: RequestOptions & LeaveTaskRequest = {},
    ): Promise<TaskResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/tasks/${encodeURIComponent(taskId)}/leave`,
            json: bodyOf(options),
            signal: options.signal,
        });
    }

    /** `POST /v0/tasks/:taskId/reorder` — moves it within the caller's own list only. */
    async reorderTask(
        taskId: Cuid2,
        request: ReorderTaskRequest,
        options: RequestOptions = {},
    ): Promise<TaskResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/tasks/${encodeURIComponent(taskId)}/reorder`,
            json: request,
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/tasks/:taskId/archive` — stops the task's work and keeps its folder and
     * memberships. Only callers whose task reports `canArchive` may do this.
     */
    async archiveTask(
        taskId: Cuid2,
        options: VersionedRequestOptions & ArchiveTaskRequest,
    ): Promise<TaskResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/tasks/${encodeURIComponent(taskId)}/archive`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/tasks/:taskId/unarchive` — the same callers as archive. */
    async unarchiveTask(
        taskId: Cuid2,
        options: VersionedRequestOptions & UnarchiveTaskRequest,
    ): Promise<TaskResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/tasks/${encodeURIComponent(taskId)}/unarchive`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    // Spaces

    /**
     * Read (and lazily create) the person's sidebar artifact. `widgets: true` includes
     * `happy-widget` elements; send it only when health reports `capabilities.sidebarOperations`.
     */
    async getSpaceSidebar(
        options: RequestOptions & { readonly widgets?: boolean } = {},
    ): Promise<SpaceSidebarResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/spaces/sidebar",
            query: { widgets: options.widgets === true ? "true" : undefined },
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/spaces/sidebar/operations` — the person's batch of operations by node ID, made
     * against `baseVersion` and rebased onto the current version. Retry with the same mutation ID;
     * a `409` names the operation that no longer applies in `operationIndex`. Send it only when
     * health reports `capabilities.sidebarOperations`.
     */
    async applySpaceSidebarOperations(
        request: SpaceSidebarOperationsRequest,
        options: RequestOptions = {},
    ): Promise<SpaceSidebarOperationsResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/spaces/sidebar/operations",
            json: request,
            signal: options.signal,
        });
    }

    /**
     * `GET /v0/spaces/sidebar/proposals/:artifactId` — a proposal and its latest document. Send it
     * only when health reports `capabilities.sidebarProposals`.
     */
    async getSpaceSidebarProposal(
        artifactId: string,
        options: RequestOptions = {},
    ): Promise<SpaceSidebarProposalResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/spaces/sidebar/proposals/${encodeURIComponent(artifactId)}`,
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/spaces/sidebar/proposals/:artifactId/operations` — the person's edit of an open
     * proposal, made against a proposal version and rebased like a sidebar batch.
     */
    async applySpaceSidebarProposalOperations(
        artifactId: string,
        request: SpaceSidebarOperationsRequest,
        options: RequestOptions = {},
    ): Promise<SpaceSidebarOperationsResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/spaces/sidebar/proposals/${encodeURIComponent(artifactId)}/operations`,
            json: request,
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/spaces/sidebar/proposals/:artifactId/accept` — apply the proposal to the sidebar
     * as the person's batch. Retry with the same mutation ID.
     */
    async acceptSpaceSidebarProposal(
        artifactId: string,
        request: AcceptSpaceSidebarProposalRequest,
        options: RequestOptions = {},
    ): Promise<AcceptSpaceSidebarProposalResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/spaces/sidebar/proposals/${encodeURIComponent(artifactId)}/accept`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/spaces/sidebar/proposals/:artifactId/decline` — leave the sidebar as it is. */
    async declineSpaceSidebarProposal(
        artifactId: string,
        request: DeclineSpaceSidebarProposalRequest = {},
        options: RequestOptions = {},
    ): Promise<DeclineSpaceSidebarProposalResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/spaces/sidebar/proposals/${encodeURIComponent(artifactId)}/decline`,
            json: request,
            signal: options.signal,
        });
    }

    /** Commit one whole document. Retry with the same mutation ID; reload on a 409. */
    async updateSpaceSidebar(
        request: UpdateSpaceSidebarRequest,
        options: RequestOptions = {},
    ): Promise<SpaceSidebarResponse> {
        return await this.#json({
            method: "PUT",
            path: "v0/spaces/sidebar",
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/spaces` — the caller's whole sidebar, and the cursor to follow it from. */
    async listSpaces(options: RequestOptions = {}): Promise<SpaceListResponse> {
        return await this.#json({ method: "GET", path: "v0/spaces", signal: options.signal });
    }

    /** `GET /v0/spaces/batches` — applied batches, newest first; `limit` is 1–100. */
    async listSpaceBatches(
        options: RequestOptions & { readonly limit?: number } = {},
    ): Promise<SpaceBatchListResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/spaces/batches",
            query: { limit: options.limit },
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/spaces/stem-cells` — new work: a fresh unnamed task and its row. Repeating `id`
     * returns the existing row and conversation. `taskId`, `workspaceId`, and `agentId` name the
     * new conversation up front when health reports `capabilities.stemCellIdentities`.
     */
    async createStemCell(
        request: CreateStemCellRequest = {},
        options: RequestOptions = {},
    ): Promise<CreateStemCellResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/spaces/stem-cells",
            json: request,
            signal: options.signal,
        });
    }

    /**
     * `PATCH /v0/spaces/:spaceId` — the person's own move, fold, or hide, applied at once. Giving
     * `sectionId` moves the row; `afterId` places it within that section.
     */
    async updateSpace(
        spaceId: Cuid2,
        request: UpdateSpaceRequest,
        options: RequestOptions = {},
    ): Promise<SpaceResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/spaces/${encodeURIComponent(spaceId)}`,
            json: request,
            signal: options.signal,
        });
    }

    /**
     * `PATCH /v0/spaces/:spaceId` with `removed: true` — take new work nobody wrote in out of the
     * sidebar and archive its task; idempotent. Answers `409` once its conversation holds a message.
     */
    async removeSpace(
        spaceId: Cuid2,
        options: RequestOptions & { readonly mutationId?: string } = {},
    ): Promise<void> {
        await this.#send({
            method: "PATCH",
            path: `v0/spaces/${encodeURIComponent(spaceId)}`,
            json: { removed: true, ...bodyOf(options) },
            signal: options.signal,
        });
    }

    /** `PATCH /v0/spaces/sections/:sectionId` — the person's own disclosure, applied at once. */
    async updateSpaceSection(
        sectionId: Cuid2,
        request: UpdateSpaceSectionRequest,
        options: RequestOptions = {},
    ): Promise<SpaceSectionResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/spaces/sections/${encodeURIComponent(sectionId)}`,
            json: request,
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/spaces/attention` — `interacting` holds batches back; `calm` lets a waiting one
     * apply and returns it.
     */
    async reportSpaceAttention(
        request: SpaceAttentionRequest,
        options: RequestOptions = {},
    ): Promise<SpaceAttentionResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/spaces/attention",
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/spaces/tidy` — post "Tidy the sidebar now" into Prioritizing's conversation. */
    async tidySpaces(
        options: RequestOptions & { readonly mutationId?: string } = {},
    ): Promise<void> {
        await this.#send({
            method: "POST",
            path: "v0/spaces/tidy",
            json: bodyOf(options),
            signal: options.signal,
        });
    }

    // Surfaces

    /** `GET /v0/surfaces` — shared catalog, with members nested in each Surface. */
    async listSurfaces(options: RequestOptions = {}): Promise<SurfaceListResponse> {
        return await this.#json({ method: "GET", path: "v0/surfaces", signal: options.signal });
    }

    async createSurface(
        request: CreateSurfaceRequest,
        options: RequestOptions = {},
    ): Promise<SurfaceResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/surfaces",
            json: request,
            signal: options.signal,
        });
    }

    async getSurfaceImage(
        surfaceId: SurfaceId,
        options: ConditionalRequestOptions = {},
    ): Promise<BinaryContent | null> {
        return await this.#binary({
            method: "GET",
            path: `v0/surfaces/${encodeURIComponent(surfaceId)}/image`,
            ifNoneMatch: options.ifNoneMatch,
            signal: options.signal,
        });
    }

    /**
     * Renames a Surface or replaces its image; `image: null` removes it. Requires
     * `capabilities.surfaceEditing`. No `If-Match`: the latest edit wins.
     */
    async updateSurface(
        surfaceId: SurfaceId,
        request: UpdateSurfaceRequest,
        options: RequestOptions = {},
    ): Promise<SurfaceResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/surfaces/${encodeURIComponent(surfaceId)}`,
            json: request,
            signal: options.signal,
        });
    }

    /** Joining appends to the caller's sidebar. It never changes Surface data. */
    async joinSurface(
        surfaceId: SurfaceId,
        options: RequestOptions & SurfaceMemberRequest = {},
    ): Promise<SurfaceResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/${encodeURIComponent(surfaceId)}/join`,
            json: bodyOf(options),
            signal: options.signal,
        });
    }

    async leaveSurface(
        surfaceId: SurfaceId,
        options: RequestOptions & SurfaceMemberRequest = {},
    ): Promise<SurfaceResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/${encodeURIComponent(surfaceId)}/leave`,
            json: bodyOf(options),
            signal: options.signal,
        });
    }

    /** Moves only the caller's member record; `afterId: null` means first. */
    async reorderSurface(
        surfaceId: SurfaceId,
        request: ReorderSurfaceRequest,
        options: RequestOptions = {},
    ): Promise<SurfaceResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/${encodeURIComponent(surfaceId)}/reorder`,
            json: request,
            signal: options.signal,
        });
    }

    /** Idempotently opens the Surface's shared chat without joining the caller or sending a message. */
    async ensureSurfaceChat(
        surfaceId: SurfaceId,
        options: RequestOptions & EnsureSurfaceChatRequest = {},
    ): Promise<SurfaceChatResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/${encodeURIComponent(surfaceId)}/chat`,
            json: bodyOf(options),
            signal: options.signal,
        });
    }

    /** Loads every active todo by default, with a snapshot cursor for following changes. */
    async listTodos(
        surfaceId: SurfaceId,
        options: RequestOptions & { readonly scope?: TodoListScope } = {},
    ): Promise<TodoListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/todo/${encodeURIComponent(surfaceId)}`,
            query: { scope: options.scope },
            signal: options.signal,
        });
    }

    /** Adds at the top; a supplied ID safely resolves an uncertain creation outcome. */
    async createTodo(
        surfaceId: SurfaceId,
        request: CreateTodoRequest,
        options: RequestOptions = {},
    ): Promise<TodoResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/todo/${encodeURIComponent(surfaceId)}`,
            json: request,
            signal: options.signal,
        });
    }

    /** Deleted tombstones remain readable by ID. */
    async getTodo(
        surfaceId: SurfaceId,
        todoId: Cuid2,
        options: RequestOptions = {},
    ): Promise<TodoResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/todo/${encodeURIComponent(surfaceId)}/${encodeURIComponent(todoId)}`,
            signal: options.signal,
        });
    }

    async updateTodo(
        surfaceId: SurfaceId,
        todoId: Cuid2,
        request: UpdateTodoRequest,
        options: VersionedRequestOptions,
    ): Promise<TodoResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/surfaces/todo/${encodeURIComponent(surfaceId)}/${encodeURIComponent(todoId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** Only active todos can move; completed and deleted targets reject reordering. */
    async reorderTodo(
        surfaceId: SurfaceId,
        todoId: Cuid2,
        request: ReorderTodoRequest,
        options: VersionedRequestOptions,
    ): Promise<TodoResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/todo/${encodeURIComponent(surfaceId)}/${encodeURIComponent(todoId)}/reorder`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** Deletion retains the text and every immutable revision. */
    async deleteTodo(
        surfaceId: SurfaceId,
        todoId: Cuid2,
        options: VersionedRequestOptions & TodoMutationRequest,
    ): Promise<TodoResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/surfaces/todo/${encodeURIComponent(surfaceId)}/${encodeURIComponent(todoId)}`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** Permanent revisions, oldest first; the cursor belongs to this todo's version history. */
    async listTodoVersions(
        surfaceId: SurfaceId,
        todoId: Cuid2,
        options: RequestOptions & { readonly afterVersion?: string; readonly limit?: number } = {},
    ): Promise<TodoVersionListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/todo/${encodeURIComponent(surfaceId)}/${encodeURIComponent(todoId)}/versions`,
            query: { afterVersion: options.afterVersion, limit: options.limit },
            signal: options.signal,
        });
    }

    async getTodoVersion(
        surfaceId: SurfaceId,
        todoId: Cuid2,
        version: string,
        options: RequestOptions = {},
    ): Promise<TodoVersionResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/todo/${encodeURIComponent(surfaceId)}/${encodeURIComponent(todoId)}/versions/${encodeURIComponent(version)}`,
            signal: options.signal,
        });
    }

    /** Current daemon-host telemetry, shared by every System Monitor Surface. */
    async getSystemMonitor(
        surfaceId: SurfaceId,
        options: RequestOptions = {},
    ): Promise<SystemMonitorSnapshot> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/system-monitor/${encodeURIComponent(surfaceId)}`,
            signal: options.signal,
        });
    }

    /** Occurrences overlapping `[from, to)`, expanded by the daemon in `timeZone`. */
    async listCalendarEvents(
        surfaceId: SurfaceId,
        range: { readonly from: number; readonly to: number; readonly timeZone: string },
        options: RequestOptions = {},
    ): Promise<CalendarRangeResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/calendar/${encodeURIComponent(surfaceId)}`,
            query: { from: range.from, to: range.to, timeZone: range.timeZone },
            signal: options.signal,
        });
    }

    /** A supplied ID safely resolves an uncertain creation outcome. */
    async createCalendarEvent(
        surfaceId: SurfaceId,
        request: CreateCalendarEventRequest,
        options: RequestOptions = {},
    ): Promise<CalendarEventResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/calendar/${encodeURIComponent(surfaceId)}`,
            json: request,
            signal: options.signal,
        });
    }

    /** Deleted tombstones remain readable by ID. */
    async getCalendarEvent(
        surfaceId: SurfaceId,
        eventId: Cuid2,
        options: RequestOptions = {},
    ): Promise<CalendarEventResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/calendar/${encodeURIComponent(surfaceId)}/${encodeURIComponent(eventId)}`,
            signal: options.signal,
        });
    }

    /** Changes the whole series; applying a revision's fields restores that state. */
    async updateCalendarEvent(
        surfaceId: SurfaceId,
        eventId: Cuid2,
        request: UpdateCalendarEventRequest,
        options: VersionedRequestOptions,
    ): Promise<CalendarEventResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/surfaces/calendar/${encodeURIComponent(surfaceId)}/${encodeURIComponent(eventId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** Deletion tombstones the whole series and keeps every immutable revision. */
    async deleteCalendarEvent(
        surfaceId: SurfaceId,
        eventId: Cuid2,
        options: VersionedRequestOptions & CalendarEventMutationRequest,
    ): Promise<CalendarEventResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/surfaces/calendar/${encodeURIComponent(surfaceId)}/${encodeURIComponent(eventId)}`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** Permanent revisions, oldest first; the cursor belongs to this event's version history. */
    async listCalendarEventVersions(
        surfaceId: SurfaceId,
        eventId: Cuid2,
        options: RequestOptions & { readonly afterVersion?: string; readonly limit?: number } = {},
    ): Promise<CalendarEventVersionListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/calendar/${encodeURIComponent(surfaceId)}/${encodeURIComponent(eventId)}/versions`,
            query: { afterVersion: options.afterVersion, limit: options.limit },
            signal: options.signal,
        });
    }

    async getCalendarEventVersion(
        surfaceId: SurfaceId,
        eventId: Cuid2,
        version: string,
        options: RequestOptions = {},
    ): Promise<CalendarEventVersionResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/calendar/${encodeURIComponent(surfaceId)}/${encodeURIComponent(eventId)}/versions/${encodeURIComponent(version)}`,
            signal: options.signal,
        });
    }

    /**
     * One page of a chat Surface's messages, oldest first. Without `afterSeq` it is the newest
     * page below `beforeSeq`; with `afterSeq` it reads forward. These are people's messages,
     * never the Surface's shared agent chat.
     */
    async listSurfaceMessages(
        surfaceId: SurfaceId,
        options: RequestOptions & {
            readonly beforeSeq?: number;
            readonly afterSeq?: number;
            readonly limit?: number;
        } = {},
    ): Promise<SurfaceMessagePageResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/chat/${encodeURIComponent(surfaceId)}/messages`,
            query: {
                beforeSeq: options.beforeSeq,
                afterSeq: options.afterSeq,
                limit: options.limit,
            },
            signal: options.signal,
        });
    }

    /** A client-generated ID safely resolves an uncertain post; a retry never posts twice. */
    async sendSurfaceMessage(
        surfaceId: SurfaceId,
        request: SendSurfaceMessageRequest,
        options: RequestOptions = {},
    ): Promise<SurfaceMessageResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/chat/${encodeURIComponent(surfaceId)}/messages`,
            json: request,
            signal: options.signal,
        });
    }

    /** Deleted tombstones remain readable by ID. */
    async getSurfaceMessage(
        surfaceId: SurfaceId,
        messageId: Cuid2,
        options: RequestOptions = {},
    ): Promise<SurfaceMessageResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/chat/${encodeURIComponent(surfaceId)}/messages/${encodeURIComponent(messageId)}`,
            signal: options.signal,
        });
    }

    /** Only the message's author may edit it. */
    async editSurfaceMessage(
        surfaceId: SurfaceId,
        messageId: Cuid2,
        request: EditSurfaceMessageRequest,
        options: VersionedRequestOptions,
    ): Promise<SurfaceMessageResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/surfaces/chat/${encodeURIComponent(surfaceId)}/messages/${encodeURIComponent(messageId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** Only the author may delete; the tombstone keeps every immutable revision. */
    async deleteSurfaceMessage(
        surfaceId: SurfaceId,
        messageId: Cuid2,
        options: VersionedRequestOptions & SurfaceMessageMutationRequest,
    ): Promise<SurfaceMessageResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/surfaces/chat/${encodeURIComponent(surfaceId)}/messages/${encodeURIComponent(messageId)}`,
            json: bodyOf(options),
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** Permanent revisions, oldest first; the cursor belongs to this message's version history. */
    async listSurfaceMessageVersions(
        surfaceId: SurfaceId,
        messageId: Cuid2,
        options: RequestOptions & { readonly afterVersion?: string; readonly limit?: number } = {},
    ): Promise<SurfaceMessageVersionListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/chat/${encodeURIComponent(surfaceId)}/messages/${encodeURIComponent(messageId)}/versions`,
            query: { afterVersion: options.afterVersion, limit: options.limit },
            signal: options.signal,
        });
    }

    async getSurfaceMessageVersion(
        surfaceId: SurfaceId,
        messageId: Cuid2,
        version: string,
        options: RequestOptions = {},
    ): Promise<SurfaceMessageVersionResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/chat/${encodeURIComponent(surfaceId)}/messages/${encodeURIComponent(messageId)}/versions/${encodeURIComponent(version)}`,
            signal: options.signal,
        });
    }

    /**
     * The read-only Markdown projection and the shared cursor captured before it was read;
     * `seq` reads the document as of that change.
     */
    async getSurfaceDocument(
        surfaceId: SurfaceId,
        options: RequestOptions & { readonly seq?: number } = {},
    ): Promise<SurfaceDocumentSnapshotResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/document/${encodeURIComponent(surfaceId)}`,
            query: { seq: options.seq },
            signal: options.signal,
        });
    }

    /**
     * The collaborative document as one Yjs update: only what `stateVector` lacks, the whole
     * document, or the whole document as of `seq`.
     */
    async getSurfaceDocumentState(
        surfaceId: SurfaceId,
        options: RequestOptions & {
            readonly stateVector?: string;
            readonly seq?: number;
        } = {},
    ): Promise<SurfaceDocumentStateResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/document/${encodeURIComponent(surfaceId)}/state`,
            query: { stateVector: options.stateVector, seq: options.seq },
            signal: options.signal,
        });
    }

    /** Stores one change before answering; repeating its mutation ID returns the original seq. */
    async sendSurfaceDocumentUpdate(
        surfaceId: SurfaceId,
        request: SendSurfaceDocumentUpdateRequest,
        options: RequestOptions = {},
    ): Promise<SurfaceDocumentSeqResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/document/${encodeURIComponent(surfaceId)}/updates`,
            json: request,
            signal: options.signal,
        });
    }

    /** The permanent change log, oldest first, without change bytes. */
    async listSurfaceDocumentUpdates(
        surfaceId: SurfaceId,
        options: RequestOptions & { readonly afterSeq?: number; readonly limit?: number } = {},
    ): Promise<SurfaceDocumentChangeListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/document/${encodeURIComponent(surfaceId)}/updates`,
            query: { afterSeq: options.afterSeq, limit: options.limit },
            signal: options.signal,
        });
    }

    /** Sends this document's live frames to the event stream named by its hello `streamId`. */
    async subscribeSurfaceDocument(
        surfaceId: SurfaceId,
        request: SurfaceDocumentSubscriptionRequest,
        options: RequestOptions = {},
    ): Promise<SurfaceDocumentSeqResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/document/${encodeURIComponent(surfaceId)}/subscribe`,
            json: request,
            signal: options.signal,
        });
    }

    /** Stops this document's live frames on that stream and ends its presence there. */
    async unsubscribeSurfaceDocument(
        surfaceId: SurfaceId,
        request: SurfaceDocumentSubscriptionRequest,
        options: RequestOptions = {},
    ): Promise<Record<string, never>> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/document/${encodeURIComponent(surfaceId)}/unsubscribe`,
            json: request,
            signal: options.signal,
        });
    }

    /** Relays an awareness update to the document's other subscribed streams; never stored. */
    async sendSurfaceDocumentPresence(
        surfaceId: SurfaceId,
        request: SendSurfaceDocumentPresenceRequest,
        options: RequestOptions = {},
    ): Promise<Record<string, never>> {
        return await this.#json({
            method: "POST",
            path: `v0/surfaces/document/${encodeURIComponent(surfaceId)}/presence`,
            json: request,
            signal: options.signal,
        });
    }

    /** Markdown revisions frozen before a document became collaborative, oldest first. */
    async listSurfaceDocumentVersions(
        surfaceId: SurfaceId,
        options: RequestOptions & { readonly afterVersion?: string; readonly limit?: number } = {},
    ): Promise<SurfaceDocumentVersionListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/document/${encodeURIComponent(surfaceId)}/versions`,
            query: { afterVersion: options.afterVersion, limit: options.limit },
            signal: options.signal,
        });
    }

    async getSurfaceDocumentVersion(
        surfaceId: SurfaceId,
        version: string,
        options: RequestOptions = {},
    ): Promise<SurfaceDocumentVersionResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/surfaces/document/${encodeURIComponent(surfaceId)}/versions/${encodeURIComponent(version)}`,
            signal: options.signal,
        });
    }

    // Artifacts

    /**
     * `GET /v0/artifacts` — one page of the global catalog, newest created first, tombstones only
     * with `includeDeleted`. Follow `nextPageCursor` as `pageCursor`; `cursor` is where to follow
     * events from so no change made while paging is missed.
     */
    async listArtifacts(
        query: ArtifactListQuery = {},
        options: RequestOptions = {},
    ): Promise<ArtifactListResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/artifacts",
            query: { ...query },
            signal: options.signal,
        });
    }

    /** `GET /v0/artifacts/:artifactId` — a deleted artifact answers as its tombstone. */
    async getArtifact(artifactId: Cuid2, options: RequestOptions = {}): Promise<ArtifactResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/artifacts/${encodeURIComponent(artifactId)}`,
            signal: options.signal,
        });
    }

    /** `GET /v0/artifacts/:artifactId/versions` — newest first. */
    async listArtifactVersions(
        artifactId: Cuid2,
        query: ArtifactVersionListQuery = {},
        options: RequestOptions = {},
    ): Promise<ArtifactVersionListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/artifacts/${encodeURIComponent(artifactId)}/versions`,
            query: { ...query },
            signal: options.signal,
        });
    }

    /**
     * `GET /v0/artifacts/:artifactId/versions/:number` — one version with its whole manifest;
     * `"latest"` names whichever version is latest when the daemon answers.
     */
    async getArtifactVersion(
        artifactId: Cuid2,
        version: ArtifactVersionSelector,
        options: RequestOptions = {},
    ): Promise<ArtifactVersionResponse> {
        return await this.#json({
            method: "GET",
            path: artifactVersionPath(artifactId, version),
            signal: options.signal,
        });
    }

    /**
     * `GET /v0/artifacts/:artifactId/versions/:number/files/*path` — one file's bytes, or one
     * range of them, by its path in the version; `null` when `ifNoneMatch` still matches.
     */
    async getArtifactFile(
        artifactId: Cuid2,
        version: ArtifactVersionSelector,
        path: ArtifactPath,
        options: ArtifactFileRequestOptions = {},
    ): Promise<ArtifactFileContent | null> {
        const response = await this.#send({
            method: "GET",
            path: artifactFilePath(artifactId, version, path),
            accept: "*/*",
            ifNoneMatch: options.ifNoneMatch,
            range: options.range === undefined ? undefined : rangeHeader(options.range),
            signal: options.signal,
            allowNotModified: true,
        });
        if (response.status === 304) return null;
        return {
            contentRange: response.status === 206 ? response.headers.get("content-range") : null,
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
            data: await response.arrayBuffer(),
            etag: response.headers.get("etag"),
        };
    }

    /**
     * The URL of `GET /v0/artifacts/:artifactId/versions/:number/files/*path`.
     *
     * Every file of a version shares one prefix, so a relative reference in a Markdown or HTML
     * entry resolves against the entry's URL to its file. A frame, a media element, or a streaming
     * download reads files through this URL rather than through `getArtifactFile`, with the bearer
     * token added by whatever transport carries the request.
     */
    artifactFileUrl(
        artifactId: Cuid2,
        version: ArtifactVersionSelector,
        path: ArtifactPath,
    ): string {
        return endpointUrl(this.#endpoint, artifactFilePath(artifactId, version, path));
    }

    /**
     * The URL of `CONNECT /v0/artifacts/:artifactId/proxy`. The daemon enforces the live
     * artifact's current destination policy on its recorded network. Fetch cannot open this
     * tunnel; the caller's transport supplies authentication. Never fall back to a network proxy.
     */
    artifactProxyUrl(artifactId: Cuid2): string {
        return endpointUrl(this.#endpoint, `v0/artifacts/${encodeURIComponent(artifactId)}/proxy`);
    }

    /**
     * `POST /v0/artifact-uploads` — one file's bytes for a later creation or update, up to
     * 256 MiB. The file's name and media type come from the path it is placed at.
     */
    async uploadArtifactFile(
        file: ArtifactFileUpload,
        options: RequestOptions = {},
    ): Promise<ArtifactUploadResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/artifact-uploads",
            binary: { contentType: "application/octet-stream", data: file.data },
            signal: options.signal,
        });
    }

    /** `POST /v0/artifacts` — the artifact and its first version, by the authenticated person. */
    async createArtifact(
        request: CreateArtifactRequest,
        options: RequestOptions = {},
    ): Promise<ArtifactResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/artifacts",
            json: request,
            signal: options.signal,
        });
    }

    /** `PATCH /v0/artifacts/:artifactId` — a new version; the previous ones are kept. */
    async updateArtifact(
        artifactId: Cuid2,
        request: UpdateArtifactRequest,
        options: VersionedRequestOptions,
    ): Promise<ArtifactResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/artifacts/${encodeURIComponent(artifactId)}`,
            json: request,
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    /** `POST /v0/artifacts/:artifactId/delete` — leaves a tombstone; repeating it is harmless. */
    async deleteArtifact(
        artifactId: Cuid2,
        options: VersionedRequestOptions & DeleteArtifactRequest,
    ): Promise<ArtifactResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/artifacts/${encodeURIComponent(artifactId)}/delete`,
            json: {
                ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
                ...(options.source === undefined ? {} : { source: options.source }),
            },
            ifMatch: options.ifMatch,
            signal: options.signal,
        });
    }

    // Terminals

    /** `GET /v0/workspaces/:workspaceId/terminals` */
    async listTerminals(
        workspaceId: Cuid2,
        options: RequestOptions = {},
    ): Promise<TerminalListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/terminals`,
            signal: options.signal,
        });
    }

    /** `POST /v0/workspaces/:workspaceId/terminals` — a workspace holds at most 32. */
    async openTerminal(
        workspaceId: Cuid2,
        request: OpenTerminalRequest = {},
        options: RequestOptions = {},
    ): Promise<TerminalResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/terminals`,
            json: request,
            signal: options.signal,
        });
    }

    /** `PATCH /v0/workspaces/:workspaceId/terminals/:terminalId` */
    async resizeTerminal(
        workspaceId: Cuid2,
        terminalId: Cuid2,
        request: ResizeTerminalRequest,
        options: RequestOptions = {},
    ): Promise<TerminalResponse> {
        return await this.#json({
            method: "PATCH",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}`,
            json: request,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/workspaces/:workspaceId/terminals/:terminalId` — stops it and its process. */
    async stopTerminal(
        workspaceId: Cuid2,
        terminalId: Cuid2,
        options: RequestOptions = {},
    ): Promise<TerminalResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}`,
            signal: options.signal,
        });
    }

    /**
     * The URL of `GET /v0/workspaces/:workspaceId/terminals/:terminalId/attach`.
     *
     * The attachment is a WebSocket upgrade carrying binary terminal frames,
     * which `fetch` cannot open. This client hands back the address so a caller
     * can attach with whatever WebSocket its runtime provides; the bearer token
     * goes on that request the same way it does here.
     */
    terminalAttachUrl(workspaceId: Cuid2, terminalId: Cuid2): string {
        return endpointUrl(
            this.#endpoint,
            `v0/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}/attach`,
        );
    }

    /**
     * The URL of `CONNECT /v0/workspaces/:workspaceId/proxy`.
     *
     * The tunnel is a raw byte stream that `fetch` cannot open either, so the
     * address is what this client offers.
     */
    workspaceProxyUrl(workspaceId: Cuid2): string {
        return endpointUrl(
            this.#endpoint,
            `v0/workspaces/${encodeURIComponent(workspaceId)}/proxy`,
        );
    }

    /**
     * The URL of `CONNECT /v0/workspaces/:workspaceId/agents/:agentId/proxy`: the same tunnel,
     * opened in that agent's own network.
     */
    workspaceAgentProxyUrl(workspaceId: Cuid2, agentId: Cuid2): string {
        return endpointUrl(
            this.#endpoint,
            `v0/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/proxy`,
        );
    }

    /**
     * `GET /v0/workspaces/:workspaceId/agents/:agentId/proxy` — the network that agent's
     * connections leave from. Protocol 28 or newer; an older daemon answers `404`.
     */
    async getWorkspaceAgentNetwork(
        workspaceId: Cuid2,
        agentId: Cuid2,
        options: RequestOptions = {},
    ): Promise<WorkspaceAgentNetworkResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/proxy`,
            signal: options.signal,
        });
    }

    /**
     * The URL of `CONNECT /v0/networks/:networkId/proxy`: the same tunnel, opened in the network
     * that `getWorkspaceAgentNetwork` named.
     */
    networkProxyUrl(networkId: string): string {
        if (!Value.Check(networkIdSchema, networkId)) {
            throw new Error("The network ID is invalid.");
        }
        return endpointUrl(this.#endpoint, `v0/networks/${networkId}/proxy`);
    }

    // Sandboxed workspace services: creation belongs to the agent's service_start tool.

    /** `GET /v0/workspaces/:workspaceId/services`. Unavailable is not an empty list. */
    async listWorkspaceServices(
        workspaceId: Cuid2,
        query: WorkspaceServiceListQuery = {},
        options: RequestOptions = {},
    ): Promise<WorkspaceServiceListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/services`,
            query,
            signal: options.signal,
        });
    }

    /** `GET /v0/workspaces/:workspaceId/services/:serviceId`. */
    async getWorkspaceService(
        workspaceId: Cuid2,
        serviceId: Cuid2,
        options: RequestOptions = {},
    ): Promise<WorkspaceServiceResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceId)}`,
            signal: options.signal,
        });
    }

    /** Empty chars reads; non-empty chars writes then reads. Never automatically replay input. */
    async inputWorkspaceService(
        workspaceId: Cuid2,
        serviceId: Cuid2,
        request: WorkspaceServiceInputRequest,
        options: RequestOptions = {},
    ): Promise<WorkspaceServiceInputResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceId)}/input`,
            json: request,
            signal: options.signal,
        });
    }

    /** Stops the runtime, not its record. A stopping response is not proof of termination. */
    async stopWorkspaceService(
        workspaceId: Cuid2,
        serviceId: Cuid2,
        request: StopWorkspaceServiceRequest = {},
        options: RequestOptions = {},
    ): Promise<WorkspaceServiceResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceId)}`,
            json: request,
            signal: options.signal,
        });
    }

    /** Issues a short-lived credential for existing permission; does not create a sharing grant. */
    async issueWorkspaceServiceAccessToken(
        workspaceId: Cuid2,
        serviceId: Cuid2,
        options: RequestOptions = {},
    ): Promise<WorkspaceServiceAccessTokenResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceId)}/access-token`,
            json: {},
            signal: options.signal,
        });
    }

    /**
     * Address of the fixed-service CONNECT tunnel. Fetch cannot open this attachment.
     * Send ordinary API authentication and X-Happy-Service-Authorization separately;
     * neither credential belongs in the URL or in the application request stream.
     */
    workspaceServiceProxyUrl(workspaceId: Cuid2, serviceId: Cuid2): string {
        return endpointUrl(
            this.#endpoint,
            `v0/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceId)}/proxy`,
        );
    }

    // Local bridges: every bridge is opened and held by a WebSocket the caller owns.

    /**
     * `GET /v0/workspaces/:workspaceId/bridges` — what the workspace can bridge, and its open
     * bridges. `404` means the daemon has no bridges, not that the list is empty.
     */
    async listWorkspaceBridges(
        workspaceId: Cuid2,
        options: RequestOptions = {},
    ): Promise<WorkspaceBridgeListResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/bridges`,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/workspaces/:workspaceId/bridges/:bridgeId` — closes an open bridge. */
    async closeWorkspaceBridge(
        workspaceId: Cuid2,
        bridgeId: Cuid2,
        request: CloseWorkspaceBridgeRequest = {},
        options: RequestOptions = {},
    ): Promise<WorkspaceBridgeResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/bridges/${encodeURIComponent(bridgeId)}`,
            json: request,
            signal: options.signal,
        });
    }

    /**
     * The URL of the `GET /v0/workspaces/:workspaceId/bridges/usb` WebSocket upgrade, whose binary
     * messages carry one USB/IP connection. Supply the bearer token on the upgrade request.
     */
    workspaceUsbBridgeUrl(workspaceId: Cuid2, query: WorkspaceUsbBridgeQuery): string {
        return endpointUrl(
            this.#endpoint,
            `v0/workspaces/${encodeURIComponent(workspaceId)}/bridges/usb`,
            { busId: query.busId, id: query.id, name: query.name },
        );
    }

    /**
     * The URL of the `GET /v0/workspaces/:workspaceId/bridges/port` WebSocket upgrade, the JSON
     * control channel of a loopback listener on the workspace's machine.
     */
    workspacePortBridgeUrl(workspaceId: Cuid2, query: WorkspacePortBridgeQuery): string {
        return endpointUrl(
            this.#endpoint,
            `v0/workspaces/${encodeURIComponent(workspaceId)}/bridges/port`,
            { port: query.port, id: query.id, name: query.name },
        );
    }

    /** The URL of the WebSocket upgrade that accepts one waiting port-bridge connection. */
    workspaceBridgeConnectionUrl(workspaceId: Cuid2, bridgeId: Cuid2, connectionId: Cuid2): string {
        return endpointUrl(
            this.#endpoint,
            `v0/workspaces/${encodeURIComponent(workspaceId)}/bridges/${encodeURIComponent(bridgeId)}/connections/${encodeURIComponent(connectionId)}`,
        );
    }

    // Files

    /** `GET /v0/workspaces/:workspaceId/files` — ranked fuzzy workspace-file search. */
    async searchFiles(
        workspaceId: Cuid2,
        query: FileSearchQuery,
        options: RequestOptions = {},
    ): Promise<FileSearchResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/files`,
            query: { query: query.query, limit: query.limit },
            signal: options.signal,
        });
    }

    /** `GET /v0/workspaces/:workspaceId/file-tree` — one directory level, paginated. */
    async getFileTree(
        workspaceId: Cuid2,
        query: FileTreeQuery = {},
        options: RequestOptions = {},
    ): Promise<FileTreeResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/file-tree`,
            query: { path: query.path, cursor: query.cursor, limit: query.limit },
            signal: options.signal,
        });
    }

    /** `GET /v0/workspaces/:workspaceId/file` — base64 content and its sha256. */
    async readFile(
        workspaceId: Cuid2,
        path: string,
        options: RequestOptions = {},
    ): Promise<FileContentResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/file`,
            query: { path },
            signal: options.signal,
        });
    }

    /** `PUT /v0/workspaces/:workspaceId/file` — `expectedHash` is the compare-and-swap. */
    async writeFile(
        workspaceId: Cuid2,
        request: WriteFileRequest,
        options: RequestOptions = {},
    ): Promise<WriteFileResponse> {
        return await this.#json({
            method: "PUT",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/file`,
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/workspaces/:workspaceId/file-revision` — one file as of a revision. */
    async readFileRevision(
        workspaceId: Cuid2,
        query: FileRevisionQuery,
        options: RequestOptions = {},
    ): Promise<FileRevisionResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/file-revision`,
            query: { path: query.path, revision: query.revision },
            signal: options.signal,
        });
    }

    // Git

    /** `GET /v0/workspaces/:workspaceId/git` — scans if nothing fresh is cached. */
    async getWorkspaceGit(
        workspaceId: Cuid2,
        options: RequestOptions = {},
    ): Promise<GitStateResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/workspaces/${encodeURIComponent(workspaceId)}/git`,
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/git/watch` — subscribes workspaces to the live git watcher.
     *
     * Registrations are held per subscription set: a client re-posts its
     * current interest, and workspaces it stops naming age out of the watcher.
     */
    async watchGit(
        request: WatchGitRequest,
        options: RequestOptions = {},
    ): Promise<WatchGitResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/git/watch",
            json: request,
            signal: options.signal,
        });
    }

    // Live voice sessions. Creation and close are never retried automatically.

    /** `POST /v0/live/sessions` — one explicitly authenticated WebRTC call. */
    async createLiveSession(
        request: CreateLiveSessionRequest,
        options: RequestOptions = {},
    ): Promise<CreateLiveSessionResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/live/sessions",
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/live/sessions/:id` — owner-private status and voice usage. */
    async getLiveSession(id: Cuid2, options: RequestOptions = {}): Promise<LiveSessionResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/live/sessions/${encodeURIComponent(id)}`,
            signal: options.signal,
        });
    }

    /** Authenticated WebSocket upgrade URL. The trusted host supplies ordinary bearer headers. */
    liveSessionControlUrl(id: Cuid2, windowId: string): string {
        return endpointUrl(this.#endpoint, `v0/live/sessions/${encodeURIComponent(id)}/control`, {
            windowId,
        });
    }

    /** `POST /v0/live/sessions/:id/close` — leaves coding sessions and their tasks running. */
    async closeLiveSession(
        id: Cuid2,
        request: CloseLiveSessionRequest = {},
        options: RequestOptions = {},
    ): Promise<LiveSessionResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/live/sessions/${encodeURIComponent(id)}/close`,
            json: request,
            signal: options.signal,
        });
    }

    // Agents

    /** `POST /v0/agents` — creates a parentless, user-controlled workspace root. */
    async createAgent(
        request: CreateAgentRequest,
        options: RequestOptions = {},
    ): Promise<AgentResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/agents",
            json: request,
            signal: options.signal,
        });
    }

    /** `GET /v0/agents/:agentId` */
    async getAgent(agentId: Cuid2, options: RequestOptions = {}): Promise<AgentResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/agents/${encodeURIComponent(agentId)}`,
            signal: options.signal,
        });
    }

    /** `GET /v0/agents/:agentId/mode` — the last submitted message mode. */
    async getAgentMode(agentId: Cuid2, options: RequestOptions = {}): Promise<AgentModeResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/agents/${encodeURIComponent(agentId)}/mode`,
            signal: options.signal,
        });
    }

    /** `GET /v0/agents/:agentId/bootstrap` — current agent state, activity, and cursor. */
    async getAgentBootstrap(
        agentId: Cuid2,
        options: RequestOptions = {},
    ): Promise<AgentBootstrapResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/agents/${encodeURIComponent(agentId)}/bootstrap`,
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/agents/:agentId/send` — queues a message, or steers the run.
     *
     * The message is pending until inference accepts it; the acceptance travels
     * inside a `run.started` or `run.boundary` event, and the `runId` it brings
     * is the handle for `abortAgent`.
     * Execution provenance is omitted from outbound modes.
     */
    async sendMessage(
        agentId: Cuid2,
        request: SendMessageRequest,
        options: RequestOptions = {},
    ): Promise<SendMessageResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/send`,
            json: { ...request, mode: requestedMode(request.mode) },
            signal: options.signal,
        });
    }

    /**
     * `GET /v0/agents/:agentId/messages` — history, grouped by run.
     *
     * `limit` is a lower bound: a page always contains whole runs and may
     * overflow well past it, so buffers are sized for the runs received.
     */
    async getMessages(
        agentId: Cuid2,
        query: MessageHistoryQuery = {},
        options: RequestOptions = {},
    ): Promise<MessageHistoryResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/agents/${encodeURIComponent(agentId)}/messages`,
            query: {
                before: query.before,
                after: query.after,
                limit: query.limit,
                omitToolData: query.omitToolData,
            },
            signal: options.signal,
        });
    }

    /**
     * `GET /v0/agents/:agentId/tool-calls/:toolCallId/media/:index` — the bytes of one item of a
     * completed call's `media` presentation, or one range of them; `null` when `ifNoneMatch`
     * still matches.
     */
    async getToolCallMedia(
        agentId: Cuid2,
        toolCallId: Cuid2,
        index: number,
        options: ToolCallMediaRequestOptions = {},
    ): Promise<ToolCallMediaContent | null> {
        const response = await this.#send({
            method: "GET",
            path: toolCallMediaPath(agentId, toolCallId, index),
            accept: "*/*",
            ifNoneMatch: options.ifNoneMatch,
            range: options.range === undefined ? undefined : rangeHeader(options.range),
            signal: options.signal,
            allowNotModified: true,
        });
        if (response.status === 304) return null;
        return {
            contentRange: response.status === 206 ? response.headers.get("content-range") : null,
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
            data: await response.arrayBuffer(),
            etag: response.headers.get("etag"),
        };
    }

    /**
     * The URL of `GET /v0/agents/:agentId/tool-calls/:toolCallId/media/:index`, for an image,
     * video, or document element that loads the bytes through a transport adding the bearer token.
     */
    toolCallMediaUrl(agentId: Cuid2, toolCallId: Cuid2, index: number): string {
        return endpointUrl(this.#endpoint, toolCallMediaPath(agentId, toolCallId, index));
    }

    /** `GET /v0/agents/:agentId/question` — the open question, or `null`. */
    async getPendingQuestion(
        agentId: Cuid2,
        options: RequestOptions = {},
    ): Promise<PendingQuestionResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/agents/${encodeURIComponent(agentId)}/question`,
            signal: options.signal,
        });
    }

    /**
     * `POST /v0/agents/:agentId/question/:questionId/answer` — the run resumes.
     *
     * Answering is first-write-wins across clients: a second answer is `409`
     * carrying the question as it now stands.
     */
    async answerQuestion(
        agentId: Cuid2,
        questionId: Cuid2,
        request: AnswerQuestionRequest,
        options: RequestOptions = {},
    ): Promise<QuestionResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/question/${encodeURIComponent(questionId)}/answer`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/agents/:agentId/abort` — immediately aborts this and every descendant run. */
    async abortAgent(
        agentId: Cuid2,
        request: AbortAgentRequest = {},
        options: RequestOptions = {},
    ): Promise<AgentAbortResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/abort`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/agents/:agentId/compact` — summarizes older context for the model. */
    async compactAgent(
        agentId: Cuid2,
        request: MutationOnlyRequest = {},
        options: RequestOptions = {},
    ): Promise<AgentCompactResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/compact`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/agents/:agentId/messages/:messageId/retry` — runs a failed turn again. */
    async retryFailedTurn(
        agentId: Cuid2,
        messageId: Cuid2,
        request: RetryFailedTurnRequest = {},
        options: RequestOptions = {},
    ): Promise<FailureResolutionResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}/retry`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/agents/:agentId/messages/:messageId/switch` — moves the chat and continues. */
    async switchAndContinue(
        agentId: Cuid2,
        messageId: Cuid2,
        request: SwitchAndContinueRequest,
        options: RequestOptions = {},
    ): Promise<FailureResolutionResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}/switch`,
            json: request,
            signal: options.signal,
        });
    }

    /** The slash command's image bytes; `null` when the caller's `ETag` is still current. */
    async getSlashCommandImage(
        agentId: Cuid2,
        name: string,
        options: ConditionalRequestOptions = {},
    ): Promise<BinaryContent | null> {
        return await this.#binary({
            method: "GET",
            path: `v0/agents/${encodeURIComponent(agentId)}/slash-commands/${encodeURIComponent(name)}/image`,
            ifNoneMatch: options.ifNoneMatch,
            signal: options.signal,
        });
    }

    /** Invoke a slash command directly on the agent module that contributed it. */
    async invokeSlashCommand(
        agentId: Cuid2,
        name: string,
        request: InvokeSlashCommandRequest,
        options: RequestOptions = {},
    ): Promise<InvokeSlashCommandResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/slash-commands/${encodeURIComponent(name)}`,
            json: { ...request, mode: requestedMode(request.mode) },
            signal: options.signal,
        });
    }

    /** `POST /v0/agents/:agentId/read` — clears `unread`. */
    async markAgentRead(
        agentId: Cuid2,
        request: MutationOnlyRequest = {},
        options: RequestOptions = {},
    ): Promise<AgentResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/read`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/agents/:agentId/archive` — keeps the history; aborts a running turn. */
    async archiveAgent(
        agentId: Cuid2,
        request: MutationOnlyRequest = {},
        options: RequestOptions = {},
    ): Promise<AgentResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/archive`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/agents/:agentId/unarchive` — idempotent. */
    async unarchiveAgent(
        agentId: Cuid2,
        request: MutationOnlyRequest = {},
        options: RequestOptions = {},
    ): Promise<AgentResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/unarchive`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/agents/:agentId/reorder` — moves the agent in the list order. */
    async reorderAgent(
        agentId: Cuid2,
        request: ReorderAgentRequest,
        options: RequestOptions = {},
    ): Promise<AgentResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/reorder`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/agents/:agentId/subtask-reorder` — moves a subtask among its siblings. */
    async reorderSubtask(
        agentId: Cuid2,
        request: ReorderSubtaskRequest,
        options: RequestOptions = {},
    ): Promise<AgentResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/subtask-reorder`,
            json: request,
            signal: options.signal,
        });
    }

    /** `PUT /v0/agents/:agentId/draft` — saves or clears the composer draft. */
    async saveAgentDraft(
        agentId: Cuid2,
        request: SaveAgentDraftRequest,
        options: RequestOptions = {},
    ): Promise<AgentDraftResponse> {
        return await this.#json({
            method: "PUT",
            path: `v0/agents/${encodeURIComponent(agentId)}/draft`,
            json: {
                ...request,
                draft: request.draft === null ? null : requestedMode(request.draft),
            },
            signal: options.signal,
        });
    }

    /** `GET /v0/agents/:agentId/draft` — current composer state and LWW timestamp. */
    async getAgentDraft(agentId: Cuid2, options: RequestOptions = {}): Promise<AgentDraftResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/agents/${encodeURIComponent(agentId)}/draft`,
            signal: options.signal,
        });
    }

    /** `GET /v0/agents/:agentId/usage` — the agent's whole life, subagents included. */
    async getAgentUsage(agentId: Cuid2, options: RequestOptions = {}): Promise<AgentUsageResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/agents/${encodeURIComponent(agentId)}/usage`,
            signal: options.signal,
        });
    }

    /** `GET /v0/agents/:agentId/activity` — every subagent and process it set in motion. */
    async getAgentActivity(
        agentId: Cuid2,
        options: RequestOptions = {},
    ): Promise<AgentActivityResponse> {
        return await this.#json({
            method: "GET",
            path: `v0/agents/${encodeURIComponent(agentId)}/activity`,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/agents/:agentId/processes/:processId` — stops a running process. */
    async stopProcess(
        agentId: Cuid2,
        processId: Cuid2,
        options: RequestOptions = {},
    ): Promise<BackgroundProcessResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/agents/${encodeURIComponent(agentId)}/processes/${encodeURIComponent(processId)}`,
            signal: options.signal,
        });
    }

    /** `GET /v0/usage` — the whole daemon, in rolling windows ending now. */
    async getUsage(options: RequestOptions = {}): Promise<DaemonUsageResponse> {
        return await this.#json({ method: "GET", path: "v0/usage", signal: options.signal });
    }

    /**
     * `POST /v0/usage/refresh` — asks for fresher provider-account readings, protocol 29 or newer.
     *
     * Answers at once with the accounts whose reads started; the readings themselves arrive as
     * `provider.usage.updated` events. An older daemon answers `404`.
     */
    async refreshProviderUsage(
        request: ProviderUsageRefreshRequest = {},
        options: RequestOptions = {},
    ): Promise<ProviderUsageRefreshResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/usage/refresh",
            json: request,
            signal: options.signal,
        });
    }

    // Events

    /**
     * `GET /v0/events` — pulls events, oldest first.
     *
     * A cursor that fell out of the bounded journal answers `409` with code
     * `cursor_unavailable`, carrying the cursor to resync from.
     */
    async getEvents(
        query: EventPageQuery = {},
        options: RequestOptions = {},
    ): Promise<EventPageResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/events",
            query: { after: query.after, until: query.until, limit: query.limit },
            signal: options.signal,
        });
    }

    /**
     * `GET /v0/events/stream` — the same journal, live.
     *
     * The iteration yields the opening `hello` frame and then every event, and
     * ends when the daemon closes the stream or the signal aborts. One
     * connection is one iteration: reconnecting is the caller's decision, made
     * with the last cursor it received and honored through `after` or
     * `lastEventId`.
     */
    async *streamEvents(options: EventStreamOptions = {}): AsyncGenerator<EventStreamFrame> {
        const response = await this.#send({
            method: "GET",
            path: "v0/events/stream",
            query: { after: options.after },
            accept: "text/event-stream",
            lastEventId: options.lastEventId,
            signal: options.signal,
        });
        if (response.body === null) {
            throw new EventStreamProtocolError("The event stream carried no body.");
        }
        yield* readEventStream(response.body);
    }

    /**
     * Follows daemon updates across connection failures.
     *
     * Events are yielded in strictly increasing cursor order. Duplicate and
     * older events are ignored, reconnects resume after the last accepted
     * cursor with exponential backoff, and connection, interruption, and
     * recoverable journal-gap transitions are visible in the same ordered
     * iteration.
     */
    async *updates(options: HappyAgentUpdatesOptions = {}): AsyncGenerator<HappyAgentUpdate> {
        yield* reconnectingUpdates((streamOptions) => this.streamEvents(streamOptions), options);
    }

    // Bootstrap

    /**
     * `GET /v0/bootstrap/desktop` — one request that gets a client on screen.
     *
     * The `cursor` it carries is the newest event as of the snapshot, so a
     * stream opened from it leaves no window for a change to fall through.
     */
    async getDesktopBootstrap(options: RequestOptions = {}): Promise<DesktopBootstrapResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/bootstrap/desktop",
            signal: options.signal,
        });
    }

    // Making the request

    async #json<TResponse>(request: HttpRequest): Promise<TResponse> {
        const response = await this.#send(request);
        return (await response.json()) as TResponse;
    }

    async #jsonWithStatus<TResponse extends object, TStatus extends number>(
        request: HttpRequest,
    ): Promise<TResponse & { httpStatus: TStatus }> {
        const response = await this.#send(request);
        return {
            ...((await response.json()) as TResponse),
            httpStatus: response.status as TStatus,
        };
    }

    async #binary(request: HttpRequest): Promise<BinaryContent | null> {
        const response = await this.#send({
            ...request,
            accept: "image/*",
            allowNotModified: true,
        });
        if (response.status === 304) return null;
        return {
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
            data: await response.arrayBuffer(),
            etag: response.headers.get("etag"),
        };
    }

    async #send(request: HttpRequest): Promise<Response> {
        const headers: Record<string, string> = {
            accept: request.accept ?? "application/json",
        };
        const token = typeof this.#token === "function" ? await this.#token() : this.#token;
        if (token !== undefined) headers.authorization = `Bearer ${token}`;
        if (request.ifMatch !== undefined) headers["if-match"] = request.ifMatch;
        if (request.ifNoneMatch !== undefined) headers["if-none-match"] = request.ifNoneMatch;
        if (request.lastEventId !== undefined) headers["last-event-id"] = request.lastEventId;
        if (request.range !== undefined) headers.range = request.range;

        let body: BodyInit | null = null;
        if (request.binary !== undefined) {
            headers["content-type"] = request.binary.contentType;
            body = request.binary.data;
        } else if (request.json !== undefined) {
            headers["content-type"] = "application/json; charset=utf-8";
            body = JSON.stringify(request.json);
        }

        const response = await this.#fetch(
            endpointUrl(this.#endpoint, request.path, request.query),
            {
                method: request.method,
                headers,
                body,
                signal: request.signal ?? null,
            },
        );
        if (response.ok) return response;
        if (response.status === 304 && request.allowNotModified === true) return response;
        throw await readApiError(response);
    }
}

/**
 * The JSON body of a mutation whose only field is the optional mutation echo.
 *
 * Archiving names nothing but the resource itself, so one options object
 * carries the `If-Match` version, the signal, and the single body field; this
 * keeps the transport parts out of what is sent.
 */
function bodyOf(options: { mutationId?: string }): { mutationId?: string } {
    return options.mutationId === undefined ? {} : { mutationId: options.mutationId };
}

/** A setting's route; keys need no percent-encoding, so an invalid one is refused before sending. */
function userSettingPath(key: UserSettingKey): string {
    if (!Value.Check(userSettingKeySchema, key)) {
        throw new Error("The user setting key is invalid.");
    }
    return `v0/user-settings/${key}`;
}

function artifactVersionPath(artifactId: Cuid2, version: ArtifactVersionSelector): string {
    return `v0/artifacts/${encodeURIComponent(artifactId)}/versions/${String(version)}`;
}

/** A file's route, with each segment of its path percent-encoded and the slashes kept. */
function artifactFilePath(
    artifactId: Cuid2,
    version: ArtifactVersionSelector,
    path: ArtifactPath,
): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `${artifactVersionPath(artifactId, version)}/files/${encoded}`;
}

/** The `Range` header for one byte range. */
function storyPath(storyId: Cuid2): string {
    return `v0/stories/${encodeURIComponent(storyId)}`;
}

function storyOverlayMediaPath(storyId: Cuid2, overlayId: Cuid2): string {
    return `${storyPath(storyId)}/overlays/${encodeURIComponent(overlayId)}/media`;
}

function storyFramePath(storyId: Cuid2, frameId: Cuid2): string {
    return `${storyPath(storyId)}/frames/${encodeURIComponent(frameId)}`;
}

function toolCallMediaPath(agentId: Cuid2, toolCallId: Cuid2, index: number): string {
    if (!Number.isSafeInteger(index) || index < 0) {
        throw new TypeError("A media index must be a non-negative integer.");
    }
    return `v0/agents/${encodeURIComponent(agentId)}/tool-calls/${encodeURIComponent(toolCallId)}/media/${String(index)}`;
}

function rangeHeader(range: ByteRange): string {
    if (range.suffix !== undefined) return `bytes=-${String(range.suffix)}`;
    return `bytes=${String(range.start)}-${range.end === undefined ? "" : String(range.end)}`;
}

/** Provenance is output-only, and older compatible daemons reject it in request modes. */
function requestedMode<T extends MessageMode>(mode: T): Omit<T, "account" | "providerType"> {
    const { account: _account, providerType: _providerType, ...requested } = mode;
    return requested;
}

function secretAttachmentPath(secretId: Cuid2, target: SecretAttachmentTarget): string {
    return `v0/secrets/${encodeURIComponent(secretId)}/attachments/${encodeURIComponent(target.type)}/${encodeURIComponent(target.id)}`;
}
