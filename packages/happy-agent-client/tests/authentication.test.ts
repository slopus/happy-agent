import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentApiError } from "../sources/HappyAgentApiError.js";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import { HappyAgentOAuthError } from "../sources/HappyAgentOAuthError.js";
import {
    beginOAuthSignIn,
    completeOAuthSignIn,
    refreshOAuthCredential,
    type OAuthCredential,
} from "../sources/oauthSignIn.js";
import {
    authenticationResponseSchema,
    type OAuthAuthenticationMethod,
} from "../sources/protocol/authentication.js";

const METHOD: OAuthAuthenticationMethod = {
    type: "oauth",
    id: "jwt",
    name: "Acme SSO",
    authorizationUrl: "https://sso.acme.example/oauth/authorize?tenant=acme",
    tokenUrl: "https://sso.acme.example/oauth/token",
    refreshUrl: "https://refresh.acme.example/oauth/refresh",
    clientId: "happy",
    scope: "happy offline_access",
};
const REDIRECT = "http://127.0.0.1:53682/callback";

interface Recorded {
    readonly url: string;
    readonly headers: Headers;
    readonly body: URLSearchParams;
    readonly redirect: RequestRedirect | undefined;
}

function recordingFetch(answer: (request: Recorded) => Response): {
    fetch: typeof globalThis.fetch;
    requests: Recorded[];
} {
    const requests: Recorded[] = [];
    return {
        requests,
        fetch: async (input, init) => {
            const request = {
                url: input.toString(),
                headers: new Headers(init?.headers),
                body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
                redirect: init?.redirect,
            };
            requests.push(request);
            return answer(request);
        },
    };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

describe("authentication discovery", () => {
    it("asks without a token and skips unknown method types", async () => {
        const { fetch, requests } = recordingFetch(() =>
            json({
                authenticated: false,
                userId: null,
                methods: [{ type: "browser", id: "old", name: "Old", url: "https://x" }, METHOD],
            }),
        );
        const client = new HappyAgentClient({ endpoint: "http://team.example/", fetch });

        const result = await client.getAuthentication();

        expect(result).toEqual({ authenticated: false, userId: null, methods: [METHOD] });
        expect(requests[0]!.headers.has("authorization")).toBe(false);
        expect(new URL(requests[0]!.url).pathname).toBe("/v0/authentication");
        expect(Value.Check(authenticationResponseSchema, result)).toBe(true);
    });

    it("reads the token from a function on every request", async () => {
        const { fetch, requests } = recordingFetch(() =>
            json({ authenticated: true, userId: "u", methods: [] }),
        );
        let current = "first";
        const client = new HappyAgentClient({
            endpoint: "http://team.example/",
            token: async () => current,
            fetch,
        });

        await client.getAuthentication();
        current = "second";
        await client.connection("remote").getAuthentication();

        expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
            "Bearer first",
            "Bearer second",
        ]);
    });

    it("exposes the sign-in methods offered by a 401", async () => {
        const { fetch } = recordingFetch(() =>
            json(
                {
                    error: "Unauthorized",
                    code: "unauthorized",
                    authentication: { methods: [METHOD, { type: "future" }] },
                },
                401,
            ),
        );
        const client = new HappyAgentClient({
            endpoint: "http://team.example/",
            token: "x",
            fetch,
        });

        const error = await client.getHealth().catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(HappyAgentApiError);
        expect((error as HappyAgentApiError).authentication).toEqual({ methods: [METHOD] });
        expect(
            new HappyAgentApiError(401, "Unauthorized", "unauthorized", null).authentication,
        ).toBe(null);
    });
});

describe("OAuth sign-in", () => {
    it("builds an authorization URL with state and an S256 PKCE challenge", async () => {
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT });
        const url = new URL(signIn.url);

        expect(signIn.host).toBe("sso.acme.example");
        expect(url.origin + url.pathname).toBe("https://sso.acme.example/oauth/authorize");
        expect(Object.fromEntries(url.searchParams)).toEqual({
            tenant: "acme",
            response_type: "code",
            client_id: "happy",
            redirect_uri: REDIRECT,
            state: signIn.state,
            code_challenge: createHash("sha256").update(signIn.codeVerifier).digest("base64url"),
            code_challenge_method: "S256",
            scope: "happy offline_access",
        });
        expect(signIn.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(signIn.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
        const other = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT });
        expect(other.state).not.toBe(signIn.state);
        expect(other.codeVerifier).not.toBe(signIn.codeVerifier);
    });

    it("exchanges the code only at the token URL and records the refresh URL", async () => {
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT });
        const { fetch, requests } = recordingFetch(() =>
            json({
                access_token: "access-1",
                token_type: "Bearer",
                expires_in: 3600,
                refresh_token: "refresh-1",
            }),
        );
        const before = Date.now();

        const credential = await completeOAuthSignIn(
            signIn,
            `${REDIRECT}?code=the-code&state=${signIn.state}`,
            { fetch },
        );

        expect(requests).toHaveLength(1);
        expect(requests[0]!.url).toBe(METHOD.tokenUrl);
        expect(requests[0]!.redirect).toBe("error");
        expect(requests[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
        expect(Object.fromEntries(requests[0]!.body)).toEqual({
            grant_type: "authorization_code",
            code: "the-code",
            redirect_uri: REDIRECT,
            client_id: "happy",
            code_verifier: signIn.codeVerifier,
        });
        expect(credential).toMatchObject({
            accessToken: "access-1",
            clientId: "happy",
            refreshToken: "refresh-1",
            refreshUrl: METHOD.refreshUrl,
        });
        expect(credential.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    });

    it("rejects a mismatched state, an authorization error, or a missing code without a request", async () => {
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT });
        const { fetch, requests } = recordingFetch(() => json({}));

        for (const [callback, code] of [
            [`${REDIRECT}?code=c&state=other`, "state_mismatch"],
            [`${REDIRECT}?code=c`, "state_mismatch"],
            [`${REDIRECT}?error=access_denied&state=${signIn.state}`, "access_denied"],
            [`${REDIRECT}?state=${signIn.state}`, "invalid_response"],
        ] as const) {
            await expect(completeOAuthSignIn(signIn, callback, { fetch })).rejects.toMatchObject({
                code,
            });
        }
        expect(requests).toEqual([]);
    });

    it("reports token endpoint errors and invalid responses", async () => {
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT });
        const callback = `${REDIRECT}?code=c&state=${signIn.state}`;
        for (const [response, code] of [
            [json({ error: "invalid_grant", error_description: "Expired." }, 400), "invalid_grant"],
            [new Response("oops", { status: 500 }), "invalid_response"],
            [json({ access_token: "a", token_type: "mac" }), "invalid_response"],
            [json({ token_type: "Bearer" }), "invalid_response"],
        ] as const) {
            await expect(
                completeOAuthSignIn(signIn, callback, { fetch: async () => response }),
            ).rejects.toMatchObject({ code });
        }
        await expect(
            completeOAuthSignIn(signIn, callback, {
                fetch: async () => {
                    throw new TypeError("offline");
                },
            }),
        ).rejects.toMatchObject({ code: "network_error" });
    });

    it("refuses insecure sign-in URLs a daemon might advertise", async () => {
        for (const field of ["authorizationUrl", "tokenUrl", "refreshUrl"] as const) {
            await expect(
                beginOAuthSignIn(
                    { ...METHOD, [field]: "http://sso.acme.example/x" },
                    { redirectUri: REDIRECT },
                ),
            ).rejects.toBeInstanceOf(HappyAgentOAuthError);
        }
        await expect(
            beginOAuthSignIn(
                { ...METHOD, authorizationUrl: "http://127.0.0.1:8080/authorize" },
                { redirectUri: REDIRECT },
            ),
        ).resolves.toBeDefined();
        await expect(
            beginOAuthSignIn(METHOD, { redirectUri: `${REDIRECT}#fragment` }),
        ).rejects.toMatchObject({ code: "insecure_url" });
    });
});

describe("OAuth refresh", () => {
    const credential: OAuthCredential = {
        accessToken: "access-1",
        clientId: "happy",
        expiresAt: null,
        refreshToken: "refresh-1",
        refreshUrl: "https://refresh.acme.example/oauth/refresh",
    };

    it("refreshes only at the recorded refresh URL and rotates the refresh token", async () => {
        const { fetch, requests } = recordingFetch(() =>
            json({ access_token: "access-2", token_type: "bearer", refresh_token: "refresh-2" }),
        );

        const refreshed = await refreshOAuthCredential(credential, { fetch });

        expect(requests[0]!.url).toBe("https://refresh.acme.example/oauth/refresh");
        expect(Object.fromEntries(requests[0]!.body)).toEqual({
            grant_type: "refresh_token",
            refresh_token: "refresh-1",
            client_id: "happy",
        });
        expect(refreshed).toEqual({
            ...credential,
            accessToken: "access-2",
            refreshToken: "refresh-2",
        });
    });

    it("keeps the previous refresh token when none is returned", async () => {
        const refreshed = await refreshOAuthCredential(credential, {
            fetch: async () => json({ access_token: "access-2", token_type: "Bearer" }),
        });
        expect(refreshed.refreshToken).toBe("refresh-1");
    });

    it("refuses to refresh without a token or URL", async () => {
        for (const missing of [
            { ...credential, refreshToken: null },
            { ...credential, refreshUrl: null },
        ]) {
            await expect(refreshOAuthCredential(missing)).rejects.toMatchObject({
                code: "refresh_unavailable",
            });
        }
    });
});
