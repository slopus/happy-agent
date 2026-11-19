/**
 * The bounds on a chain of `ask_parent` questions.
 *
 * A reviewer asks its reviewed agent's parent; the parent's forked reviewer may ask the
 * grandparent, and so on toward the root. Parentage is a tree, but an identity can be recreated
 * under a reused ID, so every chain also carries the agents it has already asked and never asks one
 * twice. The whole chain has to finish inside the review that started it, with time left for each
 * asker to answer after its own question returns, so each hop gets less time than the one before
 * and a hop with too little time left is not attempted.
 */

/** The most agents one review may ask: parent, grandparent, and two more toward the root. */
export const MAX_ASK_PARENT_HOPS = 4;

/**
 * The most questions one reviewer may send in one review, and one forked reviewer in its one
 * answer. Each fork further up has its own allowance, so the chain as a whole is bounded by hops
 * and time rather than by this.
 */
export const MAX_ASK_PARENT_QUESTIONS = 2;

/** What a question past that allowance is answered. */
export const ASK_PARENT_LIMIT_REACHED =
    "unknown: The parent's reviewer could not answer: no more questions may be asked in this review.";

/** The longest the first question of a review may wait for its answer. */
export const ASK_PARENT_TIMEOUT_MS = 60_000;

/**
 * How long after the review starts the first question must have its answer. The review budget is
 * 120 seconds; the remainder is the asking reviewer's to reach its verdict.
 */
export const ASK_PARENT_REVIEW_WINDOW_MS = 90_000;

/** The time a forked reviewer keeps for itself after a question it asked further up returns. */
export const ASK_PARENT_ANSWER_MARGIN_MS = 15_000;

/** A question with less time than this left is not asked at all. */
export const MIN_ASK_PARENT_TIME_MS = 5_000;

/** The longest answer handed back to the asking reviewer. */
export const MAX_ASK_PARENT_ANSWER_CHARACTERS = 4_000;

/**
 * Whether an agent reached through `visited` may still ask its parent: the chain has hops left and
 * the parent has not been asked already.
 */
export function canAskParent(visited: readonly string[], parentAgentId: string): boolean {
    return visited.length <= MAX_ASK_PARENT_HOPS && !visited.includes(parentAgentId);
}

/**
 * When a question asked now must be answered, given the latest time its asker can wait for, or
 * `undefined` when too little time is left to ask at all.
 */
export function askParentDeadline(now: number, latestAnswerAt: number): number | undefined {
    const deadline = Math.min(now + ASK_PARENT_TIMEOUT_MS, latestAnswerAt);
    return deadline - now < MIN_ASK_PARENT_TIME_MS ? undefined : deadline;
}

/** The answer a question gets when no reviewer established one. */
export function unknownParentAnswer(reason: string): string {
    return `unknown: ${reason}`;
}

/** Bound an answer to what the asking reviewer is handed. */
export function boundParentAnswer(answer: string): string {
    const trimmed = answer.trim();
    if (trimmed.length <= MAX_ASK_PARENT_ANSWER_CHARACTERS) return trimmed;
    return `${trimmed.slice(0, MAX_ASK_PARENT_ANSWER_CHARACTERS)}\n<truncated />`;
}
