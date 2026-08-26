import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it } from "vitest";

import { MutationAwareApiEventJournal } from "../../sources/api/ApiModule.js";

describe("MutationAwareApiEventJournal", () => {
    it("keeps concurrent mutation identifiers in their own async chains", async () => {
        const mutationIds = new AsyncLocalStorage<string>();
        const journal = new MutationAwareApiEventJournal(mutationIds);
        let releaseFirst!: () => void;
        const firstMayFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        await Promise.all([
            mutationIds.run("first", async () => {
                await firstMayFinish;
                journal.append("project.updated", { projectId: "p1" });
            }),
            mutationIds.run("second", async () => {
                journal.append("workspace.updated", { workspaceId: "w1" });
                releaseFirst();
            }),
        ]);
        journal.append("git.updated", { workspaceId: "w1" });

        const payloads = journal
            .replay(undefined, undefined, 10)
            ?.events.map((event) => event.payload);
        expect(payloads).toEqual([
            { workspaceId: "w1", mutationId: "second" },
            { projectId: "p1", mutationId: "first" },
            { workspaceId: "w1" },
        ]);
    });

    it("keeps delayed background invalidations mutationless inside a mutation async chain", () => {
        const mutationIds = new AsyncLocalStorage<string>();
        const journal = new MutationAwareApiEventJournal(mutationIds);

        mutationIds.run("direct-mutation", () => {
            journal.append("example.updated", { version: "direct" });
            journal.appendOutsideMutation("example.updated", { version: "background" });
        });

        expect(
            journal.replay(undefined, undefined, 10)?.events.map((event) => event.payload),
        ).toEqual([
            { mutationId: "direct-mutation", version: "direct" },
            { version: "background" },
        ]);
    });
});
