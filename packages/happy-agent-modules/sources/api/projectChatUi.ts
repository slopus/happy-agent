import type { IncomingMessage } from "node:http";

import { Type } from "@sinclair/typebox";
import {
    CHAT_UI_PROTOCOL_VERSION,
    HAPPY_PROTOCOL_HEADER,
    uiDocumentFallback,
    uiDocumentSchema,
} from "@slopus/happy-agent-client";

import type { ApiEvent } from "./ApiEventJournal.js";
import { apiValidator } from "./impl/apiValidator.js";

const uiBlockSchema = Type.Object({ type: Type.Literal("ui"), ui: uiDocumentSchema });
const uiCallSchema = Type.Object({
    type: Type.Literal("tool_call"),
    presentation: Type.Object({ type: Type.Literal("ui"), ui: uiDocumentSchema }),
});
const actionBlockSchema = Type.Object({ type: Type.Literal("action") });
const messageSchema = Type.Object({ content: Type.Array(Type.Unknown()) });
const messageEventPayloadSchema = Type.Object({ message: messageSchema });

/**
 * Whether a request reads chat UI: it sends `Happy-Protocol` with 35 or greater. Event streams
 * decide once, when they open.
 */
export function readsChatUi(request: IncomingMessage): boolean {
    const raw = request.headers[HAPPY_PROTOCOL_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || !/^[0-9]{1,6}$/.test(value.trim())) return false;
    return Number(value.trim()) >= CHAT_UI_PROTOCOL_VERSION;
}

/**
 * A public message as a client below protocol 35 reads it: a `ui` block, and a completed
 * `show_ui` call, become a `text` block of the document's fallback text, and `action` blocks are
 * left out. An attempt record, whose content is only `action` blocks, is left out entirely.
 */
export function projectChatUiMessage(
    message: Record<string, unknown>,
): Record<string, unknown> | undefined {
    if (!apiValidator(messageSchema).Check(message)) return message;
    const content = message.content;
    if (
        content.length > 0 &&
        content.every((block) => apiValidator(actionBlockSchema).Check(block))
    ) {
        return undefined;
    }
    let changed = false;
    const projected = content.flatMap((block): unknown[] => {
        if (apiValidator(actionBlockSchema).Check(block)) {
            changed = true;
            return [];
        }
        if (apiValidator(uiBlockSchema).Check(block)) {
            changed = true;
            return [{ type: "text", text: uiDocumentFallback(block.ui) }];
        }
        if (apiValidator(uiCallSchema).Check(block)) {
            changed = true;
            return [{ type: "text", text: uiDocumentFallback(block.presentation.ui) }];
        }
        return [block];
    });
    return changed ? { ...message, content: projected } : message;
}

/** An event as a client below protocol 35 reads it, or undefined when it reads none. */
export function projectChatUiEvent(event: ApiEvent): ApiEvent | undefined {
    if (event.type !== "message.created" && event.type !== "message.updated") return event;
    if (!apiValidator(messageEventPayloadSchema).Check(event.payload)) return event;
    const message = projectChatUiMessage(event.payload.message);
    if (message === undefined) return undefined;
    if (message === event.payload.message) return event;
    return { ...event, payload: { ...event.payload, message } };
}
