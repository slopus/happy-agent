import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const messageBreakdownSchema = Type.Object({
    toolCallTokens: count,
    toolResultTokens: count,
    attachmentTokens: count,
    assistantMessageTokens: count,
    userMessageTokens: count,
    redirectedContextTokens: count,
    unattributedTokens: count,
});
const reportSchema = Type.Object({
    totalTokens: count,
    maxTokens: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    rawMaxTokens: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    autoCompactThreshold: Type.Optional(count),
    isAutoCompactEnabled: Type.Optional(Type.Boolean()),
    messageBreakdown: Type.Optional(messageBreakdownSchema),
    categories: Type.Array(
        Type.Object({
            id: Type.Optional(Type.String()),
            tokens: count,
            kind: Type.Union([
                Type.Literal("used"),
                Type.Literal("free"),
                Type.Literal("buffer"),
                Type.Literal("deferred"),
            ]),
        }),
    ),
});

const categoryNames = [
    "messages",
    "system_prompt",
    "system_tools",
    "mcp_tools",
    "mcp_instructions",
    "custom_agents",
    "memory_files",
    "skills",
    "other",
] as const;
type Category = (typeof categoryNames)[number];

export interface ClaudeContextBudget {
    readonly inputTokens: number;
    readonly messageTokens: number;
    readonly fixedTokens: number;
    readonly unattributedTokens: number;
    readonly reserveTokens: number;
    readonly limitTokens: number;
    readonly usableTokens: number;
    readonly fits: boolean;
    readonly fixedFits: boolean;
    /** Only allowlisted category IDs and numbers; never names, paths, or content. */
    readonly categories: Readonly<Record<Category, number>>;
    /** Subtotals of messages, not additional contributions to the assembled request. */
    readonly messageDetails?: Static<typeof messageBreakdownSchema>;
}

/**
 * Interpret Claude's own assembled-context report, never characters/4 from Happy's transcript.
 * Count used rows once and retain any larger native total conservatively. Do not subtract a
 * reserve from an unexplained difference: a newer native category may account for that input.
 * Deferred schemas/free space do not count toward used rows.
 * A caller may reserve a bounded pending prompt not present in the native store yet.
 */
export function readClaudeContextBudget(report: unknown, pendingTokens = 0): ClaudeContextBudget {
    if (!Value.Check(reportSchema, report) || !Value.Check(count, pendingTokens)) {
        throw new Error("Claude did not return a valid context budget.");
    }
    return budgetFromReport(report, pendingTokens);
}

function budgetFromReport(
    report: Static<typeof reportSchema>,
    pendingTokens: number,
): ClaudeContextBudget {
    const categories = Object.fromEntries(categoryNames.map((name) => [name, 0])) as Record<
        Category,
        number
    >;
    let reserveTokens = 0;
    let usedTokens = 0;
    for (const row of report.categories) {
        if (row.kind === "buffer") reserveTokens += row.tokens;
        if (row.kind !== "used") continue;
        usedTokens += row.tokens;
        const category = categoryNames.find((name) => name === row.id) ?? "other";
        categories[category] += row.tokens;
    }
    const unassigned = Math.max(0, report.totalTokens - usedTokens);
    categories.other += unassigned;
    categories.messages += pendingTokens;
    const inputTokens = usedTokens + unassigned + pendingTokens;
    // The native limit may be a smaller compaction policy window, not the API's hard limit.
    // Keep that policy and its reserve rather than assuming every model has a 1M window.
    const usableTokens = Math.max(
        0,
        Math.min(
            report.maxTokens,
            report.rawMaxTokens - reserveTokens,
            report.isAutoCompactEnabled !== false && report.autoCompactThreshold !== undefined
                ? report.autoCompactThreshold
                : Infinity,
        ),
    );
    // Missing/new category IDs are unknown, not proof that history cannot be compacted.
    const fixedTokens = inputTokens - categories.messages - categories.other;
    if (![inputTokens, reserveTokens, fixedTokens].every(Number.isSafeInteger)) {
        throw new Error("Claude did not return a valid context budget.");
    }
    return {
        inputTokens,
        messageTokens: categories.messages,
        fixedTokens,
        unattributedTokens: categories.other,
        reserveTokens,
        limitTokens: report.rawMaxTokens,
        usableTokens,
        fits: inputTokens <= usableTokens,
        fixedFits: fixedTokens < usableTokens,
        categories,
        ...(report.messageBreakdown === undefined
            ? {}
            : {
                  messageDetails: Object.fromEntries(
                      Object.keys(messageBreakdownSchema.properties).map((key) => [
                          key,
                          report.messageBreakdown![
                              key as keyof Static<typeof messageBreakdownSchema>
                          ],
                      ]),
                  ) as Static<typeof messageBreakdownSchema>,
              }),
    };
}

/** Numeric-only diagnostic safe to persist in a failure or emit to a log. */
export function formatClaudeContextBudget(budget: ClaudeContextBudget): string {
    const components = categoryNames
        .filter((name) => budget.categories[name] > 0)
        .map((name) => `${name}=${budget.categories[name]}`)
        .join(", ");
    const details =
        budget.messageDetails === undefined
            ? ""
            : ` Message subtotals: ${Object.entries(budget.messageDetails)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(", ")}.`;
    return `Context tokens: input=${budget.inputTokens}, usable=${budget.usableTokens}, reserve=${budget.reserveTokens}, fixed=${budget.fixedTokens}; ${components}.${details}`;
}
