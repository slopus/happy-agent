import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentDatabaseRun, withAgentDatabase } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import { EventsModule } from "../../sources/events/EventsModule.js";

const ORIGIN = "00000000-0000-7000-8000-000000000000";
const FIRST_EVENT = "00000000-0000-7000-8000-000000000001";
const SECOND_EVENT = "00000000-0000-7000-8000-000000000002";

interface SharedDatabaseFixture {
    readonly context: ReturnType<typeof withAgentDatabase>;
    readonly database: ReturnType<typeof drizzle>;
    readonly writer: DatabaseSync;
    readonly enableInterleaving: () => void;
    readonly wasInterleaved: () => boolean;
    close(): Promise<void>;
}

describe("EventsModule startup consistency", () => {
    const fixtures: SharedDatabaseFixture[] = [];

    afterEach(async () => {
        await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
    });

    it("loads the event state from one snapshot while retention advances concurrently", async () => {
        const fixture = await createSharedDatabase();
        fixtures.push(fixture);
        const events = new EventsModule();

        for (const [, migrate] of events.migrations) {
            await migrate(fixture.context, fixture.database);
        }
        await agentDatabaseRun(
            fixture.database,
            sql`INSERT INTO happy_agent_event_state (key, value)
                VALUES (${"origin_cursor"}, ${ORIGIN})`,
        );
        await agentDatabaseRun(
            fixture.database,
            sql`INSERT INTO happy_agent_events
                (event_id, agent_id, occurred_at, type, payload_json)
                VALUES
                    (${FIRST_EVENT}, ${"agent-startup"}, ${1}, ${"test.first"}, ${"{}"}),
                    (${SECOND_EVENT}, ${"agent-startup"}, ${2}, ${"test.second"}, ${"{}"})`,
        );

        fixture.enableInterleaving();
        await expect(events.beforeStart?.(fixture.context)).resolves.toBeDefined();

        expect(fixture.wasInterleaved()).toBe(true);
        expect(events.originCursor()).toBe(ORIGIN);
        expect(events.replay(events.originCursor())?.events).toHaveLength(2);
    });
});

async function createSharedDatabase(): Promise<SharedDatabaseFixture> {
    const directory = await mkdtemp(join(tmpdir(), "happy-events-startup-"));
    const databasePath = join(directory, "events.sqlite");
    const reader = new DatabaseSync(databasePath);
    const writer = new DatabaseSync(databasePath);
    reader.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA journal_mode = WAL");

    let interleave = false;
    let interleaved = false;
    const database = drizzle(async (query, params, method) => {
        const statement = reader.prepare(query);
        let result: { rows: unknown[] };
        if (method === "run") {
            statement.run(...params);
            result = { rows: [] };
        } else if (method === "get") {
            const row = statement.get(...params);
            result = { rows: row === undefined ? [] : [row] };
        } else if (method === "values") {
            statement.setReturnArrays(true);
            result = { rows: statement.all(...params) };
        } else {
            result = { rows: statement.all(...params) };
        }

        if (interleave && query.includes("FROM happy_agent_events ORDER BY event_id DESC")) {
            interleave = false;
            interleaved = true;
            writer
                .prepare("UPDATE happy_agent_event_state SET value = ? WHERE key = 'origin_cursor'")
                .run(FIRST_EVENT);
        }
        return result;
    });
    const context = withAgentDatabase(createRootContext(), database);

    return {
        context,
        database,
        writer,
        enableInterleaving: () => {
            interleave = true;
        },
        wasInterleaved: () => interleaved,
        close: async () => {
            reader.close();
            writer.close();
            await rm(directory, { force: true, recursive: true });
        },
    };
}
