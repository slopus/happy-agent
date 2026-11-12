import type { AgentModule } from "@slopus/happy-agent-base";
import {
    MAX_USER_SETTING_VALUE_BYTES,
    userSettingKeySchema,
    type StoredUserSetting,
    type UserSetting,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { TeamAuthenticationError, TeamModule, teamUser } from "../team/index.js";

import { queryUserSetting } from "./persistence/queryUserSetting.js";
import { queryUserSettings } from "./persistence/queryUserSettings.js";
import { saveUserSetting } from "./persistence/saveUserSetting.js";
import {
    STANDALONE_USER_SETTINGS_OWNER,
    userSettingWriteSchema,
    type UserSettingChangedEvent,
    type UserSettingsListener,
    type UserSettingsOwner,
    type UserSettingWrite,
} from "./UserSettings.js";
import { UserSettingsError } from "./UserSettingsError.js";
import { userSettingsMigrations } from "./UserSettingsMigrations.js";
import { requireDurableCommit } from "../impl/durableCommit.js";

/**
 * Small opaque preferences that belong to one person and follow them from device to device.
 *
 * In team mode the owner is the authenticated member; standalone, the installation's one person.
 * Every operation takes its owner from the caller's context, so no caller can name another
 * person's settings. The module checks only shapes and sizes and never interprets a value; it has
 * no tools, and settings never reach agents. Each key is last-write-wins by the time the person
 * made the change, and every applied write is announced after its transaction commits.
 */
export class UserSettingsModule implements AgentModule {
    readonly name = "userSettings";
    readonly migrations = userSettingsMigrations;

    readonly #team: TeamModule;
    readonly #listeners = new Set<UserSettingsListener>();
    readonly #transactionalListeners = new Set<UserSettingsListener>();

    constructor(team: TeamModule) {
        this.#team = team;
    }

    /** Everything held for the caller, values and retained clears, in ascending key order. */
    async list(ctx: Context): Promise<readonly StoredUserSetting[]> {
        return await queryUserSettings(ctx, this.#owner(ctx));
    }

    /** The caller's entry for one key; a key holding nothing has a null value, time, and version. */
    async get(ctx: Context, key: string): Promise<UserSetting> {
        const owner = this.#owner(ctx);
        checkKey(key);
        return (
            (await queryUserSetting(ctx, owner, key)) ?? {
                key,
                value: null,
                updatedAt: null,
                version: null,
            }
        );
    }

    /**
     * Set or clear one of the caller's settings and return the authoritative entry: what this
     * write stored, or the stored entry unchanged when the write is stale.
     */
    async save(ctx: Context, key: string, write: UserSettingWrite): Promise<UserSetting> {
        const owner = this.#owner(ctx);
        checkKey(key);
        if (!Value.Check(userSettingWriteSchema, write)) {
            throw new UserSettingsError(
                "invalid_request",
                "The setting must be a JSON value nested at most 32 deep, with an optional time.",
            );
        }
        if (
            write.value !== null &&
            Buffer.byteLength(JSON.stringify(write.value)) > MAX_USER_SETTING_VALUE_BYTES
        ) {
            throw new UserSettingsError(
                "too_large",
                "A setting value can be at most 64 KiB as compact JSON.",
            );
        }
        return await ctx.inTx(async (txCtx) => {
            const result = await saveUserSetting(txCtx, owner, key, write, Date.now());
            if (result.applied) {
                await this.#publish(txCtx, { owner, setting: result.setting });
                await requireDurableCommit(txCtx);
            }
            return result.setting;
        });
    }

    /** Watch applied writes after their transaction commits. */
    onEvent(listener: UserSettingsListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Participate in an applied write's transaction; a failure rolls the write back. */
    onEventTransactional(listener: UserSettingsListener): () => void {
        this.#transactionalListeners.add(listener);
        return () => {
            this.#transactionalListeners.delete(listener);
        };
    }

    #owner(ctx: Context): UserSettingsOwner {
        if (!this.#team.enabled) return STANDALONE_USER_SETTINGS_OWNER;
        const user = teamUser(ctx);
        if (user === undefined) throw new TeamAuthenticationError();
        return user.id;
    }

    async #publish(ctx: Context, event: UserSettingChangedEvent): Promise<void> {
        const frozen = deepFreeze(structuredClone(event));
        afterCommit(ctx, async (eventCtx) => {
            for (const listener of Array.from(this.#listeners)) {
                try {
                    await listener(eventCtx, frozen);
                } catch (error: unknown) {
                    eventCtx.log.error(
                        "A user settings subscriber failed.",
                        { key: frozen.setting.key },
                        error,
                    );
                }
            }
        });
        for (const listener of Array.from(this.#transactionalListeners)) {
            await listener(ctx, frozen);
        }
    }
}

function checkKey(key: string): void {
    if (!Value.Check(userSettingKeySchema, key)) {
        throw new UserSettingsError(
            "invalid_request",
            "A setting key is 1 to 128 letters, digits, dots, underscores, and hyphens, starting with a letter or digit.",
        );
    }
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}
