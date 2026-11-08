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
    refreshUrl: "https://sso.acme.example/oauth/refresh",
    clientId: "happy",
    scope: "happy offline_access",
};
const REDIRECT = "happy://oauth/callback";
const SERVER = "https://happy.acme.example/";

/** An unsigned JWT-shaped access token; clients read `aud` without verifying it. */
function jwt(aud: unknown): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none" })}.${part({ sub: "user-1", aud })}.signature`;
}
const ACCESS_1 = jwt("https://happy.acme.example");
const ACCESS_2 = jwt(["https://other.example", "https://happy.acme.example/"]);

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
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT, serverUrl: SERVER });
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
        const other = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT, serverUrl: SERVER });
        expect(other.state).not.toBe(signIn.state);
        expect(other.codeVerifier).not.toBe(signIn.codeVerifier);
    });

    it("exchanges the code only at the token URL and records the refresh URL", async () => {
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT, serverUrl: SERVER });
        const { fetch, requests } = recordingFetch(() =>
            json({
                access_token: ACCESS_1,
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
            accessToken: ACCESS_1,
            clientId: "happy",
            refreshToken: "refresh-1",
            refreshUrl: METHOD.refreshUrl,
        });
        expect(credential.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    });

    it("rejects a mismatched state, an authorization error, or a missing code without a request", async () => {
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT, serverUrl: SERVER });
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
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT, serverUrl: SERVER });
        const callback = `${REDIRECT}?code=c&state=${signIn.state}`;
        for (const [response, code] of [
            [json({ error: "invalid_grant", error_description: "Expired." }, 400), "invalid_grant"],
            [new Response("oops", { status: 500 }), "invalid_response"],
            [json({ access_token: ACCESS_1, token_type: "mac" }), "invalid_response"],
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
                    { redirectUri: REDIRECT, serverUrl: SERVER },
                ),
            ).rejects.toBeInstanceOf(HappyAgentOAuthError);
        }
        await expect(
            beginOAuthSignIn(
                {
                    ...METHOD,
                    authorizationUrl: "http://127.0.0.1:8080/authorize",
                    tokenUrl: "http://127.0.0.1:8080/token",
                    refreshUrl: "http://127.0.0.1:8080/token",
                },
                { redirectUri: REDIRECT, serverUrl: SERVER },
            ),
        ).resolves.toBeDefined();
        await expect(
            beginOAuthSignIn(METHOD, { redirectUri: `${REDIRECT}#fragment`, serverUrl: SERVER }),
        ).rejects.toMatchObject({ code: "insecure_url" });
    });
});

describe("binding a sign-in to its authorization server and its server", () => {
    it("refuses token and refresh URLs on another origin than the authorization URL", async () => {
        for (const method of [
            { ...METHOD, tokenUrl: "https://attacker.example/oauth/token" },
            { ...METHOD, refreshUrl: "https://attacker.example/oauth/token" },
            { ...METHOD, tokenUrl: "https://sso.acme.example:8443/oauth/token" },
            { ...METHOD, tokenUrl: "https://login.sso.acme.example/oauth/token" },
        ]) {
            await expect(
                beginOAuthSignIn(method, { redirectUri: REDIRECT, serverUrl: SERVER }),
            ).rejects.toMatchObject({ code: "insecure_url" });
        }
        await expect(
            beginOAuthSignIn(
                {
                    ...METHOD,
                    authorizationUrl: "https://SSO.acme.example:443/oauth/authorize",
                },
                { redirectUri: REDIRECT, serverUrl: SERVER },
            ),
        ).resolves.toBeDefined();
    });

    it("keeps the endpoints checked at the start, whatever happens to the method later", async () => {
        const method = { ...METHOD };
        const signIn = await beginOAuthSignIn(method, { redirectUri: REDIRECT, serverUrl: SERVER });
        method.tokenUrl = "https://attacker.example/oauth/token";
        expect(Object.isFrozen(signIn)).toBe(true);
        expect(Object.isFrozen(signIn.method)).toBe(true);
        expect(() => {
            (signIn.method as { tokenUrl: string }).tokenUrl = "https://attacker.example/token";
        }).toThrow(TypeError);
        const { fetch, requests } = recordingFetch(() =>
            json({ access_token: ACCESS_1, token_type: "Bearer" }),
        );
        await completeOAuthSignIn(signIn, `${REDIRECT}?code=c&state=${signIn.state}`, { fetch });
        expect(requests.map((request) => request.url)).toEqual([METHOD.tokenUrl]);

        // An attempt assembled by hand still never sends the code to another site.
        const forged = {
            ...signIn,
            method: { ...signIn.method, tokenUrl: "https://attacker.example/oauth/token" },
        };
        await expect(
            completeOAuthSignIn(forged, `${REDIRECT}?code=c&state=${signIn.state}`, { fetch }),
        ).rejects.toMatchObject({ code: "insecure_url" });
        expect(requests).toHaveLength(1);
    });

    it("refuses an insecure server URL", async () => {
        for (const serverUrl of [
            "http://happy.acme.example/",
            "http://localhost.acme.example/",
            "http://acme.localhost.example/",
            "http://.localhost/",
            "http://user:pass@acme.localhost/",
        ]) {
            await expect(
                beginOAuthSignIn(METHOD, { redirectUri: REDIRECT, serverUrl }),
            ).rejects.toMatchObject({ code: "insecure_url" });
        }
    });

    it("accepts a server at a name under localhost over plain http", async () => {
        const serverUrl = "http://acme.localhost:31360/";
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT, serverUrl });
        const callback = `${REDIRECT}?code=c&state=${signIn.state}`;
        const credential = await completeOAuthSignIn(signIn, callback, {
            fetch: async () =>
                json({ access_token: jwt("http://acme.localhost:31360"), token_type: "Bearer" }),
        });
        expect(credential.serverUrl).toBe(serverUrl);
        await expect(
            completeOAuthSignIn(signIn, callback, {
                fetch: async () =>
                    json({
                        access_token: jwt("http://other.localhost:31360"),
                        token_type: "Bearer",
                    }),
            }),
        ).rejects.toMatchObject({ code: "audience_mismatch" });
    });

    it("refuses sign-in URLs at a name under localhost, which fetch may resolve through DNS", async () => {
        await expect(
            beginOAuthSignIn(
                {
                    ...METHOD,
                    authorizationUrl: "http://sso.localhost:31361/authorize",
                    tokenUrl: "http://sso.localhost:31361/token",
                    refreshUrl: "http://sso.localhost:31361/token",
                },
                { redirectUri: REDIRECT, serverUrl: "http://acme.localhost:31360/" },
            ),
        ).rejects.toMatchObject({
            code: "insecure_url",
            message: "Sign-in URLs must use https, or http only on this machine.",
        });
    });

    it("returns an access token only when its aud names the server", async () => {
        const accepted = [
            "https://happy.acme.example",
            "https://happy.acme.example/",
            "https://HAPPY.acme.example:443/",
            ["https://other.example/", "https://happy.acme.example"],
        ];
        const refused = [
            "https://other.example/",
            "https://happy.acme.example/team/",
            "http://happy.acme.example/",
            "https://happy.acme.example:8443/",
            "happy",
            ["https://other.example/"],
            [],
            undefined,
            42,
        ];
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT, serverUrl: SERVER });
        const callback = `${REDIRECT}?code=c&state=${signIn.state}`;
        for (const aud of accepted) {
            const credential = await completeOAuthSignIn(signIn, callback, {
                fetch: async () => json({ access_token: jwt(aud), token_type: "Bearer" }),
            });
            expect(credential.serverUrl).toBe(SERVER);
        }
        for (const accessToken of [...refused.map(jwt), "opaque-token", "a.!!!.c"]) {
            await expect(
                completeOAuthSignIn(signIn, callback, {
                    fetch: async () => json({ access_token: accessToken, token_type: "Bearer" }),
                }),
            ).rejects.toMatchObject({ code: "audience_mismatch" });
        }
    });

    it("matches a server under a path prefix only at that path", async () => {
        const serverUrl = "https://acme.example/happy/";
        const signIn = await beginOAuthSignIn(METHOD, { redirectUri: REDIRECT, serverUrl });
        const callback = `${REDIRECT}?code=c&state=${signIn.state}`;
        for (const [aud, ok] of [
            ["https://acme.example/happy", true],
            ["https://acme.example/happy/", true],
            ["https://acme.example/", false],
            ["https://acme.example/happy/team", false],
        ] as const) {
            const result = completeOAuthSignIn(signIn, callback, {
                fetch: async () => json({ access_token: jwt(aud), token_type: "Bearer" }),
            });
            if (ok) await expect(result).resolves.toBeDefined();
            else await expect(result).rejects.toMatchObject({ code: "audience_mismatch" });
        }
    });

    it("refuses a refreshed token for another server", async () => {
        await expect(
            refreshOAuthCredential(
                {
                    accessToken: ACCESS_1,
                    clientId: "happy",
                    expiresAt: null,
                    refreshToken: "refresh-1",
                    refreshUrl: "https://sso.acme.example/oauth/refresh",
                    serverUrl: SERVER,
                },
                {
                    fetch: async () =>
                        json({ access_token: jwt("https://other.example/"), token_type: "Bearer" }),
                },
            ),
        ).rejects.toMatchObject({ code: "audience_mismatch" });
    });
});

describe("OAuth refresh", () => {
    const credential: OAuthCredential = {
        accessToken: ACCESS_1,
        clientId: "happy",
        expiresAt: null,
        refreshToken: "refresh-1",
        refreshUrl: "https://sso.acme.example/oauth/refresh",
        serverUrl: SERVER,
    };

    it("refreshes only at the recorded refresh URL and rotates the refresh token", async () => {
        const { fetch, requests } = recordingFetch(() =>
            json({ access_token: ACCESS_2, token_type: "bearer", refresh_token: "refresh-2" }),
        );

        const refreshed = await refreshOAuthCredential(credential, { fetch });

        expect(requests[0]!.url).toBe("https://sso.acme.example/oauth/refresh");
        expect(Object.fromEntries(requests[0]!.body)).toEqual({
            grant_type: "refresh_token",
            refresh_token: "refresh-1",
            client_id: "happy",
        });
        expect(refreshed).toEqual({
            ...credential,
            accessToken: ACCESS_2,
            refreshToken: "refresh-2",
        });
    });

    it("keeps the previous refresh token when none is returned", async () => {
        const refreshed = await refreshOAuthCredential(credential, {
            fetch: async () => json({ access_token: ACCESS_2, token_type: "Bearer" }),
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
