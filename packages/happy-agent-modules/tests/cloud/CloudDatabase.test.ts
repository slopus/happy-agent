import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { cloudSession, createCloudDatabase } from "../../sources/cloud/CloudDatabase.js";
import { cloudMigrations } from "../../sources/cloud/CloudMigrations.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const databases: ModuleDatabase[] = [];

afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

async function fixture(name: string) {
    const database = moduleDatabase(cloudMigrations, name);
    databases.push(database);
    await database.ready;
    return { database, store: createCloudDatabase() };
}

const user = {
    email: "person@example.com",
    firstName: "Ada",
    id: "user_01H",
    lastName: "Lovelace",
};

describe("Cloud storage", () => {
    it("persists a session and advances versions across clock rollback", async () => {
        const { database, store } = await fixture("cloud-storage-version");
        expect(await store.read(database.context)).toBeUndefined();

        const authorizing = await store.replace(
            database.context,
            { error: null, pending: true, session: null },
            () => 1_000,
        );
        const connected = await store.replace(
            database.context,
            {
                error: null,
                pending: false,
                session: cloudSession("production", "refresh-a", user),
            },
            () => 999,
        );

        expect(connected.version > authorizing.version).toBe(true);
        expect(connected.updatedAt).toBe(999);
        await expect(store.read(database.context)).resolves.toEqual(connected);
    });

    it("commits a rotated refresh token without changing the public version", async () => {
        const { database, store } = await fixture("cloud-storage-rotation");
        const connected = await store.replace(database.context, {
            error: null,
            pending: false,
            session: cloudSession("staging", "refresh-a", user),
        });

        const rotated = await store.rotateRefreshToken(database.context, "refresh-a", "refresh-b");

        expect(rotated.version).toBe(connected.version);
        expect(rotated.updatedAt).toBe(connected.updatedAt);
        expect(rotated.session?.refreshToken).toBe("refresh-b");
        await expect(
            store.rotateRefreshToken(database.context, "refresh-a", "refresh-c"),
        ).rejects.toThrow("changed while it was refreshing");
    });

    it("retains the seven historical migrations and removes only retired state on upgrade", async () => {
        expect(cloudMigrations.map(([key]) => key)).toEqual([
            "001-cloud-state",
            "002-cloud-social-state",
            "003-cloud-keys",
            "004-cloud-murmur-store",
            "005-cloud-enrollment",
            "006-cloud-disconnect",
            "007-cloud-disconnect-refresh-token",
            "008-cloud-workos-only",
        ]);
        const database = moduleDatabase(cloudMigrations.slice(0, 7), "cloud-upgrade");
        databases.push(database);
        await database.ready;
        const state = {
            error: null,
            pending: false,
            session: {
                environment: "staging",
                refreshToken: "retained-refresh",
                user,
                enrollment: { status: "enrolled", username: "ada", profileVersion: null },
                keys: { status: "ready" },
                keysReconciliationCallId: "obsolete-call",
            },
            updatedAt: 1_000,
            version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
        };
        await agentDatabaseRun(
            database.context.db,
            sql`INSERT INTO happy_agent_cloud_state (singleton_id, state_json)
                VALUES (1, ${JSON.stringify(state)})`,
        );
        await agentDatabaseRun(
            database.context.db,
            sql`CREATE TABLE unrelated_state (value TEXT NOT NULL)`,
        );
        await agentDatabaseRun(
            database.context.db,
            sql`INSERT INTO unrelated_state (value) VALUES ('keep')`,
        );
        const migrate = cloudMigrations[7]![1];
        await migrate(database.context, database.database);
        await migrate(database.context, database.database);
        const store = createCloudDatabase();
        await expect(store.read(database.context)).resolves.toEqual({
            ...state,
            session: { environment: "staging", refreshToken: "retained-refresh", user },
        });
        const tables = await agentDatabaseRows<{ name: string }>(
            database.context.db,
            sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        );
        expect(tables.map(({ name }) => name)).toEqual([
            "happy_agent_cloud_state",
            "unrelated_state",
        ]);
        expect(
            await agentDatabaseRows(database.context.db, sql`SELECT value FROM unrelated_state`),
        ).toEqual([{ value: "keep" }]);
        const signedOut = await store.replace(
            database.context,
            { error: null, pending: false, session: null },
            () => 999,
        );
        expect(signedOut.version > state.version).toBe(true);
    });

    it("rejects malformed durable state", async () => {
        const { database, store } = await fixture("cloud-storage-invalid");
        await store.replace(database.context, {
            error: null,
            pending: false,
            session: null,
        });
        await agentDatabaseRun(
            database.context.db,
            sql`UPDATE happy_agent_cloud_state SET state_json = ${JSON.stringify({
                refreshToken: "must-not-be-loose",
            })}`,
        );

        await expect(store.read(database.context)).rejects.toThrow(
            "The stored Cloud authentication state is invalid.",
        );
    });

    it("rejects extra fields nested inside a stored public error", async () => {
        const { database, store } = await fixture("cloud-storage-error-extra-field");
        const clean = await store.replace(database.context, {
            error: null,
            pending: false,
            session: null,
        });
        await agentDatabaseRun(
            database.context.db,
            sql`UPDATE happy_agent_cloud_state SET state_json = ${JSON.stringify({
                ...clean,
                error: {
                    code: "authorization_rejected",
                    message: "Cloud authorization was not approved.",
                    refreshToken: "must-not-be-projected",
                },
            })}`,
        );

        await expect(store.read(database.context)).rejects.toThrow(
            "The stored Cloud authentication state is invalid.",
        );
    });
});
