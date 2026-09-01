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
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { createProfileVersion } from "./createProfileVersion.js";
import {
    MAX_PROFILE_PHOTO_BYTES,
    normalizeProfilePhoto,
    type NormalizedProfilePhoto,
} from "./normalizeProfilePhoto.js";
import {
    createProfileInputSchema,
    instanceIdSchema,
    profileEventListenerSchema,
    profileMutationOptionsSchema,
    profilePhotoAssetSchema,
    profilePhotoContentTypeSchema,
    profileSchema,
    updateProfileInputSchema,
    type CreateProfileInput,
    type Profile,
    type ProfileEventListener,
    type ProfileMutationOptions,
    type ProfilePhotoAsset,
    type ProfilePhotoContentType,
    type ProfileUnsubscribe,
    type ProfileVersion,
    type UpdateProfileInput,
} from "./ProfileTypes.js";
import { ProfileVersionConflictError } from "./ProfileVersionConflictError.js";

export const PROFILE_MIGRATION_KEY = "001-profile";
export const PROFILE_PHOTO_MIGRATION_KEY = "002-profile-photo";

const PROFILE_TABLE = "happy_agent_profile";
const PROFILE_PHOTO_TABLE = "happy_agent_profile_photo";
const storedPhotoRowSchema = Type.Object(
    {
        content_hash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        content_type: Type.Literal("image/webp"),
        height: Type.Integer({ maximum: 512, minimum: 1 }),
        photo_bytes: Type.Uint8Array({
            maxByteLength: MAX_PROFILE_PHOTO_BYTES,
            minByteLength: 1,
        }),
        thumbhash: Type.String({ maxLength: 128, minLength: 4 }),
        width: Type.Integer({ maximum: 512, minimum: 1 }),
    },
    { additionalProperties: false },
);

/**
 * The one person this installation belongs to, including their one bounded profile photo.
 *
 * The singleton owns a stable private identity for P2P while allowing every user-facing field
 * to remain empty. Media stays in the module's database because this module takes no config or
 * host object and must keep its own storage boundary.
 */
export class ProfileModule<Database extends AgentDatabase = AgentDatabase> implements AgentModule<
    never,
    Database
> {
    readonly name = "profile";
    readonly migrations: readonly AgentModuleMigration<Database>[] = [
        [
            PROFILE_MIGRATION_KEY,
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROFILE_TABLE)} (
                        singleton_id INTEGER PRIMARY KEY,
                        profile_json TEXT NOT NULL
                    )`,
                );
            },
        ],
        [
            PROFILE_PHOTO_MIGRATION_KEY,
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS ${sql.raw(PROFILE_PHOTO_TABLE)} (
                        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                        photo_bytes BLOB NOT NULL,
                        content_type TEXT NOT NULL,
                        content_hash TEXT NOT NULL,
                        thumbhash TEXT NOT NULL,
                        width INTEGER NOT NULL,
                        height INTEGER NOT NULL
                    )`,
                );
            },
        ],
    ] as readonly AgentModuleMigration<Database>[];
    readonly #listeners = new Set<ProfileEventListener>();
    #localInstanceId: string | undefined;

    /** Watch every saved mutation; call the returned function to stop watching. */
    onEvent(listener: ProfileEventListener): ProfileUnsubscribe {
        if (!Value.Check(profileEventListenerSchema, listener)) {
            throw new Error("Profile event listener must be a function.");
        }
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Name the installation that permanently owns this profile identity. */
    open(localInstanceId: string): void {
        if (!Value.Check(instanceIdSchema, localInstanceId)) {
            throw new Error("The installation identity is not valid.");
        }
        this.#localInstanceId = localInstanceId;
    }

    /** Read the singleton when it has already been materialized. */
    async get(ctx: Context): Promise<Profile | undefined> {
        return await this.#read(ctx);
    }

    /**
     * Materialize and return the empty singleton.
     *
     * First access is initialization, not a user-visible change, so it emits no update event.
     */
    async ensure(ctx: Context): Promise<Profile> {
        const instanceId = this.#requireInstance();
        return await ctx.inTx(async (txCtx): Promise<Profile> => {
            const current = await this.#read(txCtx);
            if (current !== undefined) return current;
            const now = Date.now();
            const created: Profile = {
                createdAt: now,
                email: null,
                id: createId(),
                name: null,
                parentInstanceId: instanceId,
                photo: null,
                updatedAt: now,
                version: createProfileVersion(),
            };
            await this.#insertIfAbsent(txCtx, created);
            const stored = await this.#read(txCtx);
            if (stored === undefined) throw new Error("The profile could not be initialized.");
            return stored;
        });
    }

    /** The same singleton addressed by its private P2P identity. */
    async getById(ctx: Context, profileId: string): Promise<Profile | undefined> {
        const profile = await this.#read(ctx);
        return profile?.id === profileId ? profile : undefined;
    }

    /** Whether this installation owns that profile identity and may act as it. */
    async isLocal(ctx: Context, profileId: string): Promise<boolean> {
        const profile = await this.getById(ctx, profileId);
        if (profile === undefined || this.#localInstanceId === undefined) return false;
        return profile.parentInstanceId === this.#localInstanceId;
    }

    /**
     * Create a complete local identity in one operation for P2P callers.
     *
     * The HTTP singleton uses `ensure` followed by `update`; there is deliberately no HTTP create.
     */
    async create(ctx: Context, input: CreateProfileInput): Promise<Profile> {
        if (!Value.Check(createProfileInputSchema, input)) {
            throw new Error("The profile name or email address is not valid.");
        }
        const instanceId = this.#requireInstance();
        const now = Date.now();
        const profile = await ctx.inTx(async (txCtx): Promise<Profile> => {
            if ((await this.#read(txCtx)) !== undefined) {
                throw new Error("This installation already has a profile.");
            }
            const created: Profile = {
                createdAt: now,
                email: input.email,
                id: createId(),
                name: input.name,
                parentInstanceId: instanceId,
                photo: null,
                updatedAt: now,
                version: createProfileVersion(),
            };
            await this.#insertIfAbsent(txCtx, created);
            return created;
        });
        await this.#publishChanged(ctx, profile, null);
        return profile;
    }

    /** Change nullable public metadata, optionally requiring the version last observed. */
    async update(
        ctx: Context,
        profileId: string,
        input: UpdateProfileInput,
        options: ProfileMutationOptions = {},
    ): Promise<Profile | undefined> {
        if (
            !Value.Check(updateProfileInputSchema, input) ||
            !Value.Check(profileMutationOptionsSchema, options)
        ) {
            throw new Error("The profile update is not valid.");
        }
        const instanceId = this.#requireInstance();
        const changed = await ctx.inTx(
            async (
                txCtx,
            ): Promise<{ readonly current: Profile; readonly updated: Profile } | undefined> => {
                const current = await this.getById(txCtx, profileId);
                if (current === undefined) return undefined;
                this.#assertOwned(current, instanceId);
                this.#assertExpectedVersion(current, options.expectedVersion);
                const updated: Profile = {
                    ...current,
                    ...(input.email === undefined ? {} : { email: input.email }),
                    ...(input.name === undefined ? {} : { name: input.name }),
                    updatedAt: Date.now(),
                    version: createProfileVersion(current.version),
                };
                await this.#write(txCtx, updated);
                return { current, updated };
            },
        );
        if (changed === undefined) return undefined;
        await this.#publishChanged(ctx, changed.updated, changed.current.version);
        return changed.updated;
    }

    /** Read the normalized WebP plus the strong ETag derived from its own bytes. */
    async getPhoto(ctx: Context): Promise<ProfilePhotoAsset | undefined> {
        const row = (
            await agentDatabaseRows<unknown>(
                ctx.db,
                sql`SELECT photo_bytes, content_type, content_hash, thumbhash, width, height
                    FROM ${sql.raw(PROFILE_PHOTO_TABLE)}
                    WHERE singleton_id = 1`,
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
            throw new Error("The stored profile photo is invalid.");
        }
        const bytes = new Uint8Array(stored.photo_bytes);
        const actualHash = createHash("sha256").update(bytes).digest("hex");
        if (actualHash !== stored.content_hash) {
            throw new Error("The stored profile photo does not match its content hash.");
        }
        const asset: ProfilePhotoAsset = {
            bytes,
            contentHash: stored.content_hash,
            contentType: stored.content_type,
            etag: `"${stored.content_hash}"`,
            height: stored.height,
            thumbhash: stored.thumbhash,
            width: stored.width,
        };
        if (!Value.Check(profilePhotoAssetSchema, asset)) {
            throw new Error("The stored profile photo metadata is invalid.");
        }
        return asset;
    }

    /** Validate and normalize profile media for this module or a dependent identity module. */
    async normalizePhoto(
        bytes: Uint8Array,
        contentType: ProfilePhotoContentType,
    ): Promise<NormalizedProfilePhoto> {
        if (
            !Value.Check(Type.Uint8Array(), bytes) ||
            !Value.Check(profilePhotoContentTypeSchema, contentType)
        ) {
            throw new Error("The profile photo update is not valid.");
        }
        return await normalizeProfilePhoto(bytes, contentType);
    }

    /** Normalize and atomically replace the one retained photo. */
    async putPhoto(
        ctx: Context,
        bytes: Uint8Array,
        contentType: ProfilePhotoContentType,
        options: ProfileMutationOptions = {},
    ): Promise<Profile> {
        if (
            !Value.Check(Type.Uint8Array(), bytes) ||
            !Value.Check(profilePhotoContentTypeSchema, contentType) ||
            !Value.Check(profileMutationOptionsSchema, options)
        ) {
            throw new Error("The profile photo update is not valid.");
        }
        const normalized = await this.normalizePhoto(bytes, contentType);
        const instanceId = this.#requireInstance();
        const changed = await ctx.inTx(async (txCtx) => {
            const current = await this.#ensureInTransaction(txCtx, instanceId);
            this.#assertOwned(current, instanceId);
            this.#assertExpectedVersion(current, options.expectedVersion);
            const updated: Profile = {
                ...current,
                photo: {
                    contentHash: normalized.contentHash,
                    height: normalized.height,
                    thumbhash: normalized.thumbhash,
                    width: normalized.width,
                },
                updatedAt: Date.now(),
                version: createProfileVersion(current.version),
            };
            await agentDatabaseRun(
                txCtx.db,
                sql`INSERT INTO ${sql.raw(PROFILE_PHOTO_TABLE)}
                    (singleton_id, photo_bytes, content_type, content_hash, thumbhash, width, height)
                    VALUES (
                        1,
                        ${normalized.bytes},
                        ${normalized.contentType},
                        ${normalized.contentHash},
                        ${normalized.thumbhash},
                        ${normalized.width},
                        ${normalized.height}
                    )
                    ON CONFLICT (singleton_id) DO UPDATE SET
                        photo_bytes = EXCLUDED.photo_bytes,
                        content_type = EXCLUDED.content_type,
                        content_hash = EXCLUDED.content_hash,
                        thumbhash = EXCLUDED.thumbhash,
                        width = EXCLUDED.width,
                        height = EXCLUDED.height`,
            );
            await this.#write(txCtx, updated);
            return { current, updated };
        });
        await this.#publishChanged(ctx, changed.updated, changed.current.version);
        return changed.updated;
    }

    /** Remove the retained photo; when none exists this is an idempotent read of current state. */
    async deletePhoto(ctx: Context, options: ProfileMutationOptions = {}): Promise<Profile> {
        if (!Value.Check(profileMutationOptionsSchema, options)) {
            throw new Error("The profile photo update is not valid.");
        }
        const instanceId = this.#requireInstance();
        const changed = await ctx.inTx(async (txCtx) => {
            const current = await this.#ensureInTransaction(txCtx, instanceId);
            this.#assertOwned(current, instanceId);
            this.#assertExpectedVersion(current, options.expectedVersion);
            if (current.photo === null) return { current, updated: current, mutated: false };
            const updated: Profile = {
                ...current,
                photo: null,
                updatedAt: Date.now(),
                version: createProfileVersion(current.version),
            };
            await agentDatabaseRun(
                txCtx.db,
                sql`DELETE FROM ${sql.raw(PROFILE_PHOTO_TABLE)} WHERE singleton_id = 1`,
            );
            await this.#write(txCtx, updated);
            return { current, updated, mutated: true };
        });
        if (changed.mutated) {
            await this.#publishChanged(ctx, changed.updated, changed.current.version);
        }
        return changed.updated;
    }

    #requireInstance(): string {
        const instanceId = this.#localInstanceId;
        if (instanceId === undefined) throw new Error("The profile is not open yet.");
        return instanceId;
    }

    #assertOwned(profile: Profile, instanceId: string): void {
        if (profile.parentInstanceId !== instanceId) {
            throw new Error("Only this profile's own installation may change it.");
        }
    }

    #assertExpectedVersion(profile: Profile, expectedVersion: ProfileVersion | undefined): void {
        if (expectedVersion !== undefined && profile.version !== expectedVersion) {
            throw new ProfileVersionConflictError(profile);
        }
    }

    async #read(ctx: Context): Promise<Profile | undefined> {
        const row = (
            await agentDatabaseRows<{ profile_json: string }>(
                ctx.db,
                sql`SELECT profile_json FROM ${sql.raw(PROFILE_TABLE)} WHERE singleton_id = 1`,
            )
        )[0];
        if (row === undefined) return undefined;
        let value: unknown;
        try {
            value = JSON.parse(row.profile_json);
        } catch (error: unknown) {
            throw new Error("The stored profile is not readable.", { cause: error });
        }
        if (!Value.Check(profileSchema, value)) {
            throw new Error("The stored profile is invalid.");
        }
        return structuredClone(value) as Profile;
    }

    async #ensureInTransaction(ctx: Context, instanceId: string): Promise<Profile> {
        const current = await this.#read(ctx);
        if (current !== undefined) return current;
        const now = Date.now();
        const created: Profile = {
            createdAt: now,
            email: null,
            id: createId(),
            name: null,
            parentInstanceId: instanceId,
            photo: null,
            updatedAt: now,
            version: createProfileVersion(),
        };
        await this.#insertIfAbsent(ctx, created);
        const stored = await this.#read(ctx);
        if (stored === undefined) throw new Error("The profile could not be initialized.");
        return stored;
    }

    async #insertIfAbsent(ctx: Context, profile: Profile): Promise<void> {
        if (!Value.Check(profileSchema, profile)) throw new Error("The profile is not valid.");
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO ${sql.raw(PROFILE_TABLE)} (singleton_id, profile_json)
                VALUES (1, ${JSON.stringify(profile)})
                ON CONFLICT (singleton_id) DO NOTHING`,
        );
    }

    async #write(ctx: Context, profile: Profile): Promise<void> {
        if (!Value.Check(profileSchema, profile)) throw new Error("The profile is not valid.");
        await agentDatabaseRun(
            ctx.db,
            sql`UPDATE ${sql.raw(PROFILE_TABLE)}
                SET profile_json = ${JSON.stringify(profile)}
                WHERE singleton_id = 1`,
        );
    }

    /** Notify listeners after commit; one failed listener cannot undo or hide the saved change. */
    async #publishChanged(
        ctx: Context,
        profile: Profile,
        previousVersion: ProfileVersion | null,
    ): Promise<void> {
        const event = {
            createdAt: profile.updatedAt,
            data: { previousVersion, profileId: profile.id, version: profile.version },
            id: profile.version,
            type: "profile_changed",
        } as const;
        for (const listener of this.#listeners) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                ctx.log.warn(
                    "A profile listener failed after the change was saved.",
                    { profileId: profile.id, version: profile.version },
                    error,
                );
            }
        }
    }
}
