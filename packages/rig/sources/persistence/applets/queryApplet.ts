import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import type { Applet } from "@slopus/happy-agent-features";
import type { DatabaseScope } from "../Transaction.js";
import { readAppletRow, readAppletVersionRow } from "./queryApplets.js";

export async function queryApplet(ctx: Context, name: string): Promise<Applet | undefined> {
    return await inDatabase(ctx, "rig.sql.applets.query_one", async (ctx) => {
        const tx = ctx.tx;
        const row = await tx.get<Record<string, unknown>>(
            sql`SELECT * FROM applets WHERE name = ${name}`,
        );
        if (row === undefined) return undefined;
        const versions = (
            await tx.all<Record<string, unknown>>(
                sql`SELECT * FROM applet_versions WHERE applet_name = ${name} ORDER BY version ASC`,
            )
        ).map(readAppletVersionRow);
        return readAppletRow(row, versions);
    });
}
