import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    cloudEnrollment,
    cloudMigrations,
    cloudSession,
    createCloudDatabase,
} from "../../sources/cloud/CloudDatabase.js";
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

    it("stores enrollment beside the connected account without changing the public version", async () => {
        const { database, store } = await fixture("cloud-storage-enrollment");
        const connected = await store.replace(database.context, {
            error: null,
            pending: false,
            session: cloudSession("production", "refresh-a", user),
        });
        const profileVersion = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";

        const enrolled = await store.updateEnrollment(
            database.context,
            user.id,
            cloudEnrollment("ada", profileVersion),
        );

        expect(enrolled.version).toBe(connected.version);
        expect(enrolled.updatedAt).toBe(connected.updatedAt);
        expect(enrolled.session?.enrollment).toEqual({ profileVersion, username: "ada" });
        await expect(
            store.updateEnrollment(database.context, "another-user", null),
        ).rejects.toThrow("account changed");
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
