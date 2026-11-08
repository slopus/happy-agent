import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import {
    authenticationResponseSchema,
    healthResponseSchema,
    type HealthResponse,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

import { RemoteConnectionError } from "../RemoteConnectionError.js";
import { isNameUnderLocalhost } from "./normalizeServerUrl.js";

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
        throw new RemoteConnectionError(
            400,
            "invalid_request",
            "This address is not a Happy server, or something in front of it, such as a sign-in page, answered instead.",
        );
    }
    if (!body.methods.some((method) => method.type === "oauth")) {
        throw new RemoteConnectionError(
            400,
            "invalid_request",
            "This server does not offer a sign-in the Happy apps can use.",
        );
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
    const target = new URL(path, url);
    const headers = {
        accept: "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    };
    const signal = AbortSignal.timeout(REQUEST_DEADLINE_MS);
    try {
        return isNameUnderLocalhost(target.hostname)
            ? await getOnLoopback(target, headers, signal)
            : await fetch(target, { headers, redirect: "manual", signal });
    } catch {
        throw signal.aborted
            ? new RemoteConnectionError(504, "remote_timeout", "The server did not answer in time.")
            : new RemoteConnectionError(
                  503,
                  "remote_unavailable",
                  "The server could not be reached.",
              );
    }
}

/**
 * A GET to a name under `localhost`, sent to 127.0.0.1 with the name still in its Host header,
 * because `fetch` would ask DNS for the name. Like the `fetch` above, it follows no redirects, and
 * it keeps at most one byte past what `readJson` reads.
 */
async function getOnLoopback(
    target: URL,
    headers: Record<string, string>,
    signal: AbortSignal,
): Promise<Response> {
    const secure = target.protocol === "https:";
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = (secure ? httpsRequest : httpRequest)(
            {
                host: "127.0.0.1",
                port: target.port === "" ? (secure ? 443 : 80) : Number(target.port),
                path: `${target.pathname}${target.search}`,
                method: "GET",
                headers: { ...headers, host: target.host },
                ...(secure ? { servername: target.hostname } : {}),
                signal,
            },
            resolve,
        );
        request.on("error", reject);
        request.end();
    });
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response) {
        const bytes = Buffer.from(chunk as Uint8Array);
        if (length + bytes.length > MAX_RESPONSE_BYTES) {
            chunks.push(bytes.subarray(0, MAX_RESPONSE_BYTES + 1 - length));
            response.destroy();
            break;
        }
        chunks.push(bytes);
        length += bytes.length;
    }
    const status = response.statusCode ?? 502;
    const empty = status === 204 || status === 205 || status === 304;
    return new Response(empty ? null : Buffer.concat(chunks), { status });
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
