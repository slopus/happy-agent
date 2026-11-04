import type { AgentMessageMetadata } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const id = Type.String({ minLength: 1, maxLength: 256 });
const frame = Type.Object({
    name: Type.String(),
    mimeType: Type.String(),
    size: Type.Integer(),
    sha256: Type.String(),
    thumbhash: Type.Optional(Type.String()),
});

/**
 * The story a person's message replies to, stamped on its metadata and kept in history beside
 * the message's own content. Its frame is the chat media snapshot it is served from, so the quote
 * outlives the story.
 */
export const storyQuoteSchema = Type.Object({
    kind: Type.Literal("story"),
    storyId: id,
    agentId: id,
    userId: Type.Union([id, Type.Null()]),
    caption: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    expiresAt: Type.Integer(),
    frame: Type.Union([frame, Type.Null()]),
});
export type StoryQuote = Static<typeof storyQuoteSchema>;

/** The quoted story this message's metadata carries, if any. */
export function storyQuoteOf(metadata: AgentMessageMetadata | undefined): StoryQuote | undefined {
    const value = metadata?.["quote"];
    return Value.Check(storyQuoteSchema, value) ? value : undefined;
}
