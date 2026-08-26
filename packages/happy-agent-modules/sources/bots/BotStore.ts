import { createHash } from "node:crypto";

import { agentDatabaseRows, agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import {
    botAvatarAssetSchema,
    botRecordSchema,
    type BotAvatarAsset,
    type BotRecord,
} from "./Bot.js";
import { BOT_AVATARS_TABLE, BOTS_TABLE } from "./BotMigrations.js";

interface BotRow {
    readonly id: string;
    readonly name: string;
    readonly username: string;
    readonly workspace_id: string;
    readonly workspace_version: number | string;
    readonly workspace_updated_at: number | string;
    readonly agent_id: string;
    readonly path: string;
    readonly status: string;
    readonly avatar_source: string | null;
    readonly avatar_thumbhash: string | null;
    readonly order_key: string;
    readonly version: number | string;
    readonly created_at: number | string;
    readonly updated_at: number | string;
    readonly archived_at: number | string | null;
}

export async function readBot(ctx: Context, botId: string): Promise<BotRecord | undefined> {
    const rows = await agentDatabaseRows<BotRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(BOTS_TABLE)} WHERE id = ${botId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : botFromRow(rows[0]);
}

export async function readBotByUsername(
    ctx: Context,
    username: string,
): Promise<BotRecord | undefined> {
    const rows = await agentDatabaseRows<BotRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(BOTS_TABLE)} WHERE username = ${username} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : botFromRow(rows[0]);
}

export async function readBotByWorkspace(
    ctx: Context,
    workspaceId: string,
): Promise<BotRecord | undefined> {
    const rows = await agentDatabaseRows<BotRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(BOTS_TABLE)} WHERE workspace_id = ${workspaceId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : botFromRow(rows[0]);
}

export async function readBotByAgent(
    ctx: Context,
    agentId: string,
): Promise<BotRecord | undefined> {
    const rows = await agentDatabaseRows<BotRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(BOTS_TABLE)} WHERE agent_id = ${agentId} LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : botFromRow(rows[0]);
}

export async function readBots(ctx: Context): Promise<readonly BotRecord[]> {
    const rows = await agentDatabaseRows<BotRow>(
        ctx.db,
        sql`SELECT * FROM ${sql.raw(BOTS_TABLE)} ORDER BY order_key, id`,
    );
    return rows.map(botFromRow);
}

export async function insertBot(ctx: Context, bot: BotRecord): Promise<void> {
    assertBot(bot);
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(BOTS_TABLE)} (
            id, name, username, workspace_id, workspace_version, workspace_updated_at,
            agent_id, path, status, avatar_source,
            avatar_thumbhash, order_key, version, created_at, updated_at, archived_at
        ) VALUES (
            ${bot.id}, ${bot.name}, ${bot.username}, ${bot.workspaceId},
            ${bot.workspaceVersion}, ${bot.workspaceUpdatedAt}, ${bot.agentId},
            ${bot.path}, ${bot.status}, ${bot.avatar?.source ?? null},
            ${bot.avatar?.thumbhash ?? null}, ${bot.orderKey}, ${bot.version},
            ${bot.createdAt}, ${bot.updatedAt}, ${bot.archivedAt ?? null}
        )`,
    );
}

export async function updateBot(
    ctx: Context,
    bot: BotRecord,
    expectedVersion: number,
): Promise<BotRecord> {
    assertBot(bot);
    const changed = await agentDatabaseRows<{ readonly id: string }>(
        ctx.db,
        sql`UPDATE ${sql.raw(BOTS_TABLE)} SET
            name = ${bot.name}, status = ${bot.status},
            workspace_version = ${bot.workspaceVersion},
            workspace_updated_at = ${bot.workspaceUpdatedAt},
            avatar_source = ${bot.avatar?.source ?? null},
            avatar_thumbhash = ${bot.avatar?.thumbhash ?? null},
            order_key = ${bot.orderKey}, version = ${bot.version},
            updated_at = ${bot.updatedAt}, archived_at = ${bot.archivedAt ?? null}
            WHERE id = ${bot.id} AND version = ${expectedVersion}
            RETURNING id`,
    );
    if (changed.length !== 1) throw new Error("The bot changed before it could be stored.");
    const stored = await readBot(ctx, bot.id);
    if (stored === undefined) throw new Error("The stored bot disappeared.");
    return stored;
}

export async function readBotAvatar(
    ctx: Context,
    botId: string,
): Promise<BotAvatarAsset | undefined> {
    const row = (
        await agentDatabaseRows<Record<string, unknown>>(
            ctx.db,
            sql`SELECT image_bytes, content_hash, thumbhash, width, height
                FROM ${sql.raw(BOT_AVATARS_TABLE)} WHERE bot_id = ${botId} LIMIT 1`,
        )
    )[0];
    if (row === undefined) return undefined;
    const bytes =
        row["image_bytes"] instanceof ArrayBuffer
            ? new Uint8Array(row["image_bytes"])
            : row["image_bytes"];
    const asset = {
        bytes,
        contentHash: row["content_hash"],
        etag: `"${String(row["content_hash"])}"`,
        thumbhash: row["thumbhash"],
        width: Number(row["width"]),
        height: Number(row["height"]),
    };
    if (!Value.Check(botAvatarAssetSchema, asset)) {
        throw new Error("Bot avatar storage contains an invalid image.");
    }
    const typed = asset as BotAvatarAsset;
    if (createHash("sha256").update(typed.bytes).digest("hex") !== typed.contentHash) {
        throw new Error("The stored bot avatar does not match its content hash.");
    }
    return typed;
}

export async function writeBotAvatar(
    ctx: Context,
    botId: string,
    asset: BotAvatarAsset,
): Promise<void> {
    if (!Value.Check(botAvatarAssetSchema, asset)) throw new Error("The bot avatar is invalid.");
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(BOT_AVATARS_TABLE)} (
            bot_id, image_bytes, content_hash, thumbhash, width, height
        ) VALUES (
            ${botId}, ${asset.bytes}, ${asset.contentHash},
            ${asset.thumbhash}, ${asset.width}, ${asset.height}
        ) ON CONFLICT (bot_id) DO UPDATE SET
            image_bytes = EXCLUDED.image_bytes,
            content_hash = EXCLUDED.content_hash, thumbhash = EXCLUDED.thumbhash,
            width = EXCLUDED.width, height = EXCLUDED.height`,
    );
}

export async function deleteBotAvatar(ctx: Context, botId: string): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(BOT_AVATARS_TABLE)} WHERE bot_id = ${botId}`,
    );
}

function botFromRow(row: BotRow): BotRecord {
    const hasAvatar = row.avatar_source !== null && row.avatar_thumbhash !== null;
    const bot: BotRecord = {
        id: row.id,
        name: row.name,
        username: row.username,
        workspaceId: row.workspace_id,
        workspaceVersion: Number(row.workspace_version),
        workspaceUpdatedAt: Number(row.workspace_updated_at),
        agentId: row.agent_id,
        path: row.path,
        status: row.status as BotRecord["status"],
        ...(hasAvatar
            ? {
                  avatar: {
                      kind: "image" as const,
                      source: row.avatar_source as "generated" | "user",
                      thumbhash: row.avatar_thumbhash as string,
                  },
              }
            : {}),
        orderKey: row.order_key,
        version: Number(row.version),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ...(row.archived_at === null ? {} : { archivedAt: Number(row.archived_at) }),
    };
    assertBot(bot);
    return bot;
}

function assertBot(bot: unknown): asserts bot is BotRecord {
    if (!Value.Check(botRecordSchema, bot)) throw new Error("Bot storage contains an invalid bot.");
}
