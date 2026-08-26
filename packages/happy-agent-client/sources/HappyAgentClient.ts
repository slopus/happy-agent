import type { Cuid2 } from "./protocol/common.js";
import type {
    BinaryContent,
    ConditionalRequestOptions,
    ImageUpload,
    OptionallyVersionedRequestOptions,
    RequestOptions,
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
    MutationOnlyRequest,
    ReorderAgentRequest,
    SaveAgentDraftRequest,
} from "./protocol/agents.js";
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
    CloudAccessTokenResponse,
    CloudAuthorizingResponse,
    CloudConnectedResponse,
    CloudDisconnectedResponse,
    CloudMutationRequest,
    CloudProfileResponse,
    CloudResponse,
    CompleteCloudAuthorizationRequest,
    EnrollCloudProfileRequest,
    StartCloudAuthorizationRequest,
} from "./protocol/cloud.js";
import type {
    ConfigPatch,
    ConfigResponse,
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
    SharingIdentity,
    SharingInvitationResponse,
    SharingMutationRequest,
    SharingRequestId,
    SharingRequestSubmission,
    SharingResponse,
} from "./protocol/sharing.js";
import type {
    MessageHistoryQuery,
    MessageHistoryResponse,
    SendMessageRequest,
    SendMessageResponse,
} from "./protocol/messages.js";
import type { BackgroundProcessResponse } from "./protocol/processes.js";
import type { ProfileResponse, ProfileUpdateRequest } from "./protocol/profile.js";
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
    OpenTerminalRequest,
    ResizeTerminalRequest,
    TerminalListResponse,
    TerminalResponse,
} from "./protocol/terminals.js";
import type { AgentUsageResponse, DaemonUsageResponse } from "./protocol/usage.js";
import type {
    InvokeSlashCommandRequest,
    InvokeSlashCommandResponse,
} from "./protocol/slashCommands.js";
import type {
    ArchiveWorkspaceRequest,
    CreateWorkspaceRequest,
    ListWorkspacesQuery,
    RenameWorkspaceRequest,
    ReorderWorkspaceRequest,
    WorkspaceListResponse,
    WorkspaceResponse,
} from "./protocol/workspaces.js";
import type { QueryParameters } from "./endpointUrl.js";
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
    /** The bearer token; every route, health included, requires one. */
    token: string;
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
    /** A binary body, for the picture routes. */
    binary?: ImageUpload;
    accept?: string;
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
    readonly #token: string;
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

    // The daemon

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

    /** `POST /v0/drain` — permanently enters this daemon process's read-only drain mode. */
    async drain(options: RequestOptions = {}): Promise<DrainResponse> {
        return await this.#json({ method: "POST", path: "v0/drain", signal: options.signal });
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

    /** `GET /v0/cloud/profile` — reads the connected user's durable Cloud profile. */
    async getCloudProfile(options: RequestOptions = {}): Promise<CloudProfileResponse> {
        return await this.#json({
            method: "GET",
            path: "v0/cloud/profile",
            signal: options.signal,
        });
    }

    /** `PUT /v0/cloud/profile` — enrolls using the local profile and supplied username. */
    async enrollCloudProfile(
        request: EnrollCloudProfileRequest,
        options: RequestOptions = {},
    ): Promise<CloudProfileResponse> {
        return await this.#json({
            method: "PUT",
            path: "v0/cloud/profile",
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

    // Sharing

    /** `GET /v0/sharing` — current contacts state, enrolled or not. */
    async getSharing(options: RequestOptions = {}): Promise<SharingResponse> {
        return await this.#json({ method: "GET", path: "v0/sharing", signal: options.signal });
    }

    /** `POST /v0/sharing/enroll` — opts in once; later calls are idempotent. */
    async enrollSharing(
        request: SharingMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<SharingResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/sharing/enroll",
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/sharing/invitations` — returns a sensitive five-minute capability. */
    async createSharingInvitation(
        options: RequestOptions = {},
    ): Promise<SharingInvitationResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/sharing/invitations",
            signal: options.signal,
        });
    }

    /** `POST /v0/sharing/requests` — redeems another person's invitation. */
    async submitSharingRequest(
        request: SharingRequestSubmission,
        options: RequestOptions = {},
    ): Promise<SharingResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/sharing/requests",
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/sharing/requests/:requestId/accept` — makes the peer a contact. */
    async acceptSharingRequest(
        requestId: SharingRequestId,
        request: SharingMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<SharingResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/sharing/requests/${encodeURIComponent(requestId)}/accept`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/sharing/requests/:requestId/reject` — declines the pending request. */
    async rejectSharingRequest(
        requestId: SharingRequestId,
        request: SharingMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<SharingResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/sharing/requests/${encodeURIComponent(requestId)}/reject`,
            json: request,
            signal: options.signal,
        });
    }

    /** `DELETE /v0/sharing/contacts/:identity` — ends the relationship on both sides. */
    async removeSharingContact(
        identity: SharingIdentity,
        request: SharingMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<SharingResponse> {
        return await this.#json({
            method: "DELETE",
            path: `v0/sharing/contacts/${encodeURIComponent(identity)}`,
            json: request,
            signal: options.signal,
        });
    }

    /** `POST /v0/sharing/reset` — replaces the identity and clears every relationship. */
    async resetSharing(
        request: SharingMutationRequest = {},
        options: RequestOptions = {},
    ): Promise<SharingResponse> {
        return await this.#json({
            method: "POST",
            path: "v0/sharing/reset",
            json: request,
            signal: options.signal,
        });
    }

    // Profile

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

    // Agents

    /** `POST /v0/agents` — creation always makes a user-visible workspace root. */
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
     */
    async sendMessage(
        agentId: Cuid2,
        request: SendMessageRequest,
        options: RequestOptions = {},
    ): Promise<SendMessageResponse> {
        return await this.#json({
            method: "POST",
            path: `v0/agents/${encodeURIComponent(agentId)}/send`,
            json: request,
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
            json: request,
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

    /** `PUT /v0/agents/:agentId/draft` — saves or clears the composer draft. */
    async saveAgentDraft(
        agentId: Cuid2,
        request: SaveAgentDraftRequest,
        options: RequestOptions = {},
    ): Promise<AgentDraftResponse> {
        return await this.#json({
            method: "PUT",
            path: `v0/agents/${encodeURIComponent(agentId)}/draft`,
            json: request,
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
            authorization: `Bearer ${this.#token}`,
        };
        if (request.ifMatch !== undefined) headers["if-match"] = request.ifMatch;
        if (request.ifNoneMatch !== undefined) headers["if-none-match"] = request.ifNoneMatch;
        if (request.lastEventId !== undefined) headers["last-event-id"] = request.lastEventId;

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
