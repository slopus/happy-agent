import {
    authenticationResponseSchema,
    healthResponseSchema,
    type HealthResponse,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

import { RemoteConnectionError } from "../RemoteConnectionError.js";

const REQUEST_DEADLINE_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Check that a server offers a sign-in the apps can use: discovery read without a credential,
 * following no redirects, must be a Happy response that lists an `oauth` method.
 */
export async function requireServerSignIn(url: string): Promise<void> {
    const response = await get(url, "v0/authentication");
    const body = response.status === 200 ? await readJson(response) : undefined;
    if (!Value.Check(authenticationResponseSchema, body)) {
        throw new Error(
            "This address is not a Happy server, or something in front of it, such as a sign-in page, answered instead.",
        );
    }
    if (!body.methods.some((method) => method.type === "oauth")) {
        throw new Error("This server does not offer a sign-in the Happy apps can use.");
    }
}

/** Whether the server still accepts a token, by asking its discovery with it. */
export async function serverAcceptsToken(url: string, token: string): Promise<boolean> {
    const response = await get(url, "v0/authentication", token);
    if (response.status !== 200) return false;
    const body: unknown = await readJson(response);
    return Value.Check(authenticationResponseSchema, body) && body.authenticated;
}

/** The server's health, read with a token when one is given; undefined unless it answers one. */
export async function readServerHealth(
    url: string,
    token?: string,
): Promise<HealthResponse | undefined> {
    try {
        const response = await get(url, "v0/health", token);
        if (response.status !== 200) return undefined;
        const body: unknown = await readJson(response);
        return Value.Check(healthResponseSchema, body) ? body : undefined;
    } catch {
        return undefined;
    }
}

/** The answer for a request that does not carry a token the server accepts. */
export function remoteSignInRequired(): RemoteConnectionError {
    return new RemoteConnectionError(
        403,
        "remote_sign_in_required",
        "Sign in to this server again.",
    );
}

async function get(url: string, path: string, token?: string): Promise<Response> {
    try {
        return await fetch(new URL(path, url), {
            headers: {
                accept: "application/json",
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
            redirect: "manual",
            signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
        });
    } catch (error: unknown) {
        throw error instanceof DOMException && error.name === "TimeoutError"
            ? new RemoteConnectionError(504, "remote_timeout", "The server did not answer in time.")
            : new RemoteConnectionError(
                  503,
                  "remote_unavailable",
                  "The server could not be reached.",
              );
    }
}

async function readJson(response: Response): Promise<unknown> {
    try {
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) return undefined;
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}
