import { createHash } from "node:crypto";

import {
    createLocalJWKSet,
    exportJWK,
    generateKeyPair,
    SignJWT,
    type CryptoKey,
    type JWK,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    TEAM_ONBOARDING_PROFILE_VERSION,
    TeamAuthenticationError,
    TeamModule,
    teamIdentity,
    teamUser,
    WorkOSAccessTokenVerifier,
} from "../../sources/team/index.js";
import { ProfileModule } from "../../sources/profile/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const CLIENT_ID = "client_test123";
const ISSUER = `https://api.workos.com/user_management/${CLIENT_ID}`;
const ORGANIZATION_ID = "org_01TESTORG123";
const WORKOS_USER_ID = "user_01TESTUSER123";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("TeamModule", () => {
    it("migrates an empty user database without seeding a user or owner", async () => {
        const team = createTeam();
        const database = moduleDatabase(team.migrations, "team-empty");
        await database.ready;

        await expect(team.listUsers(database.context)).resolves.toEqual([]);

        database.close();
    });

    it("stores users by CUID2 and unique WorkOS user ID with preprocessed photos", async () => {
        const team = createTeam();
        const database = moduleDatabase(team.migrations, "team-users");
        await database.ready;

        const created = await team.createUser(database.context, {
            firstName: "Ada",
            lastName: "Lovelace",
            workosUserId: WORKOS_USER_ID,
        });
        expect(created).toMatchObject({
            firstName: "Ada",
            isOwner: true,
            lastName: "Lovelace",
            photo: null,
            workosUserId: WORKOS_USER_ID,
        });
        expect(created.id).toMatch(/^[a-z][a-z0-9]+$/);
        await expect(
            team.findUserByWorkOSUserId(database.context, WORKOS_USER_ID),
        ).resolves.toEqual(created);

        const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
        const withPhoto = await team.putUserPhoto(database.context, created.id, {
            bytes,
            contentType: "image/webp",
            height: 128,
            thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j3A",
            width: 128,
        });
        expect(withPhoto?.photo).toEqual({
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            height: 128,
            thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j3A",
            width: 128,
        });
        await expect(team.getUserPhoto(database.context, created.id)).resolves.toEqual({
            bytes,
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            contentType: "image/webp",
            etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
            height: 128,
            thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j3A",
            width: 128,
        });
        await expect(
            team.createUser(database.context, {
                firstName: "Augusta",
                workosUserId: WORKOS_USER_ID,
            }),
        ).rejects.toThrow();

        database.close();
    });

    it("authenticates an organization member before and after local onboarding", async () => {
        const { privateKey, jwk } = await signingKey();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ keys: [jwk] })),
        );
        const team = createTeam();
        const database = moduleDatabase(team.migrations, "team-authentication");
        await database.ready;
        const accessToken = await signAccessToken(privateKey, WORKOS_USER_ID);

        const onboarding = await team.authenticate(database.context, `Bearer ${accessToken}`);
        expect(teamIdentity(onboarding)).toEqual({
            organizationId: ORGANIZATION_ID,
            workosUserId: WORKOS_USER_ID,
        });
        expect(teamUser(onboarding)).toBeUndefined();

        const user = await team.createUser(database.context, {
            firstName: "Ada",
            workosUserId: WORKOS_USER_ID,
        });
        const authenticated = await team.authenticate(database.context, `Bearer ${accessToken}`);
        expect(teamUser(authenticated)).toEqual(user);
        await expect(
            team.authenticate(database.context, "Bearer malformed"),
        ).rejects.toBeInstanceOf(TeamAuthenticationError);

        database.close();
    });

    it("creates the owner from the first profile save and parses the combined name", async () => {
        const { privateKey, jwk } = await signingKey();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ keys: [jwk] })),
        );
        const team = createTeam();
        const database = moduleDatabase(team.migrations, "team-profile-onboarding");
        await database.ready;
        const request = await team.authenticate(
            database.context,
            `Bearer ${await signAccessToken(privateKey, WORKOS_USER_ID)}`,
        );

        await expect(
            team.updateCurrentProfile(
                request,
                { email: "ada@example.com" },
                TEAM_ONBOARDING_PROFILE_VERSION,
            ),
        ).rejects.toThrow("A name is required");

        const created = await team.updateCurrentProfile(
            request,
            { email: "ada@example.com", name: "Ada Lovelace Byron" },
            TEAM_ONBOARDING_PROFILE_VERSION,
        );

        expect(created).toMatchObject({
            email: "ada@example.com",
            firstName: "Ada",
            isOwner: true,
            lastName: "Lovelace Byron",
            workosUserId: WORKOS_USER_ID,
        });
        expect(created.id).toMatch(/^[a-z][a-z0-9]+$/);
        expect(created.version).not.toBe(TEAM_ONBOARDING_PROFILE_VERSION);
        await expect(
            team.updateCurrentProfile(request, { name: null }, created.version),
        ).rejects.toThrow("must keep a name");

        database.close();
    });
});

describe("WorkOSAccessTokenVerifier", () => {
    it("requires the WorkOS issuer, client, session, subject, and RS256 signature", async () => {
        const { privateKey, jwk } = await signingKey();
        const verifier = new WorkOSAccessTokenVerifier({
            clientId: CLIENT_ID,
            issuer: ISSUER,
            jwks: createLocalJWKSet({ keys: [jwk] }),
            organizationId: ORGANIZATION_ID,
        });

        await expect(
            verifier.verify(await signAccessToken(privateKey, WORKOS_USER_ID)),
        ).resolves.toEqual({ organizationId: ORGANIZATION_ID, userId: WORKOS_USER_ID });
        await expect(
            verifier.verify(
                await signAccessToken(privateKey, WORKOS_USER_ID, {
                    clientId: "client_other123",
                }),
            ),
        ).rejects.toThrow();
        await expect(
            verifier.verify(
                await signAccessToken(privateKey, WORKOS_USER_ID, {
                    organizationId: "org_other123",
                }),
            ),
        ).rejects.toThrow();
    });
});

function createTeam(): TeamModule {
    return new TeamModule(
        {
            configuration: {
                values: {
                    feature: {
                        team: {
                            enabled: true,
                            host: "127.0.0.1",
                            ownerWorkOSUserId: WORKOS_USER_ID,
                            port: 3_000,
                            workosClientId: CLIENT_ID,
                            workosOrganizationId: ORGANIZATION_ID,
                        },
                    },
                },
            },
        } as never,
        new ProfileModule(),
    );
}

async function signingKey(): Promise<{
    readonly privateKey: CryptoKey;
    readonly jwk: JWK;
}> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    return {
        privateKey,
        jwk: { ...(await exportJWK(publicKey)), alg: "RS256", kid: "team-test", use: "sig" },
    };
}

async function signAccessToken(
    privateKey: CryptoKey,
    subject: string,
    options: { readonly clientId?: string; readonly organizationId?: string } = {},
): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    return await new SignJWT({
        client_id: options.clientId ?? CLIENT_ID,
        org_id: options.organizationId ?? ORGANIZATION_ID,
        sid: "session_01TEST123",
    })
        .setProtectedHeader({ alg: "RS256", kid: "team-test" })
        .setIssuer(ISSUER)
        .setSubject(subject)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
}
