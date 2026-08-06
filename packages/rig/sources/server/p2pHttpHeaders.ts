import type { IncomingHttpHeaders } from "node:http";

const REQUEST_HEADERS = new Set([
    "accept",
    "content-type",
    "if-match",
    "last-event-id",
    "x-rig-mutation-id",
]);
const RESPONSE_HEADERS = new Set([
    "allow",
    "cache-control",
    "content-disposition",
    "content-length",
    "content-type",
    "etag",
    "location",
    "x-content-type-options",
]);

export function selectP2pRequestHeaders(
    headers: IncomingHttpHeaders,
): Readonly<Record<string, string>> {
    return selectHeaders(headers, REQUEST_HEADERS);
}

export function selectP2pResponseHeaders(
    headers: IncomingHttpHeaders,
): Readonly<Record<string, string>> {
    return selectHeaders(headers, RESPONSE_HEADERS);
}

function selectHeaders(
    headers: IncomingHttpHeaders,
    allowed: ReadonlySet<string>,
): Readonly<Record<string, string>> {
    const selected: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (!allowed.has(name) || value === undefined) continue;
        selected[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    return selected;
}
