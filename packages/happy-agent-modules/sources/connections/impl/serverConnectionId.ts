/** A connection ID for a server's host, such as `happy-example-com`, unique among `taken`. */
export function serverConnectionId(url: string, taken: ReadonlySet<string>): string {
    const host = new URL(url).hostname.replace(/^\[|\]$/gu, "");
    let base = host
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
    if (!/^[a-z]/u.test(base)) base = `server-${base}`.replace(/-+$/u, "");
    base = base.slice(0, 56).replace(/-+$/u, "");
    if (!taken.has(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const id = `${base}-${String(suffix)}`;
        if (!taken.has(id)) return id;
    }
}
