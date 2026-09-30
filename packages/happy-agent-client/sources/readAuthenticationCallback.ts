/**
 * Reads the bearer token from a browser sign-in result.
 *
 * The deployer's page redirects to the client's `redirectUri` with
 * `#token=<jwt>&state=<state>` in the fragment. The returned state must equal
 * the one the client generated for this sign-in, or the result is rejected.
 */
export function readAuthenticationCallback(url: string | URL, expectedState?: string): string {
    const fragment = new URL(url.toString()).hash.replace(/^#/, "");
    const parameters = new URLSearchParams(fragment);
    const token = parameters.get("token");
    if (token === null || token.length === 0) {
        throw new Error("The sign-in result does not contain a token.");
    }
    const state = parameters.get("state");
    if ((expectedState ?? null) !== state) {
        throw new Error("The sign-in result does not match this sign-in attempt.");
    }
    return token;
}
