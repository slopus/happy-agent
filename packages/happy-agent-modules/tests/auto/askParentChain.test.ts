import { describe, expect, it } from "vitest";

import {
    ASK_PARENT_ANSWER_MARGIN_MS,
    ASK_PARENT_LIMIT_REACHED,
    MAX_ASK_PARENT_QUESTIONS,
    ASK_PARENT_REVIEW_WINDOW_MS,
    ASK_PARENT_TIMEOUT_MS,
    MAX_ASK_PARENT_ANSWER_CHARACTERS,
    MAX_ASK_PARENT_HOPS,
    askParentDeadline,
    boundParentAnswer,
    canAskParent,
    unknownParentAnswer,
} from "../../sources/auto/impl/askParentChain.js";

describe("askParentChain", () => {
    it("allows at most four hops and never revisits an agent", () => {
        expect(MAX_ASK_PARENT_HOPS).toBe(4);
        expect(canAskParent(["child"], "parent")).toBe(true);
        expect(canAskParent(["child", "parent", "grand", "great"], "root")).toBe(true);
        expect(canAskParent(["child", "parent", "grand", "great", "root"], "beyond")).toBe(false);
        expect(canAskParent(["child", "parent"], "child")).toBe(false);
    });

    it("gives the first question at most a minute, inside the review's window", () => {
        const reviewStart = 1_000_000;
        const latest = reviewStart + ASK_PARENT_REVIEW_WINDOW_MS;
        expect(askParentDeadline(reviewStart, latest)).toBe(reviewStart + ASK_PARENT_TIMEOUT_MS);
        expect(askParentDeadline(reviewStart + 80_000, latest)).toBe(latest);
        expect(askParentDeadline(latest - 4_000, latest)).toBeUndefined();
    });

    it("gives every further hop less time than the one that asked it", () => {
        const now = 0;
        const first = askParentDeadline(now, ASK_PARENT_REVIEW_WINDOW_MS)!;
        const second = askParentDeadline(now, first - ASK_PARENT_ANSWER_MARGIN_MS)!;
        const third = askParentDeadline(now, second - ASK_PARENT_ANSWER_MARGIN_MS)!;
        const fourth = askParentDeadline(now, third - ASK_PARENT_ANSWER_MARGIN_MS)!;
        expect([first, second, third, fourth]).toEqual([60_000, 45_000, 30_000, 15_000]);
        expect(askParentDeadline(now, fourth - ASK_PARENT_ANSWER_MARGIN_MS)).toBeUndefined();
    });

    it("allows two questions per asker and says so past them", () => {
        expect(MAX_ASK_PARENT_QUESTIONS).toBe(2);
        expect(ASK_PARENT_LIMIT_REACHED).toBe(
            "unknown: The parent's reviewer could not answer: no more questions may be asked in this review.",
        );
    });

    it("bounds answers and spells out the unknown ones", () => {
        expect(unknownParentAnswer("No time.")).toBe("unknown: No time.");
        expect(boundParentAnswer("  Yes.  ")).toBe("Yes.");
        const long = boundParentAnswer("x".repeat(MAX_ASK_PARENT_ANSWER_CHARACTERS + 10));
        expect(long).toBe(`${"x".repeat(MAX_ASK_PARENT_ANSWER_CHARACTERS)}\n<truncated />`);
    });
});
