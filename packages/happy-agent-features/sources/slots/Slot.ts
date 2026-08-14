import { Type, type Static } from "@sinclair/typebox";

/**
 * Slots are a host-owned catalog. These limits are deliberately finite because a slot page and
 * its model-facing rendering must remain bounded even when the host store is backed by a large
 * application database.
 */
export const MAX_SLOT_ENTRIES = 500;
export const MAX_SLOT_PAGE_SIZE = 100;
export const MAX_SLOT_OUTPUT_CHARACTERS = 100_000;
/**
 * A complete entry identity must remain actionable even at the minimum model output budget.
 * Compact list/detail rendering reserves room for a continuation cursor and its label.
 */
export const MAX_SLOT_ID_LENGTH = 192;

export const slotIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SLOT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const slotAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SLOT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const slotNameSchema = Type.Union([
    Type.Literal("status-line"),
    Type.Literal("above-composer"),
    Type.Literal("title"),
    Type.Literal("sidebar"),
]);

export const slotScopeSchema = Type.Union([
    Type.Literal("everywhere"),
    Type.Literal("project"),
    Type.Literal("workspace"),
    Type.Literal("session"),
]);

export const slotScopeReferenceIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SLOT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const slotMarkdownSchema = Type.String({
    minLength: 1,
    maxLength: 12_000,
});

export const slotButtonLabelSchema = Type.String({
    minLength: 1,
    maxLength: 500,
});

export const slotMessageSchema = Type.String({
    minLength: 1,
    maxLength: 8_000,
});

export const slotAppletIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SLOT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const slotAppletPathSchema = Type.String({
    minLength: 1,
    maxLength: 2_048,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const slotQueryKeySchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[^\\u0000\\r\\n]+$",
});

export const slotQueryValueSchema = Type.String({
    maxLength: 2_000,
    pattern: "^[^\\u0000\\r\\n]*$",
});

const slotQuerySchema = Type.Record(slotQueryKeySchema, slotQueryValueSchema, {
    maxProperties: 32,
});

const slotModelParameterSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SLOT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

const slotTitleSchema = Type.String({
    minLength: 1,
    maxLength: 500,
});

const sendCurrentChatActionSchema = Type.Object(
    {
        type: Type.Literal("send-current-chat"),
        message: slotMessageSchema,
    },
    { additionalProperties: false },
);

const openAppletActionSchema = Type.Object(
    {
        type: Type.Literal("open-applet"),
        /** An opaque applet identity. The feature never imports or resolves Applet data. */
        appletId: slotAppletIdSchema,
        path: Type.Optional(slotAppletPathSchema),
        query: Type.Optional(slotQuerySchema),
    },
    { additionalProperties: false },
);

const sendChatActionSchema = Type.Object(
    {
        type: Type.Literal("send-chat"),
        sessionId: slotScopeReferenceIdSchema,
        message: slotMessageSchema,
    },
    { additionalProperties: false },
);

const draftChatActionSchema = Type.Object(
    {
        type: Type.Literal("draft-chat"),
        sessionId: slotScopeReferenceIdSchema,
        message: slotMessageSchema,
    },
    { additionalProperties: false },
);

const newChatActionSchema = Type.Object(
    {
        type: Type.Literal("new-chat"),
        projectId: Type.Optional(slotScopeReferenceIdSchema),
        workspaceId: Type.Optional(slotScopeReferenceIdSchema),
        model: Type.Optional(slotModelParameterSchema),
        provider: Type.Optional(slotModelParameterSchema),
        effort: Type.Optional(slotModelParameterSchema),
        serviceTier: Type.Optional(Type.Literal("fast")),
        readOnly: Type.Optional(Type.Boolean()),
        title: Type.Optional(slotTitleSchema),
        prompt: Type.Optional(slotMessageSchema),
    },
    { additionalProperties: false },
);

/** The provider-neutral actions a slot button may ask the Happy host to perform. */
export const slotActionSchema = Type.Union([
    sendCurrentChatActionSchema,
    openAppletActionSchema,
    sendChatActionSchema,
    draftChatActionSchema,
    newChatActionSchema,
]);

/** Content is intentionally opaque beyond its bounded, renderable shape. */
export const slotContentSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("text"),
            markdown: slotMarkdownSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("button"),
            label: slotButtonLabelSchema,
            action: slotActionSchema,
        },
        { additionalProperties: false },
    ),
]);

export const slotDescriptionSchema = Type.String({
    minLength: 1,
    maxLength: 2_000,
});

export const slotPurposeSchema = Type.String({
    minLength: 1,
    maxLength: 2_000,
});

export const slotTimestampSchema = Type.Integer({
    minimum: 0,
});

export const slotOrderingSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_SLOT_ENTRIES - 1,
});

/**
 * Exactly one target reference belongs on a scoped entry. This is a discriminated union rather
 * than a broad object with optional fields so the runtime contract itself rejects both missing
 * and mismatched targets.
 */
const everywhereScopeProperties = {
    scope: Type.Literal("everywhere"),
} as const;
const projectScopeProperties = {
    scope: Type.Literal("project"),
    projectId: slotScopeReferenceIdSchema,
} as const;
const workspaceScopeProperties = {
    scope: Type.Literal("workspace"),
    workspaceId: slotScopeReferenceIdSchema,
} as const;
const sessionScopeProperties = {
    scope: Type.Literal("session"),
    sessionId: slotScopeReferenceIdSchema,
} as const;

export const slotScopeReferenceSchema = Type.Union([
    Type.Object(everywhereScopeProperties, { additionalProperties: false }),
    Type.Object(projectScopeProperties, { additionalProperties: false }),
    Type.Object(workspaceScopeProperties, { additionalProperties: false }),
    Type.Object(sessionScopeProperties, { additionalProperties: false }),
]);

const slotEntryBaseProperties = {
    id: slotIdSchema,
    slot: slotNameSchema,
    content: slotContentSchema,
    authorAgentId: slotAgentIdSchema,
    description: slotDescriptionSchema,
    purpose: slotPurposeSchema,
    createdAt: slotTimestampSchema,
    updatedAt: slotTimestampSchema,
    ordering: slotOrderingSchema,
} as const;

/**
 * A complete persisted entry. `authorAgentId` is supplied by the public operation's caller and
 * cannot be changed by update.
 */
export const slotEntrySchema = Type.Union([
    Type.Object(
        { ...slotEntryBaseProperties, ...everywhereScopeProperties },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...slotEntryBaseProperties, ...projectScopeProperties },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...slotEntryBaseProperties, ...workspaceScopeProperties },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...slotEntryBaseProperties, ...sessionScopeProperties },
        { additionalProperties: false },
    ),
]);

/** Input accepted by the host-facing create operation. The author is the caller's agent ID. */
const slotCreateBaseProperties = {
    id: Type.Optional(slotIdSchema),
    slot: slotNameSchema,
    content: slotContentSchema,
    description: slotDescriptionSchema,
    purpose: slotPurposeSchema,
} as const;

export const slotCreateInputSchema = Type.Union([
    Type.Object(
        { ...slotCreateBaseProperties, ...everywhereScopeProperties },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...slotCreateBaseProperties, ...projectScopeProperties },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...slotCreateBaseProperties, ...workspaceScopeProperties },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...slotCreateBaseProperties, ...sessionScopeProperties },
        { additionalProperties: false },
    ),
]);

/** Mutable fields; scope and its target remain fixed after creation. */
export const slotUpdateInputSchema = Type.Object(
    {
        slot: Type.Optional(slotNameSchema),
        content: Type.Optional(slotContentSchema),
        description: Type.Optional(slotDescriptionSchema),
        purpose: Type.Optional(slotPurposeSchema),
    },
    { additionalProperties: false, minProperties: 1 },
);

export const slotReorderInputSchema = Type.Array(slotIdSchema, {
    maxItems: MAX_SLOT_ENTRIES,
    uniqueItems: true,
});

/** A caller-owned identity for one durable mutation attempt. */
export const slotOperationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_SLOT_ID_LENGTH,
    pattern: "^[^\\u0000\\r\\n]+$",
});

/** Fingerprints are fixed-size SHA-256 digests of bounded canonical operation input. */
export const slotOperationFingerprintSchema = Type.String({
    minLength: 64,
    maxLength: 64,
    pattern: "^[a-f0-9]{64}$",
});

/** The four mutations that have durable retry receipts. */
export const slotMutationOperationSchema = Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("reorder"),
    Type.Literal("remove"),
]);

/** Optional identity supplied by direct callers; tools allocate this durably. */
export const slotMutationOptionsSchema = Type.Object(
    {
        operationId: Type.Optional(slotOperationIdSchema),
    },
    { additionalProperties: false },
);

/** State retained in call-scoped AgentKV while a durable tool call is retried. */
export const slotOperationStateSchema = Type.Object(
    {
        id: slotOperationIdSchema,
        fingerprint: slotOperationFingerprintSchema,
    },
    { additionalProperties: false },
);

export type SlotId = Static<typeof slotIdSchema>;
export type SlotAgentId = Static<typeof slotAgentIdSchema>;
export type SlotName = Static<typeof slotNameSchema>;
export type SlotScope = Static<typeof slotScopeSchema>;
export type SlotScopeReferenceId = Static<typeof slotScopeReferenceIdSchema>;
export type SlotAction = Static<typeof slotActionSchema>;
export type SlotContent = Static<typeof slotContentSchema>;
export type SlotScopeReference = Static<typeof slotScopeReferenceSchema>;
export type SlotEntry = Static<typeof slotEntrySchema>;
export type SlotCreateInput = Static<typeof slotCreateInputSchema>;
export type SlotUpdateInput = Static<typeof slotUpdateInputSchema>;
export type SlotReorderInput = Static<typeof slotReorderInputSchema>;
export type SlotOperationId = Static<typeof slotOperationIdSchema>;
export type SlotOperationFingerprint = Static<typeof slotOperationFingerprintSchema>;
export type SlotMutationOperation = Static<typeof slotMutationOperationSchema>;
export type SlotMutationOptions = Static<typeof slotMutationOptionsSchema>;
export type SlotOperationState = Static<typeof slotOperationStateSchema>;
export type SlotOrdering = Static<typeof slotOrderingSchema>;
export type SlotTimestamp = Static<typeof slotTimestampSchema>;

/** The fixed slot/scope compatibility matrix owned by the feature's type contract. */
export const allowedSlotScopes: Readonly<Record<SlotName, readonly SlotScope[]>> = {
    sidebar: ["everywhere"],
    title: ["project", "workspace"],
    "status-line": ["everywhere", "project", "workspace", "session"],
    "above-composer": ["everywhere", "project", "workspace", "session"],
};

export function scopeReferenceFromEntry(entry: SlotScopeReference): SlotScopeReference {
    switch (entry.scope) {
        case "everywhere":
            return { scope: "everywhere" };
        case "project":
            return { scope: "project", projectId: entry.projectId };
        case "workspace":
            return { scope: "workspace", workspaceId: entry.workspaceId };
        case "session":
            return { scope: "session", sessionId: entry.sessionId };
    }
}
