import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { createRootContext } from "@steve.kite/stdlib";
import { withAgentDatabase } from "@slopus/happy-agent-base";

import {
    CloudMurmurStore,
    cloudMurmurStoreMigrations,
} from "../../sources/cloud/CloudMurmurStore.js";
import { openHappyAgentDatabase } from "../../sources/runtime/HappyAgentDatabase.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const databases: ModuleDatabase[] = [];

afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

async function fixture(name: string) {
    const database = moduleDatabase(cloudMurmurStoreMigrations, name);
    databases.push(database);
    await database.ready;
    return {
        database,
        store: new CloudMurmurStore(database.database, {
            environment: "production",
            userId: "user-a",
        }),
    };
}

describe("Cloud Murmur store", () => {
    it("reads BLOB values through the runtime libSQL driver", async () => {
        const scratch = resolve(import.meta.dirname, "../../.context");
        await mkdir(scratch, { recursive: true });
        const directory = await mkdtemp(join(scratch, "cloud-murmur-runtime-"));
        const opened = await openHappyAgentDatabase(join(directory, "agent.sqlite"));
        try {
            const context = withAgentDatabase(
                createRootContext().named("cloud-murmur-runtime"),
                opened.database,
            );
            for (const [, migrate] of cloudMurmurStoreMigrations) {
                await migrate(context, opened.database);
            }
            const store = new CloudMurmurStore(opened.database, {
                environment: "production",
                userId: "user-a",
            });

            await store.set(context, "device/key", new Uint8Array([1, 2, 3]));

            await expect(store.get(context, "device/key")).resolves.toEqual(
                new Uint8Array([1, 2, 3]),
            );
            await expect(store.list(context, "device/")).resolves.toEqual(
                new Map([["device/key", new Uint8Array([1, 2, 3])]]),
            );
        } finally {
            await opened.close();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("copies values and isolates each account and deployment", async () => {
        const { database, store } = await fixture("cloud-murmur-isolation");
        const input = new Uint8Array([1, 2, 3]);
        await store.set(database.context, "device/key", input);
        input[0] = 9;

        const first = await store.get(database.context, "device/key");
        expect(first).toEqual(new Uint8Array([1, 2, 3]));
        first![1] = 9;
        await expect(store.get(database.context, "device/key")).resolves.toEqual(
            new Uint8Array([1, 2, 3]),
        );

        const anotherAccount = new CloudMurmurStore(database.database, {
            environment: "production",
            userId: "user-b",
        });
        const staging = new CloudMurmurStore(database.database, {
            environment: "staging",
            userId: "user-a",
        });
        await expect(anotherAccount.get(database.context, "device/key")).resolves.toBeUndefined();
        await expect(staging.get(database.context, "device/key")).resolves.toBeUndefined();
    });

    it("orders scans, applies cursors, and rolls failed transactions back", async () => {
        const { database, store } = await fixture("cloud-murmur-transactions");
        await store.set(database.context, "message/c", new Uint8Array([3]));
        await store.set(database.context, "message/a", new Uint8Array([1]));
        await store.set(database.context, "message/b", new Uint8Array([2]));
        await store.set(database.context, "other/a", new Uint8Array([4]));

        expect([...(await store.scan(database.context, "message/", { limit: 2 }))]).toEqual([
            ["message/a", new Uint8Array([1])],
            ["message/b", new Uint8Array([2])],
        ]);
        expect([
            ...(await store.scan(database.context, "message/", {
                after: "message/b",
                limit: 2,
            })),
        ]).toEqual([["message/c", new Uint8Array([3])]]);
        expect([...(await store.list(database.context, "message/"))].map(([key]) => key)).toEqual([
            "message/a",
            "message/b",
            "message/c",
        ]);

        await expect(
            store.tx(database.context, async (txCtx) => {
                await store.set(txCtx, "message/d", new Uint8Array([4]));
                await store.tx(txCtx, async (nestedCtx) => {
                    await store.delete(nestedCtx, "message/a");
                });
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        await expect(store.get(database.context, "message/a")).resolves.toEqual(
            new Uint8Array([1]),
        );
        await expect(store.get(database.context, "message/d")).resolves.toBeUndefined();
    });

    it("clears only the selected account", async () => {
        const { database, store } = await fixture("cloud-murmur-clear-account");
        const anotherAccount = new CloudMurmurStore(database.database, {
            environment: "production",
            userId: "user-b",
        });
        await store.set(database.context, "device/key", new Uint8Array([1]));
        await store.set(database.context, "session/a", new Uint8Array([2]));
        await anotherAccount.set(database.context, "device/key", new Uint8Array([3]));

        await store.clear(database.context);

        await expect(store.list(database.context, "")).resolves.toEqual(new Map());
        await expect(anotherAccount.get(database.context, "device/key")).resolves.toEqual(
            new Uint8Array([3]),
        );
    });
});
