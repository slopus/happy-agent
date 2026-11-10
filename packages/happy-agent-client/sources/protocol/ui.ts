import { Type, type Static } from "@sinclair/typebox";

import { uiComponentSchema } from "../ui/catalog.js";
import { MAX_UI_MEDIA } from "../ui/components/media.js";
import { cuid2Schema, eventCursorSchema, Nullable } from "./common.js";
import { mediaItemSchema, type ServiceMessage } from "./messages.js";

/**
 * Chat UI on the wire; see "Chat UI" in API.md. A document is a flat, ordered list of typed
 * components, drawn top to bottom, with no nesting and no styling. The daemon writes one in a `ui`
 * block of an agent message; a model shows one with the `show_ui` tool, whose call carries a `ui`
 * presentation. Every click on a component is one `POST /v0/agents/:agentId/actions`.
 */

/** The protocol version that carries chat UI. */
export const CHAT_UI_PROTOCOL_VERSION = 35;

/**
 * The request header a client sends with the protocol version it reads, such as
 * `Happy-Protocol: 35`. A daemon projects chat UI to fallback text for a request without it, or
 * below {@link CHAT_UI_PROTOCOL_VERSION}.
 */
export const HAPPY_PROTOCOL_HEADER = "happy-protocol";

/** A message, document, or attempt ID a client may choose, as for `send`. */
const clientIdSchema = Type.String({ minLength: 2, maxLength: 96, pattern: "^[a-z][a-z0-9]+$" });

/** One document: 1–16 components, each with an ID unique in the document. */
export const uiDocumentSchema = Type.Object({
    id: cuid2Schema,
    components: Type.Array(uiComponentSchema, { minItems: 1, maxItems: 16 }),
});
export type UiDocument = Static<typeof uiDocumentSchema>;

/** A document the daemon wrote itself, in an agent message, with no model involved. */
export const uiBlockSchema = Type.Object({
    type: Type.Literal("ui"),
    ui: uiDocumentSchema,
});
export type UiBlock = Static<typeof uiBlockSchema>;

/**
 * The document a completed `show_ui` call showed. `media` components name their items by index
 * into `items`, whose bytes are `GET /v0/agents/:agentId/tool-calls/:toolCallId/media/:index`.
 */
export const uiPresentationSchema = Type.Object({
    type: Type.Literal("ui"),
    ui: uiDocumentSchema,
    items: Type.Array(mediaItemSchema, { maxItems: MAX_UI_MEDIA }),
});
export type UiPresentation = Static<typeof uiPresentationSchema>;

/** What happened to one action. */
export const uiActionOutcomeSchema = Type.Object({
    /**
     * `pending` while its hook runs; `accepted`, `rejected` (with `code` and `reason`), or
     * `failed` (with `reason`; `code: "interrupted"` when the daemon restarted mid-hook).
     */
    status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("accepted"),
        Type.Literal("rejected"),
        Type.Literal("failed"),
    ]),
    /** A stable machine-readable code, such as `token_rejected`. */
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    /** One English sentence safe to show. */
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});
export type UiActionOutcome = Static<typeof uiActionOutcomeSchema>;

/** An action as sent: its type, `<component>.<action>`, and its payload. */
export const uiActionInputSchema = Type.Object({
    type: Type.String({
        minLength: 3,
        maxLength: 129,
        pattern: "^[a-z][a-z0-9_]{0,63}\\.[a-z][a-z0-9_]{0,63}$",
    }),
    payload: Type.Record(Type.String(), Type.Unknown()),
});
export type UiActionInput = Static<typeof uiActionInputSchema>;

/**
 * One action, in the service record of its attempt. The payload is stored with every secret left
 * out. Clients never send this block.
 */
export const uiActionBlockSchema = Type.Object({
    type: Type.Literal("action"),
    /** The agent message holding the offer. */
    messageId: cuid2Schema,
    uiId: cuid2Schema,
    componentId: Type.String({ minLength: 1, maxLength: 64 }),
    action: uiActionInputSchema,
    outcome: uiActionOutcomeSchema,
});
export type UiActionBlock = Static<typeof uiActionBlockSchema>;

/** `POST /v0/agents/:agentId/actions` */
export const uiActionRequestSchema = Type.Object(
    {
        /** The idempotency key, and the ID of the attempt record the daemon stores. */
        id: clientIdSchema,
        /** The agent message in this conversation that holds the document. */
        messageId: Type.String({ minLength: 1, maxLength: 96 }),
        uiId: Type.String({ minLength: 1, maxLength: 96 }),
        componentId: Type.String({ minLength: 1, maxLength: 64 }),
        action: uiActionInputSchema,
    },
    { additionalProperties: false },
);
export type UiActionRequest = Static<typeof uiActionRequestSchema>;

/** `POST /v0/agents/:agentId/actions` — `200` */
export const uiActionResponseSchema = Type.Object({
    /** The attempt record: a service message with one `action` block, secrets left out. */
    record: Type.Unsafe<ServiceMessage>({ type: "object" }),
    /** What the action returned, typed by its bundle; the only place a secret result appears. */
    result: Nullable(Type.Record(Type.String(), Type.Unknown())),
    /** The event cursor before the action; streaming from it replays everything it caused. */
    cursor: Nullable(eventCursorSchema),
});
export type UiActionResponse = Static<typeof uiActionResponseSchema>;

/**
 * `capabilities.chatUi` in health: the catalog version, the components this server serves, and the
 * reply components its quick replies may carry (absent on servers without any).
 */
export const chatUiCapabilitySchema = Type.Object({
    version: Type.Integer({ minimum: 1 }),
    components: Type.Array(Type.String({ minLength: 1, maxLength: 64 })),
    replies: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }))),
});
export type ChatUiCapability = Static<typeof chatUiCapabilitySchema>;

/**
 * The text a client below {@link CHAT_UI_PROTOCOL_VERSION} reads in place of a document: each
 * component's fallback line, in order, blank ones left out, separated by blank lines.
 */
export function uiDocumentFallback(document: {
    readonly components: readonly { readonly fallback: string }[];
}): string {
    return document.components
        .map((component) => component.fallback.trim())
        .filter((line) => line.length > 0)
        .join("\n\n");
}
