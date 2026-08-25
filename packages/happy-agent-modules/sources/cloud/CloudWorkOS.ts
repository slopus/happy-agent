import { cloudEnvironmentSchema, type CloudEnvironment } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { OauthException, WorkOS, type PublicWorkOS, type WorkOSOptions } from "@workos-inc/node";

const WORKOS_TIMEOUT_MS = 15_000;
const MAX_WORKOS_RESPONSE_BYTES = 1024 * 1_024;
const CLOUD_HELLO_TIMEOUT_MS = 15_000;
const MAX_HELLO_RESPONSE_BYTES = 8 * 1_024;

const deployments: Readonly<
    Record<CloudEnvironment, { readonly cloudUrl: string; readonly workosClientId: string }>
> = {
    production: {
        cloudUrl: "https://happy-cloud.bulka-llc.workers.dev",
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

export class CloudServiceUnavailableError extends Error {
    constructor() {
        super("Cloud authentication is temporarily unavailable.");
        this.name = "CloudServiceUnavailableError";
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
            throw new CloudServiceUnavailableError();
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
            throw new CloudServiceUnavailableError();
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
            throw new CloudServiceUnavailableError();
        }
    }

    /** Verifies the minted token against Happy Cloud without treating its 401 as revocation. */
    async verify(accessToken: string, expectedUserId: string): Promise<void> {
        const signal = AbortSignal.timeout(CLOUD_HELLO_TIMEOUT_MS);
        try {
            const response = await fetch(`${this.#cloudUrl}/v0/hello`, {
                headers: { authorization: `Bearer ${accessToken}` },
                method: "GET",
                signal,
            });
            if (!response.ok) throw new CloudServiceUnavailableError();
            const bytes = await readBounded(response, MAX_HELLO_RESPONSE_BYTES);
            const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
            if (!Value.Check(helloSchema, parsed)) throw new CloudServiceUnavailableError();
            if (parsed.userId !== expectedUserId) throw new CloudIdentityMismatchError();
        } catch (error: unknown) {
            if (error instanceof CloudIdentityMismatchError) throw error;
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw new CloudServiceUnavailableError();
        }
    }
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

/** Internal WorkOS transport exported only for direct boundary tests. */
export const boundedWorkOSFetch: typeof fetch = async (input, init) => {
    const deadline = AbortSignal.timeout(WORKOS_TIMEOUT_MS);
    const signal =
        init?.signal === null || init?.signal === undefined
            ? deadline
            : AbortSignal.any([deadline, init.signal]);
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
