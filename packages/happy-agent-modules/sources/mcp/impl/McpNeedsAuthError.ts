/**
 * An HTTP server refused the connection for want of a login: it answered 401, or 403 with
 * `insufficient_scope`. The challenge's hints are kept for the login that may follow; they come
 * from the server and are untrusted.
 */
export class McpNeedsAuthError extends Error {
    readonly insufficientScope: boolean;
    readonly resourceMetadataUrl: string | undefined;
    readonly scope: string | undefined;

    constructor(challenge: {
        readonly insufficientScope: boolean;
        readonly resourceMetadataUrl?: string | undefined;
        readonly scope?: string | undefined;
    }) {
        super(
            challenge.insufficientScope
                ? "The MCP server needs a login with more access."
                : "The MCP server needs a login.",
        );
        this.name = "McpNeedsAuthError";
        this.insufficientScope = challenge.insufficientScope;
        this.resourceMetadataUrl = challenge.resourceMetadataUrl;
        this.scope = challenge.scope;
    }
}
