import { Type, type Static } from "@sinclair/typebox";

import { PERMISSION_REVIEW_FOLLOWUP_REMINDER } from "./createPermissionReviewInstructions.js";

/**
 * The exact per-review request wrapper, ported from Happy Agent v1's `createPermissionReviewSideAgent.ts`.
 *
 * The reviewer keeps its own history across reviews, so a later review sends only the conversation
 * the reviewer has not already seen. The first review omits the follow-up reminder and marks its
 * `<conversation>` element plainly; every later review prepends the reminder and marks the element
 * `continued="true"`. When there is nothing new to send, the conversation body is the fixed
 * sentence below rather than an empty element, matching v1 byte-for-byte.
 *
 * Every review also names the agent that proposed the action, so the reviewer can read that agent's
 * own durable history when authorization lies outside the conversation it was sent, and names the
 * agents that sent it messages, whose histories hold the person's words when work was delegated.
 */

/** What the reviewer is shown when the budgeted delta since its last review is empty. */
export const PERMISSION_REVIEW_NO_NEW_CONVERSATION = "No new conversation since your last review.";

export const permissionReviewPromptOptionsSchema = Type.Object(
    {
        /** True for a reviewer's first review, when it has no prior history to build on. */
        first: Type.Boolean(),
        /** The budgeted conversation (whole transcript first, delta afterwards). May be empty. */
        conversation: Type.String(),
        /** The Agent ID of the reviewed agent, whose history the reviewer may read. */
        agentId: Type.String({ minLength: 1 }),
        /** The Agent IDs that sent the reviewed agent messages. Omitted from the prompt when empty. */
        delegatorAgentIds: Type.Array(Type.String({ minLength: 1 })),
        /** The proposed action, already serialized as the v1 `{description,tool,arguments}` JSON. */
        action: Type.String(),
    },
    { additionalProperties: false },
);

export type PermissionReviewPromptOptions = Static<typeof permissionReviewPromptOptionsSchema>;

export function createPermissionReviewPrompt(options: PermissionReviewPromptOptions): string {
    const { first, conversation, agentId, delegatorAgentIds, action } = options;
    // Older turns are already in the reviewer's own history, so a later review that has nothing new
    // to add still says so explicitly instead of sending an empty conversation element.
    const body = conversation.length === 0 ? PERMISSION_REVIEW_NO_NEW_CONVERSATION : conversation;
    return [
        ...(first ? [] : [PERMISSION_REVIEW_FOLLOWUP_REMINDER, ""]),
        `<conversation${first ? "" : ' continued="true"'}>`,
        body,
        "</conversation>",
        "",
        `<reviewed_agent_id>${agentId}</reviewed_agent_id>`,
        ...(delegatorAgentIds.length === 0
            ? []
            : [`<delegator_agent_ids>${delegatorAgentIds.join(", ")}</delegator_agent_ids>`]),
        "",
        "<proposed_action>",
        action,
        "</proposed_action>",
    ].join("\n");
}
