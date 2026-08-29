import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { AbortModule } from "../../sources/abort/index.js";
import { CollaborationModule } from "../../sources/collaboration/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { testConfig } from "../support/computeModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("collaboration migrations", () => {
    it("removes every legacy collaboration table and is safe to repeat", async () => {
        const database = moduleDatabase([], "collaboration-migration-removal-test");
        try {
            await database.ready;
            await agentDatabaseRun(
                database.database,
                sql`CREATE TABLE happy_collaboration_agents (id TEXT)`,
            );
            await agentDatabaseRun(
                database.database,
                sql`CREATE TABLE happy_collaboration_messages (id TEXT)`,
            );
            await agentDatabaseRun(
                database.database,
                sql`CREATE TABLE happy_collaboration_obligations (id TEXT)`,
            );
            await agentDatabaseRun(
                database.database,
                sql`CREATE TABLE happy_collaboration_receipts (id TEXT)`,
            );

            const remove = new CollaborationModule(
                testConfig,
                new AbortModule(new ComputeModule(testConfig, new SecretsModule())),
            ).migrations[3]![1];
            await remove(database.context, database.database);
            await remove(database.context, database.database);

            const rows = await agentDatabaseRows<{ readonly name: string }>(
                database.database,
                sql`SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name LIKE 'happy_collaboration_%'
                    ORDER BY name`,
            );
            expect(rows).toEqual([]);
        } finally {
            database.close();
        }
    });
});
