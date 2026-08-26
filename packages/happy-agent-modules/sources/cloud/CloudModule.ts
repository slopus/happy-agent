import { timingSafeEqual } from "node:crypto";

import type {
    Cloud,
    CloudAccessTokenResponse,
    CloudAuthorizing,
    CloudConnected,
    CloudDisconnected,
    CloudEnvironment,
    CloudProfile,
    CloudProfileResponse,
    CloudSocial,
    CloudSocialResponse,
    CloudUser,
    CompleteCloudAuthorizationRequest,
    EnrollCloudProfileRequest,
    StartCloudAuthorizationRequest,
} from "@slopus/happy-agent-client";
import { cloudUsernameSchema, enrollCloudProfileRequestSchema } from "@slopus/happy-agent-client";
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
    withLifetime,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { ProfileModule, type Profile, type ProfileUnsubscribe } from "../profile/index.js";

import {
    cloudMigrations,
    cloudEnrollment,
    cloudSession,
    createCloudDatabase,
    type CloudEnrollment,
    type CloudSession,
    type CloudStoredState,
    type CloudStoredValue,
} from "./CloudDatabase.js";
import {
    CLOUD_AUTHORIZATION_EXPIRY_FUNCTION,
    CLOUD_AUTHORIZATION_EXPIRY_OPERATION,
    CLOUD_AUTHORIZATION_LOCK,
    CLOUD_PROFILE_SYNC_FUNCTION,
    CLOUD_PROFILE_SYNC_LOCK,
    CLOUD_SOCIAL_SYNC_FUNCTION,
    CLOUD_SOCIAL_SYNC_LOCK,
    cloudAuthorizationExpiryArgumentsSchema,
    cloudAuthorizationExpiryResultSchema,
    cloudProfileSyncArgumentsSchema,
    cloudProfileSyncResultSchema,
    cloudSocialSyncArgumentsSchema,
    cloudSocialSyncResultSchema,
    type CloudAuthorizationExpiryArguments,
    type CloudProfileSyncArguments,
    type CloudSocialSyncArguments,
} from "./CloudDurableFunctions.js";
import {
    cloudSocialMigrations,
    createCloudSocialDatabase,
    unenrolledCloudSocialValue,
    type CloudSocialDatabaseReplacement,
    type CloudSocialStoredState,
    type CloudSocialStoredValue,
} from "./CloudSocialDatabase.js";
import type { CloudSocialSocketConnection } from "./CloudSocialSocket.js";
import {
    CloudCredentialsRejectedError,
    CloudIdentityMismatchError,
    CloudProfileRejectedError,
    CloudProfileRequiredError,
    CloudServiceUnavailableError,
    CloudSocialBlockedError,
    CloudSocialInvalidRequestError,
    CloudSocialNotFoundError,
    CloudSocialSnapshotChangedError,
    CloudUsernameUnavailableError,
    CloudWorkOS,
    type CloudAuthentication,
    type CloudRemoteSocialSnapshot,
    type CloudSocialMutation,
} from "./CloudWorkOS.js";
import { createCloudVersion } from "./createCloudVersion.js";

const AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1_000;
const AUTHORIZATION_EXPIRY_RETRY_MS = 5_000;
const PROFILE_SYNC_RETRY_MS = 5_000;
const SOCIAL_SYNC_RETRY_MS = 5_000;
const SOCIAL_SOCKET_RETRY_MS = 5_000;
const SOCIAL_ELIGIBILITY_POLL_MS = 1_000;
const SOCIAL_MUTATION_SNAPSHOT_ATTEMPTS = 3;
const SOCIAL_PROFILE_REFRESH_MS = 5 * 60 * 1_000;
const cloudProfileNameSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});

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
    readonly socialOrigin?: CloudSocialUpdateOrigin;
}

interface MintedCloudCredential extends CloudAccessTokenResponse {
    readonly authenticated: CloudAuthentication;
    readonly session: CloudSession;
}

type CloudStoredReplacement = CloudStoredValue;

export type CloudUpdatedListener = (ctx: Context, cloud: Cloud) => void;
export type CloudProfileUpdatedListener = (ctx: Context) => void;
export type CloudSocialUpdateOrigin = "background" | "mutation";
export type CloudSocialMutationKind = CloudSocialMutation;
export type CloudSocialUpdatedListener = (
    ctx: Context,
    social: CloudSocial,
    origin: CloudSocialUpdateOrigin,
) => void;

interface LiveCloudSocialConnection {
    readonly controller: AbortController;
    readonly userId: string;
    socket: CloudSocialSocketConnection | undefined;
    stateVersion: string | undefined;
}

export type CloudOperationErrorCode =
    | "cloud_not_authenticated"
    | "cloud_not_enrolled"
    | "cloud_unauthorized"
    | "cloud_unavailable"
    | "conflict"
    | "invalid_request"
    | "not_found";

/** A display-safe Cloud failure carrying the authoritative current snapshot. */
export class CloudOperationError extends Error {
    readonly cloud: Cloud;
    readonly cloudSocial: CloudSocial | undefined;
    readonly code: CloudOperationErrorCode;
    readonly status: 400 | 404 | 409 | 503;

    constructor(
        status: 400 | 404 | 409 | 503,
        code: CloudOperationErrorCode,
        message: string,
        cloud: Cloud,
        cloudSocial?: CloudSocial,
    ) {
        super(message);
        this.name = "CloudOperationError";
        this.status = status;
        this.code = code;
        this.cloud = cloud;
        this.cloudSocial = cloudSocial;
    }
}

/** Owns Happy Cloud authentication, refresh-token storage, token minting, and profile access. */
export class CloudModule implements AgentModule {
    readonly name = "cloud";
    readonly migrations = [...cloudMigrations, ...cloudSocialMigrations];

    readonly #database = createCloudDatabase();
    readonly #socialDatabase = createCloudSocialDatabase();
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #profile: ProfileModule;
    readonly #profileUnsubscribe: ProfileUnsubscribe;
    readonly #listeners = new Set<CloudUpdatedListener>();
    readonly #profileListeners = new Set<CloudProfileUpdatedListener>();
    readonly #socialListeners = new Set<CloudSocialUpdatedListener>();
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #clients = new Map<CloudEnvironment, CloudWorkOS>();
    readonly #socialLifetime = new AbortController();
    #attempt: CloudAttempt | undefined;
    #cloud: Cloud;
    #cloudSocial: CloudSocial;
    #cloudSocialUserId: string | null = null;
    #context: Context | undefined;
    #liveSocial: LiveCloudSocialConnection | undefined;
    #socialSupervisor: Promise<void> | undefined;
    #socialWake: (() => void) | undefined;
    #stopping = false;

    constructor(durableFunctions: DurableFunctionsModule, profile: ProfileModule) {
        this.#durableFunctions = durableFunctions;
        this.#profile = profile;
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
        this.#cloudSocial = projectSocial({
            ...unenrolledCloudSocialValue(),
            updatedAt,
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
        durableFunctions.register({
            name: CLOUD_PROFILE_SYNC_FUNCTION,
            argumentsSchema: cloudProfileSyncArgumentsSchema,
            resultSchema: cloudProfileSyncResultSchema,
            executor: async (ctx, call) => {
                await this.#executeProfileSync(ctx, call.arguments);
                return null;
            },
        });
        durableFunctions.register({
            name: CLOUD_SOCIAL_SYNC_FUNCTION,
            argumentsSchema: cloudSocialSyncArgumentsSchema,
            resultSchema: cloudSocialSyncResultSchema,
            executor: async (ctx, call) => {
                await this.#executeSocialSync(ctx, call.arguments);
                return null;
            },
        });
        this.#profileUnsubscribe = profile.onEvent(async (ctx, event) => {
            await this.#scheduleChangedProfileSync(ctx, event.data.version);
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
        return {
            afterStart: () => {
                this.#startSocialSupervisor();
            },
        };
    };

    async stop(): Promise<void> {
        this.#profileUnsubscribe();
        this.#socialLifetime.abort();
        this.#liveSocial?.controller.abort();
        this.#socialWake?.();
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
        await this.#socialSupervisor;
    }

    status(_ctx: Context): Cloud {
        return this.#cloud;
    }

    socialStatus(_ctx: Context): CloudSocial {
        return this.#cloudSocial;
    }

    onUpdated(listener: CloudUpdatedListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    onProfileUpdated(listener: CloudProfileUpdatedListener): () => void {
        this.#profileListeners.add(listener);
        return () => {
            this.#profileListeners.delete(listener);
        };
    }

    onSocialUpdated(listener: CloudSocialUpdatedListener): () => void {
        this.#socialListeners.add(listener);
        return () => {
            this.#socialListeners.delete(listener);
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

            const cloud = await this.#settleAttempt(
                ctx,
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
            return connected(cloud);
        });
    }

    async disconnect(_ctx: Context): Promise<CloudDisconnected> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const alreadyClean =
                this.#attempt === undefined &&
                this.#cloud.status === "disconnected" &&
                this.#cloud.error === null;
            if (alreadyClean) return disconnected(this.#cloud);
            return disconnected(
                await this.#replace(
                    ctx,
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
    }

    async mint(_ctx: Context): Promise<CloudAccessTokenResponse> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const minted = await this.#mintInLock(ctx, true);
            return { accessToken: minted.accessToken, cloud: minted.cloud };
        });
    }

    async getProfile(_ctx: Context): Promise<CloudProfileResponse> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            const minted = await this.#mintInLock(ctx, true);
            try {
                return {
                    profile: await this.#client(minted.cloud.environment).getProfile(
                        minted.accessToken,
                    ),
                };
            } catch (error: unknown) {
                logCloudFailure(
                    ctx,
                    "profile",
                    minted.cloud.environment,
                    "cloud-profile-read",
                    error,
                );
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "The Cloud profile is temporarily unavailable.",
                );
            }
        });
    }

    async enrollProfile(
        _ctx: Context,
        request: EnrollCloudProfileRequest,
    ): Promise<CloudProfileResponse> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            if (!Value.Check(enrollCloudProfileRequestSchema, request)) {
                throw this.#error(400, "invalid_request", "The Cloud profile is invalid.");
            }
            const localProfile = await this.#profile.get(ctx);
            const name = localProfileName(localProfile);
            if (localProfile === undefined || name === undefined) {
                throw this.#error(
                    409,
                    "conflict",
                    "Set a compatible Happy Agent profile name before enrolling in Cloud.",
                );
            }
            const minted = await this.#mintInLock(ctx, false);
            let profile: CloudProfile;
            try {
                profile = await this.#client(minted.cloud.environment).updateProfile(
                    minted.accessToken,
                    { firstName: name, username: request.username },
                );
            } catch (error: unknown) {
                logCloudFailure(
                    ctx,
                    "profile",
                    minted.cloud.environment,
                    "cloud-profile-update",
                    error,
                );
                if (error instanceof CloudProfileRejectedError) {
                    throw this.#error(
                        503,
                        "cloud_unavailable",
                        "The Cloud profile is temporarily unavailable.",
                    );
                }
                if (error instanceof CloudUsernameUnavailableError) {
                    throw this.#error(409, "conflict", "The Cloud username is unavailable.");
                }
                if (error instanceof CloudServiceUnavailableError) {
                    throw this.#error(
                        503,
                        "cloud_unavailable",
                        "The Cloud profile is temporarily unavailable.",
                    );
                }
                throw error;
            }
            if (profile.username === null) {
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "The Cloud profile is temporarily unavailable.",
                );
            }
            await this.#persistSessionAfterProfile(
                ctx,
                minted,
                cloudEnrollment(profile.username, localProfile.version),
            );
            for (const listener of this.#profileListeners) listener(ctx);
            return { profile };
        });
    }

    getSocial(_ctx: Context): CloudSocialResponse {
        return { cloudSocial: this.#cloudSocial };
    }

    async mutateSocial(
        _ctx: Context,
        mutation: CloudSocialMutation,
        username: string,
    ): Promise<CloudSocialResponse> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            if (!Value.Check(cloudUsernameSchema, username)) {
                throw this.#error(400, "invalid_request", "The Cloud username is invalid.", true);
            }
            const stored = await this.#readOwned(ctx);
            if (stored?.session === null || stored?.session === undefined) {
                throw this.#error(
                    409,
                    "cloud_not_authenticated",
                    "Cloud is not authenticated on this Happy Agent.",
                    true,
                );
            }
            if (stored.session.enrollment === null || stored.session.enrollment === undefined) {
                throw this.#error(
                    409,
                    "cloud_not_enrolled",
                    "Enroll a Cloud profile before using friends.",
                    true,
                );
            }
            const minted = await this.#mintInLock(ctx, false);
            try {
                await this.#client(minted.cloud.environment).mutateSocial(
                    minted.accessToken,
                    mutation,
                    username,
                );
            } catch (error: unknown) {
                if (error instanceof CloudSocialNotFoundError) {
                    throw this.#error(
                        404,
                        "not_found",
                        "The Cloud user or request was not found.",
                        true,
                    );
                }
                if (error instanceof CloudSocialBlockedError) {
                    throw this.#error(
                        409,
                        "conflict",
                        "The Cloud friend request is blocked.",
                        true,
                    );
                }
                if (error instanceof CloudSocialInvalidRequestError) {
                    throw this.#error(
                        400,
                        "invalid_request",
                        "The Cloud friend request is invalid.",
                        true,
                    );
                }
                if (error instanceof CloudProfileRequiredError) {
                    await this.#persistSessionAfterProfile(ctx, minted, null, "mutation");
                    throw this.#error(
                        409,
                        "cloud_not_enrolled",
                        "Enroll a Cloud profile before using friends.",
                        true,
                    );
                }
                logCloudFailure(
                    ctx,
                    "social",
                    minted.cloud.environment,
                    "cloud-social-mutation",
                    error,
                );
                throw this.#error(
                    503,
                    "cloud_unavailable",
                    "Cloud friends are temporarily unavailable.",
                    true,
                );
            }

            for (let attempt = 0; attempt < SOCIAL_MUTATION_SNAPSHOT_ATTEMPTS; attempt += 1) {
                try {
                    await this.#synchronizeSocialSnapshot(ctx, minted, "mutation");
                    return { cloudSocial: this.#cloudSocial };
                } catch (error: unknown) {
                    if (error instanceof CloudSocialSnapshotChangedError) continue;
                    if (error instanceof CloudOperationError) throw error;
                    logCloudFailure(
                        ctx,
                        "social",
                        minted.cloud.environment,
                        "cloud-social-snapshot",
                        error,
                    );
                    await this.#scheduleCurrentSocialSync(ctx, stored.session.user.id);
                    throw this.#error(
                        503,
                        "cloud_unavailable",
                        "Cloud friends are temporarily unavailable.",
                        true,
                    );
                }
            }
            await this.#scheduleCurrentSocialSync(ctx, stored.session.user.id);
            throw this.#error(
                503,
                "cloud_unavailable",
                "Cloud friends changed while they were being synchronized.",
                true,
            );
        });
    }

    async #mintInLock(ctx: Context, publishUserChange: boolean): Promise<MintedCloudCredential> {
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
            authenticated = await this.#client(session.environment).refresh(session.refreshToken);
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
                minted.session.enrollment ?? null,
            ),
        });
    }

    async #persistSessionAfterProfile(
        ctx: Context,
        minted: MintedCloudCredential,
        enrollment: CloudEnrollment | null,
        origin: CloudSocialUpdateOrigin = "mutation",
    ): Promise<void> {
        const stored = await this.#readOwned(ctx);
        if (stored?.session === null || stored?.session === undefined) {
            throw new Error("The Cloud session changed while enrollment was being stored.");
        }
        if (stored.session.user.id !== minted.session.user.id) {
            throw new Error("The Cloud account changed while enrollment was being stored.");
        }
        if (sameUser(stored.session.user, minted.authenticated.user)) {
            await ctx.inTx(async (txCtx) => {
                await this.#database.updateEnrollment(txCtx, stored.session!.user.id, enrollment);
                const currentSocial = await this.#socialDatabase.read(txCtx);
                const replacement = await this.#socialDatabase.replace(
                    txCtx,
                    socialValueForSession(currentSocial, {
                        ...stored.session!,
                        enrollment,
                    }),
                );
                afterCommit(txCtx, (postCommitCtx) => {
                    this.#applySocial(postCommitCtx, replacement, origin, true);
                });
                return replacement;
            });
            return;
        }
        await this.#replace(
            ctx,
            {
                error: null,
                pending: false,
                session: cloudSession(
                    stored.session.environment,
                    stored.session.refreshToken,
                    minted.authenticated.user,
                    enrollment,
                ),
            },
            { socialOrigin: origin },
        );
    }

    async #scheduleChangedProfileSync(ctx: Context, profileVersion: string): Promise<void> {
        if (this.#stopping || this.#context === undefined) return;
        const stored = await this.#database.read(ctx);
        if (stored?.session?.enrollment === null || stored?.session?.enrollment === undefined) {
            return;
        }
        await this.#scheduleProfileSync(
            ctx,
            stored.session.user.id,
            `cloud.profile-change:${profileVersion}`,
        );
    }

    async #scheduleProfileSync(ctx: Context, userId: string, operationId?: string): Promise<void> {
        await this.#durableFunctions.invoke(ctx, {
            function: CLOUD_PROFILE_SYNC_FUNCTION,
            arguments: { userId },
            ...(operationId === undefined ? {} : { operationId }),
            lockKeys: [CLOUD_PROFILE_SYNC_LOCK],
        });
    }

    async #executeProfileSync(ctx: Context, input: CloudProfileSyncArguments): Promise<void> {
        for (;;) {
            try {
                const synchronized = await this.#lock.runInLock(
                    ctx,
                    async () => await this.#synchronizeProfileOnce(ctx, input.userId),
                );
                if (synchronized) return;
            } catch (error: unknown) {
                if (
                    error instanceof CloudOperationError &&
                    (error.code === "cloud_not_authenticated" ||
                        error.code === "cloud_unauthorized")
                ) {
                    return;
                }
                const environment =
                    this.#cloud.status === "connected" ? this.#cloud.environment : "unknown";
                const diagnostic = cloudFailureDiagnostic(error);
                const status =
                    diagnostic.status === undefined ? "" : ` status=${String(diagnostic.status)}`;
                ctx.log.warn(
                    `cloud:profile:error environment=${environment} phase=durable-profile-sync reason=${diagnostic.reason}${status}`,
                );
            }
            await delay(ctx, PROFILE_SYNC_RETRY_MS);
        }
    }

    async #synchronizeProfileOnce(ctx: Context, expectedUserId: string): Promise<boolean> {
        this.#assertRunning();
        const stored = await this.#readOwned(ctx);
        if (
            stored?.session === null ||
            stored?.session === undefined ||
            stored.session.user.id !== expectedUserId
        ) {
            return true;
        }

        const minted = await this.#mintInLock(ctx, false);
        const client = this.#client(minted.cloud.environment);
        let online: CloudProfile;
        try {
            online = await client.getProfile(minted.accessToken);
        } catch (error: unknown) {
            logCloudFailure(
                ctx,
                "profile",
                minted.cloud.environment,
                "cloud-profile-reconcile",
                error,
            );
            throw error;
        }

        if (online.username === null) {
            await this.#persistSessionAfterProfile(ctx, minted, null, "background");
            return true;
        }

        const localProfile = await this.#profile.get(ctx);
        const name = localProfileName(localProfile);
        if (localProfile === undefined || name === undefined) {
            await this.#persistSessionAfterProfile(
                ctx,
                minted,
                cloudEnrollment(online.username, null),
                "background",
            );
            return true;
        }

        if (online.firstName === name && online.lastName === undefined) {
            await this.#persistSessionAfterProfile(
                ctx,
                minted,
                cloudEnrollment(online.username, localProfile.version),
                "background",
            );
            return true;
        }

        let synchronized: CloudProfile;
        try {
            synchronized = await client.updateProfile(minted.accessToken, {
                firstName: name,
                username: online.username,
            });
        } catch (error: unknown) {
            logCloudFailure(ctx, "profile", minted.cloud.environment, "cloud-profile-sync", error);
            throw error;
        }
        if (synchronized.username === null) {
            throw new CloudServiceUnavailableError();
        }
        await this.#persistSessionAfterProfile(
            ctx,
            minted,
            cloudEnrollment(synchronized.username, localProfile.version),
            "background",
        );
        for (const listener of this.#profileListeners) listener(ctx);

        const latest = await this.#profile.get(ctx);
        return latest?.version === localProfile.version;
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
        const currentSocial = await this.#socialDatabase.read(ctx);
        const social = await this.#socialDatabase.replace(
            ctx,
            socialValueForSession(currentSocial, stored.session, true),
        );
        this.#cloudSocial = projectSocial(social.state);
        this.#cloudSocialUserId = social.state.userId;
        if (stored.session !== null) {
            await this.#scheduleProfileSync(ctx, stored.session.user.id);
        }
    }

    async #beginAttempt(ctx: Context, draft: CloudAttemptDraft): Promise<Cloud> {
        return await ctx.inTx(async (txCtx) => {
            await this.#durableFunctions.cancel(txCtx, CLOUD_AUTHORIZATION_EXPIRY_OPERATION);
            const stored = await this.#database.replace(txCtx, {
                error: null,
                pending: true,
                session: null,
            });
            const social = await this.#socialDatabase.replace(txCtx, unenrolledCloudSocialValue());
            const attempt: CloudAttempt = { ...draft, version: stored.version };
            const cloud = project(stored, attempt);
            afterCommit(txCtx, (postCommitCtx) => {
                this.#attempt = attempt;
                this.#cloud = cloud;
                for (const listener of this.#listeners) listener(postCommitCtx, cloud);
                this.#applySocial(postCommitCtx, social, "mutation", true);
            });
            await this.#durableFunctions.invoke(txCtx, {
                function: CLOUD_AUTHORIZATION_EXPIRY_FUNCTION,
                arguments: { expiresAt: attempt.expiresAt, version: attempt.version },
                operationId: CLOUD_AUTHORIZATION_EXPIRY_OPERATION,
                lockKeys: [CLOUD_AUTHORIZATION_LOCK],
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
            const currentSocial = await this.#socialDatabase.read(txCtx);
            const social = await this.#socialDatabase.replace(
                txCtx,
                socialValueForSession(currentSocial, value.session),
            );
            const cloud = project(stored, options.attempt);
            afterCommit(txCtx, (postCommitCtx) => {
                options.onCommit?.();
                this.#cloud = cloud;
                for (const listener of this.#listeners) listener(postCommitCtx, cloud);
                this.#applySocial(postCommitCtx, social, options.socialOrigin ?? "mutation", true);
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

    #startSocialSupervisor(): void {
        if (this.#socialSupervisor !== undefined || this.#socialLifetime.signal.aborted) return;
        const owned = this.#ownedContext();
        const database = agentDatabase(owned);
        if (database === undefined) throw new Error("Cloud lost its agent database.");
        const ctx = withLifetime(
            withAgentDatabase(detach(owned).named("cloud-social-socket"), database),
            this.#socialLifetime.signal,
        );
        this.#socialSupervisor = this.#runSocialSupervisor(ctx).catch((error: unknown) => {
            if (this.#socialLifetime.signal.aborted) return;
            ctx.log.warn("Cloud friends stopped reconnecting unexpectedly.", {}, error);
        });
    }

    async #runSocialSupervisor(ctx: Context): Promise<void> {
        while (!this.#socialLifetime.signal.aborted) {
            let live: LiveCloudSocialConnection | undefined;
            let environment: CloudEnvironment | undefined;
            try {
                const prepared = await this.#lock.runInLock(ctx, async () => {
                    const stored = await this.#readOwned(ctx);
                    if (
                        stored?.session === null ||
                        stored?.session === undefined ||
                        stored.session.enrollment === null ||
                        stored.session.enrollment === undefined
                    ) {
                        return undefined;
                    }
                    const controller = new AbortController();
                    const next: LiveCloudSocialConnection = {
                        controller,
                        socket: undefined,
                        stateVersion: undefined,
                        userId: stored.session.user.id,
                    };
                    this.#liveSocial = next;
                    const minted = await this.#mintInLock(ctx, false);
                    return { live: next, minted };
                });
                if (prepared === undefined) {
                    await this.#waitForSocialWake(SOCIAL_ELIGIBILITY_POLL_MS);
                    continue;
                }
                live = prepared.live;
                environment = prepared.minted.cloud.environment;
                const socket = await this.#client(environment).openSocialSocket(
                    prepared.minted.accessToken,
                    live.controller.signal,
                    {
                        onState: async (version) => {
                            await this.#handleSocialSocketVersion(ctx, live!, version, true);
                        },
                        onUpdate: async (version) => {
                            await this.#handleSocialSocketVersion(ctx, live!, version, false);
                        },
                    },
                );
                live.socket = socket;
                let periodicRefresh: Promise<void> | undefined;
                const refresh = setInterval(() => {
                    if (
                        periodicRefresh !== undefined ||
                        live?.stateVersion === undefined ||
                        this.#liveSocial !== live
                    ) {
                        return;
                    }
                    periodicRefresh = this.#scheduleSocialSync(ctx, live.userId, live.stateVersion)
                        .catch((error: unknown) => {
                            ctx.log.warn(
                                "Cloud friends could not schedule their periodic profile refresh.",
                                {},
                                error,
                            );
                        })
                        .finally(() => {
                            periodicRefresh = undefined;
                        });
                }, SOCIAL_PROFILE_REFRESH_MS);
                refresh.unref();
                try {
                    await socket.done;
                } finally {
                    clearInterval(refresh);
                    await periodicRefresh;
                }
            } catch (error: unknown) {
                if (!this.#socialLifetime.signal.aborted && environment !== undefined) {
                    logCloudFailure(ctx, "social", environment, "cloud-social-socket", error);
                }
            } finally {
                if (live !== undefined) await this.#socialSocketClosed(ctx, live);
            }
            if (!this.#socialLifetime.signal.aborted) {
                await this.#waitForSocialWake(SOCIAL_SOCKET_RETRY_MS);
            }
        }
    }

    async #handleSocialSocketVersion(
        ctx: Context,
        live: LiveCloudSocialConnection,
        version: string,
        initial: boolean,
    ): Promise<void> {
        const previous = live.stateVersion;
        if (
            this.#liveSocial !== live ||
            (initial ? previous !== undefined : previous === undefined || version <= previous)
        ) {
            throw new Error("The Cloud social socket version is out of order.");
        }
        live.stateVersion = version;
        await this.#lock.runInLock(ctx, async () => {
            if (this.#liveSocial !== live) return;
            const stored = await this.#readOwned(ctx);
            if (
                stored?.session === null ||
                stored?.session === undefined ||
                stored.session.user.id !== live.userId ||
                stored.session.enrollment === null ||
                stored.session.enrollment === undefined
            ) {
                throw new Error("The Cloud account changed while its social socket was open.");
            }
            await ctx.inTx(async (txCtx) => {
                const current = await this.#socialDatabase.read(txCtx);
                if (current === undefined || current.status !== "enrolled") {
                    throw new Error(
                        "The Cloud social state disappeared while its socket was open.",
                    );
                }
                const synchronized = current.remoteVersion === version;
                const replacement = await this.#socialDatabase.replace(txCtx, {
                    ...enrolledSocialStoredValue(current),
                    connection: synchronized ? "connected" : "connecting",
                });
                if (!synchronized) await this.#scheduleSocialSync(txCtx, live.userId, version);
                afterCommit(txCtx, (postCommitCtx) => {
                    this.#applySocial(postCommitCtx, replacement, "background", false);
                });
            });
        });
    }

    async #socialSocketClosed(ctx: Context, live: LiveCloudSocialConnection): Promise<void> {
        await this.#lock.runInLock(ctx, async () => {
            if (this.#liveSocial !== live) return;
            this.#liveSocial = undefined;
            const current = await this.#socialDatabase.read(ctx);
            if (current?.status !== "enrolled" || current.userId !== live.userId) return;
            await this.#replaceSocial(
                ctx,
                { ...enrolledSocialStoredValue(current), connection: "connecting" },
                "background",
            );
        });
    }

    async #waitForSocialWake(milliseconds?: number): Promise<void> {
        if (this.#socialLifetime.signal.aborted) return;
        await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (): void => {
                if (this.#socialWake !== finish) return;
                this.#socialWake = undefined;
                if (timer !== undefined) clearTimeout(timer);
                this.#socialLifetime.signal.removeEventListener("abort", finish);
                resolve();
            };
            this.#socialWake = finish;
            this.#socialLifetime.signal.addEventListener("abort", finish, { once: true });
            if (milliseconds !== undefined) timer = setTimeout(finish, milliseconds);
        });
    }

    #restartSocialConnection(): void {
        this.#liveSocial?.controller.abort();
        this.#socialWake?.();
    }

    async #scheduleCurrentSocialSync(ctx: Context, userId: string): Promise<void> {
        const live = this.#liveSocial;
        if (live?.userId !== userId || live.stateVersion === undefined) return;
        await this.#scheduleSocialSync(ctx, userId, live.stateVersion);
    }

    async #scheduleSocialSync(ctx: Context, userId: string, remoteVersion: string): Promise<void> {
        await this.#durableFunctions.invoke(ctx, {
            function: CLOUD_SOCIAL_SYNC_FUNCTION,
            arguments: { remoteVersion, userId },
            operationId: `cloud.social-sync:${remoteVersion}`,
            lockKeys: [CLOUD_SOCIAL_SYNC_LOCK],
        });
    }

    async #executeSocialSync(ctx: Context, input: CloudSocialSyncArguments): Promise<void> {
        for (;;) {
            try {
                const synchronized = await this.#lock.runInLock(ctx, async () => {
                    const stored = await this.#readOwned(ctx);
                    if (
                        stored?.session === null ||
                        stored?.session === undefined ||
                        stored.session.user.id !== input.userId ||
                        stored.session.enrollment === null ||
                        stored.session.enrollment === undefined
                    ) {
                        return true;
                    }
                    const live = this.#liveSocial;
                    if (live?.userId !== input.userId || live.stateVersion === undefined)
                        return true;
                    const minted = await this.#mintInLock(ctx, false);
                    const snapshot = await this.#synchronizeSocialSnapshot(
                        ctx,
                        minted,
                        "background",
                    );
                    return (
                        this.#liveSocial === live &&
                        live.stateVersion === snapshot.version &&
                        this.#cloudSocial.status === "enrolled" &&
                        this.#cloudSocial.connection === "connected"
                    );
                });
                if (synchronized) return;
            } catch (error: unknown) {
                if (
                    error instanceof CloudOperationError &&
                    (error.code === "cloud_not_authenticated" ||
                        error.code === "cloud_not_enrolled" ||
                        error.code === "cloud_unauthorized")
                ) {
                    return;
                }
                const environment =
                    this.#cloud.status === "connected" ? this.#cloud.environment : "unknown";
                const diagnostic = cloudFailureDiagnostic(error);
                const status =
                    diagnostic.status === undefined ? "" : ` status=${String(diagnostic.status)}`;
                ctx.log.warn(
                    `cloud:social:error environment=${environment} phase=durable-social-sync reason=${diagnostic.reason}${status}`,
                );
            }
            await delay(ctx, SOCIAL_SYNC_RETRY_MS);
        }
    }

    async #synchronizeSocialSnapshot(
        ctx: Context,
        minted: MintedCloudCredential,
        origin: CloudSocialUpdateOrigin,
    ): Promise<CloudRemoteSocialSnapshot> {
        const snapshot = await this.#client(minted.cloud.environment).getSocialSnapshot(
            minted.accessToken,
        );
        const stored = await this.#readOwned(ctx);
        if (
            stored?.session === null ||
            stored?.session === undefined ||
            stored.session.user.id !== minted.session.user.id ||
            stored.session.enrollment === null ||
            stored.session.enrollment === undefined
        ) {
            throw this.#error(
                409,
                "cloud_not_enrolled",
                "Enroll a Cloud profile before using friends.",
                true,
            );
        }
        const live = this.#liveSocial;
        const connected =
            live?.userId === stored.session.user.id && live.stateVersion === snapshot.version;
        await this.#replaceSocial(
            ctx,
            {
                blocked: snapshot.blocked,
                connection: connected ? "connected" : "connecting",
                friends: snapshot.friends,
                incomingRequests: snapshot.incomingRequests,
                outgoingRequests: snapshot.outgoingRequests,
                remoteVersion: snapshot.version,
                status: "enrolled",
                userId: stored.session.user.id,
            },
            origin,
        );
        return snapshot;
    }

    async #replaceSocial(
        ctx: Context,
        value: CloudSocialStoredValue,
        origin: CloudSocialUpdateOrigin,
    ): Promise<CloudSocial> {
        return await ctx.inTx(async (txCtx) => {
            const replacement = await this.#socialDatabase.replace(txCtx, value);
            const social = projectSocial(replacement.state);
            afterCommit(txCtx, (postCommitCtx) => {
                this.#applySocial(postCommitCtx, replacement, origin, false);
            });
            return social;
        });
    }

    #applySocial(
        ctx: Context,
        replacement: CloudSocialDatabaseReplacement,
        origin: CloudSocialUpdateOrigin,
        restartEligibility: boolean,
    ): void {
        const previousStatus = this.#cloudSocial.status;
        const previousUserId = this.#cloudSocialUserId;
        const social = projectSocial(replacement.state);
        this.#cloudSocial = social;
        this.#cloudSocialUserId = replacement.state.userId;
        if (replacement.changed) {
            for (const listener of this.#socialListeners) listener(ctx, social, origin);
        }
        if (
            restartEligibility &&
            (previousStatus !== social.status || previousUserId !== replacement.state.userId)
        ) {
            this.#restartSocialConnection();
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
        status: 400 | 404 | 409 | 503,
        code: CloudOperationErrorCode,
        message: string,
        includeSocial = false,
    ): CloudOperationError {
        return new CloudOperationError(
            status,
            code,
            message,
            this.#cloud,
            includeSocial ? this.#cloudSocial : undefined,
        );
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
    operation: "authorization" | "profile" | "social" | "token",
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
    if (error instanceof CloudProfileRejectedError) return { reason: "profile-rejected" };
    if (error instanceof CloudProfileRequiredError) return { reason: "profile-required" };
    if (error instanceof CloudSocialBlockedError) return { reason: "blocked" };
    if (error instanceof CloudSocialInvalidRequestError) return { reason: "invalid-request" };
    if (error instanceof CloudSocialNotFoundError) return { reason: "not-found" };
    if (error instanceof CloudSocialSnapshotChangedError) return { reason: "snapshot-changed" };
    if (error instanceof CloudUsernameUnavailableError) return { reason: "username-unavailable" };
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

function socialValueForSession(
    current: CloudSocialStoredState | undefined,
    session: CloudSession | null,
    forceConnecting = false,
): CloudSocialStoredValue {
    if (session === null || session.enrollment === null || session.enrollment === undefined) {
        return unenrolledCloudSocialValue();
    }
    if (current?.status === "enrolled" && current.userId === session.user.id) {
        return {
            ...enrolledSocialStoredValue(current),
            connection: forceConnecting ? "connecting" : current.connection,
        };
    }
    return {
        blocked: [],
        connection: "connecting",
        friends: [],
        incomingRequests: [],
        outgoingRequests: [],
        remoteVersion: null,
        status: "enrolled",
        userId: session.user.id,
    };
}

function enrolledSocialStoredValue(
    stored: Extract<CloudSocialStoredState, { status: "enrolled" }>,
): Extract<CloudSocialStoredValue, { status: "enrolled" }> {
    return {
        blocked: stored.blocked,
        connection: stored.connection,
        friends: stored.friends,
        incomingRequests: stored.incomingRequests,
        outgoingRequests: stored.outgoingRequests,
        remoteVersion: stored.remoteVersion,
        status: "enrolled",
        userId: stored.userId,
    };
}

function projectSocial(stored: CloudSocialStoredState): CloudSocial {
    if (stored.status === "unenrolled") {
        return Object.freeze({
            blocked: Object.freeze([]),
            connection: null,
            friends: Object.freeze([]),
            incomingRequests: Object.freeze([]),
            outgoingRequests: Object.freeze([]),
            status: "unenrolled",
            updatedAt: stored.updatedAt,
            version: stored.version,
        }) as CloudSocial;
    }
    const profiles = (values: CloudSocialStoredState["friends"]) =>
        Object.freeze(values.map((profile) => Object.freeze({ ...profile })));
    return Object.freeze({
        blocked: profiles(stored.blocked),
        connection: stored.connection,
        friends: profiles(stored.friends),
        incomingRequests: profiles(stored.incomingRequests),
        outgoingRequests: profiles(stored.outgoingRequests),
        status: "enrolled",
        updatedAt: stored.updatedAt,
        version: stored.version,
    }) as CloudSocial;
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

function localProfileName(profile: Profile | undefined): string | undefined {
    const name = profile?.name;
    return Value.Check(cloudProfileNameSchema, name) ? name : undefined;
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
