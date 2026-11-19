import { Type, type Static } from "@sinclair/typebox";

/**
 * The request a forked parent reviewer answers instead of a proposed action.
 *
 * The fork is built the way a fresh review of the parent is: the parent's reviewer instructions
 * and its whole evidence transcript up to its latest message, under the same `<conversation>` and
 * `<reviewed_agent_id>` elements. Where a review would name `<proposed_action>`, this names the
 * subagent whose reviewer asks and the question, and tells the fork to answer in plain text.
 */

/** What the fork is shown when the parent has recorded no evidence since its last compaction. */
export const ASK_PARENT_NO_CONVERSATION = "No conversation is recorded for this agent.";

export const ASK_PARENT_ANSWER_GUIDANCE =
    'There is no proposed action to judge. The permission reviewer of the agent in `<subagent_id>`, which the agent in `<reviewed_agent_id>` created, is judging an action that subagent wants to take and asks the question above. You are a temporary copy of the permission reviewer of the agent in `<reviewed_agent_id>`: you are discarded once you answer, and only the asking reviewer reads your answer. Answer truthfully and briefly from the conversation above and any history you can read. Quote the person\'s own words when they settle the question, and say whether they come from a user message. If the evidence does not establish the answer, say "unknown"; never invent or assume authorization.';

export const ASK_PARENT_ESCALATION_GUIDANCE =
    "If only the agent that created the agent in `<reviewed_agent_id>` can know, ask it with `ask_parent` before you answer.";

export const ASK_PARENT_ANSWER_FORMAT = "Answer in plain text, without a <review> block.";

export const askParentPromptOptionsSchema = Type.Object(
    {
        /** The parent's whole budgeted transcript. May be empty. */
        conversation: Type.String(),
        /** The parent agent, whose reviewer the fork is. */
        agentId: Type.String({ minLength: 1 }),
        /** The subagent whose reviewer asks. */
        subagentId: Type.String({ minLength: 1 }),
        /** The question exactly as the asking reviewer wrote it. */
        question: Type.String({ minLength: 1 }),
        /** Whether the fork may ask its own parent in turn. */
        canAskParent: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type AskParentPromptOptions = Static<typeof askParentPromptOptionsSchema>;

export function createAskParentPrompt(options: AskParentPromptOptions): string {
    const { conversation, agentId, subagentId, question, canAskParent } = options;
    const body = conversation.length === 0 ? ASK_PARENT_NO_CONVERSATION : conversation;
    return [
        "<conversation>",
        body,
        "</conversation>",
        "",
        `<reviewed_agent_id>${agentId}</reviewed_agent_id>`,
        "",
        `<subagent_id>${subagentId}</subagent_id>`,
        "",
        "<question>",
        question,
        "</question>",
        "",
        [
            ASK_PARENT_ANSWER_GUIDANCE,
            ...(canAskParent ? [ASK_PARENT_ESCALATION_GUIDANCE] : []),
            ASK_PARENT_ANSWER_FORMAT,
        ].join(" "),
    ].join("\n");
}
