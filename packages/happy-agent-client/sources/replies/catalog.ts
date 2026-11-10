import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { providerReply } from "./components/provider.js";
import type { ReplyBundle } from "./defineReplyComponent.js";

/**
 * Every reply component, in catalog order. A server contributes the subset it can serve and lists
 * exactly that subset in `capabilities.chatUi.replies`.
 */
export const replyComponents = [providerReply] as const;

/** One option's reply component of a known type: `{ type, props }`. */
export const knownReplyUiSchema = Type.Union([providerReply.schema]);
export type KnownReplyUi = Static<typeof knownReplyUiSchema>;

/**
 * One option's reply component as the wire carries it. The wire admits any type so a client can
 * read a newer server's suggestions; it draws the types it knows and shows the bare option for
 * the rest.
 */
export const replyUiSchema = Type.Object(
    {
        type: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_]{0,63}$" }),
        props: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
);
export type ReplyUi = Static<typeof replyUiSchema>;

/** The bundle of a reply type, or undefined for a type this catalog does not know. */
export function replyBundle(type: string): ReplyBundle | undefined {
    return (replyComponents as readonly ReplyBundle[]).find((bundle) => bundle.type === type);
}

/** Problems with one option's reply component, as English sentences a model can act on. */
export function replyUiProblems(ui: { readonly type: string; readonly props: unknown }): string[] {
    const bundle = replyBundle(ui.type);
    if (bundle === undefined) return [`There is no reply type "${ui.type}".`];
    if (!Value.Check(bundle.props, ui.props)) {
        const first = Value.Errors(bundle.props, ui.props).First();
        return [
            `The ${ui.type} props are invalid${first === undefined ? "" : ` at "${first.path || "/"}": ${first.message}`}.`,
        ];
    }
    return [];
}
