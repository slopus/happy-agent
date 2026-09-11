import { expect, it } from "vitest";

import { queryTeamDraft, saveTeamDraft } from "../../sources/api/persistence/teamDraft.js";
import { teamDraftMigration } from "../../sources/api/persistence/migrations/001-team-drafts.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

it("composes team draft reads and writes with the caller's rollback", async () => {
    const database = moduleDatabase([teamDraftMigration], "team-drafts");
    await database.ready;
    const draft = {
        text: "Private draft",
        providerId: "codex",
        modelId: "openai/gpt-5.6-sol",
        effort: "medium",
        serviceTier: null,
        permissionMode: "auto" as const,
    };
    try {
        await expect(
            database.context.inTx(async (ctx) => {
                await saveTeamDraft(ctx, "agent123", "alice123", { draft, updatedAt: 10 });
                expect(await queryTeamDraft(ctx, "agent123", "alice123")).toEqual({
                    value: draft,
                    updatedAt: 10,
                });
                expect(await queryTeamDraft(ctx, "agent123", "bob456")).toEqual({
                    value: null,
                    updatedAt: null,
                });
                throw new Error("Roll back draft");
            }),
        ).rejects.toThrow("Roll back draft");
        expect(await queryTeamDraft(database.context, "agent123", "alice123")).toEqual({
            value: null,
            updatedAt: null,
        });
        await saveTeamDraft(database.context, "agent123", "alice123", { draft, updatedAt: 10 });
        await expect(
            database.context.inTx(async (ctx) => {
                await saveTeamDraft(ctx, "agent123", "alice123", { draft: null, updatedAt: 20 });
                throw new Error("Roll back clear");
            }),
        ).rejects.toThrow("Roll back clear");
        expect(await queryTeamDraft(database.context, "agent123", "alice123")).toEqual({
            value: draft,
            updatedAt: 10,
        });
        expect(
            (
                await saveTeamDraft(database.context, "agent123", "alice123", {
                    draft: null,
                    updatedAt: 9,
                })
            ).changed,
        ).toBe(false);
        expect(
            (
                await saveTeamDraft(database.context, "agent123", "alice123", {
                    draft: null,
                    updatedAt: 10,
                })
            ).changed,
        ).toBe(true);
        expect(
            (await saveTeamDraft(database.context, "agent123", "alice123", { draft })).changed,
        ).toBe(true);
        expect(await queryTeamDraft(database.context, "otheragent", "alice123")).toEqual({
            value: null,
            updatedAt: null,
        });
    } finally {
        database.close();
    }
});
