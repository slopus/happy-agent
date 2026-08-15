import { describe, expect, it } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { InMemorySessionStore } from "../InMemorySessionStore.js";
import type { InMemorySession } from "../InMemorySession.js";

const ctx = createTestRootContext();
let nextMessage = 0;

async function projectUserMessage(session: InMemorySession, text: string): Promise<void> {
    const id = `message-${++nextMessage}`;
    await session.projectUserMessage(ctx, {
        delivery: "run",
        displayText: text,
        message: { blocks: [{ text, type: "text" }], id, role: "user" },
        runId: `run-${id}`,
    });
}

/**
 * Catching a conversation up from the last message a client holds.
 *
 * A gap can begin in the middle of a turn, so the unit here is a whole turn: the
 * turn holding the anchor comes back complete and the client replaces it, rather
 * than stitching the back half of one turn onto the front half it already had.
 */

async function messageEventIds(store: InMemorySessionStore, sessionId: string): Promise<string[]> {
    const session = (await store.get(ctx, sessionId))!;
    return (session.events.since(undefined) ?? [])
        .filter((event) => event.type === "message_submitted")
        .map((event) => event.id);
}

describe("paging a transcript forward", () => {
    it("resends the anchor's own turn, because the client may hold half of it", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-forward-current" });
        await projectUserMessage(session, "One.");
        const newest = (await messageEventIds(store, session.id)).at(-1)!;

        // Even a client holding the newest message gets that turn back. The
        // anchor says which message it has, not whether its turn had finished,
        // so the turn is replaced wholesale rather than assumed complete.
        const page = (await session.transcriptSince(ctx, newest))!;
        expect(JSON.stringify(page.messages)).toContain("One.");
        expect(page.complete).toBe(true);
    });

    it("returns the turn holding the anchor complete, not just what follows it", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-forward-midturn" });
        await projectUserMessage(session, "First.");
        await projectUserMessage(session, "Second.");
        const [first] = await messageEventIds(store, session.id);

        // The anchor is the first message, so its own turn must come back whole.
        const page = await session.transcriptSince(ctx, first!);
        expect(page).toBeDefined();
        const texts = JSON.stringify(page!.messages);
        expect(texts).toContain("First.");
        expect(texts).toContain("Second.");
    });

    it("includes messages the client never saw", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-forward-missed" });
        await projectUserMessage(session, "Held.");
        const anchor = (await messageEventIds(store, session.id)).at(-1)!;
        await projectUserMessage(session, "Missed one.");
        await projectUserMessage(session, "Missed two.");

        const page = (await session.transcriptSince(ctx, anchor))!;
        const texts = JSON.stringify(page.messages);
        expect(texts).toContain("Missed one.");
        expect(texts).toContain("Missed two.");
        expect(page.complete).toBe(true);
    });

    it("serves an ancient anchor while nothing has been trimmed away", async () => {
        const store = await InMemorySessionStore.open(ctx);
        const session = await store.create(ctx, { cwd: "/tmp/rig-forward-ancient" });
        await projectUserMessage(session, "Only.");

        // Older than any event this session issued, but the session still holds
        // its whole history, so paging forward from it can skip nothing.
        const page = (await session.transcriptSince(ctx, "00000000-0000-7000-8000-000000000000"))!;
        expect(JSON.stringify(page.messages)).toContain("Only.");
        expect(page.complete).toBe(true);
    });
});
