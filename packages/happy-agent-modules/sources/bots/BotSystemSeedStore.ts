import { agentDatabaseRows, agentDatabaseRun, cuid2Schema } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { BOT_SYSTEM_SEEDS_TABLE } from "./BotMigrations.js";
import type { BotSystemKey } from "./BotSystemKey.js";

/** Read the permanent record that a system bot has already been seeded. */
export async function readSystemBotSeed(
    ctx: Context,
    systemKey: BotSystemKey,
): Promise<string | undefined> {
    const row = (
        await agentDatabaseRows<{ readonly bot_id: unknown }>(
            ctx.db,
            sql`SELECT bot_id FROM ${sql.raw(BOT_SYSTEM_SEEDS_TABLE)}
                WHERE system_key = ${systemKey} LIMIT 1`,
        )
    )[0];
    if (row === undefined) return undefined;
    if (!Value.Check(cuid2Schema, row.bot_id)) {
        throw new Error("System bot seed storage contains an invalid bot ID.");
    }
    return row.bot_id as string;
}

/** Record seeding permanently; deleting the bot must deliberately leave this row intact. */
export async function insertSystemBotSeed(
    ctx: Context,
    systemKey: BotSystemKey,
    botId: string,
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(BOT_SYSTEM_SEEDS_TABLE)} (system_key, bot_id)
            VALUES (${systemKey}, ${botId})`,
    );
}
