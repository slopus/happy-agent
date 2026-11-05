import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/** The most a metadata, registration, or token response may hold. */
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const MAX_OAUTH_REDIRECTS = 3;
/** The only request headers an OAuth request carries; nothing from the server's configuration. */
const FORWARDED_HEADERS = ["accept", "content-type", "mcp-protocol-version"] as const;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** A login step this module refused on its own, whose message is safe to show the person. */
export class McpOAuthRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = "McpOAuthRefusal";
    }
}

/**
 * The fetch every discovery, registration, and token request goes through for one MCP server.
 * It sends none of the server's configured headers or bearer token, only reaches https endpoints
 * (or the server's own host, when the server is an http loopback address), refuses private,
 * loopback, link-local, and metadata addresses on any other host, and bounds every response's
 * size, time, and redirects.
 */
export function mcpOAuthFetch(serverUrl: URL): FetchLike {
    return async (input, init) => {
        let url = new URL(input instanceof Request ? input.url : String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const headers = forwardedHeaders(init?.headers);
        const signal = AbortSignal.any([
            AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
            ...(init?.signal ? [init.signal] : []),
        ]);
        for (let hop = 0; hop <= MAX_OAUTH_REDIRECTS; hop += 1) {
            await assertMcpOAuthEndpoint(url, serverUrl);
            const response = await fetch(url, {
                method,
                headers,
                ...(init?.body === undefined || init.body === null ? {} : { body: init.body }),
                redirect: "manual",
                signal,
            });
            const location = response.headers.get("location");
            if (response.status >= 300 && response.status < 400 && location !== null) {
                await response.body?.cancel();
                // A redirected POST would resend credentials somewhere the endpoint did not name.
                if (method !== "GET")
                    throw new McpOAuthRefusal("The authorization server redirected a request.");
                url = new URL(location, url);
                continue;
            }
            const body = await boundedBody(response);
            return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        }
        throw new McpOAuthRefusal("The authorization server redirected too many times.");
    };
}

/**
 * Whether a URL is one the login may use for this server. The authorization link a person opens is
 * held to the same scheme rule; only requests the daemon itself sends also check the address.
 */
export async function assertMcpOAuthEndpoint(target: URL, serverUrl: URL): Promise<void> {
    assertMcpOAuthScheme(target, serverUrl);
    if (sameHost(target, serverUrl)) return;
    const host = bareHost(target.hostname);
    const addresses =
        isIP(host) === 0
            ? (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
            : [host];
    if (host === "localhost" || host.endsWith(".localhost") || addresses.some(isPrivateAddress)) {
        throw new McpOAuthRefusal(
            `The authorization server ${target.host} is on a private network address.`,
        );
    }
}

/** https, except an http loopback MCP server's own host, which may serve its own login. */
export function assertMcpOAuthScheme(target: URL, serverUrl: URL): void {
    if (target.username !== "" || target.password !== "") {
        throw new McpOAuthRefusal("An authorization server address may not carry credentials.");
    }
    if (target.protocol === "https:") return;
    if (
        target.protocol === "http:" &&
        serverUrl.protocol === "http:" &&
        isLoopbackHost(serverUrl.hostname) &&
        sameHost(target, serverUrl)
    ) {
        return;
    }
    throw new McpOAuthRefusal(`The authorization server address ${target.origin} is not https.`);
}

export function isLoopbackHost(hostname: string): boolean {
    const host = bareHost(hostname);
    if (host === "localhost") return true;
    if (isIP(host) === 4) return host.startsWith("127.");
    return host === "::1";
}

function sameHost(left: URL, right: URL): boolean {
    return bareHost(left.hostname) === bareHost(right.hostname);
}

function bareHost(hostname: string): string {
    return hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
}

/** Loopback, private, link-local, shared, metadata, multicast, and unspecified addresses. */
function isPrivateAddress(address: string): boolean {
    if (isIP(address) === 4) return isPrivateIpv4(address);
    const host = address.toLowerCase();
    // An IPv4-mapped address, which URL parsing writes in hex: ::ffff:a00:1 is 10.0.0.1.
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(host)?.[1];
    if (dotted !== undefined) return isPrivateIpv4(dotted);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
    if (hex !== null) {
        const high = Number.parseInt(hex[1] ?? "0", 16);
        const low = Number.parseInt(hex[2] ?? "0", 16);
        return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
    if (host === "::" || host === "::1") return true;
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    return (
        (first & 0xfe00) === 0xfc00 || // fc00::/7, unique local, including fd00:ec2::254
        (first & 0xffc0) === 0xfe80 || // fe80::/10, link-local
        (first & 0xff00) === 0xff00 // ff00::/8, multicast
    );
}

function isPrivateIpv4(address: string): boolean {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b < 128) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b < 32) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224
    );
}

function forwardedHeaders(headers: RequestInit["headers"]): Headers {
    const given = new Headers(headers);
    const forwarded = new Headers();
    for (const name of FORWARDED_HEADERS) {
        const value = given.get(name);
        if (value !== null) forwarded.set(name, value);
    }
    // Client authentication for a registered confidential client, which the SDK adds itself.
    const authorization = given.get("authorization");
    if (authorization?.startsWith("Basic ") === true) forwarded.set("authorization", authorization);
    return forwarded;
}

async function boundedBody(response: Response): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (reader === undefined) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_OAUTH_RESPONSE_BYTES) {
            await reader.cancel();
            throw new McpOAuthRefusal("The authorization server's response was too large.");
        }
        chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}
