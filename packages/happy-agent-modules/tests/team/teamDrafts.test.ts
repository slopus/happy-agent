import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";

import { TeamModule, type TeamDraftUpdatedEvent } from "../../sources/team/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { testProfileModule } from "../support/testProfileModule.js";

const DRAFT = {
    effort: "medium",
    modelId: "openai/gpt-5.6-sol",
    permissionMode: "auto" as const,
    providerId: "codex",
    serviceTier: null,
    text: "Private draft",
};

it("composes team draft reads and writes with the caller's rollback", async () => {
    const team = createTeam();
    const database = moduleDatabase(team.migrations, "team-drafts");
    await database.ready;
    try {
        await expect(
            database.context.inTx(async (ctx) => {
                await team.saveDraft(ctx, "agent123", "alice123", { draft: DRAFT, updatedAt: 10 });
                expect(await team.draft(ctx, "agent123", "alice123")).toEqual({
                    value: DRAFT,
                    updatedAt: 10,
                });
                expect(await team.draft(ctx, "agent123", "bob456")).toEqual({
                    value: null,
                    updatedAt: null,
                });
                throw new Error("Roll back draft");
            }),
        ).rejects.toThrow("Roll back draft");
        expect(await team.draft(database.context, "agent123", "alice123")).toEqual({
            value: null,
            updatedAt: null,
        });
        await team.saveDraft(database.context, "agent123", "alice123", {
            draft: DRAFT,
            updatedAt: 10,
        });
        await expect(
            database.context.inTx(async (ctx) => {
                await team.saveDraft(ctx, "agent123", "alice123", { draft: null, updatedAt: 20 });
                throw new Error("Roll back clear");
            }),
        ).rejects.toThrow("Roll back clear");
        expect(await team.draft(database.context, "agent123", "alice123")).toEqual({
            value: DRAFT,
            updatedAt: 10,
        });
        expect(
            (
                await team.saveDraft(database.context, "agent123", "alice123", {
                    draft: null,
                    updatedAt: 9,
                })
            ).changed,
        ).toBe(false);
        expect(
            (
                await team.saveDraft(database.context, "agent123", "alice123", {
                    draft: null,
                    updatedAt: 10,
                })
            ).changed,
        ).toBe(true);
        expect(
            (await team.saveDraft(database.context, "agent123", "alice123", { draft: DRAFT }))
                .changed,
        ).toBe(true);
        expect(await team.draft(database.context, "otheragent", "alice123")).toEqual({
            value: null,
            updatedAt: null,
        });
    } finally {
        database.close();
    }
});

it("publishes a draft update only after its transaction commits", async () => {
    const team = createTeam();
    const database = moduleDatabase(team.migrations, "team-draft-events");
    await database.ready;
    const events: TeamDraftUpdatedEvent[] = [];
    const unsubscribe = team.onDraftUpdated((_ctx, event) => {
        events.push(event);
    });
    try {
        await database.context.inTx(async (ctx) => {
            await team.saveDraft(ctx, "agent123", "alice123", { draft: DRAFT, updatedAt: 10 });
            expect(events).toEqual([]);
        });
        expect(events).toEqual([
            { agentId: "agent123", userId: "alice123", draft: { value: DRAFT, updatedAt: 10 } },
        ]);
        expect(Object.isFrozen(events[0])).toBe(true);
        expect(Object.isFrozen(events[0]?.draft.value)).toBe(true);

        await expect(
            database.context.inTx(async (ctx) => {
                await team.saveDraft(ctx, "agent123", "alice123", { draft: null, updatedAt: 20 });
                throw new Error("Roll back");
            }),
        ).rejects.toThrow("Roll back");
        expect(events).toHaveLength(1);

        await team.saveDraft(database.context, "agent123", "alice123", {
            draft: null,
            updatedAt: 9,
        });
        expect(events).toHaveLength(1);

        unsubscribe();
        await team.saveDraft(database.context, "agent123", "alice123", {
            draft: null,
            updatedAt: 30,
        });
        expect(events).toHaveLength(1);
    } finally {
        database.close();
    }
});

it("carries existing per-user drafts from the retired API table into team ownership", async () => {
    const team = createTeam();
    // Exactly the table the API module's 001-team-drafts migration created, seeded the way the
    // main runtime would have before the team migrations run behind it.
    const legacyApiTable: AgentModuleMigration = [
        "000-legacy-api-table",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE happy_agent_api_team_drafts (
                    agent_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    draft_json TEXT NOT NULL,
                    PRIMARY KEY (agent_id, user_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`INSERT INTO happy_agent_api_team_drafts (agent_id, user_id, draft_json)
                    VALUES ('agent123', 'alice123', ${JSON.stringify({ value: DRAFT, updatedAt: 10 })})`,
            );
        },
    ];
    const database = moduleDatabase([legacyApiTable, ...team.migrations], "team-draft-migration");
    await database.ready;
    try {
        expect(await team.draft(database.context, "agent123", "alice123")).toEqual({
            value: DRAFT,
            updatedAt: 10,
        });
        // The retired table keeps its rows: the move preserves, never discards.
        const remaining = await agentDatabaseRows<{ readonly n: number }>(
            database.context.db,
            sql`SELECT COUNT(*) AS n FROM happy_agent_api_team_drafts`,
        );
        expect(Number(remaining[0]?.n)).toBe(1);
    } finally {
        database.close();
    }
});

function createTeam(): TeamModule {
    return new TeamModule(
        {
            configuration: {
                values: {
                    feature: {
                        team: {
                            enabled: true,
                            host: "127.0.0.1",
                            ownerWorkOSUserId: "user_01TESTUSER123",
                            port: 3_000,
                            workosClientId: "client_test123",
                            workosOrganizationId: "org_01TESTORG123",
                        },
                    },
                },
            },
        } as never,
        testProfileModule(),
    );
}
