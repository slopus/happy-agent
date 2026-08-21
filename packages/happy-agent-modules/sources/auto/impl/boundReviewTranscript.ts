import {
    MAX_PERMISSION_REVIEW_ENTRY_TEXT_CHARACTERS,
    REVIEW_TRANSCRIPT_TRUNCATION_MARKER,
    type PermissionReviewTranscript,
    type PermissionReviewTranscriptEntry,
    type PermissionReviewUsage,
} from "../../permissions/PermissionReviewer.js";

/**
 * Bounds what one review reveals about its own work, ported behavior-for-behavior from Happy Agent v1's
 * `createReviewTranscript`.
 *
 * A reviewer that investigates at length must not be able to grow the durable review record without
 * limit, so only the newest entries survive and each long field is truncated. Two v1 invariants
 * matter for parity and are preserved exactly:
 *
 * - the verdict is the last thing the reviewer says, so the *tail* is what is retained — the newest
 *   `MAX_TRANSCRIPT_ENTRIES` entries, not the first;
 * - usage is summed before any entry is dropped, so what a review cost stays exact even when what
 *   it said is abbreviated. The caller sums usage as the review runs and passes the total here.
 *
 * A review that produced no inference and no entries reports no transcript at all, matching v1's
 * `undefined` return.
 */

// The truncation budget and its marker are owned by the transcript schema in `PermissionReviewer`,
// so the text we produce and the bound that validates it can never drift apart: the schema's stored
// bound is exactly this budget plus the marker's length.
export const MAX_TRANSCRIPT_ENTRY_CHARACTERS = MAX_PERMISSION_REVIEW_ENTRY_TEXT_CHARACTERS;
export const MAX_TRANSCRIPT_ENTRIES = 60;

export function boundReviewTranscript(options: {
    /** Every entry the reviewer produced this review, in the order it produced them. */
    entries: readonly PermissionReviewTranscriptEntry[];
    /** The summed provider usage for this review, taken before bounding. */
    usage: PermissionReviewUsage;
    /** Whether any inference ran this review; a review that never inferred and said nothing has none. */
    inferred: boolean;
    modelId: string;
    providerId: string;
}): PermissionReviewTranscript | undefined {
    const { entries, usage, inferred, modelId, providerId } = options;
    if (!inferred && entries.length === 0) return undefined;
    return { entries: boundEntries(entries), modelId, providerId, usage };
}

function boundEntries(
    entries: readonly PermissionReviewTranscriptEntry[],
): PermissionReviewTranscriptEntry[] {
    const retained = entries.slice(-MAX_TRANSCRIPT_ENTRIES);
    return retained.map((entry) =>
        entry.type === "tool_call"
            ? { ...entry, arguments: truncate(entry.arguments) }
            : { ...entry, text: truncate(entry.text) },
    );
}

function truncate(text: string): string {
    if (text.length <= MAX_TRANSCRIPT_ENTRY_CHARACTERS) return text;
    return `${text.slice(0, MAX_TRANSCRIPT_ENTRY_CHARACTERS)}${REVIEW_TRANSCRIPT_TRUNCATION_MARKER}`;
}
