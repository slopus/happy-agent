import {
    agentPermissionMode,
    defineAgentTool,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { MAX_AGENT_STATUS_LINE_LENGTH } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import type { StoriesModule } from "../StoriesModule.js";
import { StoryInputError } from "../StoryErrors.js";

const setStatusToolInputSchema = Type.Object(
    {
        text: Type.Union(
            [
                Type.String({
                    minLength: 1,
                    maxLength: MAX_AGENT_STATUS_LINE_LENGTH,
                    pattern: "^[^\\r\\n]+$",
                }),
                Type.Null(),
            ],
            {
                description:
                    "A short plain-language status on where the work stands for the person, or null to clear it.",
            },
        ),
    },
    { additionalProperties: false },
);
type SetStatusToolInput = Static<typeof setStatusToolInputSchema>;

const setStatusResultSchema = Type.Object(
    { text: Type.Union([Type.String(), Type.Null()]) },
    { additionalProperties: false },
);

/** Set the second line of this conversation's sidebar row. */
export function setStatusTool(stories: StoriesModule, scope: AgentModuleScope) {
    return defineAgentTool({
        name: "set_status",
        defer: true,
        capabilities: [
            "Set the short status shown under this conversation's title in the person's sidebar, saying where the work stands for them; clear it when you finish.",
        ],
        searchKeywords: ["status", "set status", "sidebar subtitle", "progress line"],
        description: [
            'Set the status shown under this conversation\'s title in the person\'s sidebar, like the preview under a chat in Telegram. It tells them at a glance where the work stands for them, in plain words: "Testing with a few friends", "Ready for you to try on your phone", "Stuck on the payment provider\'s sign-up". The row wraps it onto at most two lines and cuts the rest, so write one or two short phrases, about 70 characters, never more than 120, and no line breaks.',
            'When the work has a few clear stages, you may lead with a tiny cue of them in plain text, one dot per stage: ● for done, [●] for the one under way, ○ for still to come, such as "● ● [●] ○ Checkout works, testing payments next". Use it only when the stages are real and few; it replaces a count, never adds one.',
            'Write it for someone who is not reading the code. No commit hashes, versions, test counts, file or branch names, or counts like "step 3/7" unless the person asked for them. The row already shows whether you are working or waiting on the person, so never say only that ("Working…", "Waiting on you"); say what for.',
            "Change it when where things stand changes in a way the person would care about, not on every step. When you finish, or it no longer says anything true, clear it with null; a status left behind on finished work is noise.",
        ].join("\n\n"),
        parameters: setStatusToolInputSchema,
        returnType: setStatusResultSchema,
        durable: true,
        // It only changes how the person's own sidebar describes this conversation.
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SetStatusToolInput, call) => {
            if (agentPermissionMode(ctx) === "read_only") {
                throw new StoryInputError("Read only mode cannot set the status line.");
            }
            await stories.setStatus(ctx, {
                agentId: scope.agent.id,
                toolCallId: call.id,
                text: input.text,
            });
            return { text: input.text };
        },
        toLLM: (result) => [
            {
                type: "text",
                text:
                    result.text === null
                        ? "Cleared the status line."
                        : `The sidebar now reads: ${result.text}`,
            },
        ],
    });
}
