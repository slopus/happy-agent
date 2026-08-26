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
    CloudUser,
    CompleteCloudAuthorizationRequest,
    EnrollCloudProfileRequest,
    StartCloudAuthorizationRequest,
} from "@slopus/happy-agent-client";
import { enrollCloudProfileRequestSchema } from "@slopus/happy-agent-client";
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
    cloudAuthorizationExpiryArgumentsSchema,
    cloudAuthorizationExpiryResultSchema,
    cloudProfileSyncArgumentsSchema,
    cloudProfileSyncResultSchema,
    type CloudAuthorizationExpiryArguments,
    type CloudProfileSyncArguments,
} from "./CloudDurableFunctions.js";
import {
    CloudCredentialsRejectedError,
    CloudIdentityMismatchError,
    CloudProfileRejectedError,
    CloudServiceUnavailableError,
    CloudUsernameUnavailableError,
    CloudWorkOS,
    type CloudAuthentication,
} from "./CloudWorkOS.js";
import { createCloudVersion } from "./createCloudVersion.js";

const AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1_000;
const AUTHORIZATION_EXPIRY_RETRY_MS = 5_000;
const PROFILE_SYNC_RETRY_MS = 5_000;
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
}

interface MintedCloudCredential extends CloudAccessTokenResponse {
    readonly authenticated: CloudAuthentication;
    readonly session: CloudSession;
}

type CloudStoredReplacement = CloudStoredValue;

export type CloudUpdatedListener = (ctx: Context, cloud: Cloud) => void;
export type CloudProfileUpdatedListener = (ctx: Context) => void;

export type CloudOperationErrorCode =
    | "cloud_not_authenticated"
    | "cloud_unauthorized"
    | "cloud_unavailable"
    | "conflict"
    | "invalid_request";

/** A display-safe Cloud failure carrying the authoritative current snapshot. */
export class CloudOperationError extends Error {
    readonly cloud: Cloud;
    readonly code: CloudOperationErrorCode;
    readonly status: 400 | 409 | 503;

    constructor(
        status: 400 | 409 | 503,
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

/** Owns Happy Cloud authentication, refresh-token storage, token minting, and profile access. */
export class CloudModule implements AgentModule {
    readonly name = "cloud";
    readonly migrations = cloudMigrations;

    readonly #database = createCloudDatabase();
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #profile: ProfileModule;
    readonly #profileUnsubscribe: ProfileUnsubscribe;
    readonly #listeners = new Set<CloudUpdatedListener>();
    readonly #profileListeners = new Set<CloudProfileUpdatedListener>();
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #clients = new Map<CloudEnvironment, CloudWorkOS>();
    #attempt: CloudAttempt | undefined;
    #cloud: Cloud;
    #context: Context | undefined;
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
        return {};
    };

    async stop(): Promise<void> {
        this.#profileUnsubscribe();
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

    onProfileUpdated(listener: CloudProfileUpdatedListener): () => void {
        this.#profileListeners.add(listener);
        return () => {
            this.#profileListeners.delete(listener);
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
    ): Promise<void> {
        const stored = await this.#readOwned(ctx);
        if (stored?.session === null || stored?.session === undefined) {
            throw new Error("The Cloud session changed while enrollment was being stored.");
        }
        if (stored.session.user.id !== minted.session.user.id) {
            throw new Error("The Cloud account changed while enrollment was being stored.");
        }
        if (sameUser(stored.session.user, minted.authenticated.user)) {
            await this.#database.updateEnrollment(ctx, stored.session.user.id, enrollment);
            return;
        }
        await this.#replace(ctx, {
            error: null,
            pending: false,
            session: cloudSession(
                stored.session.environment,
                stored.session.refreshToken,
                minted.authenticated.user,
                enrollment,
            ),
        });
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
            await this.#persistSessionAfterProfile(ctx, minted, null);
            return true;
        }

        const localProfile = await this.#profile.get(ctx);
        const name = localProfileName(localProfile);
        if (localProfile === undefined || name === undefined) {
            await this.#persistSessionAfterProfile(
                ctx,
                minted,
                cloudEnrollment(online.username, null),
            );
            return true;
        }

        if (online.firstName === name && online.lastName === undefined) {
            await this.#persistSessionAfterProfile(
                ctx,
                minted,
                cloudEnrollment(online.username, localProfile.version),
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
        );
        for (const listener of this.#profileListeners) listener(ctx);

        const latest = await this.#profile.get(ctx);
        return latest?.version === localProfile.version;
    }

    async #initialize(ctx: Context): Promise<void> {
        const stored = await this.#database.read(ctx);
        if (stored === undefined) {
            const created = await this.#database.replace(ctx, {
                error: null,
                pending: false,
                session: null,
            });
            this.#cloud = project(created);
            return;
        }
        this.#cloud = project(stored);
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
        status: 400 | 409 | 503,
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
    operation: "authorization" | "profile" | "token",
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
