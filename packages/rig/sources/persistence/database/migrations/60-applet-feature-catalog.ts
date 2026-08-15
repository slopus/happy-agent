import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Adds the operation ledger required by the feature-owned durable applet catalog. */
export async function appletFeatureCatalog(database: SessionDatabase): Promise<void> {
    const versionColumns = await database.all<{ name: string }>(
        sql.raw("PRAGMA table_info(applet_versions)"),
    );
    if (!versionColumns.some((column) => column.name === "operation_id")) {
        await database.run(sql.raw("ALTER TABLE applet_versions ADD COLUMN operation_id TEXT"));
        await database.run(
            sql.raw(`
                UPDATE applet_versions
                SET operation_id = 'legacy:' || applet_name || ':' || version
                WHERE operation_id IS NULL
            `),
        );
    }
    await database.run(
        sql.raw(`
            CREATE UNIQUE INDEX IF NOT EXISTS applet_versions_operation_id
            ON applet_versions (operation_id)
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS applet_mutation_receipts (
                operation_id TEXT NOT NULL PRIMARY KEY,
                receipt_json TEXT NOT NULL
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS applet_mutation_proofs (
                operation_id TEXT NOT NULL PRIMARY KEY,
                proof_json TEXT NOT NULL
            )
        `),
    );
}