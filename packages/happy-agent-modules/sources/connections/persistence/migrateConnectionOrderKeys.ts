import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { connectionSchema, resourceVersionSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { createConnectionVersion } from "../createConnectionVersion.js";

const previousSnapshotSchema = Type.Object({
    connections: Type.Array(Type.Omit(connectionSchema, ["orderKey"]), { maxItems: 100 }),
    version: resourceVersionSchema,
});

/** Backfill once before the required public connection schema is used to read old snapshots. */
export const migrateConnectionOrderKeys: AgentModuleMigration = [
    "002-connection-order-keys",
    async (_ctx, database) => {
        const rows = await agentDatabaseRows<{ snapshot_json: string }>(
            database,
            sql`SELECT snapshot_json FROM happy_agent_connections_snapshot WHERE singleton_id = 1`,
        );
        if (rows[0] === undefined) return;
        const previous: unknown = JSON.parse(rows[0].snapshot_json);
        if (!Value.Check(previousSnapshotSchema, previous))
            throw new Error("The stored remote connection roster is invalid.");
        if (previous.connections.length === 0) return;
        const connections = [...previous.connections]
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
            .map((connection, index) => ({
                ...connection,
                orderKey: String(index + 1).padStart(20, "0"),
            }));
        const snapshot = { connections, version: createConnectionVersion(previous.version) };
        await agentDatabaseRun(
            database,
            sql`UPDATE happy_agent_connections_snapshot
            SET snapshot_json = ${JSON.stringify(snapshot)} WHERE singleton_id = 1`,
        );
    },
];
