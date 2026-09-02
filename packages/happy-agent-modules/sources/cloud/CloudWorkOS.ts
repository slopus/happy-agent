import {
    cloudEnvironmentSchema,
    cloudOrganizationSchema,
    cloudProfileSchema,
    cloudUsernameSchema,
    createCloudOrganizationRequestSchema,
    type CloudEnvironment,
    type CloudOrganization,
    type CloudProfile,
    type CloudSocialProfile,
} from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    AuthenticationException,
    BadRequestException,
    ConflictException,
    GenericServerException,
    NotFoundException,
    OauthException,
    UnauthorizedException,
    UnprocessableEntityException,
    WorkOS,
    type PublicWorkOS,
    type WorkOSOptions,
} from "@workos-inc/node";

import {
    openCloudSocialSocket,
    type CloudSocialSocketCallbacks,
    type CloudSocialSocketConnection,
} from "./CloudSocialSocket.js";
import {
    cloudStorageInvalidResponseSchema,
    cloudStorageNotFoundResponseSchema,
    cloudStoragePreconditionFailedResponseSchema,
    cloudStorageValueSchema,
    cloudStorageWriteConditionSchema,
    cloudStorageWriteResultSchema,
    CloudStorageInvalidRequestError,
    CloudStoragePreconditionFailedError,
    MAX_CLOUD_STORAGE_VALUE_BYTES,
    validCloudStorageKey,
    type CloudStorageValue,
    type CloudStorageWriteCondition,
    type CloudStorageWriteResult,
} from "./CloudStorage.js";

export {
    CloudStorageInvalidRequestError,
    CloudStoragePreconditionFailedError,
} from "./CloudStorage.js";

const WORKOS_TIMEOUT_MS = 15_000;
const MAX_WORKOS_RESPONSE_BYTES = 1024 * 1_024;
const CLOUD_REQUEST_TIMEOUT_MS = 15_000;
const CLOUD_SOCIAL_SYNC_TIMEOUT_MS = 30_000;
const MAX_CLOUD_RESPONSE_BYTES = 8 * 1_024;
const MAX_CLOUD_ORGANIZATIONS_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const MAX_CLOUD_SOCIAL_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_CLOUD_ORGANIZATIONS = 10_000;
const MAX_CLOUD_SOCIAL_PROFILES = 5_000;
const CLOUD_PROFILE_CONCURRENCY = 8;
const exact = { additionalProperties: false } as const;

const deployments: Readonly<
    Record<CloudEnvironment, { readonly cloudUrl: string; readonly workosClientId: string }>
> = {
    production: {
        cloudUrl: "https://cloud.cluster-fluster.com",
        workosClientId: "client_01KZD3XE9YAFAMT0P8TD4HP73E",
    },
    staging: {
        cloudUrl: "https://happy-cloud-staging.bulka-llc.workers.dev",
        workosClientId: "client_01KZD3XE4EW1AF1P6WTFHBPR4J",
    },
};

const workosAuthenticationSchema = Type.Object(
    {
        accessToken: Type.String({ minLength: 1, maxLength: 32_768 }),
        refreshToken: Type.String({ minLength: 1, maxLength: 32_768 }),
        user: Type.Object(
            {
                email: Type.String({ minLength: 1, maxLength: 320 }),
                firstName: Type.Union([Type.Null(), Type.String({ maxLength: 512 })]),
                id: Type.String({ minLength: 1, maxLength: 256 }),
                lastName: Type.Union([Type.Null(), Type.String({ maxLength: 512 })]),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);

const authorizationSchema = Type.Object(
    {
        codeVerifier: Type.String({ minLength: 43, maxLength: 256 }),
        state: Type.String({ minLength: 16, maxLength: 512 }),
        url: Type.String({ minLength: 1, maxLength: 16_384 }),
    },
    { additionalProperties: false },
);

const helloSchema = Type.Object(
    {
        message: Type.Literal("hello"),
        userId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: true },
);

const invalidProfileSchema = Type.Object(
    { error: Type.Literal("invalid_profile") },
    { additionalProperties: false },
);

const usernameUnavailableSchema = Type.Object(
    { error: Type.Literal("username_unavailable") },
    { additionalProperties: false },
);

const cloudOrganizationsResponseSchema = Type.Object(
    {
        organizations: Type.Array(cloudOrganizationSchema, {
            maxItems: MAX_CLOUD_ORGANIZATIONS,
        }),
    },
    exact,
);
const invalidOrganizationSchema = Type.Object(
    { error: Type.Literal("invalid_organization") },
    exact,
);
const organizationForbiddenSchema = Type.Object({ error: Type.Literal("forbidden") }, exact);
const organizationNotFoundSchema = Type.Object({ error: Type.Literal("not_found") }, exact);
const organizationDeletedSchema = Type.Object({ status: Type.Literal("deleted") }, exact);

const cloudFriendEntrySchema = Type.Object(
    {
        firstName: Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
        }),
        lastName: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 64,
                pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
            }),
        ),
        username: cloudUsernameSchema,
    },
    exact,
);

const cloudFriendsResponseSchema = Type.Object(
    {
        friends: Type.Array(cloudFriendEntrySchema, { maxItems: MAX_CLOUD_SOCIAL_PROFILES }),
        version: Type.String({
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        }),
    },
    exact,
);

const cloudFriendRequestsResponseSchema = Type.Object(
    {
        incoming: Type.Array(cloudFriendEntrySchema, { maxItems: MAX_CLOUD_SOCIAL_PROFILES }),
        outgoing: Type.Array(cloudFriendEntrySchema, { maxItems: MAX_CLOUD_SOCIAL_PROFILES }),
        version: cloudFriendsResponseSchema.properties.version,
    },
    exact,
);

const cloudBlockedResponseSchema = Type.Object(
    {
        blocked: Type.Array(cloudFriendEntrySchema, { maxItems: MAX_CLOUD_SOCIAL_PROFILES }),
        version: cloudFriendsResponseSchema.properties.version,
    },
    exact,
);

const cloudPublicProfileSchema = Type.Object(
    {
        ...cloudFriendEntrySchema.properties,
        version: cloudFriendsResponseSchema.properties.version,
    },
    exact,
);

const cloudRemoteSocialSnapshotSchema = Type.Object(
    {
        blocked: Type.Array(cloudPublicProfileSchema, { maxItems: MAX_CLOUD_SOCIAL_PROFILES }),
        friends: Type.Array(cloudPublicProfileSchema, { maxItems: MAX_CLOUD_SOCIAL_PROFILES }),
        incomingRequests: Type.Array(cloudPublicProfileSchema, {
            maxItems: MAX_CLOUD_SOCIAL_PROFILES,
        }),
        outgoingRequests: Type.Array(cloudPublicProfileSchema, {
            maxItems: MAX_CLOUD_SOCIAL_PROFILES,
        }),
        version: cloudFriendsResponseSchema.properties.version,
    },
    exact,
);
export type CloudRemoteSocialSnapshot = Static<typeof cloudRemoteSocialSnapshotSchema>;

export const cloudSocialMutationSchema = Type.Union([
    Type.Literal("approve-request"),
    Type.Literal("block"),
    Type.Literal("reject-request"),
    Type.Literal("revoke-request"),
    Type.Literal("send-request"),
    Type.Literal("unblock"),
]);
export type CloudSocialMutation = Static<typeof cloudSocialMutationSchema>;

const socialNotFoundSchema = Type.Object({ error: Type.Literal("not_found") }, exact);
const socialBlockedSchema = Type.Object({ error: Type.Literal("blocked") }, exact);
const socialInvalidRequestSchema = Type.Object({ error: Type.Literal("invalid_request") }, exact);
const socialProfileRequiredSchema = Type.Object({ error: Type.Literal("profile_required") }, exact);

const cloudVaultVersionSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const cloudVaultIdentitySchema = Type.String({ minLength: 1, maxLength: 512 });
const cloudVaultStatusSchema = Type.Object(
    { identityKey: Type.Union([Type.Null(), cloudVaultIdentitySchema]) },
    { additionalProperties: true },
);
const cloudVaultSavedSchema = Type.Object({ version: cloudVaultVersionSchema }, exact);
const cloudVaultRestoredSchema = Type.Object(
    {
        blob: Type.String({ minLength: 1, maxLength: 4_096 }),
        identityKey: cloudVaultIdentitySchema,
        version: cloudVaultVersionSchema,
    },
    exact,
);
const cloudVaultKeyMismatchSchema = Type.Object(
    { error: Type.Literal("vault_key_mismatch") },
    exact,
);
const cloudVaultNotFoundSchema = Type.Object({ error: Type.Literal("not_found") }, exact);

const cloudProfileUpdateSchema = Type.Object(
    {
        firstName: Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
        }),
        username: cloudUsernameSchema,
    },
    { additionalProperties: false },
);
type CloudProfileUpdate = Static<typeof cloudProfileUpdateSchema>;

const cloudProfileStateSchema = Type.Union([
    Type.Object(
        {
            firstName: Type.Null(),
            username: Type.Null(),
        },
        { additionalProperties: true },
    ),
    Type.Object(
        {
            firstName: cloudProfileUpdateSchema.properties.firstName,
            lastName: cloudFriendEntrySchema.properties.lastName,
            username: cloudUsernameSchema,
        },
        { additionalProperties: true },
    ),
]);
export type CloudProfileState = {
    readonly profile: CloudProfile;
};

const workOSParseErrorSchema = Type.Object(
    {
        name: Type.Literal("ParseError"),
        rawStatus: Type.Integer({ minimum: 100, maximum: 599 }),
    },
    { additionalProperties: true },
);

export type CloudAuthorizationSecret = Static<typeof authorizationSchema>;
export type CloudAuthentication = Static<typeof workosAuthenticationSchema>;

export class CloudCredentialsRejectedError extends Error {
    constructor() {
        super("WorkOS rejected the Cloud credentials.");
        this.name = "CloudCredentialsRejectedError";
    }
}

/** Happy Cloud accepted the token but associated it with a different WorkOS user. */
export class CloudIdentityMismatchError extends Error {
    constructor() {
        super("Happy Cloud returned a different authenticated user.");
        this.name = "CloudIdentityMismatchError";
    }
}

export class CloudProfileRejectedError extends Error {
    constructor() {
        super("Happy Cloud rejected the profile.");
        this.name = "CloudProfileRejectedError";
    }
}

export class CloudUsernameUnavailableError extends Error {
    constructor() {
        super("The Happy Cloud username is unavailable.");
        this.name = "CloudUsernameUnavailableError";
    }
}

export class CloudOrganizationInvalidRequestError extends Error {
    constructor() {
        super("Happy Cloud rejected the organization request.");
        this.name = "CloudOrganizationInvalidRequestError";
    }
}

export class CloudOrganizationForbiddenError extends Error {
    constructor() {
        super("Happy Cloud rejected the organization deletion.");
        this.name = "CloudOrganizationForbiddenError";
    }
}

export class CloudVaultKeyMismatchError extends Error {
    constructor() {
        super("Happy Cloud rejected the Cloud key proof.");
        this.name = "CloudVaultKeyMismatchError";
    }
}

export class CloudVaultNotFoundError extends Error {
    constructor() {
        super("Happy Cloud has no encrypted key bundle.");
        this.name = "CloudVaultNotFoundError";
    }
}

export class CloudVaultDeleteRejectedError extends Error {
    constructor() {
        super("Happy Cloud rejected the vault reset.");
        this.name = "CloudVaultDeleteRejectedError";
    }
}

export class CloudSocialNotFoundError extends Error {
    constructor() {
        super("The Happy Cloud friend or request was not found.");
        this.name = "CloudSocialNotFoundError";
    }
}

export class CloudSocialBlockedError extends Error {
    constructor() {
        super("Happy Cloud blocked the friend request.");
        this.name = "CloudSocialBlockedError";
    }
}

export class CloudSocialInvalidRequestError extends Error {
    constructor() {
        super("Happy Cloud rejected the friend request.");
        this.name = "CloudSocialInvalidRequestError";
    }
}

export class CloudProfileRequiredError extends Error {
    constructor() {
        super("Happy Cloud requires an enrolled profile.");
        this.name = "CloudProfileRequiredError";
    }
}

export class CloudSocialSnapshotChangedError extends Error {
    constructor() {
        super("Happy Cloud social state changed while it was being read.");
        this.name = "CloudSocialSnapshotChangedError";
    }
}

export type CloudServiceUnavailableReason =
    | "request-failed"
    | "request-timed-out"
    | "response-invalid"
    | "response-rejected";

export class CloudServiceUnavailableError extends Error {
    readonly reason: CloudServiceUnavailableReason;
    readonly status: number | undefined;

    constructor(reason: CloudServiceUnavailableReason = "response-invalid", status?: number) {
        super("Cloud authentication is temporarily unavailable.");
        this.name = "CloudServiceUnavailableError";
        this.reason = reason;
        this.status = status;
    }
}

/**
 * WorkOS's public-client factory currently constructs its environment-aware base class directly,
 * which both ignores `fetchFn` and may inherit `WORKOS_API_KEY`. The Node subclass has the bounded
 * fetch seam we need; clear the base constructor's ambient key before it builds that transport so
 * authentication remains PKCE-only even in a process that happens to export server credentials.
 */
class PublicCloudWorkOSClient extends WorkOS {
    override createHttpClient(options: WorkOSOptions, userAgent: string) {
        Object.defineProperty(this, "key", { configurable: true, value: undefined });
        return super.createHttpClient(options, userAgent);
    }
}

/** The bounded WorkOS public client and Happy Cloud verification boundary. */
export class CloudWorkOS {
    readonly #cloudUrl: string;
    readonly #workos: Pick<PublicWorkOS, "userManagement">;

    constructor(environment: CloudEnvironment) {
        if (!Value.Check(cloudEnvironmentSchema, environment)) {
            throw new Error("The Cloud environment is invalid.");
        }
        const deployment = deployments[environment];
        this.#cloudUrl = deployment.cloudUrl;
        this.#workos = new PublicCloudWorkOSClient({
            clientId: deployment.workosClientId,
            fetchFn: boundedWorkOSFetch,
            maxRetries: 0,
            timeout: WORKOS_TIMEOUT_MS,
        });
    }

    async authorization(redirectUri: string): Promise<CloudAuthorizationSecret> {
        try {
            const authorization = await this.#workos.userManagement.getAuthorizationUrlWithPKCE({
                provider: "authkit",
                redirectUri,
            });
            if (!Value.Check(authorizationSchema, authorization)) {
                throw new CloudServiceUnavailableError();
            }
            return structuredClone(authorization) as CloudAuthorizationSecret;
        } catch (error: unknown) {
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw workOSUnavailable(error);
        }
    }

    async exchange(code: string, codeVerifier: string): Promise<CloudAuthentication> {
        try {
            return authentication(
                await this.#workos.userManagement.authenticateWithCode({ code, codeVerifier }),
            );
        } catch (error: unknown) {
            if (isTerminalCodeRejection(error)) throw new CloudCredentialsRejectedError();
            if (error instanceof CloudCredentialsRejectedError) throw error;
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw workOSUnavailable(error);
        }
    }

    async refresh(refreshToken: string): Promise<CloudAuthentication> {
        try {
            return authentication(
                await this.#workos.userManagement.authenticateWithRefreshToken({ refreshToken }),
            );
        } catch (error: unknown) {
            if (error instanceof OauthException && error.error === "invalid_grant") {
                throw new CloudCredentialsRejectedError();
            }
            if (error instanceof CloudCredentialsRejectedError) throw error;
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw workOSUnavailable(error);
        }
    }

    /** Verifies the minted token against Happy Cloud without treating its 401 as revocation. */
    async verify(accessToken: string, expectedUserId: string): Promise<void> {
        const result = await this.#request("/v0/hello", accessToken, "GET");
        if (result.status < 200 || result.status >= 300) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        if (!Value.Check(helloSchema, result.body)) throw new CloudServiceUnavailableError();
        if (result.body.userId !== expectedUserId) throw new CloudIdentityMismatchError();
    }

    async listOrganizations(accessToken: string): Promise<CloudOrganization[]> {
        const result = await this.#request(
            "/v0/organizations",
            accessToken,
            "GET",
            undefined,
            [],
            MAX_CLOUD_ORGANIZATIONS_RESPONSE_BYTES,
        );
        if (!result.ok) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        if (!Value.Check(cloudOrganizationsResponseSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-invalid", result.status);
        }
        return result.body.organizations.map(cloudOrganization);
    }

    async createOrganization(accessToken: string, name: string): Promise<CloudOrganization> {
        if (!Value.Check(createCloudOrganizationRequestSchema.properties.name, name)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        const result = await this.#request(
            "/v0/organizations",
            accessToken,
            "POST",
            { name },
            [400],
        );
        if (result.status === 400 && Value.Check(invalidOrganizationSchema, result.body)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        if (!result.ok) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        return cloudOrganization(result.body);
    }

    async deleteOrganization(accessToken: string, organizationId: string): Promise<void> {
        if (!Value.Check(cloudOrganizationSchema.properties.id, organizationId)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        const result = await this.#request(
            `/v0/organizations/${encodeURIComponent(organizationId)}`,
            accessToken,
            "DELETE",
            undefined,
            [403, 404],
        );
        if (result.status === 403 && Value.Check(organizationForbiddenSchema, result.body)) {
            throw new CloudOrganizationForbiddenError();
        }
        if (result.status === 404 && Value.Check(organizationNotFoundSchema, result.body)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        if (!result.ok) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        if (!Value.Check(organizationDeletedSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-invalid", result.status);
        }
    }

    async getProfile(accessToken: string): Promise<CloudProfile> {
        return (await this.getProfileState(accessToken)).profile;
    }

    async getProfileState(accessToken: string): Promise<CloudProfileState> {
        const result = await this.#request("/v0/profile", accessToken, "GET");
        if (result.status < 200 || result.status >= 300) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        if (!Value.Check(cloudProfileStateSchema, result.body)) {
            throw new CloudServiceUnavailableError();
        }
        return { profile: cloudProfile(result.body) };
    }

    async updateProfile(accessToken: string, request: CloudProfileUpdate): Promise<CloudProfile> {
        if (!Value.Check(cloudProfileUpdateSchema, request)) {
            throw new CloudProfileRejectedError();
        }
        const result = await this.#request(
            "/v0/profile",
            accessToken,
            "PUT",
            {
                firstName: request.firstName,
                username: request.username,
            },
            [400, 409],
        );
        if (result.status === 400 && Value.Check(invalidProfileSchema, result.body)) {
            throw new CloudProfileRejectedError();
        }
        if (result.status === 409 && Value.Check(usernameUnavailableSchema, result.body)) {
            throw new CloudUsernameUnavailableError();
        }
        if (result.status < 200 || result.status >= 300) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        return cloudProfile(result.body);
    }

    async readValue(accessToken: string, key: string): Promise<CloudStorageValue | undefined> {
        if (!validCloudStorageKey(key)) throw new CloudStorageInvalidRequestError();
        const { response, signal } = await this.#fetchResponse(
            `/v0/storage?key=${encodeURIComponent(key)}`,
            accessToken,
            "GET",
            undefined,
            { "accept-encoding": "identity" },
        );
        if (response.status === 404) {
            const body = await parseCloudJsonResponse(response, MAX_CLOUD_RESPONSE_BYTES, signal);
            if (Value.Check(cloudStorageNotFoundResponseSchema, body)) return undefined;
            throw new CloudServiceUnavailableError("response-invalid", response.status);
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new CloudServiceUnavailableError("response-rejected", response.status);
        }
        if (
            response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
            "application/octet-stream"
        ) {
            await response.body?.cancel().catch(() => undefined);
            throw new CloudServiceUnavailableError("response-invalid", response.status);
        }
        const metadata = cloudStorageResponseMetadata(response);
        const value = await readCloudBytes(response, MAX_CLOUD_STORAGE_VALUE_BYTES, signal);
        const result = { ...metadata, value };
        if (!Value.Check(cloudStorageValueSchema, result)) {
            throw new CloudServiceUnavailableError("response-invalid", response.status);
        }
        return result;
    }

    async writeValue(
        accessToken: string,
        key: string,
        value: Uint8Array,
        condition: CloudStorageWriteCondition = { kind: "any" },
    ): Promise<CloudStorageWriteResult> {
        if (
            !validCloudStorageKey(key) ||
            !Value.Check(cloudStorageValueSchema.properties.value, value) ||
            !Value.Check(cloudStorageWriteConditionSchema, condition)
        ) {
            throw new CloudStorageInvalidRequestError();
        }
        const conditionHeaders = cloudStorageConditionHeaders(condition);
        const copied = new Uint8Array(value);
        const { response, signal } = await this.#fetchResponse(
            `/v0/storage?key=${encodeURIComponent(key)}`,
            accessToken,
            "PUT",
            copied.buffer as ArrayBuffer,
            {
                "accept-encoding": "identity",
                "content-type": "application/octet-stream",
                ...conditionHeaders,
            },
        );
        if (response.status !== 200 && response.status !== 400 && response.status !== 412) {
            await response.body?.cancel().catch(() => undefined);
            throw new CloudServiceUnavailableError("response-rejected", response.status);
        }
        const body = await parseCloudJsonResponse(response, MAX_CLOUD_RESPONSE_BYTES, signal);
        if (response.status === 400 && Value.Check(cloudStorageInvalidResponseSchema, body)) {
            throw new CloudStorageInvalidRequestError();
        }
        if (
            response.status === 412 &&
            Value.Check(cloudStoragePreconditionFailedResponseSchema, body)
        ) {
            if (body.sha256 === null) {
                assertCloudStorageResponseHasNoMetadata(response);
                throw new CloudStoragePreconditionFailedError(undefined);
            }
            const current = { sha256: body.sha256, version: body.version };
            assertCloudStorageResponseMetadata(response, current);
            throw new CloudStoragePreconditionFailedError(current);
        }
        if (!response.ok || !Value.Check(cloudStorageWriteResultSchema, body)) {
            throw new CloudServiceUnavailableError("response-invalid", response.status);
        }
        assertCloudStorageResponseMetadata(response, body);
        return { sha256: body.sha256, version: body.version };
    }

    async getVaultIdentity(accessToken: string): Promise<string | undefined> {
        const result = await this.#request("/v0/vault", accessToken, "GET");
        if (!result.ok || !Value.Check(cloudVaultStatusSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        return result.body.identityKey ?? undefined;
    }

    async saveVault(
        accessToken: string,
        authHash: string,
        identityKey: string,
        blob: string,
    ): Promise<void> {
        if (!Value.Check(cloudVaultIdentitySchema, identityKey)) {
            throw new CloudServiceUnavailableError();
        }
        const result = await this.#request(
            "/v0/vault",
            accessToken,
            "PUT",
            { authKey: authHash, blob, identityKey },
            [400, 403],
        );
        if (result.status === 403 && Value.Check(cloudVaultKeyMismatchSchema, result.body)) {
            throw new CloudVaultKeyMismatchError();
        }
        if (!result.ok || !Value.Check(cloudVaultSavedSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
    }

    async restoreVault(
        accessToken: string,
        authHash: string,
    ): Promise<{ readonly blob: string; readonly identityKey: string }> {
        const result = await this.#request(
            "/v0/vault/restore",
            accessToken,
            "POST",
            { authKey: authHash },
            [400, 403, 404],
        );
        if (result.status === 403 && Value.Check(cloudVaultKeyMismatchSchema, result.body)) {
            throw new CloudVaultKeyMismatchError();
        }
        if (result.status === 404 && Value.Check(cloudVaultNotFoundSchema, result.body)) {
            throw new CloudVaultNotFoundError();
        }
        if (!result.ok || !Value.Check(cloudVaultRestoredSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        return { blob: result.body.blob, identityKey: result.body.identityKey };
    }

    async deleteVault(accessToken: string): Promise<void> {
        const result = await this.#request(
            "/v0/vault",
            accessToken,
            "DELETE",
            undefined,
            [400, 403, 404],
            MAX_CLOUD_RESPONSE_BYTES,
            undefined,
            true,
        );
        if (result.status === 404) return;
        if (result.status === 400 || result.status === 403) {
            throw new CloudVaultDeleteRejectedError();
        }
        if (!result.ok) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
    }

    async getSocialSnapshot(accessToken: string): Promise<CloudRemoteSocialSnapshot> {
        const socialSignal = AbortSignal.timeout(CLOUD_SOCIAL_SYNC_TIMEOUT_MS);
        const [friendsResult, requestsResult, blockedResult] = await Promise.all([
            this.#request(
                "/v0/friends",
                accessToken,
                "GET",
                undefined,
                [],
                MAX_CLOUD_SOCIAL_RESPONSE_BYTES,
                socialSignal,
            ),
            this.#request(
                "/v0/friends/requests",
                accessToken,
                "GET",
                undefined,
                [],
                MAX_CLOUD_SOCIAL_RESPONSE_BYTES,
                socialSignal,
            ),
            this.#request(
                "/v0/friends/blocked",
                accessToken,
                "GET",
                undefined,
                [],
                MAX_CLOUD_SOCIAL_RESPONSE_BYTES,
                socialSignal,
            ),
        ]);
        if (
            !friendsResult.ok ||
            !requestsResult.ok ||
            !blockedResult.ok ||
            !Value.Check(cloudFriendsResponseSchema, friendsResult.body) ||
            !Value.Check(cloudFriendRequestsResponseSchema, requestsResult.body) ||
            !Value.Check(cloudBlockedResponseSchema, blockedResult.body)
        ) {
            throw new CloudServiceUnavailableError(
                "response-rejected",
                socialStatus([friendsResult.status, requestsResult.status, blockedResult.status]),
            );
        }
        const version = friendsResult.body.version;
        if (requestsResult.body.version !== version || blockedResult.body.version !== version) {
            throw new CloudSocialSnapshotChangedError();
        }

        const usernames = [
            ...friendsResult.body.friends,
            ...requestsResult.body.incoming,
            ...requestsResult.body.outgoing,
            ...blockedResult.body.blocked,
        ].map((entry) => entry.username);
        const uniqueUsernames = [...new Set(usernames)].sort();
        if (uniqueUsernames.length > MAX_CLOUD_SOCIAL_PROFILES) {
            throw new CloudServiceUnavailableError();
        }
        const profiles = new Map<string, CloudSocialProfile>();
        for (let offset = 0; offset < uniqueUsernames.length; offset += CLOUD_PROFILE_CONCURRENCY) {
            const batch = uniqueUsernames.slice(offset, offset + CLOUD_PROFILE_CONCURRENCY);
            const resolved = await Promise.all(
                batch.map(
                    async (username) =>
                        await this.#getPublicProfile(accessToken, username, socialSignal),
                ),
            );
            for (const profile of resolved) profiles.set(profile.username, profile);
        }
        if (uniqueUsernames.some((username) => !profiles.has(username))) {
            throw new CloudSocialSnapshotChangedError();
        }

        const final = await this.#request(
            "/v0/friends",
            accessToken,
            "GET",
            undefined,
            [],
            MAX_CLOUD_SOCIAL_RESPONSE_BYTES,
            socialSignal,
        );
        if (!final.ok || !Value.Check(cloudFriendsResponseSchema, final.body)) {
            throw new CloudServiceUnavailableError("response-rejected", final.status);
        }
        if (final.body.version !== version) throw new CloudSocialSnapshotChangedError();

        const snapshot = {
            blocked: profilesFor(blockedResult.body.blocked, profiles),
            friends: profilesFor(friendsResult.body.friends, profiles),
            incomingRequests: profilesFor(requestsResult.body.incoming, profiles),
            outgoingRequests: profilesFor(requestsResult.body.outgoing, profiles),
            version,
        };
        if (!Value.Check(cloudRemoteSocialSnapshotSchema, snapshot)) {
            throw new CloudServiceUnavailableError();
        }
        return structuredClone(snapshot) as CloudRemoteSocialSnapshot;
    }

    async mutateSocial(
        accessToken: string,
        mutation: CloudSocialMutation,
        username: string,
    ): Promise<void> {
        if (
            !Value.Check(cloudSocialMutationSchema, mutation) ||
            !Value.Check(cloudUsernameSchema, username)
        ) {
            throw new CloudSocialInvalidRequestError();
        }
        const request = socialMutationRequest(mutation, username);
        const result = await this.#request(
            request.path,
            accessToken,
            request.method,
            undefined,
            [400, 403, 404, 409],
        );
        if (result.ok) return;
        if (result.status === 404 && Value.Check(socialNotFoundSchema, result.body)) {
            throw new CloudSocialNotFoundError();
        }
        if (result.status === 403 && Value.Check(socialBlockedSchema, result.body)) {
            throw new CloudSocialBlockedError();
        }
        if (result.status === 400 && Value.Check(socialInvalidRequestSchema, result.body)) {
            throw new CloudSocialInvalidRequestError();
        }
        if (result.status === 409 && Value.Check(socialProfileRequiredSchema, result.body)) {
            throw new CloudProfileRequiredError();
        }
        throw new CloudServiceUnavailableError("response-rejected", result.status);
    }

    async openSocialSocket(
        accessToken: string,
        signal: AbortSignal,
        callbacks: CloudSocialSocketCallbacks,
    ): Promise<CloudSocialSocketConnection> {
        return await openCloudSocialSocket(
            `${this.#cloudUrl}/v0/updates`,
            accessToken,
            signal,
            callbacks,
        );
    }

    async #getPublicProfile(
        accessToken: string,
        username: string,
        socialSignal: AbortSignal,
    ): Promise<CloudSocialProfile> {
        const result = await this.#request(
            `/v0/profiles/${encodeURIComponent(username)}`,
            accessToken,
            "GET",
            undefined,
            [],
            MAX_CLOUD_RESPONSE_BYTES,
            socialSignal,
        );
        if (result.status === 404) throw new CloudSocialSnapshotChangedError();
        if (!result.ok || !Value.Check(cloudPublicProfileSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        if (result.body.username !== username) throw new CloudSocialSnapshotChangedError();
        return {
            firstName: result.body.firstName,
            ...(result.body.lastName === undefined ? {} : { lastName: result.body.lastName }),
            username: result.body.username,
            version: result.body.version,
        };
    }

    async #request(
        path: string,
        accessToken: string,
        method: "DELETE" | "GET" | "POST" | "PUT",
        body?: Readonly<Record<string, string>>,
        parsedErrorStatuses: readonly number[] = [],
        maximum = MAX_CLOUD_RESPONSE_BYTES,
        callerSignal?: AbortSignal,
        discardBody = false,
    ): Promise<{ readonly body: unknown; readonly ok: boolean; readonly status: number }> {
        const { response, signal } = await this.#fetchResponse(
            path,
            accessToken,
            method,
            body === undefined ? undefined : JSON.stringify(body),
            body === undefined ? undefined : { "content-type": "application/json" },
            callerSignal,
        );
        if (!response.ok && !parsedErrorStatuses.includes(response.status)) {
            await response.body?.cancel().catch(() => undefined);
            return { body: undefined, ok: response.ok, status: response.status };
        }
        if (discardBody || response.status === 204) {
            await response.body?.cancel().catch(() => undefined);
            return { body: undefined, ok: response.ok, status: response.status };
        }
        try {
            const bytes = await readBounded(response, maximum, signal);
            return {
                body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
                ok: response.ok,
                status: response.status,
            };
        } catch (error: unknown) {
            if (signal.aborted) throw new CloudServiceUnavailableError("request-timed-out");
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw new CloudServiceUnavailableError("response-invalid", response.status);
        }
    }

    async #fetchResponse(
        path: string,
        accessToken: string,
        method: "DELETE" | "GET" | "POST" | "PUT",
        body?: RequestInit["body"],
        extraHeaders?: RequestInit["headers"],
        callerSignal?: AbortSignal,
    ): Promise<{ readonly response: Response; readonly signal: AbortSignal }> {
        const requestDeadline = AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS);
        const signal =
            callerSignal === undefined
                ? requestDeadline
                : AbortSignal.any([requestDeadline, callerSignal]);
        const headers = new Headers(extraHeaders);
        headers.set("authorization", `Bearer ${accessToken}`);
        try {
            const response = await fetch(`${this.#cloudUrl}${path}`, {
                ...(body === undefined ? {} : { body }),
                headers,
                method,
                signal,
            });
            return { response, signal };
        } catch {
            throw new CloudServiceUnavailableError(
                signal.aborted ? "request-timed-out" : "request-failed",
            );
        }
    }
}

function cloudStorageConditionHeaders(
    condition: CloudStorageWriteCondition,
): NonNullable<RequestInit["headers"]> {
    switch (condition.kind) {
        case "any":
            return {};
        case "empty":
            return { "if-none-match": "*" };
        case "sha256":
            return { "if-match": `"${condition.sha256}"` };
    }
}

function cloudStorageResponseMetadata(response: Response): CloudStorageWriteResult {
    const etag = response.headers.get("etag");
    const sha256 = etag === null ? undefined : /^"([0-9a-f]{64})"$/.exec(etag)?.[1];
    const metadata = {
        sha256,
        version: response.headers.get("x-happy-cloud-version") ?? undefined,
    };
    if (!Value.Check(cloudStorageWriteResultSchema, metadata)) {
        throw new CloudServiceUnavailableError("response-invalid", response.status);
    }
    return metadata;
}

function assertCloudStorageResponseMetadata(
    response: Response,
    expected: CloudStorageWriteResult,
): void {
    const actual = cloudStorageResponseMetadata(response);
    if (actual.sha256 !== expected.sha256 || actual.version !== expected.version) {
        throw new CloudServiceUnavailableError("response-invalid", response.status);
    }
}

function assertCloudStorageResponseHasNoMetadata(response: Response): void {
    if (
        response.headers.get("etag") !== null ||
        response.headers.get("x-happy-cloud-version") !== null
    ) {
        throw new CloudServiceUnavailableError("response-invalid", response.status);
    }
}

async function parseCloudJsonResponse(
    response: Response,
    maximum: number,
    signal: AbortSignal,
): Promise<unknown> {
    try {
        const bytes = await readBounded(response, maximum, signal);
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error: unknown) {
        if (signal.aborted) throw new CloudServiceUnavailableError("request-timed-out");
        if (error instanceof CloudServiceUnavailableError) throw error;
        throw new CloudServiceUnavailableError("response-invalid", response.status);
    }
}

async function readCloudBytes(
    response: Response,
    maximum: number,
    signal: AbortSignal,
): Promise<Uint8Array> {
    try {
        return await readBounded(response, maximum, signal);
    } catch (error: unknown) {
        if (signal.aborted) throw new CloudServiceUnavailableError("request-timed-out");
        if (error instanceof CloudServiceUnavailableError) throw error;
        throw new CloudServiceUnavailableError("response-invalid", response.status);
    }
}

function profilesFor(
    entries: readonly Static<typeof cloudFriendEntrySchema>[],
    profiles: ReadonlyMap<string, CloudSocialProfile>,
): CloudSocialProfile[] {
    return [...new Set(entries.map((entry) => entry.username))]
        .map((username) => {
            const profile = profiles.get(username);
            if (profile === undefined) throw new CloudSocialSnapshotChangedError();
            return profile;
        })
        .sort((left, right) =>
            left.username < right.username ? -1 : left.username > right.username ? 1 : 0,
        );
}

function socialStatus(statuses: readonly number[]): number | undefined {
    return statuses.find((status) => status < 200 || status >= 300);
}

function socialMutationRequest(
    mutation: CloudSocialMutation,
    username: string,
): { readonly method: "DELETE" | "POST" | "PUT"; readonly path: string } {
    const encoded = encodeURIComponent(username);
    switch (mutation) {
        case "send-request":
            return { method: "PUT", path: `/v0/friends/requests/${encoded}` };
        case "approve-request":
            return { method: "POST", path: `/v0/friends/requests/${encoded}/approve` };
        case "reject-request":
            return { method: "POST", path: `/v0/friends/requests/${encoded}/reject` };
        case "revoke-request":
            return { method: "DELETE", path: `/v0/friends/requests/${encoded}` };
        case "block":
            return { method: "PUT", path: `/v0/friends/blocked/${encoded}` };
        case "unblock":
            return { method: "DELETE", path: `/v0/friends/blocked/${encoded}` };
    }
}

function cloudOrganization(value: unknown): CloudOrganization {
    if (!Value.Check(cloudOrganizationSchema, value)) {
        throw new CloudServiceUnavailableError();
    }
    return { id: value.id, name: value.name };
}

function cloudProfile(value: unknown): CloudProfile {
    if (!Value.Check(cloudProfileSchema, value)) throw new CloudServiceUnavailableError();
    if (value.username === null) return { firstName: null, username: null };
    return {
        firstName: value.firstName,
        ...(value.lastName === undefined ? {} : { lastName: value.lastName }),
        username: value.username,
    };
}

function authentication(value: unknown): CloudAuthentication {
    if (!Value.Check(workosAuthenticationSchema, value)) {
        throw new CloudServiceUnavailableError();
    }
    return {
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        user: {
            email: value.user.email,
            firstName: value.user.firstName,
            id: value.user.id,
            lastName: value.user.lastName,
        },
    };
}

function isTerminalCodeRejection(error: unknown): boolean {
    return (
        error instanceof OauthException &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429 &&
        (error.error === "access_denied" || error.error === "invalid_grant")
    );
}

function workOSUnavailable(error: unknown): CloudServiceUnavailableError {
    const preserved = cloudUnavailableCause(error);
    if (preserved !== undefined) return preserved;
    const status = workOSResponseStatus(error);
    if (status === 408) return new CloudServiceUnavailableError("request-timed-out");
    if (status !== undefined) {
        return new CloudServiceUnavailableError("response-rejected", status);
    }
    return new CloudServiceUnavailableError("request-failed");
}

function cloudUnavailableCause(error: unknown): CloudServiceUnavailableError | undefined {
    let current = error;
    for (let depth = 0; depth < 4; depth += 1) {
        if (current instanceof CloudServiceUnavailableError) return current;
        if (!(current instanceof Error)) return undefined;
        if (Value.Check(workOSParseErrorSchema, current)) {
            const parsed = current as Static<typeof workOSParseErrorSchema>;
            return new CloudServiceUnavailableError("response-invalid", parsed.rawStatus);
        }
        current = current.cause;
    }
    return undefined;
}

function workOSResponseStatus(error: unknown): number | undefined {
    const status =
        error instanceof AuthenticationException ||
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof GenericServerException ||
        error instanceof NotFoundException ||
        error instanceof OauthException ||
        error instanceof UnauthorizedException ||
        error instanceof UnprocessableEntityException
            ? error.status
            : undefined;
    return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : undefined;
}

/** Internal WorkOS transport exported only for direct boundary tests. */
export const boundedWorkOSFetch: typeof fetch = async (input, init) => {
    const deadline = AbortSignal.timeout(WORKOS_TIMEOUT_MS);
    const signal =
        init?.signal === null || init?.signal === undefined
            ? deadline
            : AbortSignal.any([deadline, init.signal]);
    try {
        const response = await fetch(input, { ...init, signal });
        const body =
            response.body === null
                ? null
                : await readBounded(response, MAX_WORKOS_RESPONSE_BYTES, signal);
        return new Response(body, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
        });
    } catch (error: unknown) {
        if (signal.aborted) {
            throw new CloudServiceUnavailableError("request-timed-out");
        }
        throw error;
    }
};

async function readBounded(
    response: Response,
    maximum: number,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximum) {
        await response.body?.cancel().catch(() => undefined);
        throw new CloudServiceUnavailableError();
    }
    if (response.body === null) throw new CloudServiceUnavailableError();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const cancelOnAbort = () => {
        void reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", cancelOnAbort, { once: true });
    try {
        while (true) {
            if (isAborted(signal)) throw new CloudServiceUnavailableError();
            const result = await reader.read();
            if (isAborted(signal)) throw new CloudServiceUnavailableError();
            if (result.done) break;
            total += result.value.byteLength;
            if (total > maximum) throw new CloudServiceUnavailableError();
            chunks.push(result.value);
        }
    } catch (error: unknown) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        signal?.removeEventListener("abort", cancelOnAbort);
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}
