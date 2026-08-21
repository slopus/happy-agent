import { Type, type Static } from "@sinclair/typebox";

import type { EventId } from "./EventId.js";

/**
 * The fixed Happy UI locations an agent can plug content into. Happy Terminal stores the entries and
 * verifies their types; it never interprets or filters the content itself.
 */
export const slotNameSchema = Type.Union(
    [
        Type.Literal("status-line"),
        Type.Literal("above-composer"),
        Type.Literal("title"),
        Type.Literal("sidebar"),
    ],
    { description: "The fixed Happy UI location the entry plugs into." },
);

export type SlotName = Static<typeof slotNameSchema>;

export const slotScopeSchema = Type.Union(
    [
        Type.Literal("everywhere"),
        Type.Literal("project"),
        Type.Literal("workspace"),
        Type.Literal("session"),
    ],
    { description: "Where the entry applies." },
);

export type SlotScope = Static<typeof slotScopeSchema>;

export const slotActionSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("send-current-chat"),
            message: Type.String({ description: "Message to send to the current chat." }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("open-applet"),
            applet: Type.String({ description: "Kebab-case name of the applet to open." }),
            path: Type.Optional(
                Type.String({
                    description: "Optional relative path within the applet to open.",
                }),
            ),
            query: Type.Optional(
                Type.Record(Type.String(), Type.String(), {
                    description: "Optional query parameters forwarded when opening the applet.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("send-chat"),
            sessionId: Type.String({ description: "The chat to send the message to." }),
            message: Type.String({ description: "Message to send." }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("draft-chat"),
            sessionId: Type.String({ description: "The chat to draft the message in." }),
            message: Type.String({ description: "Message to place in the composer." }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("new-chat"),
            projectId: Type.Optional(Type.String()),
            workspaceId: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
            provider: Type.Optional(Type.String()),
            effort: Type.Optional(Type.String()),
            serviceTier: Type.Optional(Type.Literal("fast")),
            readOnly: Type.Optional(Type.Boolean()),
            title: Type.Optional(Type.String()),
            prompt: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
]);

export type SlotAction = Static<typeof slotActionSchema>;

export const slotContentSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("text"),
            markdown: Type.String({ description: "Markdown with URL support." }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("button"),
            label: Type.String({ description: "Button label." }),
            action: slotActionSchema,
        },
        { additionalProperties: false },
    ),
]);

export type SlotContent = Static<typeof slotContentSchema>;

export const slotEntryAuthorSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("agent"),
            sessionId: Type.String({
                description: "The session of the agent that created the entry.",
            }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("plugin"),
            folder: Type.String({
                description: "Stable installed folder of the plugin that created the entry.",
            }),
            name: Type.String({
                description: "Human-readable name of the plugin that created the entry.",
            }),
        },
        { additionalProperties: false },
    ),
]);

export type SlotEntryAuthor = Static<typeof slotEntryAuthorSchema>;

export const slotEntrySchema = Type.Object(
    {
        id: Type.String(),
        slot: slotNameSchema,
        scope: slotScopeSchema,
        projectId: Type.Optional(Type.String()),
        workspaceId: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        content: slotContentSchema,
        author: slotEntryAuthorSchema,
        description: Type.String({ description: "What the entry is." }),
        purpose: Type.String({ description: "Why the entry exists." }),
        createdAt: Type.Number(),
        updatedAt: Type.Number(),
    },
    { additionalProperties: false },
);

export type SlotEntry = Static<typeof slotEntrySchema>;

export const createSlotEntryRequestSchema = Type.Object(
    {
        slot: slotNameSchema,
        scope: slotScopeSchema,
        projectId: Type.Optional(Type.String()),
        workspaceId: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        content: slotContentSchema,
        author: slotEntryAuthorSchema,
        description: Type.String(),
        purpose: Type.String(),
    },
    { additionalProperties: false },
);

export type CreateSlotEntryRequest = Static<typeof createSlotEntryRequestSchema>;

/**
 * The scope and its target are fixed at creation; an entry that should move is removed and
 * recreated where it belongs.
 */
export const updateSlotEntryRequestSchema = Type.Object(
    {
        slot: Type.Optional(slotNameSchema),
        content: Type.Optional(slotContentSchema),
        description: Type.Optional(Type.String()),
        purpose: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);

export type UpdateSlotEntryRequest = Static<typeof updateSlotEntryRequestSchema>;

/** Scope context for listing: a session context also matches everywhere, project, and workspace. */
export interface SlotEntryFilter {
    projectId?: string;
    sessionId?: string;
    slot?: SlotName;
    workspaceId?: string;
}

export interface ListSlotEntriesResponse {
    entries: readonly SlotEntry[];
}

export interface SlotEntryResponse {
    entry: SlotEntry;
}

export type SlotManagementErrorCode = "entry_not_found" | "invalid_entry" | "invalid_request";

export interface SlotManagementErrorResponse {
    error: {
        code: SlotManagementErrorCode;
        message: string;
    };
}

/**
 * Slot entries changed. Live-only, carrying the whole current set so a reconnecting client reads
 * the current entries instead of replaying every past change.
 */
export interface SlotsChangedEvent {
    createdAt: number;
    data: {
        entries: readonly SlotEntry[];
    };
    id: EventId;
    type: "slots_changed";
}
