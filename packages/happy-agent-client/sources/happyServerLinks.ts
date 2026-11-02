/**
 * Server links: the payload a desktop shows as a QR code so that a phone can add a team server,
 * `happy://<instanceId>/server?url=<encoded base URL>`. A server link names a server, not an
 * entity, so it is not a Happy link: `parseHappyUrl` rejects it, and only a phone's own scanner
 * calls `parseHappyServerLink`. It carries no token, code, or secret.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { MAX_HAPPY_URL_LENGTH } from "./happyLinks.js";
import { instanceIdSchema } from "./protocol/common.js";

/** A server's identity and its normalized `https:` base URL, as a server link carries them. */
export const happyServerLinkSchema = Type.Object(
    {
        instanceId: instanceIdSchema,
        url: Type.String({ minLength: 1, maxLength: MAX_HAPPY_URL_LENGTH }),
    },
    { additionalProperties: false },
);
export type HappyServerLink = Static<typeof happyServerLinkSchema>;

const SERVER_LINK = new RegExp(
    String.raw`^happy://([a-z][a-z0-9]{23})/server\?url=((?:[A-Za-z0-9\-._~!*'()]|%[0-9A-Fa-f]{2})+)$`,
    "u",
);

/**
 * Parses a server link, returning undefined for anything that is not exactly one: another query
 * parameter, a fragment, an invalid escape, or a URL that is not a normalized `https:` base URL.
 */
export function parseHappyServerLink(link: string): HappyServerLink | undefined {
    if (link.length > MAX_HAPPY_URL_LENGTH) return undefined;
    const match = SERVER_LINK.exec(link);
    if (match === null) return undefined;
    const [, instanceId = "", encoded = ""] = match;
    let url: string;
    try {
        url = decodeURIComponent(encoded);
    } catch {
        return undefined;
    }
    return isNormalizedServerUrl(url) ? { instanceId, url } : undefined;
}

/**
 * The server link for a server. Throws a `TypeError` when the instance ID is invalid or the URL
 * is not a normalized `https:` base URL, such as a roster entry's loopback `http:` URL.
 */
export function formatHappyServerLink(server: HappyServerLink): string {
    if (!Value.Check(happyServerLinkSchema, server) || !isNormalizedServerUrl(server.url)) {
        throw new TypeError("A server link needs an instance ID and a normalized https URL.");
    }
    const link = `happy://${server.instanceId}/server?url=${encodeURIComponent(server.url)}`;
    if (link.length > MAX_HAPPY_URL_LENGTH) throw new TypeError("The server link is too long.");
    return link;
}

/** `https:`, no user information, query, or fragment, already in the form `URL` writes, ending in `/`. */
function isNormalizedServerUrl(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return (
        url.href === value &&
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        !value.includes("?") &&
        !value.includes("#") &&
        url.pathname.endsWith("/")
    );
}
