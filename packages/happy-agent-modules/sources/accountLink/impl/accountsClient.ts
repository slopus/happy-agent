import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const CLIENT_ID = "happy-agent";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 65_536;

const deviceAuthorizationSchema = Type.Object({
    device_code: Type.String({ maxLength: 4_096, minLength: 1 }),
    expires_in: Type.Integer({ maximum: 3_600, minimum: 1 }),
    interval: Type.Optional(Type.Integer({ maximum: 60, minimum: 1 })),
    user_code: Type.String({ maxLength: 64, minLength: 1 }),
    verification_uri: Type.String({ maxLength: 2_048, minLength: 1 }),
    verification_uri_complete: Type.Optional(Type.String({ maxLength: 4_096, minLength: 1 })),
});

const endpointTokensSchema = Type.Object({
    access_token: Type.String({ maxLength: 16_384, minLength: 1 }),
    endpoint_id: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
    refresh_token: Type.String({ maxLength: 16_384, minLength: 1 }),
});

const tokenErrorSchema = Type.Object({ error: Type.String({ maxLength: 256, minLength: 1 }) });

export type DeviceAuthorization = Static<typeof deviceAuthorizationSchema>;
export type EndpointTokens = Static<typeof endpointTokensSchema>;

/** Accounts answered, and refused: `code` is its OAuth error code or `http_<status>`. */
export class AccountsRefusal extends Error {
    readonly code: string;
    readonly status: number;

    constructor(status: number, code: string) {
        super(`Happy accounts refused the request (${code}).`);
        this.name = "AccountsRefusal";
        this.code = code;
        this.status = status;
    }
}

/** RFC 8628 device authorization for this computer. */
export async function requestDeviceAuthorization(
    accountsUrl: string,
    device: { readonly name: string; readonly platform: string },
): Promise<DeviceAuthorization> {
    return await postForm(accountsUrl, "/device/authorize", deviceAuthorizationSchema, {
        client_id: CLIENT_ID,
        name: device.name,
        platform: device.platform,
    });
}

/** One poll of the device grant. Pending and slow-down arrive as an {@link AccountsRefusal}. */
export async function redeemDeviceCode(
    accountsUrl: string,
    deviceCode: string,
): Promise<EndpointTokens> {
    return await postForm(accountsUrl, "/token", endpointTokensSchema, {
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
    });
}

/**
 * Rotate the refresh token. Never call this twice with the same token: accounts revokes the
 * whole family when a retired token is presented.
 */
export async function refreshEndpointTokens(
    accountsUrl: string,
    refreshToken: string,
): Promise<EndpointTokens> {
    return await postForm(accountsUrl, "/token", endpointTokensSchema, {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
    });
}

export async function patchEndpointReachable(
    accountsUrl: string,
    endpointId: string,
    endpointToken: string,
    reachable: boolean,
): Promise<void> {
    await endpointRequest(accountsUrl, "PATCH", endpointId, "", endpointToken, { reachable });
}

export async function markEndpointSeen(
    accountsUrl: string,
    endpointId: string,
    endpointToken: string,
): Promise<void> {
    await endpointRequest(accountsUrl, "POST", endpointId, "/seen", endpointToken, undefined);
}

/**
 * RFC 7009 revocation of this machine's refresh token, which retires its whole family. Accounts
 * answers 200 whatever the token was, so only a transport failure rejects.
 */
export async function revokeRefreshToken(accountsUrl: string, refreshToken: string): Promise<void> {
    const response = await fetch(`${accountsUrl}/revoke`, {
        body: new URLSearchParams({ client_id: CLIENT_ID, token: refreshToken }),
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new AccountsRefusal(response.status, `http_${String(response.status)}`);
}

async function endpointRequest(
    accountsUrl: string,
    method: string,
    endpointId: string,
    suffix: string,
    endpointToken: string,
    body: unknown,
): Promise<void> {
    const response = await fetch(
        `${accountsUrl}/v1/endpoints/${encodeURIComponent(endpointId)}${suffix}`,
        {
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            headers: {
                authorization: `Bearer ${endpointToken}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            method,
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
    );
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new AccountsRefusal(response.status, `http_${String(response.status)}`);
}

async function postForm<Schema extends TSchema>(
    accountsUrl: string,
    path: string,
    schema: Schema,
    form: Record<string, string>,
): Promise<Static<Schema>> {
    const response = await fetch(`${accountsUrl}${path}`, {
        body: new URLSearchParams(form),
        headers: { accept: "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await readBoundedJson(response);
    if (!response.ok) {
        throw new AccountsRefusal(
            response.status,
            Value.Check(tokenErrorSchema, body) ? body.error : `http_${String(response.status)}`,
        );
    }
    if (!Value.Check(schema, body)) {
        throw new Error("Happy accounts returned an unexpected response.");
    }
    return body;
}

async function readBoundedJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (reader === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error("Happy accounts returned an oversized response.");
        }
        chunks.push(value);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        return undefined;
    }
}
