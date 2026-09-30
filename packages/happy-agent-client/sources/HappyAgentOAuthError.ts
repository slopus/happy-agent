/**
 * A failed OAuth sign-in or refresh.
 *
 * `code` is the authorization server's OAuth error, such as `invalid_grant`, or
 * one of this client's own: `state_mismatch`, `invalid_response`, `insecure_url`,
 * `refresh_unavailable`, and `network_error`.
 */
export class HappyAgentOAuthError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "HappyAgentOAuthError";
        this.code = code;
    }
}
