import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { cuid2Schema } from "@slopus/happy-agent-base";
import { clientMetadataSchema, type ClientMetadata } from "@slopus/happy-agent-client";

import { toolPermissionReviewSchema } from "../permissions/ToolPermissionReview.js";

/** Stable bounds for durable history. These are deliberately generous for real transcripts. */
export const MAX_HISTORY_RECORD_ID_LENGTH = 256;
export const MAX_HISTORY_PROVIDER_LENGTH = 128;
export const MAX_HISTORY_MODEL_LENGTH = 256;
export const MAX_HISTORY_TEXT_LENGTH = 1_000_000;
export const MAX_HISTORY_THINKING_LENGTH = 1_000_000;
export const MAX_HISTORY_MEDIA_TYPE_LENGTH = 256;
export const MAX_HISTORY_IMAGE_DATA_LENGTH = 48 * 1_024 * 1_024;
export const MAX_HISTORY_CALL_ID_LENGTH = 32;
export const MAX_HISTORY_TOOL_NAME_LENGTH = 256;
export const MAX_HISTORY_TOOL_OUTPUT_LENGTH = 1_000_000;
/** Tool output retained in an ordinary recorded tool result and its live API projection. */
export const MAX_HISTORY_RECORDED_TOOL_OUTPUT_LENGTH = 16_000;
export const MAX_HISTORY_TOOL_DISPLAY_LENGTH = 256_000;
export const MAX_HISTORY_ARGUMENT_STRING_LENGTH = 1_000_000;
export const MAX_HISTORY_ARGUMENT_KEY_LENGTH = 256;
export const MAX_HISTORY_ARGUMENT_ARRAY_ITEMS = 256;
export const MAX_HISTORY_ARGUMENT_OBJECT_PROPERTIES = 256;
export const MAX_HISTORY_ARGUMENT_DEPTH = 8;
/** Maximum UTF-8 bytes occupied by one serialized tool-argument value. */
export const MAX_HISTORY_ARGUMENT_BYTES = 1_000_000;
/** Maximum UTF-8 bytes occupied by one serialized durable history message. */
export const MAX_HISTORY_MESSAGE_JSON_BYTES = 64 * 1_024 * 1_024;
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
export const MAX_HISTORY_MODE_VALUE_LENGTH = 256;
export const MAX_HISTORY_MUTATION_ID_LENGTH = 1_024;
export const MAX_HISTORY_REMOTE_MESSAGE_ID_LENGTH = 1_024;
const MAX_HISTORY_FILE_DIFF_FILES = 20;
const MAX_HISTORY_FILE_DIFF_LINES = 500;
const MAX_HISTORY_FILE_DIFF_TEXT_LENGTH = 4_000;

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
export const historyMutationIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_HISTORY_MUTATION_ID_LENGTH,
});
export const historyRemoteMessageIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_HISTORY_REMOTE_MESSAGE_ID_LENGTH,
});

/** The complete composer selection carried by a person's message. */
export const historyMessageModeSchema = Type.Object(
    {
        providerId: boundedIdentifier(MAX_HISTORY_MODE_VALUE_LENGTH),
        modelId: boundedIdentifier(MAX_HISTORY_MODE_VALUE_LENGTH),
        effort: boundedIdentifier(MAX_HISTORY_MODE_VALUE_LENGTH),
        serviceTier: Type.Union([boundedIdentifier(MAX_HISTORY_MODE_VALUE_LENGTH), Type.Null()]),
        permissionMode: Type.Union([
            Type.Literal("read_only"),
            Type.Literal("workspace_write"),
            Type.Literal("auto"),
            Type.Literal("full_access"),
        ]),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link historyMessageModeSchema}. */
export type HistoryMessageMode = Static<typeof historyMessageModeSchema>;

/** Opaque JSON owned by the client that submitted a user message. */
export const historyClientMetadataSchema = clientMetadataSchema;

/** The TypeScript type inferred from {@link historyClientMetadataSchema}. */
export type HistoryClientMetadata = ClientMetadata;

/**
 * Who a recorded message came from. The six roles a reader may filter on.
 *
 * Goal continuations, collaboration hand-offs, and some other generated messages reach the model
 * wearing the user role. The history records who actually sent those: `"user"` is a message the
 * person actually submitted, and `"agent"` is one an agent generated on its behalf. A message
 * that actually has the system role remains `"system"`.
 */
export const historyRoleSchema = Type.Union([
    Type.Literal("agent"),
    Type.Literal("assistant"),
    Type.Literal("error"),
    Type.Literal("service"),
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
        // A record's key bound has to be written as a pattern, because a `Record` key schema
        // becomes a JSON Schema property pattern and cannot carry its own `maxLength`. Closing the
        // record is what makes the bound bite: an over-long key then matches no pattern at all and
        // is refused rather than admitted as an extra property.
        Type.Record(
            Type.String({
                pattern: `^[\\s\\S]{0,${MAX_HISTORY_ARGUMENT_KEY_LENGTH}}$`,
            }),
            child,
            {
                additionalProperties: false,
                maxProperties: MAX_HISTORY_ARGUMENT_OBJECT_PROPERTIES,
            },
        ),
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
        /** Inline base64 media, retained exactly for public transcript reconstruction. */
        data: Type.Optional(Type.String({ maxLength: MAX_HISTORY_IMAGE_DATA_LENGTH })),
    },
    { additionalProperties: false },
);

/** A tool the model asked for, with the arguments it asked with. */
export const historyToolCallBlockSchema = Type.Object(
    {
        type: Type.Literal("tool_call"),
        callId: cuid2Schema,
        name: boundedIdentifier(MAX_HISTORY_TOOL_NAME_LENGTH),
        arguments: Type.Optional(historyToolArgumentsSchema),
        /** Present exactly when this invocation crossed the automatic-review boundary. */
        elevated: Type.Optional(Type.Boolean()),
        /** The bounded review outcome shown to public clients. */
        review: Type.Optional(toolPermissionReviewSchema),
    },
    { additionalProperties: false },
);

const historyFileDiffCountSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});
const historyFileDiffTextSchema = Type.String({ maxLength: MAX_HISTORY_FILE_DIFF_TEXT_LENGTH });
const historyFileDiffLineSchema = Type.Object(
    {
        kind: Type.Union([Type.Literal("context"), Type.Literal("add"), Type.Literal("delete")]),
        text: historyFileDiffTextSchema,
    },
    { additionalProperties: false },
);
const historyFileDiffHunkSchema = Type.Object(
    {
        oldStart: historyFileDiffCountSchema,
        newStart: historyFileDiffCountSchema,
        lines: Type.Array(historyFileDiffLineSchema, { maxItems: MAX_HISTORY_FILE_DIFF_LINES }),
    },
    { additionalProperties: false },
);
const historyFileDiffSchema = Type.Object(
    {
        path: historyFileDiffTextSchema,
        kind: Type.Union([Type.Literal("add"), Type.Literal("delete"), Type.Literal("update")]),
        added: historyFileDiffCountSchema,
        deleted: historyFileDiffCountSchema,
        hunks: Type.Array(historyFileDiffHunkSchema, { maxItems: MAX_HISTORY_FILE_DIFF_LINES }),
        language: Type.Optional(Type.String({ maxLength: 256 })),
        omittedLines: Type.Optional(historyFileDiffCountSchema),
    },
    { additionalProperties: false },
);

/** A bounded result-derived presentation retained with durable tool history. */
export const historyToolPresentationSchema = Type.Object(
    {
        type: Type.Literal("file_diff"),
        files: Type.Array(historyFileDiffSchema, { maxItems: MAX_HISTORY_FILE_DIFF_FILES }),
        omittedFiles: Type.Optional(historyFileDiffCountSchema),
    },
    { additionalProperties: false },
);

export type HistoryToolPresentation = Static<typeof historyToolPresentationSchema>;

/**
 * What a tool answered, summarized and already bounded by whoever recorded it. Lifecycle
 * recording always supplies a one-line display summary; direct host records may omit it.
 */
export const historyToolResultBlockSchema = Type.Object(
    {
        type: Type.Literal("tool_result"),
        callId: cuid2Schema,
        toolName: boundedIdentifier(MAX_HISTORY_TOOL_NAME_LENGTH),
        /** A bounded one-line summary suitable for a person-facing history view. */
        display: Type.Optional(Type.String({ maxLength: MAX_HISTORY_TOOL_DISPLAY_LENGTH })),
        /** What the model was shown, as text. */
        output: Type.Optional(Type.String({ maxLength: MAX_HISTORY_TOOL_OUTPUT_LENGTH })),
        isError: Type.Optional(Type.Boolean()),
        /** A bounded structured result presentation supplied by the tool's owning module. */
        presentation: Type.Optional(historyToolPresentationSchema),
    },
    { additionalProperties: false },
);

const historyCompactionBlockBaseSchema = Type.Object(
    {
        type: Type.Literal("compaction"),
        trigger: Type.Union([Type.Literal("manual"), Type.Literal("automatic")]),
        tokensBefore: Type.Union([
            Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
            Type.Null(),
        ]),
        startedAt: historyTimestampSchema,
    },
    { additionalProperties: false },
);

export const historyRunningCompactionBlockSchema = Type.Composite(
    [
        historyCompactionBlockBaseSchema,
        Type.Object({
            status: Type.Literal("running"),
            tokensAfter: Type.Null(),
            failureReason: Type.Null(),
            completedAt: Type.Null(),
        }),
    ],
    { additionalProperties: false },
);

export const historyCompletedCompactionBlockSchema = Type.Composite(
    [
        historyCompactionBlockBaseSchema,
        Type.Object({
            status: Type.Literal("completed"),
            tokensAfter: Type.Union([
                Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
                Type.Null(),
            ]),
            failureReason: Type.Null(),
            completedAt: historyTimestampSchema,
        }),
    ],
    { additionalProperties: false },
);

export const historyFailedCompactionBlockSchema = Type.Composite(
    [
        historyCompactionBlockBaseSchema,
        Type.Object({
            status: Type.Literal("failed"),
            tokensAfter: Type.Null(),
            failureReason: Type.String({ minLength: 1, maxLength: 8_192 }),
            completedAt: historyTimestampSchema,
        }),
    ],
    { additionalProperties: false },
);

/** One complete context-compaction lifecycle inside a durable service message. */
export const historyCompactionBlockSchema = Type.Union([
    historyRunningCompactionBlockSchema,
    historyCompletedCompactionBlockSchema,
    historyFailedCompactionBlockSchema,
]);

/** One piece of a recorded message. */
export const historyBlockSchema = Type.Union([
    historyTextBlockSchema,
    historyThinkingBlockSchema,
    historyImageBlockSchema,
    historyToolCallBlockSchema,
    historyToolResultBlockSchema,
    historyCompactionBlockSchema,
]);

/** The TypeScript type inferred from {@link historyBlockSchema}. */
export type HistoryBlock = Static<typeof historyBlockSchema>;

const historyMessageFields = {
    role: historyRoleSchema,
    /**
     * The specific agent that sent an agent- or system-role message, when its metadata named the
     * sender — a collaboration delivery names the collaborator, a goal continuation names the
     * agent driving itself. Absent when the sender did not identify itself, and on person or
     * model-authored roles.
     */
    senderAgentId: Type.Optional(historyAgentIdSchema),
    blocks: Type.Array(historyBlockSchema, { maxItems: MAX_HISTORY_BLOCKS_PER_MESSAGE }),
    /** Stable identity for this archive record. Reuse is a storage conflict. */
    recordId: historyRecordIdSchema,
    /** The accepted run this message belongs to. */
    runId: Type.Optional(historyRecordIdSchema),
    /** How a user message entered the agent. */
    delivery: Type.Optional(Type.Union([Type.Literal("queue"), Type.Literal("steer")])),
    /** The selection a user message made effective. */
    mode: Type.Optional(historyMessageModeSchema),
    /** Optimistic client mutation identity, echoed but never interpreted or deduplicated. */
    mutationId: Type.Optional(historyMutationIdSchema),
    /** Opaque JSON owned by the client that submitted this user message. */
    clientMetadata: Type.Optional(historyClientMetadataSchema),
    /** Keep this operational message out of person-facing transcript projection. */
    hideFromUser: Type.Optional(Type.Boolean()),
    /** Happy's source identity, used to suppress a remote message echo. */
    remoteMessageId: Type.Optional(historyRemoteMessageIdSchema),
    /** When it was recorded, in epoch milliseconds. */
    at: Type.Optional(historyTimestampSchema),
    /** The registry ID of the provider that produced it, for an inference. */
    provider: Type.Optional(historyProviderSchema),
    /** The model that produced it, for an inference. */
    model: Type.Optional(historyModelSchema),
};

/**
 * One message of the durable history archive. Unlike the public record input, persisted messages
 * always carry a record identity.
 */
export const historyMessageSchema = Type.Object(historyMessageFields, {
    additionalProperties: false,
});

/** Input accepted by {@link HistoryModule.record}; the module allocates an identity when absent. */
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
                block.type === "tool_call" &&
                ((block.arguments !== undefined &&
                    !historyToolArgumentsWithinByteLimit(block.arguments)) ||
                    (block.elevated === undefined) !== (block.review === undefined)),
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
