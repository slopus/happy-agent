import { timingSafeEqual } from "node:crypto";

import type {
    Cloud,
    CloudAccessTokenResponse,
    CloudAuthorizing,
    CloudConnected,
    CloudDisconnected,
    CloudEnvironment,
    CloudOrganization,
    CloudOrganizationsResponse,
    CloudUser,
    CompleteCloudAuthorizationRequest,
    StartCloudAuthorizationRequest,
} from "@slopus/happy-agent-client";
import {
    cloudOrganizationSchema,
    createCloudOrganizationRequestSchema,
} from "@slopus/happy-agent-client";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import {
    afterCommit,
    asyncLock,
    delay,
    detach,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { DurableFunctionsModule } from "../durableFunctions/index.js";

import {
    cloudSession,
    createCloudDatabase,
    type CloudSession,
    type CloudStoredState,
    type CloudStoredValue,
} from "./CloudDatabase.js";
import {
    CLOUD_AUTHORIZATION_EXPIRY_FUNCTION,
    CLOUD_AUTHORIZATION_EXPIRY_OPERATION,
    cloudAuthorizationExpiryArgumentsSchema,
    cloudAuthorizationExpiryResultSchema,
    type CloudAuthorizationExpiryArguments,
} from "./CloudDurableFunctions.js";
import {
    CloudCredentialsRejectedError,
    CloudIdentityMismatchError,
    CloudInvitationConflictError,
    CloudOrganizationForbiddenError,
    CloudOrganizationInvalidEndpointError,
    CloudOrganizationInvalidRequestError,
    CloudServiceUnavailableError,
    CloudWorkOS,
    type CloudAuthentication,
} from "./CloudWorkOS.js";
import { createCloudVersion } from "./createCloudVersion.js";
import { cloudMigrations } from "./CloudMigrations.js";
import { shortLivedWorkOSToken, type ShortLivedWorkOSToken } from "./shortLivedWorkOSToken.js";
import {
    happyTeamEndpointInputSchema,
    normalizeHappyTeamEndpoint,
    type HappyTeam,
} from "./HappyTeam.js";
import {
    happyTeamInvitationOrganizationIdSchema,
    normalizeHappyTeamInvitationEmail,
    type HappyTeamInvitation,
} from "./HappyTeamInvitation.js";

const AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1_000;
const AUTHORIZATION_EXPIRY_RETRY_MS = 5_000;

interface CloudAttempt {
    readonly codeVerifier: string;
    readonly environment: CloudEnvironment;
    readonly expiresAt: number;
    readonly phase: "active" | "consumed";
    readonly redirectUri: string;
    readonly state: string;
    readonly url: string;
    readonly version: string;
}

type CloudAttemptDraft = Omit<CloudAttempt, "version">;

interface CloudReplacementOptions {
    readonly attempt?: CloudAttempt;
    readonly cancelAuthorizationExpiry?: boolean;
    readonly onCommit?: () => void;
}

interface MintedCloudCredential extends CloudAccessTokenResponse {
    readonly authenticated: CloudAuthentication;
    readonly session: CloudSession;
}

type CloudStoredReplacement = CloudStoredValue;

export type CloudUpdatedListener = (ctx: Context, cloud: Cloud) => void;

export type CloudOperationErrorCode =
    | "cloud_not_authenticated"
    | "cloud_unauthorized"
    | "cloud_unavailable"
    | "conflict"
    | "forbidden"
    | "invalid_request"
    | "not_found";

/** A display-safe Cloud failure carrying the authoritative current snapshot. */
export class CloudOperationError extends Error {
    readonly cloud: Cloud;
    readonly code: CloudOperationErrorCode;
    readonly status: 400 | 403 | 404 | 409 | 503;

    constructor(
        status: 400 | 403 | 404 | 409 | 503,
        code: CloudOperationErrorCode,
        message: string,
        cloud: Cloud,
    ) {
        super(message);
        this.name = "CloudOperationError";
        this.status = status;
        this.code = code;
        this.cloud = cloud;
    }
}

/** Owns WorkOS authentication, token minting, and Happy Cloud organizations. */
export class CloudModule implements AgentModule {
    readonly name = "cloud";
    readonly migrations = cloudMigrations;

    readonly #database = createCloudDatabase();
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #listeners = new Set<CloudUpdatedListener>();
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #clients = new Map<CloudEnvironment, CloudWorkOS>();
    #attempt: CloudAttempt | undefined;
    #cloud: Cloud;
    #context: Context | undefined;
    #stopping = false;

    constructor(durableFunctions: DurableFunctionsModule) {
        this.#durableFunctions = durableFunctions;
        const updatedAt = Date.now();
        this.#cloud = freezeCloud({
            authorization: null,
            environment: null,
            error: null,
            status: "disconnected",
            updatedAt,
            user: null,
            version: createCloudVersion(undefined, () => updatedAt),
        });
        durableFunctions.register({
            name: CLOUD_AUTHORIZATION_EXPIRY_FUNCTION,
            argumentsSchema: cloudAuthorizationExpiryArgumentsSchema,
            resultSchema: cloudAuthorizationExpiryResultSchema,
            executor: async (ctx, call) => {
                await this.#executeAuthorizationExpiry(ctx, call.arguments);
                return null;
            },
        });
    }

    readonly beforeStart = async (
        ctx: Context,
        _agents: AgentSystemRef<LibSQLDatabase>,
    ): Promise<AgentModuleHooks> => {
        const database = agentDatabase(ctx);
        if (database === undefined) throw new Error("Cloud was started without an agent database.");
        this.#context = withAgentDatabase(detach(ctx).named("cloud"), database);
        await this.#lock.runInLock(
            this.#context,
            async () => await this.#initialize(this.#context!),
        );
        return {};
    };

    async stop(): Promise<void> {
        const ctx = this.#context;
        if (ctx === undefined) {
            this.#stopping = true;
            this.#attempt = undefined;
            return;
        }
        await this.#lock.runInLock(ctx, async () => {
            this.#stopping = true;
            this.#attempt = undefined;
        });
    }

    status(_ctx: Context): Cloud {
        return this.#cloud;
    }

    onUpdated(listener: CloudUpdatedListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    async start(_ctx: Context, request: StartCloudAuthorizationRequest): Promise<CloudAuthorizing> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            if (this.#cloud.status === "connected") {
                throw this.#error(
                    409,
                    "conflict",
                    "Disconnect Cloud before connecting another account.",
                );
            }
            const redirectUri = validRedirectUri(request.redirectUri, this.#cloud);
            const current = this.#attempt;
            if (
                current !== undefined &&
                current.phase === "active" &&
                Date.now() >= current.expiresAt
            ) {
                await this.#expire(ctx, current);
            } else if (
                current !== undefined &&
                current.phase === "active" &&
                current.environment === request.environment &&
                current.redirectUri === redirectUri
            ) {
                return this.#authorizing();
            }

            // Cloud credentials commit on this module's independently owned database lifetime.
            // The owner transaction preflight also fails before contacting WorkOS if a caller
            // accidentally invokes the workflow from inside another transaction on the same
            // database connection.
            await this.#readOwned(ctx);

            const secret = await this.#client(request.environment)
                .authorization(redirectUri)
                .catch((error: unknown) => {
                    logCloudFailure(
                        ctx,
                        "authorization",
                        request.environment,
                        "workos-start",
                        error,
                    );
                    throw this.#error(
                        503,
                        "cloud_unavailable",
                        "Cloud authorization is temporarily unavailable.",
                    );
                });
            const attempt: CloudAttemptDraft = {
                ...secret,
                environment: request.environment,
                expiresAt: Date.now() + AUTHORIZATION_LIFETIME_MS,
                phase: "active",
                redirectUri,
            };
            const cloud = await this.#beginAttempt(ctx, attempt);
            return authorizing(cloud);
        });
    }

    async complete(
        _ctx: Context,
        request: CompleteCloudAuthorizationRequest,
    ): Promise<CloudConnected> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const attempt = this.#attempt;
            if (attempt === undefined || attempt.phase !== "active") {
                throw this.#error(
                    400,
                    "invalid_request",
                    "There is no Cloud authorization waiting for this callback.",
                );
            }
            if (Date.now() >= attempt.expiresAt) {
                const cloud = await this.#expire(ctx, attempt);
                throw new CloudOperationError(
                    400,
                    "invalid_request",
                    "The Cloud authorization has expired.",
                    cloud,
                );
            }
            const callback = parseCallback(request.callbackUrl, attempt, this.#cloud);
            await this.#readOwned(ctx);
            const consumed: CloudAttempt = { ...attempt, phase: "consumed" };
            this.#attempt = consumed;

            if (callback.kind === "error") {
                const rejected = callback.error === "access_denied";
                if (!rejected) {
                    ctx.log.warn(
                        `cloud:authorization:error environment=${attempt.environment} phase=oauth-callback reason=provider-error`,
                    );
                }
                const cloud = await this.#settleAttempt(
                    ctx,
                    rejected
                        ? {
                              error: {
                                  code: "authorization_rejected",
                                  message: "Cloud authorization was not approved.",
                              },
                              pending: false,
                              session: null,
                          }
                        : { error: null, pending: false, session: null },
                    consumed,
                );
                throw new CloudOperationError(
                    rejected ? 409 : 503,
                    rejected ? "cloud_unauthorized" : "cloud_unavailable",
                    rejected
                        ? "Cloud authorization was not approved."
                        : "Cloud authorization is temporarily unavailable.",
                    cloud,
                );
            }

            let authenticated;
            let phase = "workos-exchange";
            try {
                authenticated = await this.#client(attempt.environment).exchange(
                    callback.code,
                    attempt.codeVerifier,
                );
                phase = "cloud-hello";
                await this.#client(attempt.environment).verify(
                    authenticated.accessToken,
                    authenticated.user.id,
                );
            } catch (error: unknown) {
                logCloudFailure(ctx, "authorization", attempt.environment, phase, error);
                const rejected =
                    error instanceof CloudCredentialsRejectedError ||
                    error instanceof CloudIdentityMismatchError;
                const cloud = await this.#settleAttempt(
                    ctx,
                    {
                        error: rejected
                            ? {
                                  code: "authorization_rejected",
                                  message: "Cloud rejected the authorization.",
                              }
                            : null,
                        pending: false,
                        session: null,
                    },
                    consumed,
                );
                throw new CloudOperationError(
                    rejected ? 409 : 503,
                    rejected ? "cloud_unauthorized" : "cloud_unavailable",
                    rejected
                        ? "Cloud rejected the authorization."
                        : "Cloud authorization could not be verified.",
                    cloud,
                );
            }

            const cloud = await ctx.inTx(async (txCtx) => {
                const settled = await this.#settleAttempt(
                    txCtx,
                    {
                        error: null,
                        pending: false,
                        session: cloudSession(
                            attempt.environment,
                            authenticated.refreshToken,
                            authenticated.user,
                        ),
                    },
                    consumed,
                );
                return settled;
            });
            return connected(cloud);
        });
    }

    async disconnect(ctx: Context): Promise<CloudDisconnected> {
        const bound = withAgentDatabase(ctx, agentDatabase(this.#ownedContext())!);
        return await this.#lock.runInLock(bound, async (lockCtx) => {
            this.#assertRunning();
            return await lockCtx.inTx(async (txCtx) => {
                const stored = await this.#database.read(txCtx);
                if (stored?.session === null && !stored.pending && stored.error === null) {
                    return disconnected(project(stored));
                }
                return disconnected(
                    await this.#replace(
                        txCtx,
                        { error: null, pending: false, session: null },
                        {
                            cancelAuthorizationExpiry: true,
                            onCommit: () => {
                                this.#attempt = undefined;
                            },
                        },
                    ),
                );
            });
        });
    }

    async mint(_ctx: Context): Promise<CloudAccessTokenResponse> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const minted = await this.#mintInLock(ctx, true);
            return { accessToken: minted.accessToken, cloud: minted.cloud };
        });
    }

    /** Mint for a configured team through the same serialized credential-rotation boundary. */
    async mintForOrganization(
        _ctx: Context,
        organizationId: string,
        signal?: AbortSignal,
    ): Promise<string> {
        signal?.throwIfAborted();
        if (!Value.Check(cloudOrganizationSchema.properties.id, organizationId)) {
            throw this.#error(400, "invalid_request", "The team organization ID is invalid.");
        }
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            signal?.throwIfAborted();
            this.#assertRunning();
            return (await this.#mintInLock(ctx, true, organizationId)).accessToken;
        });
    }

    /** Release an organization credential only when WorkOS's real lifetime is at most five minutes. */
    async mintShortLivedForOrganization(
        _ctx: Context,
        organizationId: string,
    ): Promise<ShortLivedWorkOSToken> {
        if (!Value.Check(cloudOrganizationSchema.properties.id, organizationId)) {
            throw this.#error(400, "invalid_request", "The team organization ID is invalid.");
        }
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const minted = await this.#mintInLock(ctx, true, organizationId);
            return shortLivedWorkOSToken(
                minted.accessToken,
                organizationId,
                minted.authenticated.user.id,
                this.#client(minted.cloud.environment).workosClientId,
            );
        });
    }

    async listOrganizations(_ctx: Context): Promise<CloudOrganizationsResponse> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const minted = await this.#mintInLock(ctx, true);
            try {
                return {
                    organizations: await this.#client(minted.cloud.environment).listOrganizations(
                        minted.accessToken,
                    ),
                };
            } catch (error: unknown) {
                logCloudFailure(
                    ctx,
                    "organizations",
                    minted.cloud.environment,
                    "cloud-organizations-list",
                    error,
                );
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "Cloud organizations are temporarily unavailable.",
                );
            }
        });
    }

    async createOrganization(_ctx: Context, name: string): Promise<CloudOrganization> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            if (!Value.Check(createCloudOrganizationRequestSchema.properties.name, name)) {
                throw this.#error(
                    400,
                    "invalid_request",
                    "The Cloud organization name is invalid.",
                );
            }
            const minted = await this.#mintInLock(ctx, true);
            try {
                return await this.#client(minted.cloud.environment).createOrganization(
                    minted.accessToken,
                    name,
                );
            } catch (error: unknown) {
                if (error instanceof CloudOrganizationInvalidRequestError) {
                    throw this.#error(
                        400,
                        "invalid_request",
                        "The Cloud organization name is invalid.",
                    );
                }
                logCloudFailure(
                    ctx,
                    "organizations",
                    minted.cloud.environment,
                    "cloud-organization-create",
                    error,
                );
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "Cloud organizations are temporarily unavailable.",
                );
            }
        });
    }

    async deleteOrganization(_ctx: Context, organizationId: string): Promise<void> {
        const ctx = this.#ownedContext();
        await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            if (!Value.Check(cloudOrganizationSchema.properties.id, organizationId)) {
                throw this.#error(400, "invalid_request", "The Cloud organization ID is invalid.");
            }
            const minted = await this.#mintInLock(ctx, true);
            try {
                await this.#client(minted.cloud.environment).deleteOrganization(
                    minted.accessToken,
                    organizationId,
                );
            } catch (error: unknown) {
                if (error instanceof CloudOrganizationInvalidRequestError) {
                    throw this.#error(
                        400,
                        "invalid_request",
                        "The Cloud organization ID is invalid.",
                    );
                }
                if (error instanceof CloudOrganizationForbiddenError) {
                    throw this.#error(
                        403,
                        "forbidden",
                        "You do not have permission to delete this Cloud organization.",
                    );
                }
                logCloudFailure(
                    ctx,
                    "organizations",
                    minted.cloud.environment,
                    "cloud-organization-delete",
                    error,
                );
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "Cloud organizations are temporarily unavailable.",
                );
            }
        });
    }

    async listTeams(_ctx: Context): Promise<readonly HappyTeam[]> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const minted = await this.#mintInLock(ctx, true);
            try {
                return await this.#client(minted.cloud.environment).listTeams(minted.accessToken);
            } catch (error: unknown) {
                logCloudFailure(
                    ctx,
                    "organizations",
                    minted.cloud.environment,
                    "happy-teams-list",
                    error,
                );
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "Happy teams are temporarily unavailable.",
                );
            }
        });
    }

    /** Return the WorkOS identifiers behind the currently connected and reverified Cloud session. */
    async getWorkOSState(_ctx: Context): Promise<{
        readonly workosClientId: string;
        readonly workosUserId: string;
    }> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const minted = await this.#mintInLock(ctx, true);
            return {
                workosClientId: this.#client(minted.cloud.environment).workosClientId,
                workosUserId: minted.authenticated.user.id,
            };
        });
    }

    async createTeam(_ctx: Context, name: string, endpoint: string): Promise<HappyTeam> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            if (!Value.Check(createCloudOrganizationRequestSchema.properties.name, name)) {
                throw this.#error(400, "invalid_request", "The Happy team name is invalid.");
            }
            const normalizedEndpoint = normalizeHappyTeamEndpoint(endpoint);
            if (
                !Value.Check(happyTeamEndpointInputSchema, endpoint) ||
                normalizedEndpoint === undefined
            ) {
                throw this.#error(400, "invalid_request", "The Happy team endpoint is invalid.");
            }
            const minted = await this.#mintInLock(ctx, true);
            const client = this.#client(minted.cloud.environment);
            let created: HappyTeam;
            try {
                created = await client.createTeam(minted.accessToken, name);
            } catch (error: unknown) {
                if (error instanceof CloudOrganizationInvalidRequestError) {
                    throw this.#error(400, "invalid_request", "The Happy team name is invalid.");
                }
                logCloudFailure(
                    ctx,
                    "organizations",
                    minted.cloud.environment,
                    "happy-team-create",
                    error,
                );
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "Happy teams are temporarily unavailable.",
                );
            }
            try {
                const configuredEndpoint = await client.setTeamEndpoint(
                    minted.accessToken,
                    created.id,
                    normalizedEndpoint,
                );
                return { ...created, endpoint: configuredEndpoint };
            } catch (error: unknown) {
                logCloudFailure(
                    ctx,
                    "organizations",
                    minted.cloud.environment,
                    "happy-team-create-endpoint-update",
                    error,
                );
                const message = `Happy team ${created.id} was created, but its endpoint could not be configured. Use update_happy_team with this team ID to finish setup.`;
                if (error instanceof CloudOrganizationForbiddenError) {
                    throw this.#error(403, "forbidden", message);
                }
                throw this.#error(503, "cloud_unavailable", message);
            }
        });
    }

    async setTeamEndpoint(
        _ctx: Context,
        organizationId: string,
        endpoint: string,
    ): Promise<string> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const normalizedEndpoint = normalizeHappyTeamEndpoint(endpoint);
            if (
                !Value.Check(cloudOrganizationSchema.properties.id, organizationId) ||
                !Value.Check(happyTeamEndpointInputSchema, endpoint) ||
                normalizedEndpoint === undefined
            ) {
                throw this.#error(400, "invalid_request", "The Happy team endpoint is invalid.");
            }
            const minted = await this.#mintInLock(ctx, true);
            try {
                return await this.#client(minted.cloud.environment).setTeamEndpoint(
                    minted.accessToken,
                    organizationId,
                    normalizedEndpoint,
                );
            } catch (error: unknown) {
                if (error instanceof CloudOrganizationInvalidEndpointError) {
                    throw this.#error(
                        400,
                        "invalid_request",
                        "The Happy team endpoint is invalid.",
                    );
                }
                if (error instanceof CloudOrganizationForbiddenError) {
                    throw this.#error(
                        403,
                        "forbidden",
                        "The connected Cloud user is not an administrator of this Happy team.",
                    );
                }
                logCloudFailure(
                    ctx,
                    "organizations",
                    minted.cloud.environment,
                    "happy-team-endpoint-update",
                    error,
                );
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "Happy teams are temporarily unavailable.",
                );
            }
        });
    }

    async inviteTeamMember(
        _ctx: Context,
        organizationId: string,
        email: string,
    ): Promise<HappyTeamInvitation> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const normalizedEmail = normalizeHappyTeamInvitationEmail(email);
            if (
                !Value.Check(happyTeamInvitationOrganizationIdSchema, organizationId) ||
                normalizedEmail === undefined
            ) {
                throw this.#error(
                    400,
                    "invalid_request",
                    "The team ID or invitation email is invalid.",
                );
            }
            const minted = await this.#mintInLock(ctx, true);
            try {
                return await this.#client(minted.cloud.environment).inviteTeamMember(
                    minted.accessToken,
                    organizationId,
                    normalizedEmail,
                );
            } catch (error: unknown) {
                if (error instanceof CloudOrganizationInvalidRequestError) {
                    throw this.#error(
                        400,
                        "invalid_request",
                        "The team ID or invitation email is invalid.",
                    );
                }
                if (error instanceof CloudOrganizationForbiddenError) {
                    throw this.#error(
                        403,
                        "forbidden",
                        "The connected Cloud user must administer this Happy team to invite members.",
                    );
                }
                if (error instanceof CloudInvitationConflictError) {
                    throw this.#error(
                        409,
                        "conflict",
                        error.reason === "already_member"
                            ? "This email address already belongs to the Happy team."
                            : "This email address already has a pending invitation to the Happy team.",
                    );
                }
                logCloudFailure(
                    ctx,
                    "organizations",
                    minted.cloud.environment,
                    "happy-team-invite",
                    error,
                );
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "The invitation could not be confirmed. It may already have been sent; check the team's invitations before trying again.",
                );
            }
        });
    }

    async #mintInLock(
        ctx: Context,
        publishUserChange: boolean,
        organizationId?: string,
    ): Promise<MintedCloudCredential> {
        const stored = await this.#readOwned(ctx);
        const session = stored?.session;
        if (session === null || session === undefined || this.#cloud.status !== "connected") {
            throw this.#error(
                409,
                "cloud_not_authenticated",
                "Cloud is not authenticated on this Happy Agent.",
            );
        }

        let authenticated;
        try {
            authenticated = await this.#client(session.environment).refresh(
                session.refreshToken,
                organizationId,
            );
        } catch (error: unknown) {
            logCloudFailure(ctx, "token", session.environment, "workos-refresh", error);
            if (error instanceof CloudCredentialsRejectedError) {
                const cloud = await this.#replace(ctx, {
                    error: {
                        code: "credentials_rejected",
                        message: "Cloud authorization has expired.",
                    },
                    pending: false,
                    session: null,
                });
                throw new CloudOperationError(
                    409,
                    "cloud_unauthorized",
                    "Cloud authorization has expired.",
                    cloud,
                );
            }
            throw this.#error(
                503,
                "cloud_unavailable",
                "Cloud authentication is temporarily unavailable.",
            );
        }

        await this.#database.rotateRefreshToken(
            ctx,
            session.refreshToken,
            authenticated.refreshToken,
        );
        if (authenticated.user.id !== session.user.id) {
            logCloudFailure(
                ctx,
                "token",
                session.environment,
                "workos-refresh",
                new CloudIdentityMismatchError(),
            );
            throw this.#error(503, "cloud_unavailable", "Cloud returned an unexpected account.");
        }
        try {
            await this.#client(session.environment).verify(
                authenticated.accessToken,
                session.user.id,
            );
        } catch (error: unknown) {
            logCloudFailure(ctx, "token", session.environment, "cloud-hello", error);
            if (
                !(error instanceof CloudServiceUnavailableError) &&
                !(error instanceof CloudIdentityMismatchError)
            ) {
                throw error;
            }
            throw this.#error(503, "cloud_unavailable", "Cloud could not verify the access token.");
        }

        const minted = {
            accessToken: authenticated.accessToken,
            authenticated,
            cloud: connected(this.#cloud),
            session,
        };
        if (publishUserChange) await this.#publishUserChange(ctx, minted);
        return { ...minted, cloud: connected(this.#cloud) };
    }

    async #publishUserChange(ctx: Context, minted: MintedCloudCredential): Promise<void> {
        if (sameUser(minted.session.user, minted.authenticated.user)) return;
        await this.#replace(ctx, {
            error: null,
            pending: false,
            session: cloudSession(
                minted.session.environment,
                minted.authenticated.refreshToken,
                minted.authenticated.user,
            ),
        });
    }

    async #initialize(ctx: Context): Promise<void> {
        let stored = await this.#database.read(ctx);
        if (stored === undefined) {
            stored = await this.#database.replace(ctx, {
                error: null,
                pending: false,
                session: null,
            });
        }
        this.#cloud = project(stored);
    }

    async #beginAttempt(ctx: Context, draft: CloudAttemptDraft): Promise<Cloud> {
        return await ctx.inTx(async (txCtx) => {
            await this.#durableFunctions.cancel(txCtx, CLOUD_AUTHORIZATION_EXPIRY_OPERATION);
            const stored = await this.#database.replace(txCtx, {
                error: null,
                pending: true,
                session: null,
            });
            const attempt: CloudAttempt = { ...draft, version: stored.version };
            const cloud = project(stored, attempt);
            afterCommit(txCtx, (postCommitCtx) => {
                this.#attempt = attempt;
                this.#cloud = cloud;
                for (const listener of this.#listeners) listener(postCommitCtx, cloud);
            });
            await this.#durableFunctions.invoke(txCtx, {
                function: CLOUD_AUTHORIZATION_EXPIRY_FUNCTION,
                arguments: { expiresAt: attempt.expiresAt, version: attempt.version },
                operationId: CLOUD_AUTHORIZATION_EXPIRY_OPERATION,
            });
            return cloud;
        });
    }

    async #replace(
        ctx: Context,
        value: CloudStoredReplacement,
        options: CloudReplacementOptions = {},
    ): Promise<Cloud> {
        return await ctx.inTx(async (txCtx) => {
            if (options.cancelAuthorizationExpiry === true) {
                await this.#durableFunctions.cancel(txCtx, CLOUD_AUTHORIZATION_EXPIRY_OPERATION);
            }
            const stored = await this.#database.replace(txCtx, value);
            const cloud = project(stored, options.attempt);
            afterCommit(txCtx, (postCommitCtx) => {
                options.onCommit?.();
                this.#cloud = cloud;
                for (const listener of this.#listeners) listener(postCommitCtx, cloud);
            });
            return cloud;
        });
    }

    async #settleAttempt(
        ctx: Context,
        value: CloudStoredReplacement,
        consumed: CloudAttempt,
    ): Promise<Cloud> {
        return await this.#replace(ctx, value, {
            cancelAuthorizationExpiry: true,
            onCommit: () => {
                if (this.#attempt === consumed) this.#attempt = undefined;
            },
        });
    }

    async #expire(ctx: Context, attempt: CloudAttempt): Promise<CloudDisconnected> {
        if (this.#attempt !== attempt) return disconnected(this.#cloud);
        return disconnected(
            await this.#replace(
                ctx,
                {
                    error: {
                        code: "authorization_expired",
                        message: "Cloud authorization expired.",
                    },
                    pending: false,
                    session: null,
                },
                {
                    cancelAuthorizationExpiry: true,
                    onCommit: () => {
                        if (this.#attempt !== attempt) return;
                        this.#attempt = undefined;
                    },
                },
            ),
        );
    }

    async #executeAuthorizationExpiry(
        ctx: Context,
        input: CloudAuthorizationExpiryArguments,
    ): Promise<void> {
        if (this.#attempt?.version === input.version) {
            for (;;) {
                const remaining = input.expiresAt - Date.now();
                if (remaining <= 0) break;
                await delay(ctx, Math.max(1, remaining));
            }
        }
        for (;;) {
            try {
                await this.#lock.runInLock(ctx, async () => {
                    const stored = await this.#readOwned(ctx);
                    if (stored?.pending !== true || stored.version !== input.version) return;
                    await this.#replace(
                        ctx,
                        {
                            error: {
                                code: "authorization_expired",
                                message: "Cloud authorization expired.",
                            },
                            pending: false,
                            session: null,
                        },
                        {
                            onCommit: () => {
                                if (this.#attempt?.version === input.version) {
                                    this.#attempt = undefined;
                                }
                            },
                        },
                    );
                });
                return;
            } catch (error: unknown) {
                ctx.log.warn("Cloud authorization expiry could not be stored.", {}, error);
                await delay(ctx, AUTHORIZATION_EXPIRY_RETRY_MS);
            }
        }
    }

    #client(environment: CloudEnvironment): CloudWorkOS {
        let client = this.#clients.get(environment);
        if (client === undefined) {
            client = new CloudWorkOS(environment);
            this.#clients.set(environment, client);
        }
        return client;
    }

    #authorizing(): CloudAuthorizing {
        return authorizing(this.#cloud);
    }

    #error(
        status: 400 | 403 | 404 | 409 | 503,
        code: CloudOperationErrorCode,
        message: string,
    ): CloudOperationError {
        return new CloudOperationError(status, code, message, this.#cloud);
    }

    #assertRunning(): void {
        if (this.#stopping) throw new Error("Cloud authentication is stopping.");
        if (this.#context === undefined) throw new Error("Cloud authentication has not started.");
    }

    #ownedContext(): Context {
        this.#assertRunning();
        return this.#context!;
    }

    async #readOwned(ctx: Context): Promise<CloudStoredState | undefined> {
        return await ctx.inTx(async (txCtx) => await this.#database.read(txCtx));
    }
}

function logCloudFailure(
    ctx: Context,
    operation: "authorization" | "organizations" | "token",
    environment: CloudEnvironment,
    phase: string,
    error: unknown,
): void {
    const diagnostic = cloudFailureDiagnostic(error);
    const status = diagnostic.status === undefined ? "" : ` status=${String(diagnostic.status)}`;
    ctx.log.warn(
        `cloud:${operation}:error environment=${environment} phase=${phase} reason=${diagnostic.reason}${status}`,
    );
}

function cloudFailureDiagnostic(error: unknown): {
    readonly reason: string;
    readonly status?: number;
} {
    if (error instanceof CloudOperationError) return { reason: error.code, status: error.status };
    if (error instanceof CloudCredentialsRejectedError) return { reason: "credentials-rejected" };
    if (error instanceof CloudIdentityMismatchError) return { reason: "identity-mismatch" };
    if (error instanceof CloudOrganizationForbiddenError) return { reason: "forbidden" };
    if (error instanceof CloudOrganizationInvalidRequestError) return { reason: "invalid-request" };
    if (error instanceof CloudServiceUnavailableError) {
        return error.status === undefined
            ? { reason: error.reason }
            : { reason: error.reason, status: error.status };
    }
    return { reason: "unexpected" };
}

function project(stored: CloudStoredState, attempt?: CloudAttempt): Cloud {
    if (stored.pending) {
        if (attempt === undefined) {
            return freezeCloud({
                authorization: null,
                environment: null,
                error: {
                    code: "authorization_expired",
                    message: "Cloud authorization expired.",
                },
                status: "disconnected",
                updatedAt: stored.updatedAt,
                user: null,
                version: stored.version,
            });
        }
        return freezeCloud({
            authorization: { expiresAt: attempt.expiresAt, url: attempt.url },
            environment: attempt.environment,
            error: null,
            status: "authorizing",
            updatedAt: stored.updatedAt,
            user: null,
            version: stored.version,
        });
    }
    if (stored.session !== null) {
        return freezeCloud({
            authorization: null,
            environment: stored.session.environment,
            error: null,
            status: "connected",
            updatedAt: stored.updatedAt,
            user: stored.session.user,
            version: stored.version,
        });
    }
    return freezeCloud({
        authorization: null,
        environment: null,
        error:
            stored.error === null
                ? null
                : { code: stored.error.code, message: stored.error.message },
        status: "disconnected",
        updatedAt: stored.updatedAt,
        user: null,
        version: stored.version,
    });
}

function validRedirectUri(value: string, cloud: Cloud): string {
    try {
        const parsed = new URL(value);
        const loopback =
            parsed.hostname === "localhost" ||
            parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "[::1]" ||
            /^127(?:\.[0-9]{1,3}){3}$/.test(parsed.hostname);
        const forbiddenSchemes = new Set([
            "about:",
            "blob:",
            "data:",
            "file:",
            "javascript:",
            "mailto:",
        ]);
        const allowedTransport =
            parsed.protocol === "https:" ||
            (parsed.protocol === "http:" && loopback) ||
            (parsed.protocol !== "http:" &&
                parsed.protocol !== "https:" &&
                !forbiddenSchemes.has(parsed.protocol) &&
                (parsed.host.length > 0 || parsed.pathname.length > 0));
        if (
            value.length === 0 ||
            value.length > 2_048 ||
            parsed.protocol.length <= 1 ||
            parsed.username.length > 0 ||
            parsed.password.length > 0 ||
            parsed.hash.length > 0 ||
            !allowedTransport
        ) {
            throw new Error("invalid");
        }
        return value;
    } catch {
        throw new CloudOperationError(
            400,
            "invalid_request",
            "The Cloud redirect URI is invalid.",
            cloud,
        );
    }
}

function parseCallback(
    value: string,
    attempt: CloudAttempt,
    cloud: Cloud,
):
    | { readonly kind: "code"; readonly code: string }
    | { readonly kind: "error"; readonly error: string } {
    const invalid = (): never => {
        throw new CloudOperationError(
            400,
            "invalid_request",
            "The Cloud authorization callback is invalid.",
            cloud,
        );
    };
    if (value.length === 0 || value.length > 4_096) return invalid();
    let callback: URL;
    let redirect: URL;
    try {
        callback = new URL(value);
        redirect = new URL(attempt.redirectUri);
    } catch {
        return invalid();
    }
    if (
        callback.hash.length > 0 ||
        callback.username.length > 0 ||
        callback.password.length > 0 ||
        callback.protocol !== redirect.protocol ||
        callback.host !== redirect.host ||
        callback.pathname !== redirect.pathname
    ) {
        return invalid();
    }
    const states = callback.searchParams.getAll("state");
    if (states.length !== 1 || states[0]?.length === 0 || !sameSecret(states[0]!, attempt.state)) {
        return invalid();
    }
    const codes = callback.searchParams.getAll("code");
    const errors = callback.searchParams.getAll("error");
    if (codes.length === 1 && codes[0]?.length !== 0 && errors.length === 0) {
        return { code: codes[0]!, kind: "code" };
    }
    if (errors.length === 1 && errors[0]?.length !== 0 && codes.length === 0) {
        return { error: errors[0]!, kind: "error" };
    }
    return invalid();
}

function sameSecret(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function sameUser(left: CloudUser, right: CloudUser): boolean {
    return (
        left.id === right.id &&
        left.email === right.email &&
        left.firstName === right.firstName &&
        left.lastName === right.lastName
    );
}

function freezeCloud(cloud: Cloud): Cloud {
    if (cloud.authorization !== null) Object.freeze(cloud.authorization);
    if (cloud.error !== null) Object.freeze(cloud.error);
    if (cloud.user !== null) Object.freeze(cloud.user);
    return Object.freeze(cloud);
}

function authorizing(cloud: Cloud): CloudAuthorizing {
    if (cloud.status !== "authorizing") throw new Error("Cloud is not authorizing.");
    return cloud;
}

function connected(cloud: Cloud): CloudConnected {
    if (cloud.status !== "connected") throw new Error("Cloud is not connected.");
    return cloud;
}

function disconnected(cloud: Cloud): CloudDisconnected {
    if (cloud.status !== "disconnected") throw new Error("Cloud is not disconnected.");
    return cloud;
}
