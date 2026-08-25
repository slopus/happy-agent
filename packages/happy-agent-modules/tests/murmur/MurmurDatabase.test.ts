import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    MURMUR_BINDING_MIGRATION_KEY,
    MURMUR_PUBLIC_STATE_MIGRATION_KEY,
    MURMUR_STORE_MIGRATION_KEY,
    MURMUR_STORE_TABLE,
    advanceMurmurPublicState,
    bindMurmurProfile,
    ensureMurmurPublicState,
    murmurMigrations,
    readMurmurBinding,
    readMurmurPublicState,
    replaceMurmurIdentity,
} from "../../sources/murmur/MurmurDatabase.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const IDENTITY = "A".repeat(43);
const REPLACEMENT_IDENTITY = "B".repeat(43);
const PROFILE = "alocalprofile00000000001";
const OTHER_PROFILE = "anotherprofile0000000001";

describe("murmur binding", () => {
    it("owns a stable migration and binds one identity to one person", async () => {
        const test = moduleDatabase(murmurMigrations, "murmur-binding-create");
        await test.ready;
        try {
            expect(murmurMigrations.map(([key]) => key)).toEqual([
                MURMUR_BINDING_MIGRATION_KEY,
                MURMUR_STORE_MIGRATION_KEY,
                MURMUR_PUBLIC_STATE_MIGRATION_KEY,
            ]);
            await expect(readMurmurBinding(test.context)).resolves.toBeUndefined();

            await expect(bindMurmurProfile(test.context, PROFILE, IDENTITY, 1_000)).resolves.toBe(
                "created",
            );
            await expect(readMurmurBinding(test.context)).resolves.toEqual({
                createdAt: 1_000,
                murmurIdentity: IDENTITY,
                profileId: PROFILE,
            });

            await expect(bindMurmurProfile(test.context, PROFILE, IDENTITY, 2_000)).resolves.toBe(
                "unchanged",
            );
            await expect(readMurmurBinding(test.context)).resolves.toMatchObject({
                createdAt: 1_000,
            });
        } finally {
            test.close();
        }
    });

    it("refuses another person and refuses another identity for the bound person", async () => {
        const test = moduleDatabase(murmurMigrations, "murmur-binding-refusals");
        await test.ready;
        try {
            await bindMurmurProfile(test.context, PROFILE, IDENTITY, 1_000);

            await expect(
                bindMurmurProfile(test.context, OTHER_PROFILE, IDENTITY, 2_000),
            ).rejects.toThrow("This Murmur identity is already bound to another profile.");
            await expect(
                bindMurmurProfile(test.context, PROFILE, REPLACEMENT_IDENTITY, 2_000),
            ).rejects.toThrow("The stored Murmur identity does not match this sharing profile.");
            await expect(readMurmurBinding(test.context)).resolves.toEqual({
                createdAt: 1_000,
                murmurIdentity: IDENTITY,
                profileId: PROFILE,
            });
        } finally {
            test.close();
        }
    });

    it("persists stable unenrolled state and strictly advances through clock rollback", async () => {
        const test = moduleDatabase(murmurMigrations, "murmur-public-high-water");
        await test.ready;
        try {
            const first = await ensureMurmurPublicState(test.context, () => 1_000);
            expect(first).toMatchObject({ enrolled: false, updatedAt: 1_000 });
            await expect(ensureMurmurPublicState(test.context, () => 500)).resolves.toEqual(first);

            const second = await advanceMurmurPublicState(
                test.context,
                (current) => {
                    const { updatedAt: _updatedAt, version: _version, ...content } = current;
                    return { ...content, enrolled: true };
                },
                () => 900,
            );
            expect(second.updatedAt).toBe(1_001);
            expect(second.version > first.version).toBe(true);
            await expect(readMurmurPublicState(test.context)).resolves.toEqual(second);
        } finally {
            test.close();
        }
    });

    it("atomically replaces the keys, binding, and authoritative public projection", async () => {
        const test = moduleDatabase(murmurMigrations, "murmur-binding-replace");
        await test.ready;
        try {
            await bindMurmurProfile(test.context, PROFILE, IDENTITY, 1_000);
            await ensureMurmurPublicState(test.context, () => 1_000);
            await agentDatabaseRun(
                test.context.db,
                sql`INSERT INTO ${sql.raw(MURMUR_STORE_TABLE)} (key, value_base64)
                    VALUES ('murmur/session-states/1', 'AQID')`,
            );

            const replaced = await replaceMurmurIdentity(
                test.context,
                {
                    identity: REPLACEMENT_IDENTITY,
                    profileId: PROFILE,
                    store: new Map([["murmur/session-states/2", Uint8Array.from([4, 5, 6])]]),
                    transform: (current) => ({
                        connection: "connecting",
                        contacts: [],
                        enrolled: true,
                        identity: REPLACEMENT_IDENTITY,
                        incomingRequests: [],
                        localProfileVersion: null,
                        outgoingRequests: [],
                        pendingOperations: current.pendingOperations,
                        profileId: PROFILE,
                    }),
                },
                () => 2_000,
            );

            expect(replaced).toMatchObject({
                identity: REPLACEMENT_IDENTITY,
                profileId: PROFILE,
                updatedAt: 2_000,
            });
            await expect(
                agentDatabaseRows<{ key: string }>(
                    test.context.db,
                    sql`SELECT key FROM ${sql.raw(MURMUR_STORE_TABLE)} ORDER BY key`,
                ),
            ).resolves.toEqual([{ key: "murmur/session-states/2" }]);
            await expect(readMurmurBinding(test.context)).resolves.toEqual({
                createdAt: 1_000,
                murmurIdentity: REPLACEMENT_IDENTITY,
                profileId: PROFILE,
            });
            await expect(readMurmurPublicState(test.context)).resolves.toEqual(replaced);
        } finally {
            test.close();
        }
    });

    it("refuses replacement before a profile is bound", async () => {
        const test = moduleDatabase(murmurMigrations, "murmur-binding-replace-unbound");
        await test.ready;
        try {
            await expect(
                replaceMurmurIdentity(test.context, {
                    identity: REPLACEMENT_IDENTITY,
                    profileId: PROFILE,
                    store: new Map(),
                    transform: () => {
                        throw new Error("must not transform");
                    },
                }),
            ).rejects.toThrow("without its existing profile");
            await expect(readMurmurBinding(test.context)).resolves.toBeUndefined();
        } finally {
            test.close();
        }
    });
});
