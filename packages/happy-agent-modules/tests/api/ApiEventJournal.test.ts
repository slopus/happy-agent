import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import { ApiEventJournal, apiEventSchema } from "../../sources/api/ApiEventJournal.js";

describe("ApiEventJournal", () => {
    it("keeps private ownership off the wire and retains global cursor progress", () => {
        const journal = new ApiEventJournal(3, () => 1_755_400_000_000);
        const origin = journal.cursor();
        const standalone = journal.append("happy.integration.updated", {
            integration: "standalone",
        });
        const alice = journal.append(
            "happy.integration.updated",
            { integration: "alice" },
            1,
            "alice123",
        );
        const bob = journal.append(
            "happy.integration.updated",
            { integration: "bob" },
            1,
            "bob456",
        );
        expect(Value.Check(apiEventSchema, alice)).toBe(true);
        expect(alice).not.toHaveProperty("ownerId");
        expect(journal.visibleTo(standalone, "alice123")).toBe(false);
        expect(journal.visibleTo(alice, undefined)).toBe(false);
        expect(journal.visibleTo(alice, "alice123")).toBe(true);
        expect(journal.visibleTo(bob, "alice123")).toBe(false);
        const hiddenPage = journal.replay(origin, undefined, 1)!;
        expect(hiddenPage.events.filter((event) => journal.visibleTo(event, "alice123"))).toEqual(
            [],
        );
        expect(hiddenPage.cursor).toBe(standalone.cursor);
        expect(hiddenPage.latestCursor).toBe(bob.cursor);
        expect(journal.replay(hiddenPage.cursor, undefined, 1)?.events).toEqual([alice]);
        const publicEvent = journal.append("project.created", {});
        expect(journal.visibleTo(publicEvent, "alice123")).toBe(true);
        expect(journal.visibleTo(publicEvent, "bob456")).toBe(true);
        expect(journal.replay(origin, undefined, 3)).toBeUndefined();
    });

    it("reads from the oldest retained event when after is omitted", () => {
        const journal = new ApiEventJournal(10, () => 1_755_400_000_000);
        const first = journal.append("project.created", { project: { id: "p1" } });
        const second = journal.append("project.updated", { projectId: "p1" });

        const page = journal.replay(undefined, undefined, 10);

        expect(page?.events).toEqual([first, second]);
        expect(page?.cursor).toBe(second.cursor);
        expect(page?.latestCursor).toBe(second.cursor);
        expect(Value.Check(apiEventSchema, first)).toBe(true);
    });

    it("uses exclusive after and inclusive until bounds", () => {
        const journal = new ApiEventJournal(10, () => 1_755_400_000_000);
        const first = journal.append("project.created", {});
        const second = journal.append("project.updated", {});
        journal.append("workspace.created", {});

        expect(journal.replay(first.cursor, second.cursor, 10)?.events).toEqual([second]);
    });

    it("reports a cursor outside the retained window as unavailable", () => {
        const journal = new ApiEventJournal(2, () => 1_755_400_000_000);
        const lost = journal.append("project.created", {});
        journal.append("project.updated", {});
        journal.append("workspace.created", {});
        journal.append("workspace.updated", {});

        expect(journal.hasCursor(lost.cursor)).toBe(false);
        expect(journal.replay(lost.cursor, undefined, 2)).toBeUndefined();
    });

    it("delivers immutable snapshots and releases subscriptions", () => {
        const journal = new ApiEventJournal(10, () => 1_755_400_000_000);
        const listener = vi.fn();
        const unsubscribe = journal.subscribe(listener);
        const payload = { changes: { name: "before" } };

        const event = journal.append("project.updated", payload);
        payload.changes.name = "after";
        unsubscribe();
        journal.append("project.updated", {});

        expect(listener).toHaveBeenCalledOnce();
        expect(event.payload).toEqual({ changes: { name: "before" } });
        expect(Object.isFrozen(event.payload)).toBe(true);
    });
});
