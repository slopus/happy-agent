import { describe, expect, it } from "vitest";

import type { FeedChange } from "../../sources/feed/FeedRecords.js";
import {
    artifactClusters,
    audienceIncludes,
    parseFeedCluster,
    subscriptionsAdmit,
} from "../../sources/feed/impl/feedClusters.js";
import { foldFeedChange, foldFeedHistory } from "../../sources/feed/impl/foldFeedChange.js";

function change(id: number, overrides: Partial<FeedChange> = {}): FeedChange {
    return {
        id: `01900000-0000-7000-8000-${String(id).padStart(12, "0")}`,
        subject: { type: "surface", id: "s1" },
        latest: { type: "todo.created", todoId: `todo${String(id)}` },
        clusters: ["surface:s1"],
        audience: { kind: "everyone" },
        actor: { userId: "u1", agentId: null },
        occurredAt: 1_000 + id,
        ...overrides,
    };
}

describe("feed folding", () => {
    it("folds creation and updates, keeping distinct actors and the newest change", () => {
        const created = change(1, {
            latest: { type: "surface.created" },
            clusters: ["team", "surface:s1"],
        });
        const agent = { userId: "u1", agentId: "a1" };
        const folded = [change(2, { actor: agent }), change(3)].reduce(
            foldFeedChange,
            foldFeedChange(undefined, created),
        );
        expect(folded).toMatchObject({
            cursor: change(3).id,
            cluster: "surface:s1",
            created: true,
            updates: 2,
            actors: [{ userId: "u1", agentId: null }, agent],
            latest: { type: "todo.created", todoId: "todo3" },
            firstAt: 1_001,
            lastAt: 1_003,
        });
    });

    it("groups history per subject, most recently changed first, within the limit", () => {
        const other = { type: "task", id: "t1" };
        const newestFirst = [
            change(4),
            change(3, { subject: other }),
            change(2),
            change(1, { subject: { type: "bot", id: "b1" } }),
        ];
        const folds = foldFeedHistory(newestFirst, 2);
        expect(folds.map((fold) => [fold.subject.id, fold.updates])).toEqual([
            ["s1", 2],
            ["t1", 1],
        ]);
    });

    it("keeps the newest change's reference when an older one arrives late", () => {
        const folded = foldFeedChange(foldFeedChange(undefined, change(5)), change(4));
        expect(folded.latest).toEqual({ type: "todo.created", todoId: "todo5" });
        expect(folded.cursor).toBe(change(5).id);
    });
});

describe("feed clusters", () => {
    it("names only known cluster kinds", () => {
        expect(parseFeedCluster("*")).toEqual({ kind: "everything" });
        expect(parseFeedCluster("task:t4k8")).toEqual({ kind: "task", id: "t4k8" });
        for (const bad of ["", "nonsense", "task:", "Task:t1", "task:T1", "agent:a1"])
            expect(parseFeedCluster(bad)).toBeUndefined();
    });

    it("maps artifact sources, with a workspace in its project too", () => {
        expect(artifactClusters({ kind: "workspace", projectId: "p1", workspaceId: "w1" })).toEqual(
            ["project:p1", "workspace:w1"],
        );
        expect(artifactClusters({ kind: "agent" })).toEqual(["team"]);
        expect(artifactClusters(undefined)).toEqual(["team"]);
    });

    it("lets a mute win and treats a missing everything choice as subscribed", () => {
        const choices = new Map<string, "subscribed" | "muted">();
        expect(subscriptionsAdmit(choices, ["team", "task:t1"])).toBe(true);
        choices.set("task:t1", "muted");
        expect(subscriptionsAdmit(choices, ["team", "task:t1"])).toBe(false);
        choices.set("*", "muted");
        choices.set("bot:b1", "subscribed");
        expect(subscriptionsAdmit(choices, ["team"])).toBe(false);
        expect(subscriptionsAdmit(choices, ["team", "bot:b1"])).toBe(true);
    });

    it("restricts a user audience in team mode only", () => {
        const audience = { kind: "users" as const, userIds: ["u1"] };
        expect(audienceIncludes(audience, "u1", false)).toBe(true);
        expect(audienceIncludes(audience, "u2", false)).toBe(false);
        expect(audienceIncludes(audience, null, true)).toBe(true);
    });
});
