import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentConfig } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { queryContextAgent, queryContextRecords } from "./persistence/queryContextWindow.js";

const requestSchema = Type.Object(
    {
        provider: Type.Literal("rig"),
        directory: Type.String({ minLength: 1 }),
        sessionId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);

export type HappyContextWindowResponse =
    | {
          type: "success";
          provider: "rig";
          entries: { kind: string; content: string }[];
          limitations: ["rig_runtime_input_not_recorded"];
      }
    | { type: "error"; reason: "unsupported" | "missing" | "unreadable" };

/** The relay's existing machine RPC carries raw retained records, never a guessed model request. */
export async function readHappyContextWindow(options: {
    ctx: Context;
    ownerId: string;
    fingerprint: string;
    params: unknown;
    config: (ctx: Context, agentId: string) => Promise<AgentConfig | undefined>;
}): Promise<HappyContextWindowResponse> {
    const { params } = options;
    if (!Value.Check(requestSchema, params)) return { type: "error", reason: "unsupported" };
    try {
        return await options.ctx.inTx(async (ctx): Promise<HappyContextWindowResponse> => {
            const agentId = await queryContextAgent(
                ctx,
                options.ownerId,
                options.fingerprint,
                params.sessionId,
            );
            if (agentId === undefined) return { type: "error", reason: "missing" };
            const config = await options.config(ctx, agentId);
            if (config === undefined || config.environment?.workingDirectory !== params.directory)
                return { type: "error", reason: "missing" };
            const records = await queryContextRecords(ctx, agentId);
            if (records.length === 0) return { type: "error", reason: "missing" };
            const entries: { kind: string; content: string }[] = [];
            for (const content of records) {
                const record: unknown = JSON.parse(content);
                if (!Value.Check(recordSchema, record))
                    return { type: "error", reason: "unsupported" };
                // Do not flatten compaction.messages, omit metadata.hideFromUser, decode opaque
                // payloads, or merge this sequence with the separate user-visible History archive.
                entries.push({ kind: `context.${record.type}`, content });
            }
            return {
                type: "success",
                provider: "rig",
                entries,
                limitations: ["rig_runtime_input_not_recorded"],
            };
        });
    } catch {
        return { type: "error", reason: "unreadable" };
    }
}

/** Validate pinned envelopes while preserving every nested provider field as recorded. */
const objectSchema = Type.Record(Type.String(), Type.Unknown());
const recordSchema = Type.Union([
    Type.Object({ type: Type.Literal("user"), id: Type.String(), message: objectSchema }),
    Type.Object({ type: Type.Literal("system"), message: objectSchema }),
    Type.Object({ type: Type.Literal("tool"), id: Type.String(), message: objectSchema }),
    Type.Object({ type: Type.Literal("block"), block: objectSchema }),
    Type.Object({
        type: Type.Literal("compaction"),
        messages: Type.Array(objectSchema),
        contextToolIds: Type.Array(Type.Tuple([Type.String(), Type.String()])),
    }),
]);
