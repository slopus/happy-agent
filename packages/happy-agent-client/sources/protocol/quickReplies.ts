import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { uiDetailSchema } from "../ui/uiValues.js";
import { cuid2Schema, Nullable } from "./common.js";

/**
 * Quick replies on the wire; see "Quick replies" in API.md. They are suggested responses, not chat
 * UI components: a client draws them as a stack of buttons, and a tap is an ordinary `send` whose
 * `text` is the option, with `quickReply` naming where the option came from. The model suggests
 * them with the `suggest_replies` tool, whose call carries a `quick_replies` presentation; the
 * daemon writes them itself in a `quick_replies` block of an agent message.
 */

/** The most options one suggestion holds. */
export const MAX_QUICK_REPLIES = 6;

/**
 * One suggested reply: plain text on one line, 1–200 characters, with no control or bidirectional
 * formatting character and runs of whitespace collapsed to one space.
 */
export const quickReplyOptionSchema = uiDetailSchema;

/** 1–6 options, each unique. */
export const quickReplyOptionsSchema = Type.Array(quickReplyOptionSchema, {
    minItems: 1,
    maxItems: MAX_QUICK_REPLIES,
});

/**
 * Reserved for a small display-only drawing beside each option: one entry per option, in option
 * order, null for a bare one. No server writes it yet. A client that does not know an entry's
 * `type`, or the field at all, shows the bare option; the option's text is always what a tap sends.
 */
export const quickReplyUiListSchema = Type.Array(
    Nullable(
        Type.Object({
            type: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]{0,63}$" }),
            props: Type.Record(Type.String(), Type.Unknown()),
        }),
    ),
    { minItems: 1, maxItems: MAX_QUICK_REPLIES },
);

/** Replies the daemon suggested itself, in an agent message, with no model involved. */
export const quickRepliesBlockSchema = Type.Object({
    type: Type.Literal("quick_replies"),
    options: quickReplyOptionsSchema,
    ui: Type.Optional(quickReplyUiListSchema),
});
export type QuickRepliesBlock = Static<typeof quickRepliesBlockSchema>;

/** The replies a completed `suggest_replies` call suggested. */
export const quickRepliesPresentationSchema = Type.Object({
    type: Type.Literal("quick_replies"),
    options: quickReplyOptionsSchema,
    ui: Type.Optional(quickReplyUiListSchema),
});
export type QuickRepliesPresentation = Static<typeof quickRepliesPresentationSchema>;

/**
 * Where a sent message's text came from: one option of one suggestion. On `send`, the daemon
 * checks it and answers `400` when it does not hold; on the stored user message, it is the
 * daemon-set provenance clients show, such as "suggested by" the agent.
 */
export const quickReplySchema = Type.Object(
    {
        /** The agent message in this conversation that holds the suggestion. */
        messageId: cuid2Schema,
        /**
         * The `suggest_replies` call in that message whose presentation holds the options; absent
         * when the options are the message's own `quick_replies` block.
         */
        toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        /** The option's position, from 0. */
        index: Type.Integer({ minimum: 0, maximum: MAX_QUICK_REPLIES - 1 }),
    },
    { additionalProperties: false },
);
export type QuickReply = Static<typeof quickReplySchema>;

/** An option as the daemon stores it: whitespace runs collapsed to one space and trimmed. */
export function normalizeQuickReply(option: string): string {
    return option.replace(/\s+/gu, " ").trim();
}

/**
 * Problems with a list of options after {@link normalizeQuickReply}, as English sentences a model
 * can act on. An empty list means it passes.
 */
export function quickRepliesProblems(options: readonly string[]): string[] {
    const problems: string[] = [];
    if (options.length < 1 || options.length > MAX_QUICK_REPLIES) {
        problems.push(`Suggest 1 to ${MAX_QUICK_REPLIES} replies.`);
    }
    for (const [index, option] of options.entries()) {
        if (!Value.Check(quickReplyOptionSchema, option)) {
            problems.push(
                `Reply ${index + 1} must be plain text of 1 to 200 characters on one line.`,
            );
        }
    }
    const repeated = options.filter((option, index) => options.indexOf(option) !== index);
    if (repeated.length > 0) problems.push(`Replies must be unique; "${repeated[0]}" repeats.`);
    return problems;
}
