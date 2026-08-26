import { afterEach, describe, expect, it } from "vitest";

import {
    cloudSocialMigrations,
    createCloudSocialDatabase,
    unenrolledCloudSocialValue,
} from "../../sources/cloud/CloudSocialDatabase.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const databases: ModuleDatabase[] = [];
const remoteVersion = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const profileVersion = "01991f3a-5c1e-7001-8000-2f9a1b3c4d5e";

afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

async function fixture(name: string) {
    const database = moduleDatabase(cloudSocialMigrations, name);
    databases.push(database);
    await database.ready;
    return { database, store: createCloudSocialDatabase() };
}

describe("Cloud social storage", () => {
    it("advances public versions for list changes but not private remote-version repair", async () => {
        const { database, store } = await fixture("cloud-social-storage-version");
        const initial = await store.replace(
            database.context,
            unenrolledCloudSocialValue(),
            () => 1,
        );
        const enrolled = await store.replace(
            database.context,
            {
                blocked: [],
                connection: "connecting",
                friends: [],
                incomingRequests: [],
                outgoingRequests: [],
                remoteVersion: null,
                status: "enrolled",
                userId: "user_01H",
            },
            () => 2,
        );
        const synchronized = await store.replace(
            database.context,
            {
                blocked: [],
                connection: "connected",
                friends: [
                    {
                        firstName: "Grace",
                        username: "grace",
                        version: profileVersion,
                    },
                ],
                incomingRequests: [],
                outgoingRequests: [],
                remoteVersion,
                status: "enrolled",
                userId: "user_01H",
            },
            () => 3,
        );
        if (synchronized.state.status !== "enrolled") throw new Error("Expected enrollment.");
        const {
            updatedAt: _updatedAt,
            version: _version,
            ...synchronizedValue
        } = synchronized.state;
        const privateRepair = await store.replace(
            database.context,
            { ...synchronizedValue, remoteVersion: profileVersion },
            () => 4,
        );

        expect(initial.changed).toBe(true);
        expect(enrolled.state.version > initial.state.version).toBe(true);
        expect(synchronized.state.version > enrolled.state.version).toBe(true);
        expect(privateRepair.changed).toBe(false);
        expect(privateRepair.state.version).toBe(synchronized.state.version);
        expect(privateRepair.state.updatedAt).toBe(synchronized.state.updatedAt);
        await expect(store.read(database.context)).resolves.toEqual(privateRepair.state);
    });

    it("clears every retained profile when enrollment disappears", async () => {
        const { database, store } = await fixture("cloud-social-storage-clear");
        await store.replace(database.context, {
            blocked: [],
            connection: "connected",
            friends: [{ firstName: "Grace", username: "grace", version: profileVersion }],
            incomingRequests: [],
            outgoingRequests: [],
            remoteVersion,
            status: "enrolled",
            userId: "user_01H",
        });

        const cleared = await store.replace(database.context, unenrolledCloudSocialValue());

        expect(cleared.state).toMatchObject({
            blocked: [],
            connection: null,
            friends: [],
            incomingRequests: [],
            outgoingRequests: [],
            remoteVersion: null,
            status: "unenrolled",
            userId: null,
        });
    });
});
