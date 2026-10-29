import {
    agentPermissionMode,
    defineAgentTool,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import type { StoriesModule } from "../StoriesModule.js";
import { StoryInputError } from "../StoryErrors.js";

/**
 * The longest status the tool writes. A row shows one line, about 40 characters, so this is a
 * hard cap well under the protocol's own limit, checked in `execute` so the agent is told to
 * shorten it rather than shown a schema mismatch.
 */
const MAX_SET_STATUS_LENGTH = 60;

const setStatusToolInputSchema = Type.Object(
    {
        text: Type.Union([Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" }), Type.Null()], {
            description: `One short phrase on where the work stands for the person, at most ${String(MAX_SET_STATUS_LENGTH)} characters, or null to remove it.`,
        }),
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
            "Set the one-line status shown under this conversation's title in the person's sidebar.",
        ],
        description: [
            'Set the status shown under this conversation\'s title in the person\'s sidebar, like the preview under a chat in Telegram. It tells them at a glance where the work stands for them, in plain words: "Shipped to preview", "On main", "Visualization ready", "Stuck on payment sign-up". Write one short phrase, about 40 characters at most, no line breaks; the row shows a single line and cuts the rest.',
            'When the work has a few clear stages and the current one fits in one or two words, you may lead with one dot per stage (● done, [●] under way, ○ to come), then those words, for example "● ● [●] ○ Testing payments" or "● [●] ○ Review". Use it only if the whole status still fits in about 40 characters; otherwise write the phrase alone.',
            'Write it for someone who is not reading the code. No commit hashes, test counts, file or branch names, or counts like "step 3/7" unless the person asked for them; a release version is fine when shipping it is the news. The row already shows whether you are working or waiting on the person, so never say only that ("Working…", "Waiting on you"); say what for.',
            'Almost always keep one: it should say plainly what this conversation is doing or where it ended up, even when the work is done ("Shipped to preview", "On main", "Plan agreed"). Set it early, then change it only at key moments the person would notice: a plan agreed, something ready to try, shipped, stuck. Never update it on every step. Clear it with null only when it would otherwise say something untrue and nothing true is worth saying.',
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
            if (input.text !== null && input.text.length > MAX_SET_STATUS_LENGTH) {
                throw new StoryInputError(
                    `That status is ${String(input.text.length)} characters, and the row shows one line of about 40. Shorten it to one short phrase of at most ${String(MAX_SET_STATUS_LENGTH)} characters and set it again.`,
                );
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
