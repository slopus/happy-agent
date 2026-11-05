import { lookup as lookupHost } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/** The most a metadata, registration, or token response may hold. */
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const DNS_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_OAUTH_REDIRECTS = 3;
/** The only request headers an OAuth request carries; nothing from the server's configuration. */
const FORWARDED_HEADERS = ["accept", "content-type", "mcp-protocol-version"] as const;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** An address a host was checked to have, which is the only one a request to it may connect to. */
export interface McpOAuthAddress {
    readonly address: string;
    readonly family: number;
}

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
 *
 * Each hop resolves its host once, checks every address, and connects only to those addresses,
 * so a DNS answer that changes between the check and the connection cannot reach a private
 * address. The hostname still names the server for SNI and certificate verification. This uses
 * node:http rather than fetch, because fetch resolves the host again on its own, and Bun, which
 * Happy Agent ships on, ignores an undici dispatcher.
 */
export function mcpOAuthFetch(serverUrl: URL): FetchLike {
    return async (input, init) => {
        let url = new URL(input instanceof Request ? input.url : String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const { headers, body } = await outgoing(init);
        const signal = AbortSignal.any([
            AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
            ...(init?.signal ? [init.signal] : []),
        ]);
        for (let hop = 0; hop <= MAX_OAUTH_REDIRECTS; hop += 1) {
            const addresses = await resolveMcpOAuthEndpoint(url, serverUrl);
            const reply = await send(url, { method, headers, body, signal, addresses });
            const location = reply.headers.get("location");
            if (reply.status >= 300 && reply.status < 400 && location !== null) {
                // A redirected POST would resend credentials somewhere the endpoint did not name.
                if (method !== "GET")
                    throw new McpOAuthRefusal("The authorization server redirected a request.");
                url = new URL(location, url);
                continue;
            }
            return new Response(NULL_BODY_STATUSES.has(reply.status) ? null : reply.body, {
                status: reply.status,
                statusText: reply.statusText,
                headers: reply.headers,
            });
        }
        throw new McpOAuthRefusal("The authorization server redirected too many times.");
    };
}

/**
 * The addresses a URL the login may use resolves to, after checking them for this server. The
 * authorization link a person opens is held to the same scheme rule; only requests the daemon
 * itself sends also check the address.
 */
export async function resolveMcpOAuthEndpoint(
    target: URL,
    serverUrl: URL,
): Promise<readonly McpOAuthAddress[]> {
    assertMcpOAuthScheme(target, serverUrl);
    const host = bareHost(target.hostname);
    const own = sameHost(target, serverUrl);
    const refused = () =>
        new McpOAuthRefusal(
            `The authorization server ${target.host} is on a private network address.`,
        );
    if (!own && (host === "localhost" || host.endsWith(".localhost"))) throw refused();
    const family = isIP(host);
    const addresses = family === 0 ? await lookupInTime(host) : [{ address: host, family }];
    if (addresses.length === 0) {
        throw new McpOAuthRefusal(`The authorization server ${target.host} has no address.`);
    }
    if (!own && addresses.some((entry) => isPrivateAddress(entry.address))) throw refused();
    return addresses;
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
    // The response is read as it arrives, so it must not be compressed.
    forwarded.set("accept-encoding", "identity");
    return forwarded;
}

/** The forwarded headers and the encoded body of a request, with its length and content type. */
async function outgoing(
    init: RequestInit | undefined,
): Promise<{ readonly headers: Headers; readonly body: Uint8Array | undefined }> {
    const headers = forwardedHeaders(init?.headers);
    if (init?.body === undefined || init.body === null) return { headers, body: undefined };
    const encoded = new Request("http://127.0.0.1/", { method: "POST", body: init.body });
    const contentType = encoded.headers.get("content-type");
    if (contentType !== null && !headers.has("content-type")) {
        headers.set("content-type", contentType);
    }
    const body = new Uint8Array(await encoded.arrayBuffer());
    headers.set("content-length", String(body.byteLength));
    return { headers, body };
}

async function lookupInTime(host: string): Promise<readonly McpOAuthAddress[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new McpOAuthRefusal(`The address of ${host} could not be looked up in time.`));
        }, DNS_LOOKUP_TIMEOUT_MS);
    });
    try {
        const found = await Promise.race([lookupHost(host, { all: true, verbatim: true }), late]);
        return found.map((entry) => ({ address: entry.address, family: entry.family }));
    } finally {
        clearTimeout(timer);
    }
}

/** A DNS lookup that answers only with the addresses already checked for this host. */
function pinnedLookup(addresses: readonly McpOAuthAddress[]): LookupFunction {
    return (_hostname, options, callback) => {
        const family = options.family === 4 || options.family === 6 ? options.family : 0;
        const usable = addresses.filter((entry) => family === 0 || entry.family === family);
        const [first] = usable;
        if (first === undefined) {
            const error: NodeJS.ErrnoException = new Error("The host has no checked address.");
            error.code = "ENOTFOUND";
            callback(error, "", 0);
            return;
        }
        if (options.all === true)
            callback(
                null,
                usable.map((entry) => ({ ...entry })),
            );
        else callback(null, first.address, first.family);
    };
}

interface McpOAuthReply {
    readonly status: number;
    readonly statusText: string;
    readonly headers: Headers;
    readonly body: Uint8Array<ArrayBuffer>;
}

/** One request on a fresh connection to the checked addresses, with its whole bounded response. */
async function send(
    url: URL,
    request: {
        readonly method: string;
        readonly headers: Headers;
        readonly body: Uint8Array | undefined;
        readonly signal: AbortSignal;
        readonly addresses: readonly McpOAuthAddress[];
    },
): Promise<McpOAuthReply> {
    const { signal } = request;
    signal.throwIfAborted();
    const open = url.protocol === "https:" ? httpsRequest : httpRequest;
    return await new Promise<McpOAuthReply>((resolve, reject) => {
        const outgoingRequest = open(
            url,
            {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                lookup: pinnedLookup(request.addresses),
                // A pooled socket may have been connected by someone else, to another address.
                agent: false,
            },
            (incoming) => {
                readBounded(incoming).then(
                    (body) =>
                        resolve({
                            status: incoming.statusCode ?? 0,
                            statusText: incoming.statusMessage ?? "",
                            headers: incomingHeaders(incoming),
                            body,
                        }),
                    reject,
                );
            },
        );
        const stop = (): void => {
            outgoingRequest.destroy(
                signal.reason instanceof Error ? signal.reason : new Error("The request stopped."),
            );
        };
        signal.addEventListener("abort", stop, { once: true });
        outgoingRequest.on("close", () => signal.removeEventListener("abort", stop));
        outgoingRequest.on("error", reject);
        outgoingRequest.end(request.body);
    });
}

async function readBounded(incoming: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
    return await new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        incoming.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MAX_OAUTH_RESPONSE_BYTES) {
                fail(new McpOAuthRefusal("The authorization server's response was too large."));
                incoming.destroy();
                return;
            }
            chunks.push(chunk);
        });
        incoming.on("end", () => {
            if (settled) return;
            settled = true;
            resolve(new Uint8Array(Buffer.concat(chunks)));
        });
        incoming.on("error", fail);
        incoming.on("close", () => {
            fail(new Error("The authorization server closed the connection."));
        });
    });
}

function incomingHeaders(incoming: IncomingMessage): Headers {
    const headers = new Headers();
    const raw = incoming.rawHeaders;
    for (let index = 0; index + 1 < raw.length; index += 2) {
        try {
            headers.append(raw[index] ?? "", raw[index + 1] ?? "");
        } catch {
            // A header fetch cannot represent is not one the login reads.
        }
    }
    return headers;
}
