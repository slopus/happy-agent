import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    cloudKeysMigrations,
    createCloudKeysDatabase,
    type CloudKeysAccount,
} from "../../sources/cloud/CloudKeysDatabase.js";
import {
    cloudEnrollmentMigrations,
    cloudMigrations,
    createCloudDatabase,
} from "../../sources/cloud/CloudDatabase.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const databases: ModuleDatabase[] = [];
const account: CloudKeysAccount = { environment: "production", userId: "user-a" };
const rootSecret = Buffer.alloc(32, 1).toString("base64url");
const identityKey = Buffer.alloc(32, 2).toString("base64url");

afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

async function fixture(name: string) {
    const database = moduleDatabase([...cloudMigrations, ...cloudKeysMigrations], name);
    databases.push(database);
    await database.ready;
    return { database, store: createCloudKeysDatabase() };
}

describe("Cloud key storage", () => {
    it("marks a connected account from before Cloud keys as requiring safe restoration", async () => {
        const database = moduleDatabase(cloudMigrations, "cloud-key-storage-upgrade");
        databases.push(database);
        await database.ready;
        await agentDatabaseRun(
            database.context.db,
            sql`INSERT INTO happy_agent_cloud_state (singleton_id, state_json)
                VALUES (1, ${JSON.stringify({
                    error: null,
                    pending: false,
                    session: {
                        environment: "production",
                        refreshToken: "refresh-a",
                        user: {
                            email: "person@example.com",
                            firstName: "Ada",
                            id: "user-a",
                            lastName: null,
                        },
                    },
                    updatedAt: 1,
                    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
                })})`,
        );

        const migration = cloudKeysMigrations[0];
        if (migration === undefined) throw new Error("Cloud key migration is missing.");
        await migration[1](database.context, database.database);
        const enrollmentMigration = cloudEnrollmentMigrations[0];
        if (enrollmentMigration === undefined) {
            throw new Error("Cloud enrollment migration is missing.");
        }
        await enrollmentMigration[1](database.context, database.database);

        await expect(createCloudDatabase().read(database.context)).resolves.toMatchObject({
            session: {
                enrollment: { status: "checking" },
                keys: { status: "restore_required" },
                user: { id: "user-a" },
            },
        });
    });

    it("persists staged and ready account roots without crossing account boundaries", async () => {
        const { database, store } = await fixture("cloud-key-storage");
        expect(await store.read(database.context, account)).toBeUndefined();

        await store.write(database.context, account, {
            bundle: "encrypted-bundle",
            identityKey,
            rootSecret,
            status: "staged",
        });
        await expect(store.read(database.context, account)).resolves.toEqual({
            bundle: "encrypted-bundle",
            identityKey,
            rootSecret,
            status: "staged",
        });
        await expect(
            store.read(database.context, { ...account, userId: "user-b" }),
        ).resolves.toBeUndefined();
        await expect(
            store.read(database.context, { ...account, environment: "staging" }),
        ).resolves.toBeUndefined();

        await store.write(database.context, account, {
            identityKey,
            rootSecret,
            status: "ready",
        });
        await expect(store.read(database.context, account)).resolves.toEqual({
            identityKey,
            rootSecret,
            status: "ready",
        });
    });

    it("rejects malformed key material before persistence", async () => {
        const { database, store } = await fixture("cloud-key-storage-invalid");

        await expect(
            store.write(database.context, account, {
                identityKey,
                rootSecret: "not-a-root",
                status: "ready",
            } as never),
        ).rejects.toThrow("Cloud key state is invalid");
        await expect(store.read(database.context, account)).resolves.toBeUndefined();
    });
});
