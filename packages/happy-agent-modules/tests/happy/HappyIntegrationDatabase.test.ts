import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    createHappyIntegrationDatabase,
    happyIntegrationMigrations,
    MAX_BLOCKED_CREDENTIAL_FINGERPRINTS,
} from "../../sources/happy/HappyIntegrationDatabase.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const databases: ModuleDatabase[] = [];

afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

async function createStore(name: string): Promise<{
    database: ModuleDatabase;
    integration: ReturnType<typeof createHappyIntegrationDatabase>;
}> {
    const database = moduleDatabase(happyIntegrationMigrations, name);
    databases.push(database);
    await database.ready;
    return { database, integration: createHappyIntegrationDatabase() };
}

describe("Happy integration storage", () => {
    it("starts empty and reserves durable, strictly increasing UUIDv7 versions", async () => {
        const { database, integration } = await createStore("happy-integration-versions");

        expect(await integration.read(database.context)).toEqual({
            blockedCredentialFingerprints: [],
        });
        const first = await integration.reserveVersion(database.context, () => 1_000);
        const second = await integration.reserveVersion(database.context, () => 1_000);
        const third = await integration.reserveVersion(database.context, () => 999);

        expect(first).toMatch(UUID_V7_PATTERN);
        expect(second).toMatch(UUID_V7_PATTERN);
        expect(third).toMatch(UUID_V7_PATTERN);
        expect(second > first).toBe(true);
        expect(third > second).toBe(true);
        await expect(integration.read(database.context)).resolves.toEqual({
            blockedCredentialFingerprints: [],
            version: third,
        });
    });

    it("keeps only the newest distinct blocked credential fingerprints", async () => {
        const { database, integration } = await createStore("happy-integration-blocked");
        const fingerprints = Array.from(
            { length: MAX_BLOCKED_CREDENTIAL_FINGERPRINTS + 1 },
            (_unused, index) => `credential-${String(index)}`,
        );

        for (const fingerprint of fingerprints) {
            await integration.addBlockedCredentialFingerprints(database.context, [fingerprint]);
        }
        await integration.addBlockedCredentialFingerprints(database.context, [
            fingerprints.at(-1)!,
        ]);

        await expect(integration.read(database.context)).resolves.toMatchObject({
            blockedCredentialFingerprints: fingerprints.slice(1),
        });
    });

    it("clears blocks without rewinding the version high-water mark", async () => {
        const { database, integration } = await createStore("happy-integration-clear");
        await integration.reserveVersion(database.context, () => 1_000);
        await integration.addBlockedCredentialFingerprints(database.context, ["rejected"]);
        const before = await integration.read(database.context);
        if (before.version === undefined)
            throw new Error("The version high-water mark was not stored.");

        await expect(
            integration.clearBlockedCredentialFingerprints(database.context),
        ).resolves.toEqual({
            blockedCredentialFingerprints: [],
            version: before.version,
        });
        const next = await integration.reserveVersion(database.context, () => 999);
        expect(next > before.version).toBe(true);
    });

    it("uses the caller transaction and rejects unreadable or malformed stored state", async () => {
        const { database, integration } = await createStore("happy-integration-validation");
        await database.context.inTx(async (txCtx) => {
            await integration.addBlockedCredentialFingerprints(txCtx, ["rejected"]);
            await expect(integration.read(txCtx)).resolves.toMatchObject({
                blockedCredentialFingerprints: ["rejected"],
            });
        });

        await agentDatabaseRun(
            database.context.db,
            sql`UPDATE happy_agent_happy_integration_state SET state_json = ${"not json"}`,
        );
        await expect(integration.read(database.context)).rejects.toThrow(
            "Happy Agent could not read the stored Happy integration state.",
        );

        await agentDatabaseRun(
            database.context.db,
            sql`UPDATE happy_agent_happy_integration_state SET state_json = ${JSON.stringify({
                blockedCredentialFingerprints: [],
                version: "not-a-version",
            })}`,
        );
        await expect(integration.read(database.context)).rejects.toThrow(
            "The stored Happy integration state is invalid.",
        );
    });
});
