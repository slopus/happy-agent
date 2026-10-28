import { createHash } from "node:crypto";

import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
    TEAM_GUESTS_MIGRATION_KEY,
    TEAM_ONBOARDING_PROFILE_VERSION,
    TeamAuthenticationError,
    TeamModule,
    isTeamGuest,
    teamIdentity,
    teamUser,
    withTeamIdentity,
    type TeamUserProfileChangedEvent,
} from "../../sources/team/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { testProfileModule } from "../support/testProfileModule.js";

const ISSUER = "https://sso.acme.example";
const AUDIENCE = "happy-agent";
const SECRET = new TextEncoder().encode("a-very-long-shared-secret-of-at-least-32-bytes");

async function sign(subject: string): Promise<string> {
    return await new SignJWT({ sub: subject })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(SECRET);
}

function createTeam(enabled: boolean): TeamModule {
    return new TeamModule(
        {
            configuration: {
                values: {
                    feature: {
                        team: enabled
                            ? {
                                  authentication: "jwt",
                                  enabled: true,
                                  host: "127.0.0.1",
                                  jwt: {
                                      algorithms: ["HS256"],
                                      audience: AUDIENCE,
                                      issuer: ISSUER,
                                      key: { env: "HAPPY_TEAM_JWT_SECRET", type: "secret" },
                                      authorizationUrl: "https://sso.acme.example/authorize",
                                      clientId: "happy",
                                      name: "Acme SSO",
                                      tokenUrl: "https://sso.acme.example/token",
                                      userIdClaim: "sub",
                                  },
                                  ownerUserId: "owner-1",
                                  port: 3_000,
                              }
                            : { authentication: "workos", enabled: false },
                    },
                },
            },
            teamJwtSecret: SECRET,
        } as never,
        testProfileModule(),
    );
}

async function setup(enabled: boolean, name: string) {
    const team = createTeam(enabled);
    const database = moduleDatabase(team.migrations, name);
    await database.ready;
    const events: TeamUserProfileChangedEvent[] = [];
    team.onProfileUpdated((_ctx, event) => {
        events.push(event);
    });
    return { team, database, events };
}

describe("team guests", () => {
    it("are stored in standalone mode as people who are never the owner, without announcing them", async () => {
        const { team, database, events } = await setup(false, "team-guest-standalone");
        try {
            const guest = await team.createGuest(database.context, { name: "Ada  Lovelace" });
            expect(guest).toMatchObject({
                authentication: "guest",
                email: null,
                firstName: "Ada",
                isOwner: false,
                lastName: "Lovelace",
                photo: null,
            });
            expect(isTeamGuest(guest)).toBe(true);
            // The identity is opaque: nothing a chat service or sign-in method issues.
            expect(guest.subject).toMatch(/^[a-z0-9]{20,32}$/);
            expect(guest.subject).not.toBe(guest.id);
            expect(await team.getUsers(database.context, [guest.id])).toEqual([guest]);
            expect(await team.listUsers(database.context)).toEqual([guest]);
            expect(await team.listMembers(database.context)).toEqual([]);
            const renamed = await team.renameGuest(database.context, guest.id, { name: "Ada" });
            expect(renamed).toMatchObject({ firstName: "Ada", lastName: null });
            expect(renamed!.version).not.toBe(guest.version);
            await Promise.resolve();
            expect(events).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("keep only the characters a profile name may hold", async () => {
        const { team, database } = await setup(false, "team-guest-names");
        try {
            const named = async (name: string) => {
                const guest = await team.createGuest(database.context, { name });
                return [guest.firstName, guest.lastName];
            };
            expect(await named("Ada\u0000\u202eLovelace")).toEqual(["Ada", "Lovelace"]);
            expect(await named("\u200b\n\t ")).toEqual(["Guest", null]);
            // Each part keeps at most 128 UTF-16 units, never half a character.
            expect(await named(`${"😀".repeat(70)} Lovelace`)).toEqual([
                "😀".repeat(64),
                "Lovelace",
            ]);
            expect(await named(`Ada ${"x".repeat(200)}`)).toEqual(["Ada", "x".repeat(128)]);
            await expect(team.createGuest(database.context, { name: "" })).rejects.toThrow(
                "The guest is not valid.",
            );
        } finally {
            database.close();
        }
    });

    it("are announced in team mode, and renaming never touches a member", async () => {
        const { team, database, events } = await setup(true, "team-guest-team");
        try {
            const guest = await team.createGuest(database.context, { name: "Grace Hopper" });
            const member = await team.createUser(database.context, {
                firstName: "Owner",
                authentication: "jwt",
                subject: "owner-1",
            });
            await vi.waitFor(() => expect(events).toHaveLength(2));
            expect(events[0]).toMatchObject({ previousVersion: null, user: { id: guest.id } });
            expect(
                await team.renameGuest(database.context, guest.id, { name: "Grace Hopper" }),
            ).toEqual(guest);
            expect(
                await team.renameGuest(database.context, member.id, { name: "Mallory" }),
            ).toBeUndefined();
            expect((await team.getUser(database.context, member.id))?.firstName).toBe("Owner");
            await team.renameGuest(database.context, guest.id, { name: "Rear Admiral Hopper" });
            await vi.waitFor(() => expect(events).toHaveLength(3));
            expect(events[2]).toMatchObject({ previousVersion: guest.version });
            expect(await team.listMembers(database.context)).toEqual([member]);
        } finally {
            database.close();
        }
    });

    it("are accepted by no authentication path", async () => {
        const { team, database } = await setup(true, "team-guest-authentication");
        try {
            const guest = await team.createGuest(database.context, { name: "Ada" });

            // A valid token whose user ID is the guest's own opaque ID proves only a member
            // identity of the sign-in method, which onboards as a separate, new member.
            const forged = await team.authenticate(
                database.context,
                `Bearer ${await sign(guest.subject)}`,
            );
            expect(teamIdentity(forged)).toEqual({ authentication: "jwt", subject: guest.subject });
            expect(teamUser(forged)).toBeUndefined();
            expect(await team.currentUser(forged)).toBeUndefined();
            const member = await team.updateCurrentProfile(
                forged,
                { name: "Someone Else" },
                TEAM_ONBOARDING_PROFILE_VERSION,
            );
            expect(member.id).not.toBe(guest.id);
            expect(member.authentication).toBe("jwt");
            expect(await team.getUser(database.context, guest.id)).toEqual(guest);

            // Even an identity no verifier can produce does not resolve to the guest.
            const impossible = withTeamIdentity(database.context, {
                authentication: "guest" as never,
                subject: guest.subject,
            });
            expect(await team.currentUser(impossible)).toBeUndefined();
            await expect(team.getCurrentUserPhoto(impossible)).resolves.toBeUndefined();

            // Personal connections are for members only.
            expect(() => team.connectionContext(database.context, guest)).toThrow(
                TeamAuthenticationError,
            );

            // Malformed or missing credentials never fall back to anyone.
            for (const authorization of [undefined, "Bearer ", `Bearer ${guest.subject}`]) {
                await expect(
                    team.authenticate(database.context, authorization),
                ).rejects.toBeInstanceOf(TeamAuthenticationError);
            }
        } finally {
            database.close();
        }
    });

    it("exist without any sign-in method in standalone mode", async () => {
        const { team, database } = await setup(false, "team-guest-standalone-sign-in");
        try {
            const guest = await team.createGuest(database.context, { name: "Ada" });
            expect(team.authenticationMethods()).toEqual([]);
            for (const authorization of [`Bearer ${await sign(guest.subject)}`, undefined]) {
                await expect(
                    team.authenticateIdentity(database.context, authorization),
                ).rejects.toBeInstanceOf(TeamAuthenticationError);
            }
        } finally {
            database.close();
        }
    });
});

describe("team guest migration", () => {
    it("keeps existing members and photos while allowing guests that are never owners", async () => {
        const team = createTeam(true);
        const index = team.migrations.findIndex(([key]) => key === TEAM_GUESTS_MIGRATION_KEY);
        const database = moduleDatabase(team.migrations.slice(0, index), "team-guest-migration");
        await database.ready;
        try {
            const bytes = new Uint8Array([1, 2, 3]);
            const hash = createHash("sha256").update(bytes).digest("hex");
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_team_users
                    (id, authentication, subject, first_name, last_name, is_owner, email,
                        profile_version, created_at, updated_at)
                    VALUES ('userone', 'jwt', 'owner-1', 'Ada', NULL, 1, 'ada@acme.example',
                        '01991f3a-5c1e-7000-8000-2f9a1b3c4d5e', 1, 2)`,
            );
            await agentDatabaseRun(
                database.database,
                sql`INSERT INTO happy_agent_team_user_photos
                    (user_id, photo_bytes, content_type, content_hash, thumbhash, width, height)
                    VALUES ('userone', ${bytes}, 'image/webp', ${hash}, 'abcd', 1, 1)`,
            );
            const insertGuest = (id: string, owner: number) =>
                agentDatabaseRun(
                    database.database,
                    sql`INSERT INTO happy_agent_team_users
                        (id, authentication, subject, first_name, is_owner, profile_version,
                            created_at, updated_at)
                        VALUES (${id}, 'guest', ${id}, 'Guest', ${owner},
                            '01991f3a-5c1e-7000-8000-2f9a1b3c4d5f', 1, 1)`,
                );
            // The released schema has no room for a guest.
            await expect(insertGuest("guestzero", 0)).rejects.toThrow();

            await team.migrations[index]![1](database.context, database.database);
            // Later migrations run too, so the current queries find the columns they read.
            for (const [, migrate] of team.migrations.slice(index + 1))
                await migrate(database.context, database.database);

            const [member] = await team.listUsers(database.context);
            expect(member).toMatchObject({
                authentication: "jwt",
                email: "ada@acme.example",
                id: "userone",
                isOwner: true,
                photo: { contentHash: hash },
                subject: "owner-1",
            });
            expect((await team.getUserPhoto(database.context, "userone"))?.bytes).toEqual(bytes);
            await insertGuest("guestone", 0);
            await expect(insertGuest("guesttwo", 1)).rejects.toThrow();
            expect((await team.getUser(database.context, "guestone"))?.authentication).toBe(
                "guest",
            );
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
