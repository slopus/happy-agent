import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRecord } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it } from "vitest";

import { createTestRootContext } from "../../../testing/createTestRootContext.js";
import { openSessionDatabase } from "../../../persistence/database/openSessionDatabase.js";
import { migrateSessionDatabase } from "../../../persistence/database/migrateSessionDatabase.js";
import { agentRecords, onboardingState } from "../../../persistence/database/schema.js";
import { SqliteAgentPersistence } from "../SqliteAgentPersistence.js";

const temporaryDirectories: string[] = [];
const ctx = createTestRootContext().named("sqlite-agent-persistence-test");

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("SqliteAgentPersistence", () => {
    it("isolates agents and persists records and values across reopen", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".agent-persistence-test-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "sessions.sqlite");
        const firstOpened = await openSessionDatabase(ctx, path);
        await migrateSessionDatabase(firstOpened.ctx);
        const first = new SqliteAgentPersistence(firstOpened.database, "first");
        const second = new SqliteAgentPersistence(firstOpened.database, "second");
        const record: AgentRecord = {
            id: "user-record-1",
            type: "user",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
        };

        await first.append(ctx, record);
        await first.writeValue(ctx, "state.active", true);
        await second.writeValue(ctx, "state.active", false);
        await firstOpened.database.close(ctx);

        const reopened = await openSessionDatabase(ctx, path);
        await migrateSessionDatabase(reopened.ctx);
        const reopenedFirst = new SqliteAgentPersistence(reopened.database, "first");
        const reopenedSecond = new SqliteAgentPersistence(reopened.database, "second");
        expect(await reopenedFirst.load(ctx)).toEqual([record]);
        expect(await reopenedFirst.readValues(ctx, "state.")).toEqual([
            { key: "state.active", value: true },
        ]);
        expect(await reopenedSecond.readValues(ctx, "state.")).toEqual([
            { key: "state.active", value: false },
        ]);
        await reopened.database.close(ctx);
    });

    it("rolls back a failed transaction", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".agent-persistence-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const persistence = new SqliteAgentPersistence(opened.database, "agent");

        await expect(
            persistence.transaction(ctx, async (txCtx) => {
                await persistence.writeValue(txCtx, "pending", true);
                await txCtx.tx.update(onboardingState).set({ completedVersion: 99 }).run();
                throw new Error("stop");
            }),
        ).rejects.toThrow("stop");

        expect(await persistence.readValues(ctx, "")).toEqual([]);
        expect(
            await opened.database
                .select({ completedVersion: onboardingState.completedVersion })
                .from(onboardingState)
                .get(),
        ).toEqual({ completedVersion: 0 });
        await opened.database.close(ctx);
    });

    it("rejects malformed Agent Base context records", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".agent-persistence-test-"));
        temporaryDirectories.push(directory);
        const opened = await openSessionDatabase(ctx, join(directory, "sessions.sqlite"));
        await migrateSessionDatabase(opened.ctx);
        const persistence = new SqliteAgentPersistence(opened.database, "agent");
        await opened.database
            .insert(agentRecords)
            .values({
                agentId: "agent",
                recordJson: JSON.stringify({ message: { role: "user" }, type: "user" }),
            })
            .run();

        await expect(persistence.load(ctx)).rejects.toThrow(
            "Agent persistence contains an invalid context record.",
        );
        await opened.database.close(ctx);
    });
});
