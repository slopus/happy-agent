import type { AgentMessageMetadata } from "@slopus/happy-agent-base";
import { quickReplySchema, type QuickReply } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

/**
 * The quick reply a person's message is, stamped on its metadata by the `send` route after the
 * daemon checked it, and kept in history beside the message's own content.
 */
export function quickReplyOf(metadata: AgentMessageMetadata | undefined): QuickReply | undefined {
    const value = metadata?.["quickReply"];
    return Value.Check(quickReplySchema, value) ? value : undefined;
}
