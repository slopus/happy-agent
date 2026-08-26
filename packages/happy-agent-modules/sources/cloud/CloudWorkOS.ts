import {
    cloudEnvironmentSchema,
    cloudProfileSchema,
    cloudUsernameSchema,
    type CloudEnvironment,
    type CloudProfile,
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

const WORKOS_TIMEOUT_MS = 15_000;
const MAX_WORKOS_RESPONSE_BYTES = 1024 * 1_024;
const CLOUD_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CLOUD_RESPONSE_BYTES = 8 * 1_024;

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
    { additionalProperties: false },
);

const invalidProfileSchema = Type.Object(
    { error: Type.Literal("invalid_profile") },
    { additionalProperties: false },
);

const usernameUnavailableSchema = Type.Object(
    { error: Type.Literal("username_unavailable") },
    { additionalProperties: false },
);

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

    async getProfile(accessToken: string): Promise<CloudProfile> {
        const result = await this.#request("/v0/profile", accessToken, "GET");
        if (result.status < 200 || result.status >= 300) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        return cloudProfile(result.body);
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

    async #request(
        path: string,
        accessToken: string,
        method: "GET" | "PUT",
        body?: Readonly<Record<string, string>>,
        parsedErrorStatuses: readonly number[] = [],
    ): Promise<{ readonly body: unknown; readonly status: number }> {
        const signal = AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS);
        let response: Response;
        try {
            response = await fetch(`${this.#cloudUrl}${path}`, {
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                method,
                signal,
            });
        } catch {
            throw new CloudServiceUnavailableError(
                signal.aborted ? "request-timed-out" : "request-failed",
            );
        }
        if (!response.ok && !parsedErrorStatuses.includes(response.status)) {
            await response.body?.cancel().catch(() => undefined);
            return { body: undefined, status: response.status };
        }
        try {
            const bytes = await readBounded(response, MAX_CLOUD_RESPONSE_BYTES, signal);
            return {
                body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
                status: response.status,
            };
        } catch (error: unknown) {
            if (signal.aborted) throw new CloudServiceUnavailableError("request-timed-out");
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw new CloudServiceUnavailableError("response-invalid", response.status);
        }
    }
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
