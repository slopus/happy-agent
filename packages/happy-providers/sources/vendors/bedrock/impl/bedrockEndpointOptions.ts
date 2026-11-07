/**
 * The Anthropic and OpenAI SDKs append each request path to `baseURL` as text, so a query on a
 * Bedrock endpoint would swallow the path: `https://gw/bedrock?route=a` plus `/responses` becomes
 * the query value `a/responses`. The query travels as the SDK's default parameters instead, which
 * it merges with each request's own, and the base path stays intact.
 *
 * Default parameters hold one value per name, so a name repeated on the endpoint keeps only its
 * last value. They replace a parameter of the same name written into a request path, such as the
 * `beta=true` on Anthropic Mantle's `/v1/messages?beta=true`.
 */
export function bedrockEndpointOptions(endpoint: string): {
    baseURL: string;
    defaultQuery?: Record<string, string>;
} {
    const url = new URL(endpoint);
    if (url.search === "") return { baseURL: endpoint };
    const defaultQuery = Object.fromEntries(url.searchParams);
    url.search = "";
    url.hash = "";
    return { baseURL: url.toString(), defaultQuery };
}

/** The query a SigV4 signature covers, keeping every value of a repeated name. */
export function bedrockSigningQuery(url: URL): Record<string, string | string[]> {
    const query: Record<string, string | string[]> = {};
    for (const [name, value] of url.searchParams) {
        const existing = query[name];
        query[name] =
            existing === undefined
                ? value
                : typeof existing === "string"
                  ? [existing, value]
                  : [...existing, value];
    }
    return query;
}
