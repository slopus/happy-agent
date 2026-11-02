import { createClient } from "@libsql/client";
import { AgentStorage, type AgentModule } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { drizzle } from "drizzle-orm/libsql";
import { expect, it } from "vitest";

import { StoriesModule } from "../../sources/stories/StoriesModule.js";
import { storyMigrations } from "../../sources/stories/storyStore.js";

it.each(["prototype", "prototype-agents", "minimal-preview", "fresh"])(
    "opens %s Stories storage without losing either generation on restart",
    async (generation) => {
        const client = createClient({ url: ":memory:" });
        const ctx = createRootContext();
        const storage = new AgentStorage({
            database: drizzle(client),
            acquireLock: async () => ({ release: async () => {} }),
        });
        const stories = new StoriesModule(
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        );
        try {
            await storage.migrate(ctx, []);
            if (generation === "minimal-preview") {
                await storage.migrate(ctx, [{ name: "stories", migrations: storyMigrations }]);
                await client.execute(`INSERT INTO happy_agent_module_stories
                    VALUES ('existing', 123, 100, '{"preserve":true}')`);
            } else if (generation !== "fresh") {
                // The retired prototype used different tables but the same ledger owner.
                await client.execute("CREATE TABLE happy_agent_stories (id TEXT PRIMARY KEY)");
                await client.execute("INSERT INTO happy_agent_stories VALUES ('prototype')");
                const keys =
                    generation === "prototype"
                        ? ["001-stories"]
                        : ["001-stories", "002-agent-stories"];
                await storage.migrate(ctx, [
                    {
                        name: "stories",
                        migrations: keys.map((key) => [key, async () => {}]),
                    } satisfies AgentModule,
                ]);
            }
            const before = await client.execute(
                "SELECT * FROM happy_agent_migrations WHERE module_key = 'stories' ORDER BY position",
            );
            await storage.migrate(ctx, [stories]);
            await storage.migrate(ctx, [stories]);
            expect(
                (
                    await client.execute(
                        "SELECT * FROM happy_agent_migrations WHERE module_key = 'stories' ORDER BY position",
                    )
                ).rows,
            ).toEqual(before.rows);
            expect(
                (
                    await client.execute(
                        "SELECT name FROM sqlite_master WHERE name = 'happy_agent_module_story_replies'",
                    )
                ).rows,
            ).toHaveLength(1);
            if (generation === "minimal-preview") {
                expect(
                    (
                        await client.execute(
                            "SELECT record FROM happy_agent_module_stories WHERE id = 'existing'",
                        )
                    ).rows[0]?.record,
                ).toBe('{"preserve":true}');
            } else if (generation !== "fresh") {
                expect(
                    (await client.execute("SELECT id FROM happy_agent_stories")).rows[0]?.id,
                ).toBe("prototype");
            }
        } finally {
            client.close();
        }
    },
);
