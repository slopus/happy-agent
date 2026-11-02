const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The normalized form of a server URL, or undefined when it cannot name a server: `https`, or
 * `http` on a loopback host; no user information, query, or fragment; a lowercase scheme and host;
 * no default port; and a path that always ends in `/`.
 */
export function normalizeServerUrl(value: string): string | undefined {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    const secure =
        url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
    if (
        !secure ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        value.includes("?") ||
        url.hash !== "" ||
        value.includes("#")
    ) {
        return undefined;
    }
    // URL already lowercases the scheme and host and drops a default port.
    const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    return `${url.protocol}//${url.host}${path}`;
}
