import { Type, type Static } from "@sinclair/typebox";

import { autoTranscriptMessageSchema } from "./impl/createAutoPermissionTranscript.js";

/**
 * The durable shapes the Auto reviewer reads and writes, kept in one place because they cross the
 * two databases the module owns: the main agent's evidence archive in `agent.sqlite`, and the
 * private reviewer's own runtime state in `auto-agent.sqlite`.
 *
 * Everything here is validated with TypeBox before a write and after a read. The v2 review system
 * is durable where Happy Agent v1's was process memory, so a value that survives a restart has to prove it
 * is still the value it claims to be — a dangling reviewer cursor or a half-written evidence row is
 * exactly the kind of state that must fail a review closed rather than approve from a partial past.
 */

/**
 * One row of the main-agent evidence archive.
 *
 * `entry` is the message-shaped view `createAutoPermissionTranscript` classifies and budgets; the
 * denormalized `category` and `trustedUserEvidence*` fields record what the classification decided
 * at the base hook, where a message's provenance and the human-owned portion of an interactive
 * answer still existed. They let the store reason about aggregate bounds without re-deriving every
 * row, while the pure builder remains the single authority on the final transcript.
 */
export const autoEvidenceEntrySchema = Type.Object(
    {
        /** Whether this entry counts as a conversational message or as tool output for budgeting. */
        category: Type.Union([Type.Literal("message"), Type.Literal("tool")]),
        /** The exact message-shaped view the transcript builder classifies. */
        entry: autoTranscriptMessageSchema,
        /** True when this entry is trusted user authorization rather than untrusted context. */
        trustedUserEvidence: Type.Boolean(),
        /** True when a trusted entry was already truncated before it was stored. */
        trustedUserEvidenceTruncated: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type AutoEvidenceEntry = Static<typeof autoEvidenceEntrySchema>;

/**
 * The per-agent evidence cursor kept in the main database. A generation is bumped whenever the
 * conversation history the evidence describes is erased or replaced, so a review can tell that the
 * transcript it last read no longer exists. `archiveHealthy` is the fail-closed switch: once a
 * durable evidence write could not be completed, the next review must refuse rather than approve
 * from an archive it knows is incomplete.
 */
export const autoEvidenceStateSchema = Type.Object(
    {
        generation: Type.Integer({ minimum: 0 }),
        nextPosition: Type.Integer({ minimum: 0 }),
        archiveHealthy: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type AutoEvidenceState = Static<typeof autoEvidenceStateSchema>;

/**
 * The private reviewer's durable cursor, persisted beside the reviewer agent in the private
 * database. It is the durable equivalent of Happy Agent v1's in-memory `reviewedMessageCount` /
 * `reportedOwnMessageCount`: `evidenceGeneration` binds the cursor to the exact main-history
 * generation it was taken against, and the two offsets record how far into the main evidence and
 * into the reviewer's own history the last confirmed-normal review reached.
 *
 * A cursor may only be reused when the last review ended normally and the main generation still
 * matches; otherwise the reviewer is recreated and the whole current transcript is resent. This is
 * what keeps a crash from ever reusing a dangling, unanswered question.
 */
export const autoReviewerCursorSchema = Type.Object(
    {
        /** The main evidence generation this cursor was taken against. */
        evidenceGeneration: Type.Integer({ minimum: 0 }),
        /** How far into the main evidence archive the last confirmed review had read. */
        reviewedPosition: Type.Integer({ minimum: 0 }),
        /** How many of the reviewer's own history entries the last review had already reported. */
        reportedOwnEntryCount: Type.Integer({ minimum: 0 }),
        /** Whether the last review captured for this reviewer ended on a normal stop. */
        lastReviewNormal: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type AutoReviewerCursor = Static<typeof autoReviewerCursorSchema>;
