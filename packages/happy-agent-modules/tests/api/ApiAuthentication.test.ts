import { mkdtemp, rm } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SignJWT } from "jose";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiModule } from "../../sources/api/ApiModule.js";
import { TeamModule } from "../../sources/team/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import { testProfileModule } from "../support/testProfileModule.js";

const SECRET = new TextEncoder().encode("a-very-long-shared-secret-of-at-least-32-bytes");
const OAUTH = {
    authorizationUrl: "https://sso.acme.example/oauth/authorize",
    clientId: "happy",
    id: "jwt",
    name: "Acme SSO",
    refreshUrl: "https://refresh.acme.example/oauth/refresh",
    tokenUrl: "https://sso.acme.example/oauth/token",
    type: "oauth",
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Harness {
    readonly call: (
        path: string,
        authorization?: string,
    ) => Promise<{ readonly status: number; readonly body: Record<string, unknown> }>;
    readonly database: ModuleDatabase;
    readonly team: TeamModule;
    readonly token: string | undefined;
}

async function harness(mode: "standalone" | "jwt"): Promise<Harness> {
    const directory = await mkdtemp(join(tmpdir(), "api-authentication-"));
    const teamValues =
        mode === "jwt"
            ? {
                  authentication: "jwt",
                  enabled: true,
                  host: "127.0.0.1",
                  jwt: {
                      algorithms: ["HS256"],
                      audience: "happy-agent",
                      issuer: "https://sso.acme.example",
                      key: { env: "HAPPY_TEAM_JWT_SECRET", type: "secret" },
                      authorizationUrl: OAUTH.authorizationUrl,
                      clientId: OAUTH.clientId,
                      name: "Acme SSO",
                      refreshUrl: OAUTH.refreshUrl,
                      tokenUrl: OAUTH.tokenUrl,
                      userIdClaim: "sub",
                  },
                  ownerUserId: "owner-1",
                  port: 0,
                  workosClientId: "client_test123",
              }
            : { authentication: "workos", enabled: false, host: "127.0.0.1", port: 0 };
    const config = {
        onProviderServiceTiersChanged: () => () => undefined,
        configuration: {
            paths: { tokenPath: join(directory, "token") },
            values: { feature: { team: teamValues }, features: { workspaces: false } },
        },
        teamJwtSecret: SECRET,
    };
    const team = new TeamModule(config as never, testProfileModule());
    const database = moduleDatabase(team.migrations, `api-authentication-${mode}`);
    await database.ready;
    const subscribe = () => () => undefined;
    const passive = new Proxy({}, { get: () => subscribe }) as never;
    const api = new ApiModule(
        passive,
        config as never,
        { subscribe } as never,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        { onPending: subscribe, onAppend: subscribe, onToolSpawn: subscribe } as never,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        passive,
        team,
        passive,
        passive,
        passive,
    );
    const ctx: Context = database.context;
    await api.beforeStart(ctx, {} as never);
    await api.markReady();
    cleanups.push(async () => {
        await api.close();
        database.close();
        await rm(directory, { force: true, recursive: true });
    });
    return {
        call: async (path, authorization) => {
            const socket = new Socket();
            try {
                const request = new IncomingMessage(socket);
                request.method = "GET";
                request.url = path;
                request.headers = authorization === undefined ? {} : { authorization };
                request.push(null);
                const response = new ServerResponse(request);
                const end = vi.spyOn(response, "end").mockImplementation(() => response);
                await api.handleRequest(ctx, request, response);
                return {
                    body: JSON.parse(String(end.mock.calls[0]?.[0])) as Record<string, unknown>,
                    status: response.statusCode,
                };
            } finally {
                socket.destroy();
            }
        },
        database,
        team,
        token: api.token(),
    };
}

async function jwt(subject: string, audience = "happy-agent"): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    return await new SignJWT({ sub: subject })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("https://sso.acme.example")
        .setAudience(audience)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(SECRET);
}

describe("GET /v0/authentication with JWT team authentication", () => {
    it("lists the OAuth method without a token and reports sign-in state", async () => {
        const { call, database, team } = await harness("jwt");

        expect(await call("/v0/authentication")).toEqual({
            body: { authenticated: false, methods: [OAUTH], userId: null },
            status: 200,
        });
        expect(
            (await call("/v0/authentication", `Bearer ${await jwt("person-1", "other")}`)).body,
        ).toEqual({ authenticated: false, methods: [OAUTH], userId: null });

        const token = await jwt("person-1");
        expect((await call("/v0/authentication", `Bearer ${token}`)).body).toEqual({
            authenticated: true,
            methods: [OAUTH],
            userId: null,
        });
        const user = await team.createUser(database.context, {
            authentication: "jwt",
            firstName: "Ada",
            subject: "person-1",
        });
        expect((await call("/v0/authentication", `Bearer ${token}`)).body).toMatchObject({
            authenticated: true,
            userId: user.id,
        });
    });

    it("ignores any query string and never echoes sign-in parameters", async () => {
        const { call } = await harness("jwt");

        const result = await call(
            "/v0/authentication?redirectUri=https%3A%2F%2Fevil.example&state=x&code=y",
        );

        expect(result).toEqual({
            body: { authenticated: false, methods: [OAUTH], userId: null },
            status: 200,
        });
        expect(JSON.stringify(result.body)).not.toContain("evil.example");
    });

    it("tells every rejected request how to sign in", async () => {
        const { call, database, team } = await harness("jwt");

        expect(await call("/v0/health")).toEqual({
            body: {
                authentication: { methods: [OAUTH] },
                code: "unauthorized",
                error: "Unauthorized",
            },
            status: 401,
        });
        const token = await jwt("person-2");
        expect((await call("/v0/projects", `Bearer ${token}`)).body).toMatchObject({
            authentication: { methods: [OAUTH] },
            code: "unauthorized",
        });
        await team.createUser(database.context, {
            authentication: "jwt",
            firstName: "Grace",
            subject: "person-2",
        });
        expect((await call("/v0/health", `Bearer ${token}`)).status).toBe(200);
    });
});

describe("GET /v0/authentication in standalone mode", () => {
    it("offers no methods and never adds a challenge to rejections", async () => {
        const { call, token } = await harness("standalone");

        expect(await call("/v0/authentication")).toEqual({
            body: { authenticated: false, methods: [], userId: null },
            status: 200,
        });
        expect((await call("/v0/authentication", `Bearer ${token!}`)).body).toEqual({
            authenticated: true,
            methods: [],
            userId: null,
        });
        expect(await call("/v0/health")).toEqual({
            body: { code: "unauthorized", error: "Unauthorized" },
            status: 401,
        });
    });
});
