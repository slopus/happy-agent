import { createHash, generateKeyPairSync } from "node:crypto";

import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { describe, expect, it } from "vitest";

import {
    JwtAccessTokenVerifier,
    TEAM_ONBOARDING_PROFILE_VERSION,
    TEAM_USER_IDENTITIES_MIGRATION_KEY,
    TeamAuthenticationError,
    TeamModule,
    teamIdentity,
    teamUser,
} from "../../sources/team/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { testProfileModule } from "../support/testProfileModule.js";

const ISSUER = "https://sso.acme.example";
const AUDIENCE = "happy-agent";
const SECRET = new TextEncoder().encode("a-very-long-shared-secret-of-at-least-32-bytes");
const LOGIN_URL = "https://sso.acme.example/happy/login?tenant=acme&state=stale";

interface Claims {
    readonly aud?: string | string[];
    readonly exp?: number | null;
    readonly iat?: number;
    readonly iss?: string;
    readonly nbf?: number;
    readonly [claim: string]: unknown;
}

async function sign(
    key: CryptoKey | Uint8Array,
    alg: string,
    claims: Claims = {},
    kid?: string,
): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const { aud, exp, iss, ...rest } = claims;
    const jwt = new SignJWT({ sub: "person-1", iat: now, ...rest })
        .setProtectedHeader({ alg, ...(kid === undefined ? {} : { kid }) })
        .setIssuer(iss ?? ISSUER)
        .setAudience(aud ?? AUDIENCE);
    if (exp !== null) jwt.setExpirationTime(exp ?? now + 300);
    return await jwt.sign(key);
}

function hs256Verifier(userIdClaim = "sub"): JwtAccessTokenVerifier {
    return new JwtAccessTokenVerifier({
        algorithms: ["HS256"],
        audience: AUDIENCE,
        issuer: ISSUER,
        key: SECRET,
        userIdClaim,
    });
}

describe("JwtAccessTokenVerifier", () => {
    it("verifies a shared-secret token and returns its user ID", async () => {
        await expect(hs256Verifier().verify(await sign(SECRET, "HS256"))).resolves.toBe("person-1");
        await expect(
            hs256Verifier("email").verify(
                await sign(SECRET, "HS256", { email: "ada@acme.example" }),
            ),
        ).resolves.toBe("ada@acme.example");
    });

    it("verifies asymmetric tokens from a key set and a static public key", async () => {
        const { privateKey, publicKey } = await generateKeyPair("ES256");
        const jwk = { ...(await exportJWK(publicKey)), kid: "k1" };
        const fromKeySet = new JwtAccessTokenVerifier({
            algorithms: ["ES256"],
            audience: AUDIENCE,
            issuer: ISSUER,
            key: createLocalJWKSet({ keys: [jwk] }),
            userIdClaim: "sub",
        });
        await expect(fromKeySet.verify(await sign(privateKey, "ES256", {}, "k1"))).resolves.toBe(
            "person-1",
        );

        const pair = generateKeyPairSync("ed25519");
        const fromPublicKey = new JwtAccessTokenVerifier({
            algorithms: ["EdDSA"],
            audience: AUDIENCE,
            issuer: ISSUER,
            key: pair.publicKey,
            userIdClaim: "sub",
        });
        await expect(
            fromPublicKey.verify(await sign(pair.privateKey as never, "EdDSA")),
        ).resolves.toBe("person-1");
    });

    it.each([
        ["the wrong issuer", { iss: "https://evil.example" }],
        ["the wrong audience", { aud: "other" }],
        ["an expired token", { exp: Math.floor(Date.now() / 1_000) - 120 }],
        ["a token without exp", { exp: null }],
        ["a token not yet valid", { nbf: Math.floor(Date.now() / 1_000) + 600 }],
        ["a token issued in the future", { iat: Math.floor(Date.now() / 1_000) + 600 }],
        ["a missing user ID", { sub: undefined }],
        ["a non-string user ID", { sub: 42 }],
        ["a user ID with control characters", { sub: "person\n1" }],
    ])("rejects %s", async (_name, claims) => {
        await expect(hs256Verifier().verify(await sign(SECRET, "HS256", claims))).rejects.toThrow();
    });

    it("rejects a token signed with another key, algorithm, or no signature", async () => {
        const other = new TextEncoder().encode("another-secret-that-is-also-long-enough-to-use");
        await expect(hs256Verifier().verify(await sign(other, "HS256"))).rejects.toThrow();
        await expect(hs256Verifier().verify(await sign(SECRET, "HS384"))).rejects.toThrow();
        const [header, payload] = (await sign(SECRET, "HS256")).split(".");
        const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${payload!}.`;
        expect(header).toBeDefined();
        await expect(hs256Verifier().verify(unsigned)).rejects.toThrow();
    });

    it("accepts small clock skew", async () => {
        const now = Math.floor(Date.now() / 1_000);
        await expect(
            hs256Verifier().verify(await sign(SECRET, "HS256", { exp: now - 10, iat: now + 10 })),
        ).resolves.toBe("person-1");
    });
});

describe("TeamModule with JWT authentication", () => {
    it("authenticates members, onboards them, and marks only the configured owner", async () => {
        const team = createJwtTeam();
        const database = moduleDatabase(team.migrations, "team-jwt-onboarding");
        await database.ready;
        try {
            const token = await sign(SECRET, "HS256", { sub: "owner-1" });
            const onboarding = await team.authenticate(database.context, `Bearer ${token}`);
            expect(teamIdentity(onboarding)).toEqual({ authentication: "jwt", subject: "owner-1" });
            expect(teamUser(onboarding)).toBeUndefined();

            const owner = await team.updateCurrentProfile(
                onboarding,
                { name: "Ada Lovelace" },
                TEAM_ONBOARDING_PROFILE_VERSION,
            );
            expect(owner).toMatchObject({
                authentication: "jwt",
                isOwner: true,
                subject: "owner-1",
            });
            expect(teamUser(await team.authenticate(database.context, `Bearer ${token}`))).toEqual(
                owner,
            );

            const member = await team.updateCurrentProfile(
                await team.authenticate(
                    database.context,
                    `Bearer ${await sign(SECRET, "HS256", { sub: "person-2" })}`,
                ),
                { name: "Grace" },
                TEAM_ONBOARDING_PROFILE_VERSION,
            );
            expect(member.isOwner).toBe(false);
        } finally {
            database.close();
        }
    });

    it("scopes user IDs to their authentication method", async () => {
        const team = createJwtTeam();
        const database = moduleDatabase(team.migrations, "team-jwt-scope");
        await database.ready;
        try {
            const workos = await team.createUser(database.context, {
                authentication: "workos",
                firstName: "WorkOS",
                subject: "owner-1",
            });
            const jwt = await team.createUser(database.context, {
                authentication: "jwt",
                firstName: "JWT",
                subject: "owner-1",
            });
            expect(workos.id).not.toBe(jwt.id);
            expect(workos.isOwner).toBe(false);
            expect(jwt.isOwner).toBe(true);
            const ctx = await team.authenticate(
                database.context,
                `Bearer ${await sign(SECRET, "HS256", { sub: "owner-1" })}`,
            );
            expect(teamUser(ctx)?.id).toBe(jwt.id);
            await expect(
                team.createUser(database.context, {
                    authentication: "jwt",
                    firstName: "Duplicate",
                    subject: "owner-1",
                }),
            ).rejects.toThrow();
        } finally {
            database.close();
        }
    });

    it("rejects missing, malformed, oversized, and unverifiable bearer tokens", async () => {
        const team = createJwtTeam();
        const database = moduleDatabase(team.migrations, "team-jwt-reject");
        await database.ready;
        try {
            for (const authorization of [
                undefined,
                "Basic abc",
                "Bearer ",
                `Bearer ${"a".repeat(16_385)}`,
                `Bearer ${await sign(SECRET, "HS256", { aud: "other" })}`,
                ["Bearer a", "Bearer b"],
            ]) {
                await expect(
                    team.authenticateIdentity(database.context, authorization),
                ).rejects.toBeInstanceOf(TeamAuthenticationError);
            }
        } finally {
            database.close();
        }
    });

    it("builds the browser sign-in URL from the client's redirect and state", () => {
        const team = createJwtTeam();
        expect(team.authenticationMethods()).toEqual([
            { id: "jwt", name: "Acme SSO", type: "browser", url: LOGIN_URL },
        ]);
        const [method] = team.authenticationMethods({
            redirectUri: "happy://auth/callback",
            state: "k3v9",
        });
        const url = new URL(method!.url);
        expect(url.origin + url.pathname).toBe("https://sso.acme.example/happy/login");
        expect(url.searchParams.get("tenant")).toBe("acme");
        expect(url.searchParams.getAll("state")).toEqual(["k3v9"]);
        expect(url.searchParams.get("redirect_uri")).toBe("happy://auth/callback");
        const [withoutState] = team.authenticationMethods({ redirectUri: "happy://auth" });
        expect(new URL(withoutState!.url).searchParams.has("state")).toBe(false);
    });

    it("refuses to start without a long enough shared secret", () => {
        expect(() => createJwtTeam(null)).toThrow("HAPPY_TEAM_JWT_SECRET");
        expect(() => createJwtTeam(new TextEncoder().encode("too-short"))).toThrow(
            "at least 32 bytes",
        );
    });
});

describe("team identity migration", () => {
    it("keeps existing WorkOS users and photos while re-keying identities", async () => {
        const team = createJwtTeam();
        const index = team.migrations.findIndex(
            ([key]) => key === TEAM_USER_IDENTITIES_MIGRATION_KEY,
        );
        const database = moduleDatabase(team.migrations.slice(0, index), "team-jwt-migration");
        await database.ready;
        try {
            const bytes = new Uint8Array([1, 2, 3]);
            const hash = createHash("sha256").update(bytes).digest("hex");
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_team_users
                    (id, workos_user_id, first_name, last_name, is_owner, email, profile_version,
                        created_at, updated_at)
                    VALUES ('userone', 'user_01OWNER', 'Ada', NULL, 1, NULL,
                        '01991f3a-5c1e-7000-8000-2f9a1b3c4d5e', 1, 2)`,
            );
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_team_user_photos
                    (user_id, photo_bytes, content_type, content_hash, thumbhash, width, height)
                    VALUES ('userone', ${bytes}, 'image/webp', ${hash}, 'abcd', 1, 1)`,
            );

            await team.migrations[index]![1](database.context, database.database);

            const [user] = await team.listUsers(database.context);
            expect(user).toMatchObject({
                authentication: "workos",
                firstName: "Ada",
                id: "userone",
                isOwner: true,
                photo: { contentHash: hash },
                subject: "user_01OWNER",
            });
            expect((await team.getUserPhoto(database.context, "userone"))?.bytes).toEqual(bytes);
            const leftovers = await agentDatabaseRows<{ name: string }>(
                database.database,
                sql`SELECT name FROM sqlite_master WHERE name LIKE '%_previous'`,
            );
            expect(leftovers).toEqual([]);
        } finally {
            database.close();
        }
    });
});

function createJwtTeam(secret: Uint8Array | null = SECRET): TeamModule {
    return new TeamModule(
        {
            configuration: {
                values: {
                    feature: {
                        team: {
                            authentication: "jwt",
                            enabled: true,
                            host: "127.0.0.1",
                            jwt: {
                                algorithms: ["HS256"],
                                audience: AUDIENCE,
                                issuer: ISSUER,
                                key: { env: "HAPPY_TEAM_JWT_SECRET", type: "secret" },
                                loginUrl: LOGIN_URL,
                                name: "Acme SSO",
                                userIdClaim: "sub",
                            },
                            ownerUserId: "owner-1",
                            port: 3_000,
                            workosClientId: "client_test123",
                        },
                    },
                },
            },
            teamJwtSecret: secret ?? undefined,
        } as never,
        testProfileModule(),
    );
}
