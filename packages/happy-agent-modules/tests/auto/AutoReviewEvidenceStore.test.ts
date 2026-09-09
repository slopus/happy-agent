import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentDatabaseRun, type AgentDatabase } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";

import type { AutoEvidenceEntry } from "../../sources/auto/AutoReviewTranscript.js";
import type { AutoTranscriptMessage } from "../../sources/auto/impl/createAutoPermissionTranscript.js";
import { createAutoPermissionTranscript } from "../../sources/auto/impl/createAutoPermissionTranscript.js";
import {
    userMessageEvidence,
    toolResultEvidence,
} from "../../sources/auto/impl/evidenceEntries.js";
import {
    AutoEvidenceOverflowError,
    AutoReviewEvidenceStore,
    MAX_EVIDENCE_ROWS,
} from "../../sources/auto/impl/AutoReviewEvidenceStore.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const AGENT = "agent-1";

function messageEntry(text: string, trusted = false): AutoEvidenceEntry {
    const entry: AutoTranscriptMessage = { role: "user", blocks: [{ type: "text", text }] };
    return {
        category: "message",
        entry,
        trustedUserEvidence: trusted,
        trustedUserEvidenceTruncated: false,
    };
}

describe("AutoReviewEvidenceStore", () => {
    let store: AutoReviewEvidenceStore;
    let db: ModuleDatabase & { readonly database: AgentDatabase };

    beforeEach(async () => {
        store = new AutoReviewEvidenceStore();
        db = moduleDatabase(store.migrations, "auto-evidence");
        await db.ready;
    });

    afterEach(() => {
        db.close();
    });

    it("reports a fresh healthy generation-zero state for an unseen agent", async () => {
        expect(await store.readState(db.database, AGENT)).toEqual({
            generation: 0,
            nextPosition: 0,
            archiveHealthy: true,
        });
    });

    it("appends entries and advances the cursor in order", async () => {
        await store.appendEntry(db.database, AGENT, messageEntry("first"));
        await store.appendEntry(db.database, AGENT, messageEntry("second"));

        expect(await store.readState(db.database, AGENT)).toMatchObject({
            generation: 0,
            nextPosition: 2,
            archiveHealthy: true,
        });
        const entries = await store.readEntries(db.database, AGENT, 0);
        expect(entries.map((entry) => entry.blocks[0])).toEqual([
            { type: "text", text: "first" },
            { type: "text", text: "second" },
        ]);
    });

    it("restores exact human tool requests and retains them ahead of large tool output", async () => {
        const request = {
            type: "tool_call_request" as const,
            name: "exec_command",
            arguments: { cmd: "git push origin HEAD:main" },
        };
        await store.appendEntry(
            db.database,
            AGENT,
            userMessageEvidence({ role: "user", content: [request] }, { messageOrigin: "user" })!,
        );
        await store.appendEntry(
            db.database,
            AGENT,
            toolResultEvidence({
                toolName: "read_file",
                isError: false,
                content: [{ type: "text", text: "Untrusted output ".repeat(20_000) }],
            }),
        );
        const restored = new AutoReviewEvidenceStore();
        const entries = await restored.readEntries(db.database, AGENT, 0);
        expect(entries[0]?.blocks).toEqual([request]);
        const transcript = createAutoPermissionTranscript(entries);
        expect(transcript.text).toContain("User:\nRequested tool (exec_command)");
        expect(transcript.text).toContain("git push origin HEAD:main");
        expect(transcript.userEvidenceOmitted).toBe(false);
    });

    it("marks the archive unhealthy so a later review fails closed", async () => {
        await store.markUnhealthy(db.database, AGENT);
        expect((await store.readState(db.database, AGENT)).archiveHealthy).toBe(false);
    });

    it("bumps the generation, clears old rows, and resets position", async () => {
        await store.appendEntry(db.database, AGENT, messageEntry("gen-zero"));
        await store.bumpGeneration(db.database, AGENT);

        expect(await store.readState(db.database, AGENT)).toEqual({
            generation: 1,
            nextPosition: 0,
            archiveHealthy: true,
        });
        expect(await store.readEntries(db.database, AGENT, 0)).toEqual([]);

        await store.appendEntry(db.database, AGENT, messageEntry("gen-one"));
        const entries = await store.readEntries(db.database, AGENT, 1);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.blocks[0]).toEqual({ type: "text", text: "gen-one" });
    });

    it("upserts a recorded human answer and consumes it exactly once", async () => {
        const first: AutoTranscriptMessage = {
            role: "user",
            blocks: [{ type: "text", text: "yes" }],
        };
        await store.recordUserAnswer(db.database, AGENT, "call-1", first);

        const revised: AutoTranscriptMessage = {
            role: "user",
            blocks: [{ type: "text", text: "actually no" }],
        };
        await store.recordUserAnswer(db.database, AGENT, "call-1", revised);
        expect(await store.consumeUserAnswer(db.database, AGENT, "call-1")).toEqual(revised);
        // Consumed once: a later result reusing the same call id finds nothing to trust.
        expect(await store.consumeUserAnswer(db.database, AGENT, "call-1")).toBeUndefined();
    });

    it("returns undefined for an unrecorded answer", async () => {
        expect(await store.consumeUserAnswer(db.database, AGENT, "missing")).toBeUndefined();
    });

    it("keeps evidence and state readable through a fresh store instance", async () => {
        await store.appendEntry(db.database, AGENT, messageEntry("survives reload"));

        const reloaded = new AutoReviewEvidenceStore();

        expect(await reloaded.readState(db.database, AGENT)).toEqual({
            generation: 0,
            nextPosition: 1,
            archiveHealthy: true,
        });
        expect(await reloaded.readEntries(db.database, AGENT, 0)).toEqual([
            messageEntry("survives reload").entry,
        ]);
    });

    it("fails closed when evidence exists without a state row", async () => {
        const entry = messageEntry("orphaned evidence");
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_evidence
                (agent_id, generation, position, category, entry_json,
                 trusted_user_evidence, trusted_user_evidence_truncated)
                VALUES (${AGENT}, 0, 0, ${entry.category}, ${JSON.stringify(entry.entry)}, 0, 0)`,
        );

        expect(await store.readState(db.database, AGENT)).toEqual({
            generation: 0,
            nextPosition: 0,
            archiveHealthy: false,
        });
    });

    it("rejects malformed persisted state instead of coercing it", async () => {
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_state
                (agent_id, generation, next_position, archive_healthy)
                VALUES (${AGENT}, -1, 0, 1)`,
        );

        await expect(store.readState(db.database, AGENT)).rejects.toThrow(
            `The stored auto-review state for agent "${AGENT}" is invalid.`,
        );
    });

    it("rejects non-boolean archive health encodings", async () => {
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_state
                (agent_id, generation, next_position, archive_healthy)
                VALUES (${AGENT}, 0, 0, 'not-a-boolean')`,
        );

        await expect(store.readState(db.database, AGENT)).rejects.toThrow(
            `The stored auto-review state for agent "${AGENT}" is invalid.`,
        );
    });

    it("rejects malformed persisted evidence payloads", async () => {
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_state
                (agent_id, generation, next_position, archive_healthy)
                VALUES (${AGENT}, 0, 1, 1)`,
        );
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_evidence
                (agent_id, generation, position, category, entry_json,
                 trusted_user_evidence, trusted_user_evidence_truncated)
                VALUES (${AGENT}, 0, 0, 'message', ${JSON.stringify({ role: "user" })}, 0, 0)`,
        );

        await expect(store.readEntries(db.database, AGENT, 0)).rejects.toThrow(
            `A stored auto-review evidence entry for agent "${AGENT}" is invalid.`,
        );
    });

    it("rejects malformed denormalized evidence columns instead of trusting only JSON", async () => {
        const entry = messageEntry("valid payload");
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_state
                (agent_id, generation, next_position, archive_healthy)
                VALUES (${AGENT}, 0, 1, 1)`,
        );
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_evidence
                (agent_id, generation, position, category, entry_json,
                 trusted_user_evidence, trusted_user_evidence_truncated)
                VALUES (${AGENT}, 0, 0, 'not-a-category', ${JSON.stringify(entry.entry)}, 2, 0)`,
        );

        await expect(store.readEntries(db.database, AGENT, 0)).rejects.toThrow(
            `A stored auto-review evidence entry for agent "${AGENT}" is invalid.`,
        );
    });

    it("rejects evidence positions that do not form the persisted cursor sequence", async () => {
        const entry = messageEntry("out of sequence");
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_state
                (agent_id, generation, next_position, archive_healthy)
                VALUES (${AGENT}, 0, 2, 1)`,
        );
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_evidence
                (agent_id, generation, position, category, entry_json,
                 trusted_user_evidence, trusted_user_evidence_truncated)
                VALUES (${AGENT}, 0, 1, ${entry.category}, ${JSON.stringify(entry.entry)}, 0, 0)`,
        );

        await expect(store.readEntries(db.database, AGENT, 0)).rejects.toThrow(
            "The automatic permission review evidence archive is invalid.",
        );
    });

    it("rejects malformed persisted user answers", async () => {
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_user_evidence (agent_id, call_id, content_json)
                VALUES (${AGENT}, 'call-1', ${JSON.stringify({ role: "user" })})`,
        );

        await expect(store.consumeUserAnswer(db.database, AGENT, "call-1")).rejects.toThrow(
            `A stored user answer for agent "${AGENT}" is invalid.`,
        );
    });

    it("resets an in-memory poison marker on a deliberate generation bump", async () => {
        await store.markUnhealthy(db.database, AGENT);
        expect((await store.readState(db.database, AGENT)).archiveHealthy).toBe(false);

        await store.bumpGeneration(db.database, AGENT);

        expect(await store.readState(db.database, AGENT)).toEqual({
            generation: 1,
            nextPosition: 0,
            archiveHealthy: true,
        });
    });

    it("clears stray evidence from every older generation when starting fresh", async () => {
        const entry = messageEntry("stray old generation");
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_state
                (agent_id, generation, next_position, archive_healthy)
                VALUES (${AGENT}, 0, 0, 1)`,
        );
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO happy_agent_auto_evidence
                (agent_id, generation, position, category, entry_json,
                 trusted_user_evidence, trusted_user_evidence_truncated)
                VALUES (${AGENT}, 99, 0, ${entry.category}, ${JSON.stringify(entry.entry)}, 0, 0)`,
        );

        await store.bumpGeneration(db.database, AGENT);

        expect(await store.readEntries(db.database, AGENT, 99)).toEqual([]);
    });

    it("fails closed instead of truncating an archive past its materialization ceiling", async () => {
        const entry = messageEntry("bounded");
        for (let position = 0; position <= MAX_EVIDENCE_ROWS; position += 1) {
            await agentDatabaseRun(
                db.database,
                sql`INSERT INTO happy_agent_auto_evidence
                    (agent_id, generation, position, category, entry_json,
                     trusted_user_evidence, trusted_user_evidence_truncated)
                    VALUES (${AGENT}, 0, ${position}, ${entry.category},
                            ${JSON.stringify(entry.entry)}, 0, 0)`,
            );
        }

        await expect(store.readEntries(db.database, AGENT, 0)).rejects.toBeInstanceOf(
            AutoEvidenceOverflowError,
        );
    });
});
