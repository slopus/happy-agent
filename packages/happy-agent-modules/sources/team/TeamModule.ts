import { createHash, createPublicKey } from "node:crypto";

import { createId } from "@paralleldrive/cuid2";
import { userIdsSchema } from "@slopus/happy-agent-client";
import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { createRemoteJWKSet } from "jose";

import type { ConfigModule } from "../config/index.js";
import type { ProfileModule, ProfilePhotoContentType } from "../profile/index.js";
import { createTeamUserVersion } from "./createTeamUserVersion.js";
import { TeamAuthenticationError } from "./TeamAuthenticationError.js";
import { teamIdentity, withTeamIdentity, withTeamUser, type TeamIdentity } from "./TeamContext.js";
import { JwtAccessTokenVerifier } from "./JwtAccessTokenVerifier.js";
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
    type TeamAuthentication,
    type TeamUser,
    type TeamUserPhotoAsset,
    type UpdateTeamProfileInput,
} from "./TeamUser.js";
import { WorkOSAccessTokenVerifier } from "./WorkOSAccessTokenVerifier.js";
import { teamDraftInputSchema, type TeamDraft, type TeamDraftInput } from "./TeamDraft.js";
import { queryTeamUsers } from "./persistence/queryTeamUsers.js";
import { TEAM_DRAFTS_TABLE, queryTeamDraft, saveTeamDraft } from "./persistence/teamDrafts.js";
import { teamSenderNotifications } from "./impl/teamSenderNotifications.js";

export const TEAM_USERS_MIGRATION_KEY = "001-users";
export const TEAM_USER_PHOTOS_MIGRATION_KEY = "002-user-photos";
export const TEAM_USER_PROFILE_FIELDS_MIGRATION_KEY = "003-profile-fields";
export const TEAM_DRAFTS_MIGRATION_KEY = "004-drafts";
export const TEAM_USER_IDENTITIES_MIGRATION_KEY = "005-identities";
/** Stable optimistic version exposed before an organization member has a durable local user. */
export const TEAM_ONBOARDING_PROFILE_VERSION = "00000000-0000-7000-8000-00000020eab6";

const USERS_TABLE = "happy_agent_team_users";
const USER_PHOTOS_TABLE = "happy_agent_team_user_photos";

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

export interface TeamDraftUpdatedEvent {
    readonly agentId: string;
    readonly draft: TeamDraft;
    readonly userId: string;
}

/** A sign-in method a person completes in the system browser. */
export interface TeamBrowserAuthenticationMethod {
    readonly id: string;
    readonly name: string;
    readonly type: "browser";
    readonly url: string;
}

/** Where a browser sign-in result returns, supplied by the client. */
export interface TeamAuthenticationRedirect {
    readonly redirectUri: string;
    readonly state?: string;
}

/** Bearer tokens beyond this length are rejected before any verification work. */
const MAX_BEARER_TOKEN_LENGTH = 16_384;
/** Symmetric JWT secrets shorter than this are rejected at startup. */
const MIN_JWT_SECRET_BYTES = 32;

export type TeamDraftUpdatedListener = (
    ctx: Context,
    event: TeamDraftUpdatedEvent,
) => void | Promise<void>;

/** Team deployment identity, membership, WorkOS authentication, and durable user storage. */
export class TeamModule<Database extends AgentDatabase = AgentDatabase> implements AgentModule<
    never,
    Database
> {
    readonly name = "team";
    readonly beforeStart?: () => AgentModuleHooks<never, Database>;
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
        [
            TEAM_DRAFTS_MIGRATION_KEY,
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(TEAM_DRAFTS_TABLE)} (
                        agent_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        draft_json TEXT NOT NULL,
                        PRIMARY KEY (agent_id, user_id)
                    )`,
                );
                // The API module owned these rows first. Adopt them with plain SQL so unsent
                // drafts survive the move without deserializing a single payload; the runner's
                // per-migration transaction makes creation and copy one atomic step. The retired
                // table keeps its rows.
                const legacy = await agentDatabaseRows<unknown>(
                    database,
                    sql`SELECT name FROM sqlite_master
                        WHERE type = 'table' AND name = 'happy_agent_api_team_drafts'`,
                );
                if (legacy.length === 0) return;
                await agentDatabaseRun(
                    database,
                    sql`INSERT INTO ${sql.raw(TEAM_DRAFTS_TABLE)} (agent_id, user_id, draft_json)
                        SELECT agent_id, user_id, draft_json
                        FROM happy_agent_api_team_drafts WHERE true
                        ON CONFLICT (agent_id, user_id) DO NOTHING`,
                );
            },
        ],
        [
            TEAM_USER_IDENTITIES_MIGRATION_KEY,
            async (_ctx, database) => {
                // Identities become (method, subject) so JWT user IDs cannot collide with WorkOS
                // IDs. SQLite cannot change a uniqueness constraint in place, so both tables are
                // rebuilt. Renaming first moves the photo foreign key onto the previous users
                // table, so dropping it later cannot cascade into the copied photos.
                const run = async (statement: ReturnType<typeof sql>) =>
                    await agentDatabaseRun(database, statement);
                await run(
                    sql`ALTER TABLE ${sql.raw(USERS_TABLE)} RENAME TO happy_agent_team_users_previous`,
                );
                await run(
                    sql`ALTER TABLE ${sql.raw(USER_PHOTOS_TABLE)} RENAME TO happy_agent_team_user_photos_previous`,
                );
                await run(
                    sql`CREATE TABLE ${sql.raw(USERS_TABLE)} (
                        id TEXT PRIMARY KEY,
                        authentication TEXT NOT NULL CHECK (authentication IN ('workos', 'jwt')),
                        subject TEXT NOT NULL,
                        first_name TEXT NOT NULL,
                        last_name TEXT,
                        is_owner INTEGER NOT NULL CHECK (is_owner IN (0, 1)),
                        email TEXT,
                        profile_version TEXT,
                        created_at INTEGER,
                        updated_at INTEGER,
                        UNIQUE (authentication, subject)
                    )`,
                );
                await run(
                    sql`INSERT INTO ${sql.raw(USERS_TABLE)}
                        (id, authentication, subject, first_name, last_name, is_owner, email,
                            profile_version, created_at, updated_at)
                        SELECT id, 'workos', workos_user_id, first_name, last_name, is_owner, email,
                            profile_version, created_at, updated_at
                        FROM happy_agent_team_users_previous`,
                );
                await run(
                    sql`CREATE TABLE ${sql.raw(USER_PHOTOS_TABLE)} (
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
                await run(
                    sql`INSERT INTO ${sql.raw(USER_PHOTOS_TABLE)}
                        (user_id, photo_bytes, content_type, content_hash, thumbhash, width, height)
                        SELECT user_id, photo_bytes, content_type, content_hash, thumbhash, width,
                            height
                        FROM happy_agent_team_user_photos_previous`,
                );
                await run(sql`DROP TABLE happy_agent_team_user_photos_previous`);
                await run(sql`DROP TABLE happy_agent_team_users_previous`);
            },
        ],
    ] as readonly AgentModuleMigration<Database>[];

    readonly #config: ConfigModule;
    readonly #draftListeners = new Set<TeamDraftUpdatedListener>();
    readonly #listeners = new Set<TeamUserProfileChangedListener>();
    readonly #authentication: TeamAuthentication;
    readonly #ownerSubject: string | undefined;
    readonly #profile: ProfileModule;
    readonly #verify: ((accessToken: string) => Promise<string>) | undefined;

    constructor(config: ConfigModule, profile: ProfileModule) {
        this.#config = config;
        this.#profile = profile;
        const team = config.configuration.values.feature.team;
        this.#authentication = team.authentication;
        this.#ownerSubject =
            team.authentication === "jwt"
                ? "ownerUserId" in team
                    ? team.ownerUserId
                    : undefined
                : "ownerWorkOSUserId" in team
                  ? team.ownerWorkOSUserId
                  : undefined;
        if (!team.enabled) {
            this.#verify = undefined;
            return;
        }
        if (team.authentication === "jwt") {
            const jwt = team.jwt;
            let key: ConstructorParameters<typeof JwtAccessTokenVerifier>[0]["key"];
            if (jwt.key.type === "jwks") {
                key = createRemoteJWKSet(new URL(jwt.key.url), { timeoutDuration: 5_000 });
            } else if (jwt.key.type === "public_key") {
                key = createPublicKey(jwt.key.pem);
            } else {
                const secret = config.teamJwtSecret;
                if (secret === undefined || secret.byteLength < MIN_JWT_SECRET_BYTES) {
                    throw new Error(
                        `JWT team authentication requires the ${jwt.key.env} environment variable to hold a secret of at least ${String(MIN_JWT_SECRET_BYTES)} bytes.`,
                    );
                }
                key = secret;
            }
            const verifier = new JwtAccessTokenVerifier({
                algorithms: jwt.algorithms,
                audience: jwt.audience,
                issuer: jwt.issuer,
                key,
                userIdClaim: jwt.userIdClaim,
            });
            this.#verify = async (accessToken) => await verifier.verify(accessToken);
        } else {
            const verifier = new WorkOSAccessTokenVerifier({
                clientId: team.workosClientId,
                organizationId: team.workosOrganizationId,
            });
            this.#verify = async (accessToken) => (await verifier.verify(accessToken)).userId;
        }
        this.beforeStart = () => ({
            systemNotificationsTransact: (ctx, scope, boundary) =>
                teamSenderNotifications(ctx, this, scope, boundary),
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

    /**
     * The sign-in methods people can complete, in display order. A redirect makes each browser
     * URL return its result there. Standalone and WorkOS deployments offer none.
     */
    authenticationMethods(
        redirect?: TeamAuthenticationRedirect,
    ): readonly TeamBrowserAuthenticationMethod[] {
        const team = this.#config.configuration.values.feature.team;
        if (!team.enabled || team.authentication !== "jwt") return [];
        const url = new URL(team.jwt.loginUrl);
        if (redirect !== undefined) {
            url.searchParams.delete("redirect_uri");
            url.searchParams.delete("state");
            url.searchParams.set("redirect_uri", redirect.redirectUri);
            if (redirect.state !== undefined) url.searchParams.set("state", redirect.state);
        }
        return [
            {
                id: "jwt",
                name: team.jwt.name,
                type: "browser",
                url: redirect === undefined ? team.jwt.loginUrl : url.toString(),
            },
        ];
    }

    /** Verify one member's token without consulting local user storage. */
    async authenticateIdentity(
        ctx: Context,
        authorization: string | readonly string[] | undefined,
    ): Promise<Context> {
        const accessToken = bearerToken(authorization);
        const verify = this.#verify;
        if (
            !this.enabled ||
            verify === undefined ||
            accessToken === undefined ||
            accessToken.length > MAX_BEARER_TOKEN_LENGTH
        ) {
            throw new TeamAuthenticationError();
        }
        let subject: string;
        try {
            subject = await verify(accessToken);
        } catch {
            throw new TeamAuthenticationError();
        }
        return withTeamIdentity(ctx, { authentication: this.#authentication, subject });
    }

    /** Authenticate an organization member, whether or not they have onboarded locally yet. */
    async authenticate(
        ctx: Context,
        authorization: string | readonly string[] | undefined,
    ): Promise<Context> {
        let requestCtx = await this.authenticateIdentity(ctx, authorization);
        const identity = this.#requireIdentity(requestCtx);
        const user = await this.findUserByIdentity(requestCtx, identity);
        if (user !== undefined) requestCtx = withTeamUser(requestCtx, user);
        return requestCtx;
    }

    async currentUser(ctx: Context): Promise<TeamUser | undefined> {
        const identity = teamIdentity(ctx);
        if (identity === undefined) return undefined;
        return await this.findUserByIdentity(ctx, identity);
    }

    /** Bind an independently owned personal connection to its locally onboarded member. */
    connectionContext(ctx: Context, user: TeamUser): Context {
        return withTeamUser(
            withTeamIdentity(ctx, { authentication: user.authentication, subject: user.subject }),
            user,
        );
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
            isOwner: this.#isOwner(input),
            lastName: input.lastName ?? null,
            photo: null,
            updatedAt: now,
            version: createTeamUserVersion(),
            authentication: input.authentication,
            subject: input.subject,
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
            const current = await this.findUserByIdentity(txCtx, identity);
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
                    isOwner: this.#isOwner(identity),
                    lastName: parsed.lastName,
                    photo: null,
                    updatedAt: now,
                    version: createTeamUserVersion(),
                    authentication: identity.authentication,
                    subject: identity.subject,
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

    /** One member's current composer draft on one agent, including the timestamp of a clear. */
    async draft(ctx: Context, agentId: string, userId: string): Promise<TeamDraft> {
        return await queryTeamDraft(ctx, agentId, userId);
    }

    /** Keep the newest of the stored and offered drafts, telling subscribers only of real change. */
    async saveDraft(
        ctx: Context,
        agentId: string,
        userId: string,
        input: TeamDraftInput,
    ): Promise<{ readonly draft: TeamDraft; readonly changed: boolean }> {
        if (!Value.Check(teamDraftInputSchema, input)) {
            throw new Error("The team draft is not valid.");
        }
        return await ctx.inTx(async (txCtx) => {
            const result = await saveTeamDraft(txCtx, agentId, userId, input);
            if (result.changed) {
                this.#publishDraft(txCtx, { agentId, draft: result.draft, userId });
            }
            return result;
        });
    }

    /** Watch per-user draft changes after their transaction commits. */
    onDraftUpdated(listener: TeamDraftUpdatedListener): () => void {
        this.#draftListeners.add(listener);
        return () => {
            this.#draftListeners.delete(listener);
        };
    }

    async getUser(ctx: Context, userId: string): Promise<TeamUser | undefined> {
        return (await queryTeamUsers(ctx, { id: userId }))[0];
    }

    /** Resolve a bounded batch in first-requested order, omitting unknown and duplicate IDs. */
    async getUsers(ctx: Context, ids: readonly string[]): Promise<readonly TeamUser[]> {
        if (!Value.Check(userIdsSchema, ids)) {
            throw new TeamProfileInputError("Provide at most 100 valid Happy user IDs.");
        }
        const uniqueIds = [...new Set(ids)];
        const users = await queryTeamUsers(ctx, { ids: uniqueIds });
        const byId = new Map(users.map((user) => [user.id, user]));
        return uniqueIds.flatMap((id) => {
            const user = byId.get(id);
            return user === undefined ? [] : [user];
        });
    }

    async findUserByIdentity(ctx: Context, identity: TeamIdentity): Promise<TeamUser | undefined> {
        return (
            await queryTeamUsers(ctx, {
                authentication: identity.authentication,
                subject: identity.subject,
            })
        )[0];
    }

    async listUsers(ctx: Context): Promise<readonly TeamUser[]> {
        return await queryTeamUsers(ctx);
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
        const user = await this.findUserByIdentity(ctx, identity);
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
            const current = await this.findUserByIdentity(txCtx, identity);
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
                (id, authentication, subject, first_name, last_name, is_owner, email,
                    profile_version, created_at, updated_at)
                VALUES (
                    ${user.id},
                    ${user.authentication},
                    ${user.subject},
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

    #assertExpectedVersion(user: TeamUser, expectedVersion: string): void {
        if (user.version !== expectedVersion) throw new TeamProfileVersionConflictError(user);
    }

    #requireIdentity(ctx: Context): NonNullable<ReturnType<typeof teamIdentity>> {
        const identity = teamIdentity(ctx);
        if (identity === undefined) throw new TeamAuthenticationError();
        return identity;
    }

    /** Only the configured owner, proved by this deployment's own method, is the owner. */
    #isOwner(identity: TeamIdentity): boolean {
        if (this.#ownerSubject === undefined) {
            throw new Error("The team owner user ID is not configured.");
        }
        return (
            identity.authentication === this.#authentication &&
            identity.subject === this.#ownerSubject
        );
    }

    #publishDraft(ctx: Context, event: TeamDraftUpdatedEvent): void {
        const frozen = deepFreeze(structuredClone(event)) as TeamDraftUpdatedEvent;
        afterCommit(ctx, async (eventCtx) => {
            for (const listener of Array.from(this.#draftListeners)) {
                try {
                    await listener(eventCtx, frozen);
                } catch (error: unknown) {
                    eventCtx.log.error(
                        "A team draft subscriber failed.",
                        { agentId: frozen.agentId, userId: frozen.userId },
                        error,
                    );
                }
            }
        });
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
