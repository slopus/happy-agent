import type { AgentPersistence, AgentRecord } from "@slopus/happy-agent-base";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { and, asc, eq, sql } from "drizzle-orm";

import { agentRecords, agentValues } from "../../persistence/database/schema.js";
import type { SessionDatabase } from "../../persistence/database/SessionDatabase.js";
import { inDatabase } from "../../persistence/database/inDatabase.js";
import { withDatabase } from "../../persistence/databaseContext.js";
import { runSessionTransaction } from "../../session/SessionTransactionContext.js";

export class SqliteAgentPersistence implements AgentPersistence {
    readonly #agentId: string;
    readonly #database: SessionDatabase;

    constructor(database: SessionDatabase, agentId: string) {
        this.#agentId = agentId;
        this.#database = database;
    }

    async transaction<Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await runSessionTransaction(withDatabase(ctx, this.#database), work);
    }

    async load(ctx: Context): Promise<readonly AgentRecord[]> {
        const rows = await inDatabase(
            withDatabase(ctx, this.#database),
            "rig.sql.agent.load",
            async (ctx) =>
                await ctx.tx
                    .select({ recordJson: agentRecords.recordJson })
                    .from(agentRecords)
                    .where(eq(agentRecords.agentId, this.#agentId))
                    .orderBy(asc(agentRecords.sequence))
                    .all(),
        );
        return rows.map((row) => decodeAgentRecord(row.recordJson));
    }

    async append(ctx: Context, record: AgentRecord): Promise<void> {
        await inDatabase(withDatabase(ctx, this.#database), "rig.sql.agent.append", async (ctx) => {
            await ctx.tx
                .insert(agentRecords)
                .values({ agentId: this.#agentId, recordJson: encodeJson(record) })
                .run();
        });
    }

    async clearRecords(ctx: Context): Promise<void> {
        await inDatabase(
            withDatabase(ctx, this.#database),
            "rig.sql.agent.clear_records",
            async (ctx) => {
                await ctx.tx
                    .delete(agentRecords)
                    .where(eq(agentRecords.agentId, this.#agentId))
                    .run();
            },
        );
    }

    async readValues(
        ctx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        const rows = await inDatabase(
            withDatabase(ctx, this.#database),
            "rig.sql.agent.read_values",
            async (ctx) =>
                await ctx.tx
                    .select({ key: agentValues.key, valueJson: agentValues.valueJson })
                    .from(agentValues)
                    .where(
                        and(
                            eq(agentValues.agentId, this.#agentId),
                            sql`substr(${agentValues.key}, 1, length(${prefix})) = ${prefix}`,
                        ),
                    )
                    .orderBy(asc(agentValues.key))
                    .all(),
        );
        return rows.map((row) => ({
            key: row.key,
            value: decodeJson(row.valueJson),
        }));
    }

    async writeValue(ctx: Context, key: string, value: unknown): Promise<void> {
        await inDatabase(
            withDatabase(ctx, this.#database),
            "rig.sql.agent.write_value",
            async (ctx) => {
                await ctx.tx
                    .insert(agentValues)
                    .values({
                        agentId: this.#agentId,
                        key,
                        valueJson: encodeJson(value),
                    })
                    .onConflictDoUpdate({
                        set: { valueJson: sql`excluded.value_json` },
                        target: [agentValues.agentId, agentValues.key],
                    })
                    .run();
            },
        );
    }

    async deleteValue(ctx: Context, key: string): Promise<void> {
        await inDatabase(
            withDatabase(ctx, this.#database),
            "rig.sql.agent.delete_value",
            async (ctx) => {
                await ctx.tx
                    .delete(agentValues)
                    .where(and(eq(agentValues.agentId, this.#agentId), eq(agentValues.key, key)))
                    .run();
            },
        );
    }
}

function encodeJson(value: unknown): string {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
        throw new Error("Agent persistence cannot store a value that is not JSON-serializable.");
    }
    return encoded;
}

const textBlockSchema = Type.Object({
    text: Type.String(),
    type: Type.Literal("text"),
});
const imageBlockSchema = Type.Object({
    data: Type.String(),
    mimeType: Type.String(),
    type: Type.Literal("image"),
});
const outputBlockSchema = Type.Union([textBlockSchema, imageBlockSchema]);
const assistantBlockSchema = Type.Union([
    textBlockSchema,
    Type.Object({
        reasoning: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        type: Type.Literal("reasoning"),
    }),
    Type.Object({
        arguments: Type.String(),
        callId: Type.String(),
        incomplete: Type.Optional(Type.Boolean()),
        name: Type.String(),
        namespace: Type.Optional(Type.String()),
        server: Type.Optional(Type.Literal(true)),
        type: Type.Literal("tool_call"),
        vendor: Type.Optional(Type.Unknown()),
    }),
    Type.Object({
        callId: Type.String(),
        content: Type.Array(outputBlockSchema),
        incomplete: Type.Optional(Type.Boolean()),
        isError: Type.Optional(Type.Boolean()),
        type: Type.Literal("tool_result"),
        vendor: Type.Optional(Type.Unknown()),
    }),
]);
const sessionMessageSchema = Type.Union([
    Type.Object({
        content: Type.Array(textBlockSchema),
        role: Type.Literal("system"),
    }),
    Type.Object({
        content: Type.Array(outputBlockSchema),
        role: Type.Literal("user"),
    }),
    Type.Object({
        agentMessageTriggerTurn: Type.Optional(Type.Boolean()),
        author: Type.String(),
        encryptedContent: Type.String(),
        header: Type.String(),
        recipient: Type.String(),
        role: Type.Literal("agent"),
    }),
    Type.Object({
        content: Type.Array(assistantBlockSchema),
        role: Type.Literal("assistant"),
    }),
    Type.Object({
        callId: Type.String(),
        content: Type.Array(outputBlockSchema),
        isError: Type.Optional(Type.Boolean()),
        role: Type.Literal("tool"),
        vendor: Type.Optional(Type.Unknown()),
    }),
    Type.Object({
        content: Type.Union([Type.String(), Type.Null()]),
        encryptedContent: Type.Union([Type.String(), Type.Null()]),
        role: Type.Literal("compaction"),
        vendor: Type.Optional(Type.Unknown()),
    }),
]);
const agentRecordSchema = Type.Union([
    Type.Object({
        message: Type.Object({
            content: Type.Array(outputBlockSchema),
            role: Type.Literal("user"),
        }),
        type: Type.Literal("user"),
    }),
    Type.Object({
        block: assistantBlockSchema,
        type: Type.Literal("block"),
    }),
    Type.Object({
        message: Type.Object({
            callId: Type.String(),
            content: Type.Array(outputBlockSchema),
            isError: Type.Optional(Type.Boolean()),
            role: Type.Literal("tool"),
            vendor: Type.Optional(Type.Unknown()),
        }),
        type: Type.Literal("tool"),
    }),
    Type.Object({
        message: Type.Object({
            content: Type.Array(textBlockSchema),
            role: Type.Literal("system"),
        }),
        type: Type.Literal("system"),
    }),
    Type.Object({
        messages: Type.Array(sessionMessageSchema),
        type: Type.Literal("compaction"),
    }),
]);
type PersistedAgentRecord = Static<typeof agentRecordSchema>;

function decodeAgentRecord(value: unknown): PersistedAgentRecord {
    const parsed = decodeJson(value);
    if (!Value.Check(agentRecordSchema, parsed)) {
        throw new Error("Agent persistence contains an invalid context record.");
    }
    return parsed;
}

function decodeJson(value: unknown): unknown {
    if (typeof value !== "string") {
        throw new Error("Agent persistence contains a non-text JSON value.");
    }
    return JSON.parse(value) as unknown;
}
