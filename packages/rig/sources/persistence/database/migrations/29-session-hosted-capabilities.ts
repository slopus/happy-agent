import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function sessionHostedCapabilities(database: SessionDatabase): void {
    const sessions = database.get<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
    );
    if (sessions === undefined) return;
    // This runs after the data-identity migrations, so a test that rewinds `user_version` to
    // replay those replays this one too and the column is already there.
    const alreadyPresent = database
        .all<{ name: string }>(sql.raw("PRAGMA table_info(sessions)"))
        .some((column) => column.name === "hosted_capabilities");
    if (alreadyPresent) return;
    database.run(sql.raw("ALTER TABLE sessions ADD COLUMN hosted_capabilities TEXT"));
}
