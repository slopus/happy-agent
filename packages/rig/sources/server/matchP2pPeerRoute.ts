import { Value } from "@sinclair/typebox/value";

import { p2pInstanceIdSchema } from "../protocol/P2pIdentityProtocol.js";

export function matchP2pPeerRoute(
    value: URL | string | undefined,
): { path: string; peerId: string } | undefined {
    let url: URL;
    try {
        url = value instanceof URL ? value : new URL(value ?? "/", "http://rig.local");
    } catch {
        return undefined;
    }
    const prefix = "/p2p/peers/";
    if (!url.pathname.startsWith(prefix)) return undefined;
    const remainder = url.pathname.slice(prefix.length);
    const separator = remainder.indexOf("/");
    if (separator <= 0) return undefined;
    let peerId: string;
    try {
        peerId = decodeURIComponent(remainder.slice(0, separator));
    } catch {
        return undefined;
    }
    if (!Value.Check(p2pInstanceIdSchema, peerId)) return undefined;
    const apiPath = remainder.slice(separator + 1);
    if (apiPath !== "api" && !apiPath.startsWith("api/")) return undefined;
    const path = apiPath === "api" ? "/" : `/${apiPath.slice("api/".length)}`;
    return { path: `${path}${url.search}`, peerId };
}
