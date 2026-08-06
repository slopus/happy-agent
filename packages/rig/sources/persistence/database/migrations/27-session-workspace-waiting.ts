import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function sessionWorkspaceWaiting(database: SessionDatabase): void {
    const sessions = database.get<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
    );
    if (sessions === undefined) return;
    const alreadyPresent = database
        .all<{ name: string }>(sql.raw("PRAGMA table_info(sessions)"))
        .some((column) => column.name === "workspace_queue_waiting");
    if (alreadyPresent) return;
    database.run(
        sql.raw(
            "ALTER TABLE sessions ADD COLUMN workspace_queue_waiting INTEGER NOT NULL DEFAULT 0",
        ),
    );
}
