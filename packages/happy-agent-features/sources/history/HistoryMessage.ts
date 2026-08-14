import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Stable bounds for durable history. These are deliberately generous for real transcripts. */
export const MAX_HISTORY_RECORD_ID_LENGTH = 256;
export const MAX_HISTORY_PROVIDER_LENGTH = 128;
export const MAX_HISTORY_MODEL_LENGTH = 256;
export const MAX_HISTORY_TEXT_LENGTH = 1_000_000;
export const MAX_HISTORY_THINKING_LENGTH = 1_000_000;
export const MAX_HISTORY_MEDIA_TYPE_LENGTH = 256;
export const MAX_HISTORY_CALL_ID_LENGTH = 256;
export const MAX_HISTORY_TOOL_NAME_LENGTH = 256;
export const MAX_HISTORY_TOOL_OUTPUT_LENGTH = 1_000_000;
export const MAX_HISTORY_TOOL_DISPLAY_LENGTH = 256_000;
export const MAX_HISTORY_ARGUMENT_STRING_LENGTH = 1_000_000;
export const MAX_HISTORY_ARGUMENT_KEY_LENGTH = 256;
export const MAX_HISTORY_ARGUMENT_ARRAY_ITEMS = 256;
export const MAX_HISTORY_ARGUMENT_OBJECT_PROPERTIES = 256;
export const MAX_HISTORY_ARGUMENT_DEPTH = 8;
/** Maximum UTF-8 bytes occupied by one serialized tool-argument value. */
export const MAX_HISTORY_ARGUMENT_BYTES = 1_000_000;
/** Maximum UTF-8 bytes occupied by one serialized durable history message. */
export const MAX_HISTORY_MESSAGE_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_HISTORY_BLOCKS_PER_MESSAGE = 2_048;
export const MAX_HISTORY_MESSAGES_PER_APPEND = 512;
export const MAX_HISTORY_PENDING_BLOCKS = 2_048;
export const MAX_HISTORY_PAGE_SIZE = 500;
export const MAX_HISTORY_TOTAL_MESSAGES = 100_000;
export const MAX_HISTORY_TOTAL_BLOCKS = MAX_HISTORY_TOTAL_MESSAGES * MAX_HISTORY_BLOCKS_PER_MESSAGE;
export const MAX_HISTORY_BLOCKS_PER_PAGE = MAX_HISTORY_PAGE_SIZE * MAX_HISTORY_BLOCKS_PER_MESSAGE;
export const MAX_HISTORY_TOTAL_TEXT_CHARACTERS = MAX_HISTORY_TOTAL_BLOCKS * MAX_HISTORY_TEXT_LENGTH;
export const MAX_HISTORY_POSITION = Number.MAX_SAFE_INTEGER;
export const MAX_HISTORY_AGENT_ID_LENGTH = 256;
export const MAX_HISTORY_QUERY_LENGTH = 100_000;

const boundedIdentifier = (maxLength: number) =>
    Type.String({
        minLength: 1,
        maxLength,
        pattern: "^[^\\u0000\\r\\n]+$",
    });

export const historyRecordIdSchema = boundedIdentifier(MAX_HISTORY_RECORD_ID_LENGTH);
export const historyProviderSchema = boundedIdentifier(MAX_HISTORY_PROVIDER_LENGTH);
export const historyModelSchema = boundedIdentifier(MAX_HISTORY_MODEL_LENGTH);
export const historyAgentIdSchema = boundedIdentifier(MAX_HISTORY_AGENT_ID_LENGTH);
export const historyQueryTextSchema = Type.String({ maxLength: MAX_HISTORY_QUERY_LENGTH });
export const historyTimestampSchema = Type.Integer({
    minimum: 0,
    maximum: MAX_HISTORY_POSITION,
});

/** Who a recorded message came from. The four roles a reader may filter on. */
export const historyRoleSchema = Type.Union([
    Type.Literal("assistant"),
    Type.Literal("error"),
    Type.Literal("system"),
    Type.Literal("user"),
]);

/** The TypeScript type inferred from {@link historyRoleSchema}. */
export type HistoryRole = Static<typeof historyRoleSchema>;

/*
 * Tool arguments are JSON values. Build a finite schema instead of using an unbounded recursive
 * reference: bounded leaves and item counts are not enough to bound an arbitrarily deep tree.
 */
const historyToolArgumentLeafSchema = Type.Union([
    Type.String({ maxLength: MAX_HISTORY_ARGUMENT_STRING_LENGTH }),
    Type.Number({
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    Type.Boolean(),
    Type.Null(),
]);

function historyToolArgumentsAtDepth(depth: number): TSchema {
    if (depth <= 0) return historyToolArgumentLeafSchema;
    const child = historyToolArgumentsAtDepth(depth - 1);
    return Type.Union([
        historyToolArgumentLeafSchema,
        Type.Array(child, { maxItems: MAX_HISTORY_ARGUMENT_ARRAY_ITEMS }),
        Type.Record(Type.String({ maxLength: MAX_HISTORY_ARGUMENT_KEY_LENGTH }), child, {
            maxProperties: MAX_HISTORY_ARGUMENT_OBJECT_PROPERTIES,
        }),
    ]);
}

export const historyToolArgumentsSchema = historyToolArgumentsAtDepth(MAX_HISTORY_ARGUMENT_DEPTH);

/** Something said, by anyone. */
export const historyTextBlockSchema = Type.Object(
    {
        type: Type.Literal("text"),
        text: Type.String({ maxLength: MAX_HISTORY_TEXT_LENGTH }),
    },
    { additionalProperties: false },
);

/** Reasoning the model exposed, or the fact that it kept it to itself. */
export const historyThinkingBlockSchema = Type.Object(
    {
        type: Type.Literal("thinking"),
        thinking: Type.String({ maxLength: MAX_HISTORY_THINKING_LENGTH }),
        /** The provider hid the reasoning itself, so only its existence was recorded. */
        redacted: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

/** An image, kept as its kind alone: history is read as text. */
export const historyImageBlockSchema = Type.Object(
    {
        type: Type.Literal("image"),
        mediaType: Type.String({
            minLength: 1,
            maxLength: MAX_HISTORY_MEDIA_TYPE_LENGTH,
            pattern: "^[^\\u0000\\r\\n]+$",
        }),
    },
    { additionalProperties: false },
);

/** A tool the model asked for, with the arguments it asked with. */
export const historyToolCallBlockSchema = Type.Object(
    {
        type: Type.Literal("tool_call"),
        callId: boundedIdentifier(MAX_HISTORY_CALL_ID_LENGTH),
        name: boundedIdentifier(MAX_HISTORY_TOOL_NAME_LENGTH),
        arguments: historyToolArgumentsSchema,
    },
    { additionalProperties: false },
);

/** What a tool answered, summarized and already bounded by whoever recorded it. */
export const historyToolResultBlockSchema = Type.Object(
    {
        type: Type.Literal("tool_result"),
        callId: boundedIdentifier(MAX_HISTORY_CALL_ID_LENGTH),
        toolName: boundedIdentifier(MAX_HISTORY_TOOL_NAME_LENGTH),
        /** The one-line summary a person would have seen. */
        display: Type.Optional(Type.String({ maxLength: MAX_HISTORY_TOOL_DISPLAY_LENGTH })),
        /** What the model was shown, as text. */
        output: Type.String({ maxLength: MAX_HISTORY_TOOL_OUTPUT_LENGTH }),
        isError: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

/** One piece of a recorded message. */
export const historyBlockSchema = Type.Union([
    historyTextBlockSchema,
    historyThinkingBlockSchema,
    historyImageBlockSchema,
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
]);

/** The TypeScript type inferred from {@link historyBlockSchema}. */
export type HistoryBlock = Static<typeof historyBlockSchema>;

const historyMessageFields = {
    role: historyRoleSchema,
    blocks: Type.Array(historyBlockSchema, { maxItems: MAX_HISTORY_BLOCKS_PER_MESSAGE }),
    /** Stable feature-owned identity used to make crash recovery idempotent. */
    recordId: historyRecordIdSchema,
    /** When it was recorded, in epoch milliseconds. */
    at: Type.Optional(historyTimestampSchema),
    /** The registry ID of the provider that produced it, for an inference. */
    provider: Type.Optional(historyProviderSchema),
    /** The model that produced it, for an inference. */
    model: Type.Optional(historyModelSchema),
};

/**
 * One message of the durable history archive. Unlike the public record input, persisted messages
 * always carry a stable feature-owned identity.
 */
export const historyMessageSchema = Type.Object(historyMessageFields, {
    additionalProperties: false,
});

/** Input accepted by {@link HistoryFeature.record}; the feature allocates a stable identity. */
export const historyMessageInputSchema = Type.Object(
    {
        ...historyMessageFields,
        recordId: Type.Optional(historyRecordIdSchema),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link historyMessageSchema}. */
export type HistoryMessage = Static<typeof historyMessageSchema>;

/** The TypeScript type inferred from {@link historyMessageInputSchema}. */
export type HistoryMessageInput = Static<typeof historyMessageInputSchema>;

/** Check the extra persistence bound that JSON Schema cannot express for a value. */
export function historyToolArgumentsWithinByteLimit(value: unknown): boolean {
    if (!Value.Check(historyToolArgumentsSchema, value)) return false;
    try {
        const encoded = JSON.stringify(value);
        return (
            encoded !== undefined &&
            new TextEncoder().encode(encoded).byteLength <= MAX_HISTORY_ARGUMENT_BYTES
        );
    } catch {
        return false;
    }
}

/** Check every tool argument and the final encoded message size before a store write. */
export function historyMessageWithinPersistenceBounds(message: unknown): boolean {
    if (!Value.Check(historyMessageSchema, message)) return false;
    const candidate = message as HistoryMessage;
    if (
        candidate.blocks.some(
            (block) =>
                block.type === "tool_call" && !historyToolArgumentsWithinByteLimit(block.arguments),
        )
    ) {
        return false;
    }
    try {
        const encoded = JSON.stringify(candidate);
        return (
            encoded !== undefined &&
            new TextEncoder().encode(encoded).byteLength <= MAX_HISTORY_MESSAGE_JSON_BYTES
        );
    } catch {
        return false;
    }
}
