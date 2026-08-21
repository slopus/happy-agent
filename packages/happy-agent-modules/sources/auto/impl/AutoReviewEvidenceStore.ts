import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";

import {
    autoTranscriptMessageSchema,
    type AutoTranscriptMessage,
} from "./createAutoPermissionTranscript.js";
import {
    autoEvidenceEntrySchema,
    autoEvidenceStateSchema,
    type AutoEvidenceEntry,
    type AutoEvidenceState,
} from "../AutoReviewTranscript.js";

/**
 * The main-agent evidence archive, owned by `AutoModule` in the main database.
 *
 * Happy Agent v1 built the reviewer's transcript straight from the live conversation. That is exactly what
 * cannot be reproduced from `HistoryModule.messages()`, whose public record intentionally drops the
 * message provenance, the collaboration origin, and the human-owned portion of an interactive
 * answer that the reviewer's trust classification depends on. So `AutoModule` observes the base
 * hooks while those facts still exist and stores a purpose-built archive here, in its own main
 * migration, rather than reconstructing them later from a lossy view.
 *
 * The archive is generation-stamped: erasing or replacing the conversation the evidence describes
 * bumps the generation and clears the old rows, and a review that finds a newer generation than its
 * reviewer was built against knows its whole transcript is stale. It is also fail-closed: a write
 * that could not be completed marks the archive unhealthy, and the next review refuses rather than
 * approving from evidence it knows is incomplete.
 *
 * Every stored JSON payload is validated with TypeBox before a write and after a read, so a
 * corrupted or partially written row fails the review instead of feeding the reviewer a shape it
 * cannot trust.
 */

/** A hard safety ceiling on how many archived rows one review materializes. */
export const MAX_EVIDENCE_ROWS = 20_000;

/** Raised when the archived evidence exceeds the safety ceiling; the review fails closed. */
export class AutoEvidenceOverflowError extends Error {
    constructor() {
        super("The automatic permission review evidence exceeds the review budget.");
        this.name = "AutoEvidenceOverflowError";
    }
}

/** Raised when the archive's rows do not form the sequence its own cursor claims. */
class AutoEvidenceArchiveInvalidError extends Error {
    constructor() {
        super("The automatic permission review evidence archive is invalid.");
        this.name = "AutoEvidenceArchiveInvalidError";
    }
}

/** How SQLite may hand back an integer column: as a number, or as its decimal text. */
const storedIntegerSchema = Type.Union([
    Type.Integer(),
    Type.String({ pattern: "^-?[0-9]+$", maxLength: 32 }),
]);
/** A stored flag is exactly zero or one. Anything else is not a boolean this archive wrote. */
const storedFlagSchema = Type.Union([
    Type.Literal(0),
    Type.Literal(1),
    Type.Literal("0"),
    Type.Literal("1"),
]);
const stateRowSchema = Type.Object(
    {
        generation: storedIntegerSchema,
        next_position: storedIntegerSchema,
        archive_healthy: storedFlagSchema,
    },
    { additionalProperties: false },
);
const entryRowSchema = Type.Object(
    {
        position: storedIntegerSchema,
        category: autoEvidenceEntrySchema.properties.category,
        entry_json: Type.String(),
        trusted_user_evidence: storedFlagSchema,
        trusted_user_evidence_truncated: storedFlagSchema,
    },
    { additionalProperties: false },
);

type StateRow = Static<typeof stateRowSchema>;
type EntryRow = Static<typeof entryRowSchema>;

interface CountRow {
    count: number | string;
}

interface ContentRow {
    content_json: string;
}

export class AutoReviewEvidenceStore {
    /**
     * Agents whose archive could not be durably marked unhealthy after a failed write. When even the
     * poison marker cannot be persisted — a transaction so broken that no write in it survives — this
     * process must still refuse to review from an archive it knows is incomplete, so the fact is held
     * in memory and honored by {@link readState} until a deliberate generation bump resets it.
     */
    readonly #poisoned = new Set<string>();
    /**
     * The module's own first migration. Agent Base runs its core migrations plus this one; there is
     * no legacy repair or compatibility path because these tables are new.
     */
    readonly migrations: readonly AgentModuleMigration[] = [
        [
            "001-auto-evidence",
            async (_ctx, database) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE happy_agent_auto_evidence (
                        agent_id TEXT NOT NULL,
                        generation INTEGER NOT NULL,
                        position INTEGER NOT NULL,
                        category TEXT NOT NULL,
                        entry_json TEXT NOT NULL,
                        trusted_user_evidence INTEGER NOT NULL,
                        trusted_user_evidence_truncated INTEGER NOT NULL,
                        PRIMARY KEY (agent_id, generation, position)
                    )`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE happy_agent_auto_state (
                        agent_id TEXT PRIMARY KEY,
                        generation INTEGER NOT NULL,
                        next_position INTEGER NOT NULL,
                        archive_healthy INTEGER NOT NULL
                    )`,
                );
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE happy_agent_auto_user_evidence (
                        agent_id TEXT NOT NULL,
                        call_id TEXT NOT NULL,
                        content_json TEXT NOT NULL,
                        PRIMARY KEY (agent_id, call_id)
                    )`,
                );
            },
        ],
    ];

    /** The current cursor for an agent, defaulting to a fresh, healthy generation-zero archive. */
    async readState(database: AgentDatabase, agentId: string): Promise<AutoEvidenceState> {
        const rows = await agentDatabaseRows<Record<string, unknown>>(
            database,
            sql`SELECT generation, next_position, archive_healthy
                FROM happy_agent_auto_state WHERE agent_id = ${agentId}`,
        );
        const row = rows[0];
        const poisoned = this.#poisoned.has(agentId);
        if (row === undefined) {
            // A brand-new agent has neither a state row nor evidence, and starts healthy. But an
            // archive that has evidence rows yet no state row has lost its cursor to a partial write
            // or corruption; it must never be treated as healthy, because a review would read fewer
            // entries than were actually recorded and approve from an incomplete transcript. Absence
            // of the state row is never, by itself, evidence of health.
            const hasEvidence = await this.#hasAnyEvidence(database, agentId);
            return {
                generation: 0,
                nextPosition: 0,
                archiveHealthy: !hasEvidence && !poisoned,
            };
        }
        // The columns are checked before they are coerced: `Number` turns anything unparseable into
        // `NaN`, and a NaN health flag would read back as healthy. A row this store did not write
        // must fail the review, never quietly widen the archive's trust.
        if (!Value.Check(stateRowSchema, row)) {
            throw new Error(`The stored auto-review state for agent "${agentId}" is invalid.`);
        }
        const stateRow: StateRow = row;
        const state = {
            generation: Number(stateRow.generation),
            nextPosition: Number(stateRow.next_position),
            archiveHealthy: Number(stateRow.archive_healthy) !== 0 && !poisoned,
        };
        if (!Value.Check(autoEvidenceStateSchema, state)) {
            throw new Error(`The stored auto-review state for agent "${agentId}" is invalid.`);
        }
        return state;
    }

    async #hasAnyEvidence(database: AgentDatabase, agentId: string): Promise<boolean> {
        const rows = await agentDatabaseRows<CountRow>(
            database,
            sql`SELECT COUNT(*) AS count FROM happy_agent_auto_evidence WHERE agent_id = ${agentId}`,
        );
        return Number(rows[0]?.count ?? 0) > 0;
    }

    /**
     * Append one classified evidence entry at the archive's next position, within the caller's
     * transaction. Reading and advancing the cursor happen in the same statement stream, so a hook
     * that records a message and its evidence commits them together.
     */
    async appendEntry(
        database: AgentDatabase,
        agentId: string,
        entry: AutoEvidenceEntry,
    ): Promise<void> {
        if (!Value.Check(autoEvidenceEntrySchema, entry)) {
            throw new Error("The auto-review evidence entry is invalid.");
        }
        const state = await this.readState(database, agentId);
        const position = state.nextPosition;
        await agentDatabaseRun(
            database,
            sql`INSERT INTO happy_agent_auto_evidence
                (agent_id, generation, position, category, entry_json,
                 trusted_user_evidence, trusted_user_evidence_truncated)
                VALUES (${agentId}, ${state.generation}, ${position}, ${entry.category},
                        ${JSON.stringify(entry.entry)},
                        ${entry.trustedUserEvidence ? 1 : 0},
                        ${entry.trustedUserEvidenceTruncated ? 1 : 0})`,
        );
        await this.#writeState(database, agentId, {
            generation: state.generation,
            nextPosition: position + 1,
            archiveHealthy: state.archiveHealthy,
        });
    }

    /**
     * Record the archive as no longer trustworthy, so the next review fails closed. If the marker
     * itself cannot be persisted — the transaction is too broken for any write to survive — the fact
     * is held in memory instead, so this process still refuses to review from the incomplete archive
     * rather than reading a stale healthy row back as if nothing had gone wrong. The in-memory poison
     * is authoritative until a deliberate generation bump resets the archive.
     */
    async markUnhealthy(database: AgentDatabase, agentId: string): Promise<void> {
        this.#poisoned.add(agentId);
        try {
            const state = await this.readState(database, agentId);
            await this.#writeState(database, agentId, { ...state, archiveHealthy: false });
        } catch {
            // The durable marker could not be written; the in-memory poison above keeps this process
            // fail-closed regardless. Do not rethrow: the caller's decision not to roll back the
            // conversation stands, and the review will still refuse.
        }
    }

    /**
     * Advance to a fresh generation and clear the old one atomically. This is what a compaction's
     * `historyErasedTransact` and a recreated main agent call: the conversation the evidence
     * described is gone, so the next review will find the mismatch and rebuild its reviewer. Any
     * pending trusted user answers belong to the erased generation and are cleared with it, and the
     * in-memory poison is reset because this is a deliberate fresh start rather than a lost write.
     */
    async bumpGeneration(database: AgentDatabase, agentId: string): Promise<void> {
        const state = await this.readState(database, agentId);
        await agentDatabaseRun(
            database,
            // Every generation goes, not only the one the cursor names. A stray row left behind by
            // an interrupted bump would otherwise outlive the conversation it described and could
            // be read back later as if it were this agent's evidence.
            sql`DELETE FROM happy_agent_auto_evidence WHERE agent_id = ${agentId}`,
        );
        await agentDatabaseRun(
            database,
            sql`DELETE FROM happy_agent_auto_user_evidence WHERE agent_id = ${agentId}`,
        );
        await this.#writeState(database, agentId, {
            generation: state.generation + 1,
            nextPosition: 0,
            archiveHealthy: true,
        });
        this.#poisoned.delete(agentId);
    }

    /**
     * The archived entries for one generation, oldest first, as the transcript builder consumes them.
     *
     * The safety ceiling is enforced by reading one row past it and refusing on overflow rather than
     * silently returning the oldest `MAX_EVIDENCE_ROWS` and dropping the newest. A truncated read
     * would hide the most recent evidence — exactly the entries a review most needs — and let the
     * cursor advance past evidence it never saw, so the review is failed closed instead. In practice
     * compaction bumps the generation and clears the archive long before the ceiling is reached.
     */
    async readEntries(
        database: AgentDatabase,
        agentId: string,
        generation: number,
    ): Promise<AutoTranscriptMessage[]> {
        const rows = await agentDatabaseRows<Record<string, unknown>>(
            database,
            sql`SELECT position, category, entry_json,
                       trusted_user_evidence, trusted_user_evidence_truncated
                FROM happy_agent_auto_evidence
                WHERE agent_id = ${agentId} AND generation = ${generation}
                ORDER BY position ASC LIMIT ${MAX_EVIDENCE_ROWS + 1}`,
        );
        if (rows.length > MAX_EVIDENCE_ROWS) throw new AutoEvidenceOverflowError();

        const entries = rows.map((row, index) => {
            // Both the payload and the columns the classification denormalized are checked. A row
            // whose category or trust flag was not written by this store is corrupt even when its
            // JSON parses, and trusting the JSON alone would let it into the transcript.
            if (!Value.Check(entryRowSchema, row)) {
                throw new Error(
                    `A stored auto-review evidence entry for agent "${agentId}" is invalid.`,
                );
            }
            const entryRow: EntryRow = row;
            if (Number(entryRow.position) !== index) throw new AutoEvidenceArchiveInvalidError();
            const parsed: unknown = JSON.parse(entryRow.entry_json);
            if (!Value.Check(autoTranscriptMessageSchema, parsed)) {
                throw new Error(
                    `A stored auto-review evidence entry for agent "${agentId}" is invalid.`,
                );
            }
            return parsed;
        });

        // The rows must be exactly the sequence the cursor claims. A gap, a duplicate, or a count
        // the cursor disagrees with means evidence was lost or never committed, and a review built
        // on it would judge from a conversation that never happened in that shape.
        const state = await this.readState(database, agentId);
        const expected = generation === state.generation ? state.nextPosition : 0;
        if (entries.length !== expected) throw new AutoEvidenceArchiveInvalidError();
        return entries;
    }

    /** Record the human-owned answer to one interactive request, keyed by its request/call ID. */
    async recordUserAnswer(
        database: AgentDatabase,
        agentId: string,
        callId: string,
        content: AutoTranscriptMessage,
    ): Promise<void> {
        if (!Value.Check(autoTranscriptMessageSchema, content)) {
            throw new Error("The recorded user answer is invalid.");
        }
        await agentDatabaseRun(
            database,
            sql`INSERT INTO happy_agent_auto_user_evidence (agent_id, call_id, content_json)
                VALUES (${agentId}, ${callId}, ${JSON.stringify(content)})
                ON CONFLICT (agent_id, call_id)
                DO UPDATE SET content_json = excluded.content_json`,
        );
    }

    /**
     * The stored human answer for one request/call ID, consumed atomically so it is trusted exactly
     * once. Reading and deleting happen in the same transaction (the caller's tool-result commit), so
     * the human-owned answer authorizes the one tool result that carries its call ID and nothing
     * else: a later tool result reusing the same `(agentId, callId)` finds nothing and stays
     * untrusted, and a generation bump has already cleared any answer bound to the erased history.
     */
    async consumeUserAnswer(
        database: AgentDatabase,
        agentId: string,
        callId: string,
    ): Promise<AutoTranscriptMessage | undefined> {
        const rows = await agentDatabaseRows<ContentRow>(
            database,
            sql`SELECT content_json FROM happy_agent_auto_user_evidence
                WHERE agent_id = ${agentId} AND call_id = ${callId}`,
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        await agentDatabaseRun(
            database,
            sql`DELETE FROM happy_agent_auto_user_evidence
                WHERE agent_id = ${agentId} AND call_id = ${callId}`,
        );
        const parsed: unknown = JSON.parse(row.content_json);
        if (!Value.Check(autoTranscriptMessageSchema, parsed)) {
            throw new Error(`A stored user answer for agent "${agentId}" is invalid.`);
        }
        return parsed;
    }

    async #writeState(
        database: AgentDatabase,
        agentId: string,
        state: AutoEvidenceState,
    ): Promise<void> {
        await agentDatabaseRun(
            database,
            sql`INSERT INTO happy_agent_auto_state
                (agent_id, generation, next_position, archive_healthy)
                VALUES (${agentId}, ${state.generation}, ${state.nextPosition},
                        ${state.archiveHealthy ? 1 : 0})
                ON CONFLICT (agent_id) DO UPDATE SET
                    generation = excluded.generation,
                    next_position = excluded.next_position,
                    archive_healthy = excluded.archive_healthy`,
        );
    }
}
