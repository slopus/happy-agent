import { describe, expect, it } from "vitest";

import { SessionDraftSync } from "./SessionDraftSync.js";

const START = 1_700_000_000_000;

interface Harness {
    pushed: { draft: string; updatedAt: number }[];
    runTimer: () => void;
    setNow: (value: number) => void;
    sync: SessionDraftSync;
}

function createHarness(
    options: {
        draft?: string;
        draftUpdatedAt?: number;
        push?: (draft: string, updatedAt: number) => Promise<void>;
    } = {},
): Harness {
    const pushed: { draft: string; updatedAt: number }[] = [];
    let scheduled: (() => void) | undefined;
    let now = START;
    const sync = new SessionDraftSync({
        origin: "terminal-a",
        ...(options.draft === undefined ? {} : { draft: options.draft }),
        ...(options.draftUpdatedAt === undefined ? {} : { draftUpdatedAt: options.draftUpdatedAt }),
        now: () => now,
        push:
            options.push ??
            ((draft, updatedAt) => {
                pushed.push({ draft, updatedAt });
                return Promise.resolve();
            }),
        setTimer: (callback) => {
            scheduled = callback;
            return 0 as unknown as NodeJS.Timeout;
        },
        clearTimer: () => {
            scheduled = undefined;
        },
    });
    return {
        pushed,
        runTimer: () => {
            const callback = scheduled;
            scheduled = undefined;
            callback?.();
        },
        setNow: (value) => {
            now = value;
        },
        sync,
    };
}

function drafts(pushed: { draft: string }[]): string[] {
    return pushed.map((entry) => entry.draft);
}

describe("SessionDraftSync", () => {
    it("coalesces typing into one write per pause", async () => {
        const { pushed, runTimer, sync } = createHarness();

        sync.recordLocalText("f");
        sync.recordLocalText("fi");
        sync.recordLocalText("fix");
        expect(drafts(pushed)).toEqual([]);

        runTimer();
        await sync.flush();
        expect(drafts(pushed)).toEqual(["fix"]);
    });

    it("does not write a draft that already matches the daemon", async () => {
        const { pushed, runTimer, sync } = createHarness({ draft: "restored" });

        sync.recordLocalText("restored");
        runTimer();
        await sync.flush();

        expect(drafts(pushed)).toEqual([]);
    });

    it("ignores the echo of its own draft", () => {
        const { sync } = createHarness();

        expect(sync.applyRemoteDraft("mine", "terminal-a", START)).toBeUndefined();
    });

    it("adopts a draft written by another client", () => {
        const { sync } = createHarness();

        expect(sync.applyRemoteDraft("from the phone", "phone", START)).toBe("from the phone");
    });

    it("keeps local text when the user typed here more recently", async () => {
        const { pushed, runTimer, setNow, sync } = createHarness();

        setNow(START + 5_000);
        sync.recordLocalText("typing here");

        // The other client's message was typed before this one.
        expect(sync.applyRemoteDraft("from the phone", "phone", START + 1_000)).toBeUndefined();

        runTimer();
        await sync.flush();
        expect(pushed).toEqual([{ draft: "typing here", updatedAt: START + 5_000 }]);
    });

    it("drops an unsent local edit that a newer message replaced", async () => {
        const { pushed, runTimer, setNow, sync } = createHarness();

        setNow(START + 1_000);
        sync.recordLocalText("typed first");

        // A message typed after this one wins, and the losing edit is not
        // written back when the debounce fires.
        expect(sync.applyRemoteDraft("typed second", "phone", START + 5_000)).toBe("typed second");

        runTimer();
        await sync.flush();
        expect(drafts(pushed)).toEqual([]);
    });

    it("ignores a draft that was typed before the one it already holds", () => {
        const { sync } = createHarness({ draft: "newest", draftUpdatedAt: START + 5_000 });

        expect(sync.applyRemoteDraft("older", "phone", START + 1_000)).toBeUndefined();
        expect(sync.remote).toBe("newest");
    });

    it("stamps an edit when it was typed, not when it is written", async () => {
        const { pushed, runTimer, setNow, sync } = createHarness();

        setNow(START + 1_000);
        sync.recordLocalText("typed early");
        setNow(START + 9_000);
        runTimer();
        await sync.flush();

        expect(pushed).toEqual([{ draft: "typed early", updatedAt: START + 1_000 }]);
    });

    it("stops writing once disposed so teardown does not clear the draft", async () => {
        const { pushed, runTimer, sync } = createHarness({ draft: "unsent work" });

        sync.dispose();
        sync.recordLocalText("");
        runTimer();
        await sync.flush();

        expect(drafts(pushed)).toEqual([]);
    });

    it("writes drafts in order even when a request is slow", async () => {
        const resolvers: (() => void)[] = [];
        const sent: string[] = [];
        const { runTimer, sync } = createHarness({
            push: (draft) => {
                sent.push(draft);
                return new Promise<void>((resolve) => resolvers.push(resolve));
            },
        });

        sync.recordLocalText("first");
        runTimer();
        sync.recordLocalText("second");
        runTimer();

        // The second draft waits for the slow first request instead of racing it.
        expect(sent).toEqual(["first"]);

        resolvers[0]?.();
        await new Promise((resolve) => setImmediate(resolve));
        expect(sent).toEqual(["first", "second"]);

        resolvers[1]?.();
        await sync.flush();
    });

    it("reports a failed write and re-sends the next edit", async () => {
        const attempts: string[] = [];
        const errors: unknown[] = [];
        let scheduled: (() => void) | undefined;
        const sync = new SessionDraftSync({
            origin: "terminal-a",
            push: (draft) => {
                attempts.push(draft);
                return attempts.length === 1
                    ? Promise.reject(new Error("daemon unavailable"))
                    : Promise.resolve();
            },
            onError: (error) => errors.push(error),
            setTimer: (callback) => {
                scheduled = callback;
                return 0 as unknown as NodeJS.Timeout;
            },
            clearTimer: () => {
                scheduled = undefined;
            },
        });

        sync.recordLocalText("draft");
        scheduled?.();
        await sync.flush();
        expect(attempts).toEqual(["draft"]);
        expect(errors).toHaveLength(1);

        sync.recordLocalText("draft more");
        scheduled?.();
        await sync.flush();
        expect(attempts).toEqual(["draft", "draft more"]);
    });
});
