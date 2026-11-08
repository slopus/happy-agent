const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether `hostname` is a name under `localhost`, such as `acme.localhost`. RFC 6761 reserves
 * them all for loopback, but resolvers such as glibc's ask DNS for them, so the daemon never looks
 * them up: it reaches them at 127.0.0.1 itself, which is what makes plain `http` safe for them.
 */
export function isNameUnderLocalhost(hostname: string): boolean {
    return hostname.endsWith(".localhost") && hostname.length > ".localhost".length;
}

/** Where a server's host is reached: 127.0.0.1 for a name under `localhost`, else the host. */
export function serverConnectHost(hostname: string): string {
    return isNameUnderLocalhost(hostname) ? "127.0.0.1" : hostname.replace(/^\[|\]$/gu, "");
}

/**
 * The normalized form of a server URL, or undefined when it cannot name a server: `https`, or
 * `http` on a loopback host or a name under `localhost`; no user information, query, or fragment;
 * a lowercase scheme and host; no default port; and a path that always ends in `/`.
 */
export function normalizeServerUrl(value: string): string | undefined {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    const secure =
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
            (LOOPBACK_HOSTS.has(url.hostname) || isNameUnderLocalhost(url.hostname)));
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
