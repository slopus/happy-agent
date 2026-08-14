import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";

import { inReadTx } from "../inReadTx.js";
import { inTx } from "../inTx.js";
import { agentMessageSubmissions, agentValues } from "../database/schema.js";
import {
    agentSubmissionInputSchema,
    agentSubmissionMessageSchema,
    rigMessageMetadataEnvelopeSchema,
    submissionFingerprintSchema,
} from "../../protocol/AgentMessageSubmission.js";

const statusSchema = Type.Union([
    Type.Literal("queued"),
    Type.Literal("consumed"),
    Type.Literal("settled"),
]);
const deliverySchema = Type.Union([Type.Literal("run"), Type.Literal("steer")]);
const boundedIdSchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^[^\\u0000\\r\\n]+$",
});

const submissionInputSchema = Type.Object(
    {
        agentId: boundedIdSchema,
        createdAtMs: Type.Integer({ minimum: 0 }),
        delivery: deliverySchema,
        fingerprint: submissionFingerprintSchema,
        input: agentSubmissionInputSchema,
        message: agentSubmissionMessageSchema,
        messageId: boundedIdSchema,
        metadata: rigMessageMetadataEnvelopeSchema,
        runId: boundedIdSchema,
        sessionId: boundedIdSchema,
    },
    { additionalProperties: false },
);

export type AgentMessageSubmissionInput = Static<typeof submissionInputSchema>;

const queryAgentIdsSchema = Type.Object(
    {
        afterAgentId: Type.Optional(boundedIdSchema),
        limit: Type.Integer({ minimum: 1, maximum: 256 }),
    },
    { additionalProperties: false },
);

export type QueryAgentBaseOwedAgentIds = Static<typeof queryAgentIdsSchema>;

const querySubmissionsSchema = Type.Union([
    Type.Object(
        {
            agentId: boundedIdSchema,
            limit: Type.Integer({ minimum: 1, maximum: 256 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            afterCreatedAtMs: Type.Integer({ minimum: 0 }),
            afterMessageId: boundedIdSchema,
            agentId: boundedIdSchema,
            limit: Type.Integer({ minimum: 1, maximum: 256 }),
        },
        { additionalProperties: false },
    ),
]);

export type QueryAgentMessageSubmissions = Static<typeof querySubmissionsSchema>;

const storedSubmissionSchema = Type.Object(
    {
        agentId: boundedIdSchema,
        createdAtMs: Type.Integer({ minimum: 0 }),
        delivery: deliverySchema,
        fingerprint: submissionFingerprintSchema,
        input: agentSubmissionInputSchema,
        message: agentSubmissionMessageSchema,
        messageId: boundedIdSchema,
        metadata: rigMessageMetadataEnvelopeSchema,
        runId: boundedIdSchema,
        sessionId: boundedIdSchema,
        status: statusSchema,
    },
    { additionalProperties: false },
);

export type AgentMessageSubmission = Static<typeof storedSubmissionSchema>;

const pageSchema = Type.Object(
    {
        messages: Type.Array(storedSubmissionSchema, { maxItems: 256 }),
        nextCreatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
        nextMessageId: Type.Optional(boundedIdSchema),
    },
    { additionalProperties: false },
);

export type AgentMessageSubmissionPage = Static<typeof pageSchema>;

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const OWED_KEY = "owed";
export const MAX_RETAINED_SETTLED_AGENT_MESSAGE_SUBMISSIONS = 1_024;
const retentionSchema = Type.Object(
    {
        agentId: boundedIdSchema,
        retain: Type.Integer({
            maximum: MAX_RETAINED_SETTLED_AGENT_MESSAGE_SUBMISSIONS,
            minimum: 0,
        }),
    },
    { additionalProperties: false },
);

/**
 * Record one caller-owned message envelope in the shared host transaction.
 *
 * The Agent Base identity marker remains the source of truth for Base idempotency. This row is a
 * separate host receipt: it carries the immutable protocol fingerprint and enough content and
 * metadata to retry or restore without reading opaque Base queue prefixes.
 */
export async function recordAgentMessageSubmission(
    ctx: Context,
    input: AgentMessageSubmissionInput,
): Promise<void> {
    if (!Value.Check(submissionInputSchema, input)) {
        throw new Error("The Agent message submission receipt is invalid.");
    }
    const metadataJson = encodeJson(input.metadata);
    const messageJson = encodeJson(input.message);
    const inputJson = encodeJson(input.input);
    if (
        jsonBytes(metadataJson) > MAX_JSON_BYTES ||
        jsonBytes(messageJson) > MAX_JSON_BYTES ||
        jsonBytes(inputJson) > MAX_JSON_BYTES
    ) {
        throw new Error("The Agent message submission receipt is too large.");
    }
    await inTx(ctx, "rig.sql.agent.message_submission_record", async (ctx) => {
        const inserted = await ctx.tx
            .insert(agentMessageSubmissions)
            .values({
                agentId: input.agentId,
                createdAtMs: input.createdAtMs,
                delivery: input.delivery,
                fingerprint: input.fingerprint,
                inputJson,
                messageId: input.messageId,
                messageJson,
                metadataJson,
                runId: input.runId,
                sessionId: input.sessionId,
                status: "queued",
            })
            .onConflictDoNothing({
                target: [agentMessageSubmissions.agentId, agentMessageSubmissions.messageId],
            })
            .run();
        if (inserted.rowsAffected > 0) return;
        const existing = await ctx.tx
            .select({ fingerprint: agentMessageSubmissions.fingerprint })
            .from(agentMessageSubmissions)
            .where(
                and(
                    eq(agentMessageSubmissions.agentId, input.agentId),
                    eq(agentMessageSubmissions.messageId, input.messageId),
                ),
            )
            .get();
        if (existing === undefined) {
            throw new Error("The Agent message submission receipt disappeared during retry.");
        }
        if (existing.fingerprint !== input.fingerprint) {
            throw new Error(
                `Message identity '${input.messageId}' was already used for a different submission.`,
            );
        }
    });
}

/** Look up one immutable receipt by the exact Agent/session message identity. */
export async function queryAgentMessageSubmission(
    ctx: Context,
    agentId: string,
    messageId: string,
): Promise<AgentMessageSubmission | undefined> {
    if (!Value.Check(boundedIdSchema, agentId)) {
        throw new Error("The Agent identity is invalid.");
    }
    if (!Value.Check(boundedIdSchema, messageId)) {
        throw new Error("The Agent message identity is invalid.");
    }
    return await inReadTx(ctx, "rig.sql.agent.message_submission_query", async (ctx) => {
        const row = await ctx.tx
            .select()
            .from(agentMessageSubmissions)
            .where(
                and(
                    eq(agentMessageSubmissions.agentId, agentId),
                    eq(agentMessageSubmissions.messageId, messageId),
                ),
            )
            .get();
        return row === undefined ? undefined : decodeSubmission(row);
    });
}

/** Check one Agent Base caller-owned identity marker without reading any queue or context rows. */
export async function queryAgentMessageMarker(
    ctx: Context,
    agentId: string,
    messageId: string,
): Promise<boolean> {
    if (!Value.Check(boundedIdSchema, agentId)) {
        throw new Error("The Agent identity is invalid.");
    }
    if (!Value.Check(boundedIdSchema, messageId)) {
        throw new Error("The Agent message identity is invalid.");
    }
    return await inReadTx(ctx, "rig.sql.agent.message_marker_query", async (ctx) => {
        const row = await ctx.tx
            .select({ key: agentValues.key })
            .from(agentValues)
            .where(
                and(eq(agentValues.agentId, agentId), eq(agentValues.key, `message.${messageId}`)),
            )
            .get();
        return row !== undefined;
    });
}

/** Read a bounded page of Agent identities whose Base store says work is owed. */
export async function queryAgentBaseOwedAgentIds(
    ctx: Context,
    query: QueryAgentBaseOwedAgentIds = { limit: 256 },
): Promise<readonly string[]> {
    if (!Value.Check(queryAgentIdsSchema, query)) {
        throw new Error("The owed Agent identity query is invalid.");
    }
    return await inReadTx(ctx, "rig.sql.agent.owed_ids", async (ctx) => {
        const where =
            query.afterAgentId === undefined
                ? eq(agentValues.key, OWED_KEY)
                : and(eq(agentValues.key, OWED_KEY), gt(agentValues.agentId, query.afterAgentId));
        const rows = await ctx.tx
            .select({ agentId: agentValues.agentId })
            .from(agentValues)
            .where(where)
            .orderBy(asc(agentValues.agentId))
            .limit(query.limit)
            .all();
        return rows.map((row) => row.agentId);
    });
}

/**
 * Read one bounded, indexed page of every non-settled receipt for an owed Agent.
 *
 * The cursor uses the same `(created_at_ms, message_id)` ordering as the index so startup can
 * walk an arbitrarily long durable queue without materializing it in one SQL result.
 */
export async function queryAgentMessageSubmissions(
    ctx: Context,
    query: QueryAgentMessageSubmissions,
): Promise<AgentMessageSubmissionPage> {
    if (!Value.Check(querySubmissionsSchema, query)) {
        throw new Error("The Agent message submission page query is invalid.");
    }
    return await inReadTx(ctx, "rig.sql.agent.message_submission_page", async (ctx) => {
        const clauses = [
            eq(agentMessageSubmissions.agentId, query.agentId),
            inArray(agentMessageSubmissions.status, ["queued", "consumed"] as const),
        ];
        if ("afterCreatedAtMs" in query) {
            clauses.push(
                or(
                    gt(agentMessageSubmissions.createdAtMs, query.afterCreatedAtMs),
                    and(
                        eq(agentMessageSubmissions.createdAtMs, query.afterCreatedAtMs),
                        gt(agentMessageSubmissions.messageId, query.afterMessageId),
                    ),
                )!,
            );
        }
        const rows = await ctx.tx
            .select()
            .from(agentMessageSubmissions)
            .where(and(...clauses))
            .orderBy(
                asc(agentMessageSubmissions.createdAtMs),
                asc(agentMessageSubmissions.messageId),
            )
            .limit(query.limit)
            .all();
        const messages = rows.map(decodeSubmission);
        const last = messages.at(-1);
        const page: AgentMessageSubmissionPage = {
            messages,
            ...(last === undefined
                ? {}
                : {
                      nextCreatedAtMs: last.createdAtMs,
                      nextMessageId: last.messageId,
                  }),
        };
        if (!Value.Check(pageSchema, page)) {
            throw new Error("The Agent message submission page is invalid.");
        }
        return page;
    });
}

/** Mark an accepted message as consumed inside the same Base transaction as its projection. */
export async function markAgentMessageSubmissionConsumed(
    ctx: Context,
    agentId: string,
    messageId: string,
): Promise<void> {
    await inTx(ctx, "rig.sql.agent.message_submission_consumed", async (ctx) => {
        const updated = await ctx.tx
            .update(agentMessageSubmissions)
            .set({ status: "consumed" })
            .where(
                and(
                    eq(agentMessageSubmissions.agentId, agentId),
                    eq(agentMessageSubmissions.messageId, messageId),
                    eq(agentMessageSubmissions.status, "queued"),
                ),
            )
            .run();
        if (updated.rowsAffected > 0) return;
        const existing = await ctx.tx
            .select({ status: agentMessageSubmissions.status })
            .from(agentMessageSubmissions)
            .where(
                and(
                    eq(agentMessageSubmissions.agentId, agentId),
                    eq(agentMessageSubmissions.messageId, messageId),
                ),
            )
            .get();
        if (existing === undefined) {
            throw new Error(
                `Accepted Agent message '${messageId}' has no durable Rig submission receipt.`,
            );
        }
    });
}

/** Mark all receipts for one run settled with its terminal Agent Base transaction. */
export async function markAgentMessageSubmissionsSettled(
    ctx: Context,
    agentId: string,
    runId: string,
): Promise<void> {
    await inTx(ctx, "rig.sql.agent.message_submission_settled", async (ctx) => {
        const updated = await ctx.tx
            .update(agentMessageSubmissions)
            .set({ status: "settled" })
            .where(
                and(
                    eq(agentMessageSubmissions.agentId, agentId),
                    eq(agentMessageSubmissions.runId, runId),
                    sql`${agentMessageSubmissions.status} != 'settled'`,
                ),
            )
            .run();
        if (updated.rowsAffected > 0) return;
        const existing = await ctx.tx
            .select({ messageId: agentMessageSubmissions.messageId })
            .from(agentMessageSubmissions)
            .where(
                and(
                    eq(agentMessageSubmissions.agentId, agentId),
                    eq(agentMessageSubmissions.runId, runId),
                ),
            )
            .limit(1)
            .get();
        if (existing === undefined) {
            throw new Error(`Settled Agent run '${runId}' has no durable Rig submission receipt.`);
        }
    });
}

/**
 * Keep a bounded settled idempotency archive. Queued and consumed receipts are live recovery
 * state and are never pruned by this operation.
 */
export async function pruneAgentMessageSubmissions(
    ctx: Context,
    agentId: string,
    retain = MAX_RETAINED_SETTLED_AGENT_MESSAGE_SUBMISSIONS,
): Promise<void> {
    const input = { agentId, retain };
    if (!Value.Check(retentionSchema, input)) {
        throw new Error("The Agent message submission retention request is invalid.");
    }
    await inTx(ctx, "rig.sql.agent.message_submission_prune", async (ctx) => {
        if (retain === 0) {
            await ctx.tx
                .delete(agentMessageSubmissions)
                .where(
                    and(
                        eq(agentMessageSubmissions.agentId, agentId),
                        eq(agentMessageSubmissions.status, "settled"),
                    ),
                )
                .run();
            return;
        }
        await ctx.tx.run(sql`
            DELETE FROM agent_message_submissions
            WHERE agent_id = ${agentId}
              AND status = 'settled'
              AND message_id NOT IN (
                  SELECT message_id
                  FROM agent_message_submissions
                  WHERE agent_id = ${agentId}
                    AND status = 'settled'
                  ORDER BY created_at_ms DESC, message_id DESC
                  LIMIT ${retain}
              )
        `);
    });
}

/** Apply the same settled-retention policy during normal daemon/session shutdown cleanup. */
export async function pruneSettledAgentMessageSubmissions(
    ctx: Context,
    retain = MAX_RETAINED_SETTLED_AGENT_MESSAGE_SUBMISSIONS,
): Promise<void> {
    if (
        !Value.Check(
            Type.Object(
                {
                    retain: Type.Integer({
                        maximum: MAX_RETAINED_SETTLED_AGENT_MESSAGE_SUBMISSIONS,
                        minimum: 0,
                    }),
                },
                { additionalProperties: false },
            ),
            { retain },
        )
    ) {
        throw new Error("The settled Agent message submission retention is invalid.");
    }
    await inTx(ctx, "rig.sql.agent.message_submission_prune_all", async (ctx) => {
        if (retain === 0) {
            await ctx.tx
                .delete(agentMessageSubmissions)
                .where(eq(agentMessageSubmissions.status, "settled"))
                .run();
            return;
        }
        await ctx.tx.run(sql`
            DELETE FROM agent_message_submissions
            WHERE status = 'settled'
              AND rowid NOT IN (
                  SELECT candidate.rowid
                  FROM agent_message_submissions AS candidate
                  WHERE candidate.status = 'settled'
                    AND (
                        SELECT COUNT(*)
                        FROM agent_message_submissions AS newer
                        WHERE newer.status = 'settled'
                          AND newer.agent_id = candidate.agent_id
                          AND (
                              newer.created_at_ms > candidate.created_at_ms
                              OR (
                                  newer.created_at_ms = candidate.created_at_ms
                                  AND newer.message_id > candidate.message_id
                              )
                          )
                    ) < ${retain}
              )
        `);
    });
}

function decodeSubmission(
    row: typeof agentMessageSubmissions.$inferSelect,
): AgentMessageSubmission {
    const decoded = {
        agentId: row.agentId,
        createdAtMs: row.createdAtMs,
        delivery: row.delivery,
        fingerprint: row.fingerprint,
        input: decodeJson(row.inputJson),
        message: decodeJson(row.messageJson),
        messageId: row.messageId,
        metadata: decodeJson(row.metadataJson),
        runId: row.runId,
        sessionId: row.sessionId,
        status: row.status,
    };
    if (!Value.Check(storedSubmissionSchema, decoded)) {
        throw new Error(`The Agent message submission receipt for '${row.messageId}' is invalid.`);
    }
    return decoded;
}

function encodeJson(value: unknown): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new Error("The Agent message submission receipt contains non-JSON data.");
    }
    return encoded;
}

function jsonBytes(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function decodeJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error("The Agent message submission receipt contains invalid JSON.");
    }
}
