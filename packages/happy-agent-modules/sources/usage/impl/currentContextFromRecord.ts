import { Value } from "@sinclair/typebox/value";

import { usageCurrentContextSchema, type UsageCurrentContext, type UsageRecord } from "../Usage.js";

/** Project the exact conversation measurement carried by one inference or completed turn. */
export function currentContextFromRecord(record: UsageRecord): UsageCurrentContext | null {
    const contextTokens =
        record.kind === "inference"
            ? record.tokens.input + record.tokens.output
            : record.contextTokens;
    if (contextTokens === undefined) return null;
    const context: UsageCurrentContext = {
        approximate: false,
        contextTokens,
        provider: record.provider,
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.effort === undefined ? {} : { effort: record.effort }),
        ...(record.tier === undefined ? {} : { tier: record.tier }),
    };
    if (!Value.Check(usageCurrentContextSchema, context)) {
        throw new Error("Usage record contains an invalid current context measurement.");
    }
    return context;
}
