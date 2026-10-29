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
        // The wire limit is the only hard bound; how short to keep it is the model's call.
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
                    "One short phrase on where the work stands for the person, or null to remove it.",
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
        // Loaded with the conversation's tools: deferred, agents never went looking for it.
        defer: false,
        capabilities: [
            "Set the short status shown under this conversation's title in the person's sidebar.",
        ],
        description: [
            'Set the status shown under this conversation\'s title in the person\'s sidebar, like the preview under a chat in Telegram. It tells them at a glance where the work stands for them, in plain words: "Shipped to preview", "On main", "Visualization ready", "Stuck on payment sign-up". The sidebar shows one or two short lines; keep it to a short phrase, about 40 characters, with no line breaks.',
            'When the work has a few clear stages and the current one fits in one or two words, you may lead with one dot per stage (● done, [●] under way, ○ to come), then those words, for example "● ● [●] ○ Testing payments" or "● [●] ○ Review". Use it only if the whole status still fits in about 40 characters; otherwise write the phrase alone.',
            'Write it for someone who is not reading the code. No commit hashes, file or branch names, or tallies such as test counts, "136 icons", or "step 3/7" unless the person asked for them; a release version is fine when shipping it is the news. The row already shows whether you are working or waiting on the person, so never say only that ("Working…", "Waiting on you"); say what for ("Needs your OK to push").',
            'Almost always keep one: it should say plainly what this conversation is doing or where it ended up, even when the work is done ("Shipped to preview", "On main", "Plan agreed"). Set it early, then change it only when where the work stands changes in a way the person would notice: a plan agreed, something ready to try, waiting on their decision or approval, shipped, stuck, paused ("Paused until you re-record"). A follow-up question, a small extra request in the same work, or your next step keeps it as it is; never describe the step you are on ("Finding the file", "Checking the links"). Before you hand the turn back, make sure it is still true. Clear it with null only when it would otherwise say something untrue and nothing true is worth saying.',
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
