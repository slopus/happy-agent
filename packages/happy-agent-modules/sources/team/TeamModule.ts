import { createHash } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { ConfigModule } from "../config/index.js";
import type { ProfileModule, ProfilePhotoContentType } from "../profile/index.js";
import { createTeamUserVersion } from "./createTeamUserVersion.js";
import { TeamAuthenticationError } from "./TeamAuthenticationError.js";
import { teamIdentity, withTeamIdentity, withTeamUser } from "./TeamContext.js";
import { TeamProfileInputError } from "./TeamProfileInputError.js";
import { TeamProfileVersionConflictError } from "./TeamProfileVersionConflictError.js";
import {
    createTeamUserInputSchema,
    preprocessedTeamUserPhotoSchema,
    teamUserPhotoAssetSchema,
    teamUserSchema,
    teamUserVersionSchema,
    updateTeamProfileInputSchema,
    type CreateTeamUserInput,
    type PreprocessedTeamUserPhoto,
    type TeamUser,
    type TeamUserPhotoAsset,
    type UpdateTeamProfileInput,
} from "./TeamUser.js";
import { WorkOSAccessTokenVerifier } from "./WorkOSAccessTokenVerifier.js";

export const TEAM_USERS_MIGRATION_KEY = "001-users";
export const TEAM_USER_PHOTOS_MIGRATION_KEY = "002-user-photos";
export const TEAM_USER_PROFILE_FIELDS_MIGRATION_KEY = "003-profile-fields";
/** Stable optimistic version exposed before an organization member has a durable local user. */
export const TEAM_ONBOARDING_PROFILE_VERSION = "00000000-0000-7000-8000-00000020eab6";

const USERS_TABLE = "happy_agent_team_users";
const USER_PHOTOS_TABLE = "happy_agent_team_user_photos";

const storedUserRowSchema = Type.Object(
    {
        content_hash: Type.Union([Type.String(), Type.Null()]),
        created_at: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        email: Type.Union([Type.String(), Type.Null()]),
        first_name: Type.String(),
        height: Type.Union([Type.Integer(), Type.Null()]),
        id: Type.String(),
        is_owner: Type.Integer({ maximum: 1, minimum: 0 }),
        last_name: Type.Union([Type.String(), Type.Null()]),
        profile_version: Type.String(),
        thumbhash: Type.Union([Type.String(), Type.Null()]),
        updated_at: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        width: Type.Union([Type.Integer(), Type.Null()]),
        workos_user_id: Type.String(),
    },
    { additionalProperties: false },
);

const storedPhotoRowSchema = Type.Object(
    {
        content_hash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        content_type: Type.Literal("image/webp"),
        height: Type.Integer({ maximum: 512, minimum: 1 }),
        photo_bytes: Type.Uint8Array({ maxByteLength: 8 * 1024 * 1024, minByteLength: 1 }),
        thumbhash: Type.String({ maxLength: 128, minLength: 4 }),
        width: Type.Integer({ maximum: 512, minimum: 1 }),
    },
    { additionalProperties: false },
);

export interface TeamUserProfileChangedEvent {
    readonly previousVersion: string | null;
    readonly user: TeamUser;
}

export type TeamUserProfileChangedListener = (
    ctx: Context,
    event: TeamUserProfileChangedEvent,
) => void | Promise<void>;

/** Team deployment identity, membership, WorkOS authentication, and durable user storage. */
export class TeamModule<Database extends AgentDatabase = AgentDatabase> implements AgentModule<
    never,
    Database
> {
    readonly name = "team";
    readonly migrations: readonly AgentModuleMigration<Database>[] = [
        [
            TEAM_USERS_MIGRATION_KEY,
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(USERS_TABLE)} (
                        id TEXT PRIMARY KEY,
                        workos_user_id TEXT NOT NULL UNIQUE,
                        first_name TEXT NOT NULL,
                        last_name TEXT,
                        is_owner INTEGER NOT NULL CHECK (is_owner IN (0, 1))
                    )`,
                );
            },
        ],
        [
            TEAM_USER_PHOTOS_MIGRATION_KEY,
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(USER_PHOTOS_TABLE)} (
                        user_id TEXT PRIMARY KEY REFERENCES ${sql.raw(USERS_TABLE)} (id)
                            ON DELETE CASCADE,
                        photo_bytes BLOB NOT NULL,
                        content_type TEXT NOT NULL CHECK (content_type = 'image/webp'),
                        content_hash TEXT NOT NULL,
                        thumbhash TEXT NOT NULL,
                        width INTEGER NOT NULL,
                        height INTEGER NOT NULL
                    )`,
                );
            },
        ],
        [
            TEAM_USER_PROFILE_FIELDS_MIGRATION_KEY,
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql`ALTER TABLE ${sql.raw(USERS_TABLE)} ADD COLUMN email TEXT`,
                );
                await agentDatabaseRun(
                    database,
                    sql`ALTER TABLE ${sql.raw(USERS_TABLE)} ADD COLUMN profile_version TEXT`,
                );
                await agentDatabaseRun(
                    database,
                    sql`ALTER TABLE ${sql.raw(USERS_TABLE)} ADD COLUMN created_at INTEGER`,
                );
                await agentDatabaseRun(
                    database,
                    sql`ALTER TABLE ${sql.raw(USERS_TABLE)} ADD COLUMN updated_at INTEGER`,
                );
                const rows = await agentDatabaseRows<{ readonly id: string }>(
                    database,
                    sql`SELECT id FROM ${sql.raw(USERS_TABLE)} ORDER BY id`,
                );
                for (const row of rows) {
                    const now = Date.now();
                    await agentDatabaseRun(
                        database,
                        sql`UPDATE ${sql.raw(USERS_TABLE)}
                            SET profile_version = ${createTeamUserVersion()},
                                created_at = ${now},
                                updated_at = ${now}
                            WHERE id = ${row.id}`,
                    );
                }
            },
        ],
    ] as readonly AgentModuleMigration<Database>[];

    readonly #config: ConfigModule;
    readonly #listeners = new Set<TeamUserProfileChangedListener>();
    readonly #ownerWorkOSUserId: string | undefined;
    readonly #profile: ProfileModule;
    readonly #tokens: WorkOSAccessTokenVerifier | undefined;

    constructor(config: ConfigModule, profile: ProfileModule) {
        this.#config = config;
        this.#profile = profile;
        const team = config.configuration.values.feature.team;
        this.#ownerWorkOSUserId = team.ownerWorkOSUserId;
        if (!team.enabled) {
            this.#tokens = undefined;
            return;
        }
        if (team.workosOrganizationId === undefined) {
            throw new Error(
                "Team mode requires feature.team.workos_organization_id in the global configuration.",
            );
        }
        if (team.ownerWorkOSUserId === undefined) {
            throw new Error(
                "Team mode requires feature.team.owner_workos_user_id in the global configuration.",
            );
        }
        this.#tokens = new WorkOSAccessTokenVerifier({
            clientId: team.workosClientId,
            organizationId: team.workosOrganizationId,
        });
    }

    get enabled(): boolean {
        return this.#config.configuration.values.feature.team.enabled;
    }

    /** Watch durable user-profile changes after their transaction commits. */
    onProfileUpdated(listener: TeamUserProfileChangedListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Verify one organization member without consulting local user storage. */
    async authenticateIdentity(
        ctx: Context,
        authorization: string | readonly string[] | undefined,
    ): Promise<Context> {
        const accessToken = bearerToken(authorization);
        const tokens = this.#tokens;
        if (!this.enabled || tokens === undefined || accessToken === undefined) {
            throw new TeamAuthenticationError();
        }
        try {
            const identity = await tokens.verify(accessToken);
            return withTeamIdentity(ctx, {
                organizationId: identity.organizationId,
                workosUserId: identity.userId,
            });
        } catch {
            throw new TeamAuthenticationError();
        }
    }

    /** Authenticate an organization member, whether or not they have onboarded locally yet. */
    async authenticate(
        ctx: Context,
        authorization: string | readonly string[] | undefined,
    ): Promise<Context> {
        let requestCtx = await this.authenticateIdentity(ctx, authorization);
        const identity = this.#requireIdentity(requestCtx);
        const user = await this.findUserByWorkOSUserId(requestCtx, identity.workosUserId);
        if (user !== undefined) requestCtx = withTeamUser(requestCtx, user);
        return requestCtx;
    }

    async currentUser(ctx: Context): Promise<TeamUser | undefined> {
        const identity = teamIdentity(ctx);
        if (identity === undefined) return undefined;
        return await this.findUserByWorkOSUserId(ctx, identity.workosUserId);
    }

    /** Create one durable team member, deriving owner status only from deployment config. */
    async createUser(ctx: Context, input: CreateTeamUserInput): Promise<TeamUser> {
        if (!Value.Check(createTeamUserInputSchema, input)) {
            throw new TeamProfileInputError("The team user is not valid.");
        }
        const now = Date.now();
        const user: TeamUser = {
            createdAt: now,
            email: input.email ?? null,
            firstName: input.firstName,
            id: createId(),
            isOwner: input.workosUserId === this.#requireOwnerWorkOSUserId(),
            lastName: input.lastName ?? null,
            photo: null,
            updatedAt: now,
            version: createTeamUserVersion(),
            workosUserId: input.workosUserId,
        };
        return await ctx.inTx(async (txCtx) => {
            await this.#insertUser(txCtx, user);
            this.#publish(txCtx, { previousVersion: null, user });
            return user;
        });
    }

    /** Save the authenticated member through the existing name/email profile contract. */
    async updateCurrentProfile(
        ctx: Context,
        input: UpdateTeamProfileInput,
        expectedVersion: string,
    ): Promise<TeamUser> {
        if (
            !Value.Check(updateTeamProfileInputSchema, input) ||
            !Value.Check(teamUserVersionSchema, expectedVersion)
        ) {
            throw new TeamProfileInputError("The profile update is not valid.");
        }
        const name = input.name;
        if (name === null) {
            throw new TeamProfileInputError("A team profile must keep a name.");
        }
        const identity = this.#requireIdentity(ctx);
        return await ctx.inTx(async (txCtx) => {
            const current = await this.findUserByWorkOSUserId(txCtx, identity.workosUserId);
            if (current === undefined) {
                if (expectedVersion !== TEAM_ONBOARDING_PROFILE_VERSION) {
                    throw new TeamProfileInputError("The onboarding profile version is invalid.");
                }
                if (name === undefined) {
                    throw new TeamProfileInputError("A name is required to create a team profile.");
                }
                const parsed = splitProfileName(name);
                const now = Date.now();
                const created: TeamUser = {
                    createdAt: now,
                    email: input.email ?? null,
                    firstName: parsed.firstName,
                    id: createId(),
                    isOwner: identity.workosUserId === this.#requireOwnerWorkOSUserId(),
                    lastName: parsed.lastName,
                    photo: null,
                    updatedAt: now,
                    version: createTeamUserVersion(),
                    workosUserId: identity.workosUserId,
                };
                await this.#insertUser(txCtx, created);
                this.#publish(txCtx, { previousVersion: null, user: created });
                return created;
            }
            this.#assertExpectedVersion(current, expectedVersion);
            const parsed = name === undefined ? undefined : splitProfileName(name);
            const updated: TeamUser = {
                ...current,
                ...(input.email === undefined ? {} : { email: input.email }),
                ...(parsed === undefined
                    ? {}
                    : { firstName: parsed.firstName, lastName: parsed.lastName }),
                updatedAt: Date.now(),
                version: createTeamUserVersion(current.version),
            };
            await this.#writeUser(txCtx, updated);
            this.#publish(txCtx, { previousVersion: current.version, user: updated });
            return updated;
        });
    }

    async getUser(ctx: Context, userId: string): Promise<TeamUser | undefined> {
        return (await this.#readUsers(ctx, sql`u.id = ${userId}`))[0];
    }

    async findUserByWorkOSUserId(
        ctx: Context,
        workosUserId: string,
    ): Promise<TeamUser | undefined> {
        return (await this.#readUsers(ctx, sql`u.workos_user_id = ${workosUserId}`))[0];
    }

    async listUsers(ctx: Context): Promise<readonly TeamUser[]> {
        return await this.#readUsers(ctx);
    }

    /** Store already-normalized media for module callers that already own preprocessing. */
    async putUserPhoto(
        ctx: Context,
        userId: string,
        photo: PreprocessedTeamUserPhoto,
    ): Promise<TeamUser | undefined> {
        if (!Value.Check(preprocessedTeamUserPhotoSchema, photo)) {
            throw new TeamProfileInputError("The team user photo is not valid.");
        }
        return await this.#replaceUserPhoto(ctx, userId, photo);
    }

    /** Normalize and replace the authenticated member's photo. */
    async putCurrentUserPhoto(
        ctx: Context,
        bytes: Uint8Array,
        contentType: ProfilePhotoContentType,
        expectedVersion: string,
    ): Promise<TeamUser> {
        const identity = this.#requireIdentity(ctx);
        const user = await this.findUserByWorkOSUserId(ctx, identity.workosUserId);
        if (user === undefined) throw new TeamAuthenticationError();
        const normalized = await this.#profile.normalizePhoto(bytes, contentType);
        const updated = await this.#replaceUserPhoto(ctx, user.id, normalized, expectedVersion);
        if (updated === undefined) throw new TeamAuthenticationError();
        return updated;
    }

    async getCurrentUserPhoto(ctx: Context): Promise<TeamUserPhotoAsset | undefined> {
        const user = await this.currentUser(ctx);
        return user === undefined ? undefined : await this.getUserPhoto(ctx, user.id);
    }

    async deleteCurrentUserPhoto(ctx: Context, expectedVersion: string): Promise<TeamUser> {
        const identity = this.#requireIdentity(ctx);
        return await ctx.inTx(async (txCtx) => {
            const current = await this.findUserByWorkOSUserId(txCtx, identity.workosUserId);
            if (current === undefined) throw new TeamAuthenticationError();
            this.#assertExpectedVersion(current, expectedVersion);
            if (current.photo === null) return current;
            await agentDatabaseRun(
                txCtx.db,
                sql`DELETE FROM ${sql.raw(USER_PHOTOS_TABLE)} WHERE user_id = ${current.id}`,
            );
            const updated: TeamUser = {
                ...current,
                photo: null,
                updatedAt: Date.now(),
                version: createTeamUserVersion(current.version),
            };
            await this.#writeUser(txCtx, updated);
            this.#publish(txCtx, { previousVersion: current.version, user: updated });
            return updated;
        });
    }

    async getUserPhoto(ctx: Context, userId: string): Promise<TeamUserPhotoAsset | undefined> {
        const row = (
            await agentDatabaseRows<unknown>(
                ctx.db,
                sql`SELECT photo_bytes, content_type, content_hash, thumbhash, width, height
                    FROM ${sql.raw(USER_PHOTOS_TABLE)}
                    WHERE user_id = ${userId}`,
            )
        )[0];
        if (row === undefined) return undefined;
        const record = row as Record<string, unknown>;
        const stored = {
            ...record,
            photo_bytes:
                record["photo_bytes"] instanceof ArrayBuffer
                    ? new Uint8Array(record["photo_bytes"])
                    : record["photo_bytes"],
        };
        if (!Value.Check(storedPhotoRowSchema, stored)) {
            throw new Error("The stored team user photo is invalid.");
        }
        const bytes = new Uint8Array(stored.photo_bytes);
        if (createHash("sha256").update(bytes).digest("hex") !== stored.content_hash) {
            throw new Error("The stored team user photo does not match its content hash.");
        }
        const photo: TeamUserPhotoAsset = {
            bytes,
            contentHash: stored.content_hash,
            contentType: stored.content_type,
            etag: `"${stored.content_hash}"`,
            height: stored.height,
            thumbhash: stored.thumbhash,
            width: stored.width,
        };
        if (!Value.Check(teamUserPhotoAssetSchema, photo)) {
            throw new Error("The stored team user photo is invalid.");
        }
        return photo;
    }

    async #replaceUserPhoto(
        ctx: Context,
        userId: string,
        photo: PreprocessedTeamUserPhoto,
        expectedVersion?: string,
    ): Promise<TeamUser | undefined> {
        const contentHash = createHash("sha256").update(photo.bytes).digest("hex");
        return await ctx.inTx(async (txCtx) => {
            const current = await this.getUser(txCtx, userId);
            if (current === undefined) return undefined;
            if (expectedVersion !== undefined)
                this.#assertExpectedVersion(current, expectedVersion);
            await agentDatabaseRun(
                txCtx.db,
                sql`INSERT INTO ${sql.raw(USER_PHOTOS_TABLE)}
                    (user_id, photo_bytes, content_type, content_hash, thumbhash, width, height)
                    VALUES (
                        ${userId},
                        ${photo.bytes},
                        ${photo.contentType},
                        ${contentHash},
                        ${photo.thumbhash},
                        ${photo.width},
                        ${photo.height}
                    )
                    ON CONFLICT (user_id) DO UPDATE SET
                        photo_bytes = EXCLUDED.photo_bytes,
                        content_type = EXCLUDED.content_type,
                        content_hash = EXCLUDED.content_hash,
                        thumbhash = EXCLUDED.thumbhash,
                        width = EXCLUDED.width,
                        height = EXCLUDED.height`,
            );
            const updated: TeamUser = {
                ...current,
                photo: {
                    contentHash,
                    height: photo.height,
                    thumbhash: photo.thumbhash,
                    width: photo.width,
                },
                updatedAt: Date.now(),
                version: createTeamUserVersion(current.version),
            };
            await this.#writeUser(txCtx, updated);
            this.#publish(txCtx, { previousVersion: current.version, user: updated });
            return updated;
        });
    }

    async #insertUser(ctx: Context, user: TeamUser): Promise<void> {
        if (!Value.Check(teamUserSchema, user)) throw new Error("The team user is not valid.");
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(USERS_TABLE)}
                (id, workos_user_id, first_name, last_name, is_owner, email,
                    profile_version, created_at, updated_at)
                VALUES (
                    ${user.id},
                    ${user.workosUserId},
                    ${user.firstName},
                    ${user.lastName},
                    ${user.isOwner ? 1 : 0},
                    ${user.email},
                    ${user.version},
                    ${user.createdAt},
                    ${user.updatedAt}
                )`,
        );
    }

    async #writeUser(ctx: Context, user: TeamUser): Promise<void> {
        if (!Value.Check(teamUserSchema, user)) throw new Error("The team user is not valid.");
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(USERS_TABLE)}
                SET first_name = ${user.firstName},
                    last_name = ${user.lastName},
                    email = ${user.email},
                    profile_version = ${user.version},
                    updated_at = ${user.updatedAt}
                WHERE id = ${user.id}`,
        );
    }

    async #readUsers(ctx: Context, predicate = sql`1 = 1`): Promise<readonly TeamUser[]> {
        const rows = await agentDatabaseRows<unknown>(
            ctx.db,
            sql`SELECT
                    u.id,
                    u.workos_user_id,
                    u.first_name,
                    u.last_name,
                    u.is_owner,
                    u.email,
                    u.profile_version,
                    u.created_at,
                    u.updated_at,
                    p.content_hash,
                    p.thumbhash,
                    p.width,
                    p.height
                FROM ${sql.raw(USERS_TABLE)} u
                LEFT JOIN ${sql.raw(USER_PHOTOS_TABLE)} p ON p.user_id = u.id
                WHERE ${predicate}
                ORDER BY u.id`,
        );
        return rows.map((value) => {
            if (!Value.Check(storedUserRowSchema, value)) {
                throw new Error("A stored team user is invalid.");
            }
            const photo =
                value.content_hash === null ||
                value.thumbhash === null ||
                value.width === null ||
                value.height === null
                    ? null
                    : {
                          contentHash: value.content_hash,
                          height: value.height,
                          thumbhash: value.thumbhash,
                          width: value.width,
                      };
            const user: TeamUser = {
                createdAt: value.created_at,
                email: value.email,
                firstName: value.first_name,
                id: value.id,
                isOwner: value.is_owner === 1,
                lastName: value.last_name,
                photo,
                updatedAt: value.updated_at,
                version: value.profile_version,
                workosUserId: value.workos_user_id,
            };
            if (!Value.Check(teamUserSchema, user)) {
                throw new Error("A stored team user is invalid.");
            }
            return user;
        });
    }

    #assertExpectedVersion(user: TeamUser, expectedVersion: string): void {
        if (user.version !== expectedVersion) throw new TeamProfileVersionConflictError(user);
    }

    #requireIdentity(ctx: Context): NonNullable<ReturnType<typeof teamIdentity>> {
        const identity = teamIdentity(ctx);
        if (identity === undefined) throw new TeamAuthenticationError();
        return identity;
    }

    #requireOwnerWorkOSUserId(): string {
        if (this.#ownerWorkOSUserId === undefined) {
            throw new Error("The team owner WorkOS user ID is not configured.");
        }
        return this.#ownerWorkOSUserId;
    }

    #publish(ctx: Context, event: TeamUserProfileChangedEvent): void {
        const frozen = deepFreeze(structuredClone(event)) as TeamUserProfileChangedEvent;
        afterCommit(ctx, async (eventCtx) => {
            const listeners = Array.from(this.#listeners);
            for (const listener of listeners) {
                try {
                    await listener(eventCtx, frozen);
                } catch (error: unknown) {
                    eventCtx.log.error(
                        "A team profile subscriber failed.",
                        { userId: frozen.user.id },
                        error,
                    );
                }
            }
        });
    }
}

function bearerToken(authorization: string | readonly string[] | undefined): string | undefined {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
        return undefined;
    }
    const token = authorization.slice("Bearer ".length);
    return token.length === 0 ? undefined : token;
}

function splitProfileName(name: string): {
    readonly firstName: string;
    readonly lastName: string | null;
} {
    const parts = name.trim().split(/\s+/u);
    const firstName = parts.shift();
    if (firstName === undefined || firstName.length === 0) {
        throw new TeamProfileInputError("A team profile must have a first name.");
    }
    const lastName = parts.join(" ");
    return { firstName, lastName: lastName.length === 0 ? null : lastName };
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}
