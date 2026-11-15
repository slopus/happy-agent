import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { botSettingsSchema, type BotSettings } from "./BotSettings.js";
import { BOT_SETTINGS_ROOTS_TABLE, BOT_SETTINGS_TABLE } from "./BotSettingsMigrations.js";

/** Old rows may carry a retired opt-in; public settings and writes never accept it. */
const storedBotSettingsSchema = Type.Object(
    { ...botSettingsSchema.properties, stories: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
);

export interface StoredBotSettings {
    readonly settings: BotSettings;
    readonly version: number;
}

export async function readStoredBotSettings(
    ctx: Context,
    botAgentId: string,
): Promise<StoredBotSettings | undefined> {
    const row = (
        await agentDatabaseRows<{ readonly settings_json: unknown; readonly version: unknown }>(
            ctx.db,
            sql`SELECT settings_json, version FROM ${sql.raw(BOT_SETTINGS_TABLE)}
                WHERE bot_agent_id = ${botAgentId} LIMIT 1`,
        )
    )[0];
    if (row === undefined) return undefined;
    let settings: unknown;
    try {
        settings = typeof row.settings_json === "string" ? JSON.parse(row.settings_json) : null;
    } catch {
        settings = null;
    }
    const version = Number(row.version);
    // A stored restriction this module cannot read is refused rather than read as no restriction.
    if (
        !Value.Check(storedBotSettingsSchema, settings) ||
        !Number.isSafeInteger(version) ||
        version < 1
    ) {
        throw new Error("Bot settings storage contains invalid settings.");
    }
    return { settings, version };
}

export async function writeStoredBotSettings(
    ctx: Context,
    botAgentId: string,
    settings: BotSettings,
    version: number,
    updatedAt: number,
): Promise<void> {
    if (!Value.Check(botSettingsSchema, settings)) throw new Error("The bot settings are invalid.");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(BOT_SETTINGS_TABLE)}
                (bot_agent_id, settings_json, version, updated_at)
            VALUES (${botAgentId}, ${JSON.stringify(settings)}, ${version}, ${updatedAt})
            ON CONFLICT (bot_agent_id) DO UPDATE SET
                settings_json = EXCLUDED.settings_json,
                version = EXCLUDED.version,
                updated_at = EXCLUDED.updated_at`,
    );
}

export async function readGoverningRoot(
    ctx: Context,
    rootAgentId: string,
): Promise<string | undefined> {
    const row = (
        await agentDatabaseRows<{ readonly governing_agent_id: unknown }>(
            ctx.db,
            sql`SELECT governing_agent_id FROM ${sql.raw(BOT_SETTINGS_ROOTS_TABLE)}
                WHERE root_agent_id = ${rootAgentId} LIMIT 1`,
        )
    )[0];
    if (row === undefined) return undefined;
    if (typeof row.governing_agent_id !== "string" || row.governing_agent_id.length === 0) {
        throw new Error("Bot settings storage contains an invalid governed root.");
    }
    return row.governing_agent_id;
}

/** Record once; a root keeps the tree it was created in for its whole life. */
export async function insertGoverningRoot(
    ctx: Context,
    rootAgentId: string,
    governingAgentId: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(BOT_SETTINGS_ROOTS_TABLE)} (root_agent_id, governing_agent_id)
            VALUES (${rootAgentId}, ${governingAgentId})
            ON CONFLICT (root_agent_id) DO NOTHING`,
    );
}
