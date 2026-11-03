import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { queryFeedChange } from "../../sources/feed/persistence/feedChanges.js";
import { queryFeedItems } from "../../sources/feed/persistence/feedItems.js";
import { feedMigrations } from "../../sources/feed/persistence/feedMigrations.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

let opened: ModuleDatabase | undefined;
afterEach(() => opened?.close());

const at = 1_755_300_000_000;
const cursor = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A change as the first Feed daemons stored it, with a snapshot of the subject. */
function legacyChange(
    n: number,
    subject: { type: string; id: string },
    verb: string,
    snapshot: object,
) {
    return {
        id: cursor(n),
        subject,
        verb,
        clusters: ["team"],
        audience: { kind: "everyone" },
        actor: { userId: "u1", agentId: null },
        snapshot,
        occurredAt: at + n,
    };
}

function legacyItem(n: number, change: ReturnType<typeof legacyChange>, updates: number) {
    return {
        id: cursor(100 + n),
        reader: "u2",
        version: cursor(100 + n),
        cursor: change.id,
        subject: change.subject,
        cluster: "team",
        created: updates === 0,
        updates,
        actors: [change.actor],
        snapshot: change.snapshot,
        firstAt: change.occurredAt,
        lastAt: change.occurredAt,
        seenAt: null,
    };
}

describe("the feed references migration", () => {
    it("drops every snapshot and names each entry's newest change instead", async () => {
        const db = moduleDatabase(feedMigrations.slice(0, 1), "feed migration");
        opened = db;
        await db.ready;
        const task = legacyChange(1, { type: "task", id: "t1" }, "task.created", {
            title: "New Task",
            agentId: "a1",
        });
        const todo = legacyChange(2, { type: "surface", id: "s1" }, "todo.created", {
            title: "Shopping",
            surfaceType: "todo",
            detail: "Milk",
        });
        const artifact = legacyChange(3, { type: "artifact", id: "r1" }, "artifact.updated", {
            title: "Q3 report",
            agentId: null,
            artifactType: "markdown",
            artifactVersion: 2,
        });
        const changes = [task, todo, artifact];
        const items = [legacyItem(1, task, 0), legacyItem(2, todo, 1), legacyItem(3, artifact, 1)];
        // An entry whose change the log no longer holds says what it was from its own snapshot.
        const orphan = {
            ...legacyItem(4, legacyChange(4, { type: "surface", id: "s2" }, "x", {}), 2),
            snapshot: { title: "Notes", surfaceType: "document" },
        };
        for (const change of changes)
            await agentDatabaseRun(
                db.database,
                sql`INSERT INTO happy_agent_feed_changes
                    (id, subject_type, subject_id, occurred_at, audience_users, record)
                    VALUES (${change.id}, ${change.subject.type}, ${change.subject.id},
                        ${change.occurredAt}, NULL, ${JSON.stringify(change)})`,
            );
        for (const item of [...items, orphan])
            await agentDatabaseRun(
                db.database,
                sql`INSERT INTO happy_agent_feed_items
                    (id, reader, subject_type, subject_id, cursor, last_at, seen_at, record)
                    VALUES (${item.id}, ${item.reader}, ${item.subject.type}, ${item.subject.id},
                        ${item.cursor}, ${item.lastAt}, NULL, ${JSON.stringify(item)})`,
            );

        await feedMigrations[1]![1](db.context, db.database);

        expect(await queryFeedChange(db.context, task.id)).toEqual({
            id: task.id,
            subject: task.subject,
            latest: { type: "task.created" },
            clusters: ["team"],
            audience: { kind: "everyone" },
            actor: task.actor,
            occurredAt: task.occurredAt,
        });
        expect((await queryFeedChange(db.context, todo.id))!.latest).toEqual({
            type: "todo.created",
        });
        expect((await queryFeedChange(db.context, artifact.id))!.latest).toEqual({
            type: "artifact.updated",
            artifactVersion: 2,
        });
        const migrated = await queryFeedItems(db.context, "u2", undefined, 10);
        expect(migrated.map((item) => [item.subject.id, item.latest])).toEqual([
            ["s2", { type: "document.edited" }],
            ["r1", { type: "artifact.updated", artifactVersion: 2 }],
            ["s1", { type: "todo.created" }],
            ["t1", { type: "task.created" }],
        ]);
        // The stored rows themselves, not only what parsing keeps, hold no entity data.
        const stored = JSON.stringify(
            await agentDatabaseRows(
                db.database,
                sql`SELECT record FROM happy_agent_feed_changes
                    UNION ALL SELECT record FROM happy_agent_feed_items`,
            ),
        );
        for (const copied of [
            "snapshot",
            "verb",
            "New Task",
            "Shopping",
            "Milk",
            "Q3 report",
            "Notes",
            "markdown",
        ])
            expect(stored).not.toContain(copied);
    });
});
