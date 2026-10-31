import { cuid2Schema, defineAgentTool } from "@slopus/happy-agent-base";
import { taskSectionAnchorSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import type { FocusModule } from "../FocusModule.js";

// Creating, renaming, and removing sections, and child visibility, are deferred.
export const focusOpSchema = Type.Union([
    Type.Object({ op: Type.Literal("move"), taskId: cuid2Schema, after: taskSectionAnchorSchema }),
    Type.Object({ op: Type.Literal("hide"), taskId: cuid2Schema, hidden: Type.Boolean() }),
    Type.Object({ op: Type.Literal("hide"), botId: cuid2Schema, hidden: Type.Boolean() }),
]);
export type FocusOp = Static<typeof focusOpSchema>;
export const focusSkipReasonSchema = Type.Union([
    Type.Literal("held_by_person"),
    Type.Literal("not_found"),
    Type.Literal("bots_not_allowed"),
]);
export type FocusSkipReason = Static<typeof focusSkipReasonSchema>;

const organizeTasksInputSchema = Type.Object(
    {
        ops: Type.Array(focusOpSchema, { minItems: 1, maxItems: 50 }),
        note: Type.Optional(Type.String({ maxLength: 200 })),
    },
    { additionalProperties: false },
);
export const organizeTasksResultSchema = Type.Union([
    Type.Object({
        applied: Type.Integer(),
        skipped: Type.Array(Type.Object({ index: Type.Integer(), reason: focusSkipReasonSchema })),
    }),
    Type.Object({ error: Type.Literal("off") }),
]);
export type OrganizeTasksResult = Static<typeof organizeTasksResultSchema>;

/** Focus's one tool: arrange its person's list in one transaction. */
export function organizeTasksTool(focus: FocusModule, memberId: string) {
    return defineAgentTool({
        name: "organize_tasks",
        // Focus's whole array, which it receives without tool search.
        defer: false,
        capabilities: ["Move and hide tasks in the person's task list."],
        description: [
            "Arrange the person's task list. Operations apply in order, in one step:",
            '- move: { op: "move", taskId, after }, where after is { taskId }, { sectionId } (first in that section), or null (the top).',
            '- hide: { op: "hide", taskId, hidden } takes a task out of the list or brings it back.',
            '- hide a bot: { op: "hide", botId, hidden } takes it out of the Bots section or brings it back. Bots are never moved.',
            "An operation on a row the person holds, on something missing, or that moves a bot is skipped with its reason; the rest still apply.",
        ].join("\n"),
        parameters: organizeTasksInputSchema,
        returnType: organizeTasksResultSchema,
        durable: true,
        transactional: true,
        // It only rearranges the person's own list, which they can always put back.
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: Static<typeof organizeTasksInputSchema>) =>
            await focus.organize(ctx, memberId, input.ops),
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}
