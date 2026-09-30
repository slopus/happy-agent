import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import {
    beginOAuthSignIn,
    completeOAuthSignIn,
    HappyAgentApiError,
    HappyAgentClient,
    refreshOAuthCredential,
} from "@slopus/happy-agent-client";
import { CodexApiKeyCredential, CodexProvider } from "@slopus/happy-providers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startHappyAgentDaemon, type HappyAgentDaemon } from "../sources/main.js";

const temporaryDirectories: string[] = [];
const CLIENT_ID = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
const ORGANIZATION_ID = "org_test123";
const OWNER_WORKOS_USER_ID = "user_owner123";
const MEMBER_WORKOS_USER_ID = "user_member456";
let daemon: HappyAgentDaemon | undefined;
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    for (const close of closers.splice(0)) await close();
    vi.unstubAllGlobals();
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((path) =>
                rm(path, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 }),
            ),
    );
});

describe("team mode daemon", () => {
    it.each([false, true])(
        "combines installation completion (%s) with each member's own profile across restart",
        async (installationCompleted) => {
            const root = await mkdtemp(join(tmpdir(), "happy-agent-team-onboarding-"));
            temporaryDirectories.push(root);
            const happyHome = join(root, ".happy");
            const configPath = join(
                root,
                process.platform === "darwin" ? "Happy/Config" : "happy/config",
                "happy.toml",
            );
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(
                configPath,
                [
                    "[feature.team]",
                    "enabled = true",
                    'host = "127.0.0.1"',
                    "port = 0",
                    `workos_organization_id = "${ORGANIZATION_ID}"`,
                    `owner_workos_user_id = "${OWNER_WORKOS_USER_ID}"`,
                ].join("\n"),
            );
            const markerPath = join(happyHome, "agent", "onboarding-v0");
            if (installationCompleted) {
                await mkdir(dirname(markerPath), { recursive: true });
                await writeFile(markerPath, "complete\n");
            }

            const { privateKey, publicKey } = await generateKeyPair("RS256");
            const jwk = {
                ...(await exportJWK(publicKey)),
                alg: "RS256",
                kid: "team-daemon-test",
                use: "sig",
            };
            const nativeFetch = globalThis.fetch;
            vi.stubGlobal(
                "fetch",
                vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                    if (String(input).includes("api.workos.com/sso/jwks/")) {
                        return Response.json({ keys: [jwk] });
                    }
                    return await nativeFetch(input, init);
                }),
            );
            daemon = await startHappyAgentDaemon({ happyHome, inference: await inference() });
            const clientFor = async (subject: string) =>
                new HappyAgentClient({
                    endpoint: daemon!.httpUrl!,
                    token: await signAccessToken(privateKey, subject),
                });
            let owner = await clientFor(OWNER_WORKOS_USER_ID);
            let member = await clientFor(MEMBER_WORKOS_USER_ID);
            const unfinished = {
                completed: false,
                steps: {
                    profile: { done: false },
                    project: { done: false },
                    providers: { done: true, signedIn: ["gym"] },
                },
            };
            await expect(owner.getOnboarding()).resolves.toEqual(unfinished);
            await expect(member.getOnboarding()).resolves.toEqual(unfinished);
            await expect(member.getHealth()).resolves.toMatchObject({ ready: true });
            await expect(member.completeOnboarding()).rejects.toMatchObject({
                status: 401,
                code: "unauthorized",
            });
            for (const read of [
                () => member.getConfig(),
                () => member.listProjects(),
                () => member.getDesktopBootstrap(),
            ]) {
                await expect(read()).rejects.toMatchObject({ status: 401 });
            }
            const ownerProfile = await owner.getProfile();
            await owner.updateProfile(
                { name: "Ada Lovelace", email: "ada@example.test" },
                { ifMatch: ownerProfile.profile.version },
            );
            await expect(owner.getOnboarding()).resolves.toMatchObject({
                completed: installationCompleted,
                steps: { profile: { done: true } },
            });
            await expect(owner.completeOnboarding()).resolves.toEqual({ completed: true });
            await expect(owner.completeOnboarding()).resolves.toEqual({ completed: true });
            await expect(readFile(markerPath, "utf8")).resolves.toBe("complete\n");

            // Completing the installation must not let another member skip their profile.
            await expect(member.getOnboarding()).resolves.toEqual(unfinished);
            const memberProfile = await member.getProfile();
            expect(memberProfile.profile.name).toBeNull();
            await member.updateProfile(
                { name: "Grace Hopper", email: "grace@example.test" },
                { ifMatch: memberProfile.profile.version },
            );
            // No second completion call, scope argument, or client-side team branch is needed.
            const finished = {
                ...unfinished,
                completed: true,
                steps: { ...unfinished.steps, profile: { done: true } },
            };
            await expect(member.getOnboarding()).resolves.toEqual(finished);
            await expect(member.getDesktopBootstrap()).resolves.toMatchObject({
                onboarding: finished,
                profile: { name: "Grace Hopper" },
            });
            await expect(member.getConfig()).resolves.toBeDefined();
            await expect(member.listProjects()).resolves.toBeDefined();

            await daemon.close();
            daemon = await startHappyAgentDaemon({ happyHome, inference: await inference() });
            owner = await clientFor(OWNER_WORKOS_USER_ID);
            member = await clientFor(MEMBER_WORKOS_USER_ID);
            const newcomer = await clientFor("user_newcomer789");
            const states = await Promise.all([
                owner.getOnboarding(),
                member.getOnboarding(),
                newcomer.getOnboarding(),
            ]);
            expect(states).toEqual([finished, finished, unfinished]);
            await expect(newcomer.completeOnboarding()).rejects.toMatchObject({ status: 401 });
            await expect(newcomer.getProfile()).resolves.toMatchObject({
                profile: { name: null },
            });
            await expect(member.getDesktopBootstrap()).resolves.toMatchObject({
                onboarding: finished,
            });
        },
        30_000,
    );

    it("starts without retaining a local API socket or bearer token", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-team-daemon-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        const configPath = join(
            root,
            process.platform === "darwin" ? "Happy/Config" : "happy/config",
            "happy.toml",
        );
        const tokenPath = join(happyHome, "agent", "token");
        const socketPath = join(happyHome, "agent", "server.sock");
        await Promise.all([
            mkdir(dirname(configPath), { recursive: true }),
            mkdir(dirname(tokenPath), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(
                configPath,
                [
                    "[feature.team]",
                    "enabled = true",
                    'host = "127.0.0.1"',
                    "port = 0",
                    `workos_organization_id = "${ORGANIZATION_ID}"`,
                    `owner_workos_user_id = "${OWNER_WORKOS_USER_ID}"`,
                ].join("\n"),
            ),
            writeFile(tokenPath, `${"a".repeat(43)}\n`),
        ]);

        daemon = await startHappyAgentDaemon({
            happyHome,
            inference: await inference(),
        });

        await expect(readFile(tokenPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(socketPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(daemon.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const response = await fetch(`${daemon.httpUrl}/v0/health`);
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
            code: "unauthorized",
            error: "Unauthorized",
        });

        await daemon.close();
        daemon = undefined;
        const sqlite = new DatabaseSync(join(happyHome, "agent", "agent.sqlite"), {
            readOnly: true,
        });
        try {
            expect(
                sqlite
                    .prepare(
                        `SELECT name FROM sqlite_master
                         WHERE type = 'table'
                           AND name IN ('happy_agent_profile', 'happy_agent_team_users')
                         ORDER BY name`,
                    )
                    .all(),
            ).toEqual([{ name: "happy_agent_team_users" }]);
            expect(
                sqlite.prepare("SELECT COUNT(*) AS count FROM happy_agent_team_users").get(),
            ).toEqual({ count: 0 });
        } finally {
            sqlite.close();
        }
    });

    it("onboards an organization member through the existing profile API", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-team-profile-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        const configPath = join(
            root,
            process.platform === "darwin" ? "Happy/Config" : "happy/config",
            "happy.toml",
        );
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            [
                "[feature.team]",
                "enabled = true",
                'host = "127.0.0.1"',
                "port = 0",
                `workos_organization_id = "${ORGANIZATION_ID}"`,
                `owner_workos_user_id = "${OWNER_WORKOS_USER_ID}"`,
            ].join("\n"),
        );

        const { privateKey, publicKey } = await generateKeyPair("RS256");
        const jwk = {
            ...(await exportJWK(publicKey)),
            alg: "RS256",
            kid: "team-daemon-test",
            use: "sig",
        };
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                if (String(input).includes("api.workos.com/sso/jwks/")) {
                    return Response.json({ keys: [jwk] });
                }
                return await nativeFetch(input, init);
            }),
        );

        daemon = await startHappyAgentDaemon({ happyHome, inference: await inference() });
        const accessToken = await signAccessToken(privateKey);
        const authorization = `Bearer ${accessToken}`;
        const profileResponse = await fetch(`${daemon.httpUrl}/v0/profile`, {
            headers: { authorization },
        });
        expect(profileResponse.status).toBe(200);
        const empty = (await profileResponse.json()) as {
            readonly profile: { readonly version: string };
        };
        expect(empty).toMatchObject({
            profile: { email: null, name: null, photo: null, updatedAt: 0 },
        });

        const blocked = await fetch(`${daemon.httpUrl}/v0/config`, {
            headers: { authorization },
        });
        expect(blocked.status).toBe(401);

        const savedResponse = await fetch(`${daemon.httpUrl}/v0/profile`, {
            body: JSON.stringify({
                email: "ada@example.com",
                mutationId: "team-profile-1",
                name: "Ada Lovelace Byron",
            }),
            headers: {
                authorization,
                "content-type": "application/json",
                "if-match": empty.profile.version,
            },
            method: "PATCH",
        });
        expect(savedResponse.status).toBe(200);
        await expect(savedResponse.json()).resolves.toMatchObject({
            profile: {
                email: "ada@example.com",
                name: "Ada Lovelace Byron",
                photo: null,
            },
        });

        const admitted = await fetch(`${daemon.httpUrl}/v0/config`, {
            headers: { authorization },
        });
        expect(admitted.status).toBe(200);

        const memberAuthorization = `Bearer ${await signAccessToken(
            privateKey,
            MEMBER_WORKOS_USER_ID,
        )}`;
        const memberEmptyResponse = await fetch(`${daemon.httpUrl}/v0/profile`, {
            headers: { authorization: memberAuthorization },
        });
        const memberEmpty = (await memberEmptyResponse.json()) as {
            readonly profile: { readonly version: string };
        };
        const memberSaved = await fetch(`${daemon.httpUrl}/v0/profile`, {
            body: JSON.stringify({ mutationId: "team-profile-2", name: "Grace Hopper" }),
            headers: {
                authorization: memberAuthorization,
                "content-type": "application/json",
                "if-match": memberEmpty.profile.version,
            },
            method: "PATCH",
        });
        expect(memberSaved.status).toBe(200);

        const eventsResponse = await fetch(`${daemon.httpUrl}/v0/events`, {
            headers: { authorization: memberAuthorization },
        });
        expect(eventsResponse.status).toBe(200);
        const page = (await eventsResponse.json()) as {
            readonly events: readonly {
                readonly payload: Record<string, unknown>;
                readonly type: string;
            }[];
        };
        const profileUpdated = page.events.find((event) => event.type === "profile.updated");
        expect(profileUpdated).toBeDefined();
        expect(profileUpdated?.payload).toMatchObject({ mutationId: "team-profile-1" });
        expect(Object.keys(profileUpdated?.payload ?? {}).sort()).toEqual(["mutationId", "userId"]);

        await daemon.close();
        daemon = undefined;
        const sqlite = new DatabaseSync(join(happyHome, "agent", "agent.sqlite"), {
            readOnly: true,
        });
        try {
            expect(
                sqlite
                    .prepare(
                        `SELECT authentication, subject, first_name, last_name, email, is_owner
                         FROM happy_agent_team_users
                         WHERE authentication = 'workos' AND subject = ?`,
                    )
                    .get(OWNER_WORKOS_USER_ID),
            ).toEqual({
                authentication: "workos",
                email: "ada@example.com",
                first_name: "Ada",
                is_owner: 1,
                last_name: "Lovelace Byron",
                subject: OWNER_WORKOS_USER_ID,
            });
            expect(
                sqlite
                    .prepare(
                        `SELECT first_name, last_name, is_owner
                         FROM happy_agent_team_users
                         WHERE authentication = 'workos' AND subject = ?`,
                    )
                    .get(MEMBER_WORKOS_USER_ID),
            ).toEqual({ first_name: "Grace", is_owner: 0, last_name: "Hopper" });
        } finally {
            sqlite.close();
        }
    });
});

describe("team mode daemon with JWT authentication", () => {
    it("signs in with the code flow and refreshes without the daemon seeing credentials", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-team-jwt-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        const configPath = join(
            root,
            process.platform === "darwin" ? "Happy/Config" : "happy/config",
            "happy.toml",
        );
        const authorizationServer = await startAuthorizationServer();
        closers.push(authorizationServer.close);
        const { origin } = authorizationServer;
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            [
                "[feature.team]",
                "enabled = true",
                'host = "127.0.0.1"',
                "port = 0",
                'authentication = "jwt"',
                'owner_user_id = "owner-1"',
                "[feature.team.jwt]",
                'name = "Acme SSO"',
                `authorization_url = "${origin}/authorize"`,
                `token_url = "${origin}/token"`,
                `refresh_url = "${origin}/refresh"`,
                'client_id = "happy"',
                'scope = "happy"',
                `issuer = "${origin}"`,
                'audience = "happy-agent-test"',
                'algorithms = ["ES256"]',
                `jwks_url = "${origin}/jwks"`,
                "jwks_refresh_interval_sec = 3600",
            ].join("\n"),
        );
        daemon = await startHappyAgentDaemon({ happyHome, inference: await inference() });
        // The daemon downloads the key set itself once the agent system has started.
        await vi.waitFor(() => expect(authorizationServer.requests).toContain("GET /jwks"));
        const daemonRequests: string[] = [];
        const recordingFetch: typeof globalThis.fetch = async (input, init) => {
            daemonRequests.push(
                `${String(input)} ${new Headers(init?.headers).get("authorization") ?? ""}`,
            );
            return await globalThis.fetch(input, init);
        };

        const anonymous = new HappyAgentClient({ endpoint: daemon.httpUrl, fetch: recordingFetch });
        const discovery = await anonymous.getAuthentication();
        expect(discovery).toEqual({
            authenticated: false,
            methods: [
                {
                    authorizationUrl: `${origin}/authorize`,
                    clientId: "happy",
                    id: "jwt",
                    name: "Acme SSO",
                    refreshUrl: `${origin}/refresh`,
                    scope: "happy",
                    tokenUrl: `${origin}/token`,
                    type: "oauth",
                },
            ],
            userId: null,
        });
        const rejected = await new HappyAgentClient({ endpoint: daemon.httpUrl, token: "invalid" })
            .getConfig()
            .catch((error: unknown) => error);
        expect((rejected as HappyAgentApiError).authentication?.methods).toEqual(discovery.methods);

        // The system browser: follow the authorization URL to the app's redirect.
        const signIn = await beginOAuthSignIn(discovery.methods[0]!, {
            redirectUri: "http://127.0.0.1:53682/callback",
        });
        const redirect = await fetch(signIn.url, { redirect: "manual" });
        expect(redirect.status).toBe(302);
        const credential = await completeOAuthSignIn(signIn, redirect.headers.get("location")!);
        expect(credential.refreshToken).toBe("refresh-1");

        let current = credential;
        const client = new HappyAgentClient({
            endpoint: daemon.httpUrl,
            fetch: recordingFetch,
            token: () => current.accessToken,
        });
        await expect(client.getAuthentication()).resolves.toMatchObject({
            authenticated: true,
            userId: null,
        });
        const { profile } = await client.getProfile();
        await client.updateProfile(
            { mutationId: "jwt-profile-1", name: "Ada Lovelace" },
            { ifMatch: profile.version },
        );
        await expect(client.getConfig()).resolves.toBeDefined();

        current = await refreshOAuthCredential(current);
        expect(current).toMatchObject({
            accessToken: expect.any(String),
            refreshToken: "refresh-2",
        });
        expect(current.accessToken).not.toBe(credential.accessToken);
        const status = await client.getAuthentication();
        expect(status).toMatchObject({ authenticated: true, userId: expect.any(String) });

        // A rotated signing key is picked up at once, without waiting for the interval.
        await authorizationServer.rotate();
        current = await refreshOAuthCredential(current);
        await expect(client.getConfig()).resolves.toBeDefined();

        expect(authorizationServer.requests).toEqual([
            "GET /jwks",
            "GET /authorize",
            "POST /token authorization_code",
            "POST /refresh refresh_token",
            "POST /refresh refresh_token",
            "GET /jwks",
        ]);
        const sentToDaemon = daemonRequests.join("\n");
        expect(sentToDaemon).not.toContain(signIn.codeVerifier);
        expect(sentToDaemon).not.toContain("refresh-");
        expect(sentToDaemon).not.toContain("code-");
    });
});

/** A minimal OAuth authorization server that checks PKCE and issues ES256 access tokens. */
async function startAuthorizationServer(): Promise<{
    readonly close: () => Promise<void>;
    readonly origin: string;
    readonly requests: string[];
    readonly rotate: () => Promise<void>;
}> {
    const keyPair = async (kid: string) => {
        const pair = await generateKeyPair("ES256");
        return {
            jwk: { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid },
            kid,
            privateKey: pair.privateKey,
        };
    };
    let signing = await keyPair("key-1");
    const requests: string[] = [];
    const codes = new Map<string, string>();
    let issued = 0;
    let origin = "";
    const token = async (refreshToken: string) => {
        issued += 1;
        const now = Math.floor(Date.now() / 1_000);
        return {
            access_token: await new SignJWT({ n: issued })
                .setProtectedHeader({ alg: "ES256", kid: signing.kid })
                .setIssuer(origin)
                .setAudience("happy-agent-test")
                .setSubject("owner-1")
                .setIssuedAt(now)
                .setExpirationTime(now + 300)
                .sign(signing.privateKey),
            expires_in: 300,
            refresh_token: refreshToken,
            token_type: "Bearer",
        };
    };
    const server = createServer((request, response) => {
        void (async () => {
            const url = new URL(request.url ?? "/", origin);
            let body = "";
            for await (const chunk of request) body += String(chunk);
            const form = new URLSearchParams(body);
            requests.push(
                `${request.method ?? ""} ${url.pathname}${form.has("grant_type") ? ` ${form.get("grant_type")!}` : ""}`,
            );
            const json = (status: number, value: unknown) => {
                response.writeHead(status, { "content-type": "application/json" });
                response.end(JSON.stringify(value));
            };
            if (url.pathname === "/authorize") {
                const params = url.searchParams;
                if (
                    params.get("response_type") !== "code" ||
                    params.get("client_id") !== "happy" ||
                    params.get("code_challenge_method") !== "S256"
                ) {
                    return json(400, { error: "invalid_request" });
                }
                const code = `code-${String(codes.size + 1)}`;
                codes.set(code, params.get("code_challenge")!);
                const target = new URL(params.get("redirect_uri")!);
                target.searchParams.set("code", code);
                target.searchParams.set("state", params.get("state")!);
                response.writeHead(302, { location: target.toString() });
                return response.end();
            }
            if (url.pathname === "/token" && form.get("grant_type") === "authorization_code") {
                const challenge = codes.get(form.get("code") ?? "");
                const expected = createHash("sha256")
                    .update(form.get("code_verifier") ?? "")
                    .digest("base64url");
                codes.delete(form.get("code") ?? "");
                if (challenge === undefined || challenge !== expected) {
                    return json(400, { error: "invalid_grant" });
                }
                return json(200, await token("refresh-1"));
            }
            if (url.pathname === "/refresh" && form.get("refresh_token")?.startsWith("refresh-")) {
                return json(200, await token(`refresh-${String(issued + 1)}`));
            }
            if (url.pathname === "/jwks") {
                return json(200, { keys: [signing.jwk] });
            }
            return json(400, { error: "invalid_grant" });
        })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No address.");
    origin = `http://127.0.0.1:${String(address.port)}`;
    return {
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
        origin,
        requests,
        rotate: async () => {
            signing = await keyPair(`key-${String(issued + 1)}`);
        },
    };
}

async function signAccessToken(
    privateKey: CryptoKey,
    subject = OWNER_WORKOS_USER_ID,
): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    return await new SignJWT({
        client_id: CLIENT_ID,
        org_id: ORGANIZATION_ID,
        sid: "session_team_daemon_test",
    })
        .setProtectedHeader({ alg: "RS256", kid: "team-daemon-test" })
        .setIssuer(`https://api.workos.com/user_management/${CLIENT_ID}`)
        .setSubject(subject)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
}

async function inference(): Promise<{ models: AgentModel[]; providers: AgentProviders }> {
    const credential = await CodexApiKeyCredential.tryLoad({ apiKey: "test-key" });
    const providers = new AgentProviders();
    providers.add(
        "gym",
        new CodexProvider({
            credential: credential!,
            endpoint: "https://example.invalid/v1",
            userAgent: "happy-team-test/1.0",
        }),
        "codex",
    );
    return {
        models: [
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "gym/model",
                name: "Gym Model",
                providerId: "gym",
            },
        ],
        providers,
    };
}
