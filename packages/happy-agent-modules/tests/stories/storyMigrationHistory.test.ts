import { createClient } from "@libsql/client";
import { AgentStorage, type AgentModule } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { drizzle } from "drizzle-orm/libsql";
import { expect, it } from "vitest";

import { storyMigrations } from "../../sources/stories/storyMigrations.js";

it.each(["prototype", "prototype-agents", "minimal-preview", "local-fix", "fresh"])(
    "cleans retired %s Stories storage and preserves the rebuilt feed on restart",
    async (generation) => {
        const client = createClient({ url: ":memory:" });
        const ctx = createRootContext();
        const storage = new AgentStorage({
            database: drizzle(client),
            acquireLock: async () => ({ release: async () => {} }),
        });
        const stories = { name: "stories-v2", migrations: storyMigrations } satisfies AgentModule;
        try {
            await storage.migrate(ctx, [
                { name: "unrelated", migrations: [["001-keep", async () => {}]] },
            ]);
            if (generation === "minimal-preview" || generation === "local-fix") {
                await storage.migrate(ctx, [
                    {
                        name: generation === "local-fix" ? "stories-v2" : "stories",
                        migrations: storyMigrations.slice(0, 2),
                    },
                ]);
                await client.execute(`INSERT INTO happy_agent_module_stories
                    VALUES ('existing', 123, 100, '{"preserve":true}')`);
                await client.execute(
                    "INSERT INTO happy_agent_module_story_seen VALUES ('existing', 'reader')",
                );
                await client.execute(
                    "INSERT INTO happy_agent_module_story_replies VALUES ('reply', 'existing', 'reader', 'keep this reply', 101)",
                );
                if (generation === "local-fix") {
                    await client.execute("CREATE TABLE happy_agent_stories (id TEXT PRIMARY KEY)");
                    await storage.migrate(ctx, [
                        {
                            name: "stories",
                            migrations: [
                                ["001-stories", async () => {}],
                                ["002-agent-stories", async () => {}],
                            ],
                        },
                    ]);
                }
            } else if (generation !== "fresh") {
                // The retired prototype used different tables but the same ledger owner.
                for (const table of [
                    "happy_agent_stories",
                    "happy_agent_story_people",
                    "happy_agent_story_participation",
                    "happy_agent_story_reactions",
                    "happy_agent_story_seen",
                ]) {
                    await client.execute(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
                }
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
            await storage.migrate(ctx, [stories]);
            await storage.migrate(ctx, [stories]);
            expect(
                (
                    await client.execute(
                        "SELECT * FROM happy_agent_migrations WHERE module_key = 'stories' ORDER BY position",
                    )
                ).rows,
            ).toEqual([]);
            expect(
                (
                    await client.execute(
                        "SELECT migration_key FROM happy_agent_migrations WHERE module_key = 'unrelated'",
                    )
                ).rows[0]?.migration_key,
            ).toBe("001-keep");
            expect(
                (
                    await client.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('happy_agent_stories', 'happy_agent_story_people', 'happy_agent_story_participation', 'happy_agent_story_reactions', 'happy_agent_story_seen')",
                    )
                ).rows,
            ).toEqual([]);
            expect(
                (
                    await client.execute(
                        "SELECT name FROM sqlite_master WHERE name = 'happy_agent_module_story_replies'",
                    )
                ).rows,
            ).toHaveLength(1);
            if (generation === "minimal-preview" || generation === "local-fix") {
                expect(
                    (
                        await client.execute(
                            "SELECT record FROM happy_agent_module_stories WHERE id = 'existing'",
                        )
                    ).rows[0]?.record,
                ).toBe('{"preserve":true}');
                expect(
                    (await client.execute("SELECT member_id FROM happy_agent_module_story_seen"))
                        .rows[0]?.member_id,
                ).toBe("reader");
                expect(
                    (await client.execute("SELECT text FROM happy_agent_module_story_replies"))
                        .rows[0]?.text,
                ).toBe("keep this reply");
            }
        } finally {
            client.close();
        }
    },
);
