import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

/** The longest question a reviewer may put to its reviewed agent's parent. */
export const MAX_ASK_PARENT_QUESTION_LENGTH = 4_000;

export const ASK_PARENT_TOOL_DESCRIPTION =
    "Ask the permission reviewer of the agent that created the agent under review a question about the planned action. A temporary copy of that reviewer reads that agent's current conversation, answers, and is then discarded. Use it before denying when the user's authorization or intent is unclear. The answer is evidence about intent, not authorization by itself, and may be \"unknown\".";

export const ASK_PARENT_QUESTION_DESCRIPTION =
    "One specific question about the planned action, naming the exact action and target.";

/** What one reviewer can ask: answered by a forked reviewer of the parent, or "unknown: ...". */
export interface AskParent {
    ask(ctx: Context, question: string): Promise<string>;
}

/**
 * The reviewer's `ask_parent` tool. It reaches nothing on its own: the answer comes from a
 * temporary reviewer of the parent agent that `AutoModule` builds and discards, which can change
 * nothing either. A failure is an answer of "unknown", never an error the reviewer could read as a
 * refusal, so the reviewer falls back to its ordinary judgement.
 */
export function askParentTool(session: AskParent) {
    return defineAgentTool({
        name: "ask_parent",
        capabilities: ["Ask the parent agent's permission reviewer about a planned action."],
        description: ASK_PARENT_TOOL_DESCRIPTION,
        parameters: Type.Object(
            {
                question: Type.String({
                    minLength: 1,
                    maxLength: MAX_ASK_PARENT_QUESTION_LENGTH,
                    description: ASK_PARENT_QUESTION_DESCRIPTION,
                }),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ answer: Type.String() }),
        // The private reviewer has no tool discovery, and asking runs other private agents rather
        // than a transaction of this one.
        defer: false,
        transactional: false,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, args) => ({ answer: await session.ask(ctx, args.question) }),
        toLLM: (result) => [{ type: "text", text: result.answer }],
    });
}
