import { Type, type Static } from "@sinclair/typebox";
import { PassThrough, type Duplex } from "node:stream";

import { P2P_MAXIMUM_CHUNK_BYTES } from "./P2pFrameDuplex.js";

/**
 * The tunnel is the transport-neutral half of P2P forwarding.
 *
 * `P2pHttp` carries one request and one response. A tunnel instead carries raw
 * bidirectional bytes — a WebSocket after a `GET` upgrade, or the remote
 * daemon's proxy connection after `CONNECT` — over the same `P2pFrameDuplex`
 * that Iroh, the direct TLS transport, and the SSH transport all provide.
 *
 * The head names a route on the remote daemon and nothing beyond it. A browser
 * asking that daemon to reach a host does so inside the established connection,
 * where its `CONNECT host:port` is simply payload this layer never inspects.
 */

const exact = { additionalProperties: false } as const;

/** Largest tunnel payload carried in one frame. */
export const P2P_TUNNEL_MAXIMUM_FRAME_BYTES = P2P_MAXIMUM_CHUNK_BYTES;
/** Largest encoded request or response head. */
export const P2P_TUNNEL_MAXIMUM_HEAD_BYTES = P2P_MAXIMUM_CHUNK_BYTES;
/** Largest header name, value, and count a tunnel head may carry. */
export const P2P_TUNNEL_MAXIMUM_HEADER_COUNT = 32;
export const P2P_TUNNEL_MAXIMUM_HEADER_NAME_BYTES = 64;
export const P2P_TUNNEL_MAXIMUM_HEADER_VALUE_BYTES = 8 * 1024;
/** Largest daemon route a tunnel head may name. */
export const P2P_TUNNEL_MAXIMUM_PATH_BYTES = 16 * 1024;

const HEADER_NAME_PATTERN = /^[a-z0-9-]+$/u;

const tunnelHeadersSchema = Type.Record(
    Type.String({
        maxLength: P2P_TUNNEL_MAXIMUM_HEADER_NAME_BYTES,
        minLength: 1,
        pattern: "^[a-z0-9-]+$",
    }),
    Type.String({
        maxLength: P2P_TUNNEL_MAXIMUM_HEADER_VALUE_BYTES,
        pattern: "^[^\\u0000-\\u001F\\u007F]*$",
    }),
    // Without this a key that fails the pattern is merely an unchecked extra
    // property, which would let a peer name a header anything it liked.
    { additionalProperties: false, maxProperties: P2P_TUNNEL_MAXIMUM_HEADER_COUNT },
);

/**
 * Headers a tunnel is allowed to forward.
 *
 * Authorization never travels: the receiving Rig injects its own daemon token
 * once the request reaches its local server. Hop-by-hop headers other than the
 * upgrade handshake never travel either, because the tunnel is the hop.
 */
const FORWARDED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
    "accept",
    "connection",
    "origin",
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
    "upgrade",
    "user-agent",
]);
const FORWARDED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
    "connection",
    "sec-websocket-accept",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    "upgrade",
]);

export const p2pTunnelRequestHeadSchema = Type.Object(
    {
        headers: tunnelHeadersSchema,
        method: Type.Union([Type.Literal("CONNECT"), Type.Literal("GET")]),
        /**
         * A route on the remote daemon, always absolute.
         *
         * `CONNECT` names the daemon's proxy route — `/projects/:id/proxy`, or
         * the workspace form of it — never the eventual target host. The target
         * authority is nested: it travels later as raw bytes inside the proxy
         * connection this tunnel establishes. `GET` names an upgrade route such
         * as a terminal attach path. The serving boundary validates the exact
         * grammar of each route; the schema only bounds and sanitizes it.
         */
        path: Type.String({
            maxLength: P2P_TUNNEL_MAXIMUM_PATH_BYTES,
            minLength: 1,
            pattern: "^/[^\\u0000-\\u001F\\u007F]*$",
        }),
    },
    exact,
);
export type P2pTunnelRequestHead = Static<typeof p2pTunnelRequestHeadSchema>;

export const p2pTunnelResponseHeadSchema = Type.Object(
    {
        headers: tunnelHeadersSchema,
        status: Type.Integer({ maximum: 599, minimum: 100 }),
    },
    exact,
);
export type P2pTunnelResponseHead = Static<typeof p2pTunnelResponseHeadSchema>;

export interface P2pTunnelConnection {
    response: P2pTunnelResponseHead;
    stream: Duplex;
}

export type ServeP2pTunnel = (
    peerId: string,
    request: P2pTunnelRequestHead,
    signal: AbortSignal,
) => Promise<P2pTunnelConnection>;

export function createClosedP2pTunnelStream(): Duplex {
    const stream = new PassThrough();
    stream.end();
    return stream;
}

export type P2pTunnelHeaders = Readonly<Record<string, string>>;

/** A source of headers shaped like Node's `IncomingHttpHeaders`. */
export type P2pTunnelHeaderSource = Readonly<
    Record<string, ReadonlyArray<string> | string | undefined>
>;

export function selectP2pTunnelRequestHeaders(headers: P2pTunnelHeaderSource): P2pTunnelHeaders {
    return selectHeaders(headers, FORWARDED_REQUEST_HEADERS);
}

export function selectP2pTunnelResponseHeaders(headers: P2pTunnelHeaderSource): P2pTunnelHeaders {
    return selectHeaders(headers, FORWARDED_RESPONSE_HEADERS);
}

function selectHeaders(
    headers: P2pTunnelHeaderSource,
    allowed: ReadonlySet<string>,
): P2pTunnelHeaders {
    const selected: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(headers)) {
        if (Object.keys(selected).length >= P2P_TUNNEL_MAXIMUM_HEADER_COUNT) break;
        if (rawValue === undefined) continue;
        const name = rawName.toLowerCase();
        if (!allowed.has(name) || !HEADER_NAME_PATTERN.test(name)) continue;
        const value = typeof rawValue === "string" ? rawValue : rawValue.join(", ");
        if (hasControlCharacters(value)) continue;
        if (value.length > P2P_TUNNEL_MAXIMUM_HEADER_VALUE_BYTES) continue;
        selected[name] = value;
    }
    return selected;
}

function hasControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}
