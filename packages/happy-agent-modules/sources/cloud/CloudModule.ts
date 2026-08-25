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
    StartCloudAuthorizationRequest,
    UpdateCloudProfileRequest,
} from "@slopus/happy-agent-client";
import { updateCloudProfileRequestSchema } from "@slopus/happy-agent-client";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import { afterCommit, asyncLock, detach, type AsyncLock, type Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import {
    cloudMigrations,
    cloudSession,
    createCloudDatabase,
    type CloudSession,
    type CloudStoredState,
    type CloudStoredValue,
} from "./CloudDatabase.js";
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

interface CloudAttempt {
    readonly codeVerifier: string;
    readonly environment: CloudEnvironment;
    readonly expiresAt: number;
    readonly phase: "active" | "consumed";
    readonly redirectUri: string;
    readonly state: string;
    readonly url: string;
}

interface CloudReplacementOptions {
    readonly attempt?: CloudAttempt;
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
    readonly #listeners = new Set<CloudUpdatedListener>();
    readonly #profileListeners = new Set<CloudProfileUpdatedListener>();
    readonly #lock: AsyncLock = asyncLock({ reentry: "allow" });
    readonly #clients = new Map<CloudEnvironment, CloudWorkOS>();
    #attempt: CloudAttempt | undefined;
    #cloud: Cloud;
    #context: Context | undefined;
    #expiryTimer: NodeJS.Timeout | undefined;
    #stopping = false;

    constructor() {
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
            this.#clearExpiry();
            this.#attempt = undefined;
            return;
        }
        await this.#lock.runInLock(ctx, async () => {
            this.#stopping = true;
            this.#clearExpiry();
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
            const attempt: CloudAttempt = {
                ...secret,
                environment: request.environment,
                expiresAt: Date.now() + AUTHORIZATION_LIFETIME_MS,
                phase: "active",
                redirectUri,
            };
            const cloud = await this.#replace(
                ctx,
                { error: null, pending: true, session: null },
                {
                    attempt,
                    onCommit: () => {
                        this.#clearExpiry();
                        this.#attempt = attempt;
                        this.#scheduleExpiry(attempt);
                    },
                },
            );
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
            this.#clearExpiry();
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
                        onCommit: () => {
                            this.#clearExpiry();
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

    async updateProfile(
        _ctx: Context,
        request: UpdateCloudProfileRequest,
    ): Promise<CloudProfileResponse> {
        const ctx = this.#ownedContext();
        return await this.#lock.runInLock(ctx, async () => {
            this.#assertRunning();
            if (!Value.Check(updateCloudProfileRequestSchema, request)) {
                throw this.#error(400, "invalid_request", "The Cloud profile is invalid.");
            }
            const minted = await this.#mintInLock(ctx, false);
            let profile: CloudProfile;
            try {
                profile = await this.#client(minted.cloud.environment).updateProfile(
                    minted.accessToken,
                    request,
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
            await this.#publishUserChangeAfterProfile(ctx, minted);
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
            ),
        });
    }

    async #publishUserChangeAfterProfile(
        ctx: Context,
        minted: MintedCloudCredential,
    ): Promise<void> {
        try {
            await this.#publishUserChange(ctx, minted);
        } catch (error: unknown) {
            // The remote profile mutation already succeeded. A secondary WorkOS metadata write
            // must not turn that success into a retry that could overwrite a newer Cloud profile.
            logCloudFailure(ctx, "profile", minted.cloud.environment, "workos-user-update", error);
        }
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
        if (stored.pending) {
            await this.#replace(ctx, {
                error: {
                    code: "authorization_expired",
                    message: "Cloud authorization expired when Happy Agent restarted.",
                },
                pending: false,
                session: null,
            });
        }
    }

    async #replace(
        ctx: Context,
        value: CloudStoredReplacement,
        options: CloudReplacementOptions = {},
    ): Promise<Cloud> {
        return await ctx.inTx(async (txCtx) => {
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
                    onCommit: () => {
                        if (this.#attempt !== attempt) return;
                        this.#clearExpiry();
                        this.#attempt = undefined;
                    },
                },
            ),
        );
    }

    #scheduleExpiry(attempt: CloudAttempt, retryAfter?: number): void {
        const delay = retryAfter ?? Math.max(1, attempt.expiresAt - Date.now());
        this.#expiryTimer = setTimeout(() => {
            this.#expiryTimer = undefined;
            const ctx = this.#context;
            if (ctx === undefined || this.#stopping) return;
            void this.#lock
                .runInLock(ctx, async () => {
                    if (this.#stopping) return;
                    if (
                        this.#attempt === attempt &&
                        attempt.phase === "active" &&
                        Date.now() >= attempt.expiresAt
                    ) {
                        await this.#expire(ctx, attempt);
                    } else if (this.#attempt === attempt && attempt.phase === "active") {
                        this.#scheduleExpiry(attempt);
                    }
                })
                .catch((error: unknown) => {
                    ctx.log.warn("Cloud authorization expiry could not be stored.", {}, error);
                    if (
                        !this.#stopping &&
                        this.#attempt === attempt &&
                        attempt.phase === "active"
                    ) {
                        this.#scheduleExpiry(attempt, AUTHORIZATION_EXPIRY_RETRY_MS);
                    }
                });
        }, delay);
        this.#expiryTimer.unref();
    }

    #clearExpiry(): void {
        if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer);
        this.#expiryTimer = undefined;
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
