import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const MAX_AGENT_MESSAGE_ID_LENGTH = 256;
export const MAX_AGENT_SESSION_ID_LENGTH = 256;
export const MAX_AGENT_MESSAGE_TEXT_LENGTH = 262_144;
export const MAX_AGENT_MESSAGE_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_AGENT_MESSAGE_BLOCKS = 256;
export const MAX_AGENT_MESSAGE_METADATA_STRING_LENGTH = 256;

const boundedIdentitySchema = Type.String({
    maxLength: MAX_AGENT_MESSAGE_ID_LENGTH,
    minLength: 1,
    pattern: "^[^\\u0000\\r\\n]+$",
});

/**
 * Agent Base 0.0.6 accepts only these user content blocks. `detail` is intentionally absent:
 * the public protocol still carries the field, but the bridge rejects it before acceptance.
 */
export const agentAcceptedContentBlockSchema = Type.Union([
    Type.Object(
        {
            text: Type.String({ maxLength: MAX_AGENT_MESSAGE_TEXT_LENGTH }),
            type: Type.Literal("text"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            data: Type.String({ maxLength: MAX_AGENT_MESSAGE_IMAGE_BYTES }),
            mediaType: Type.String({
                maxLength: MAX_AGENT_MESSAGE_METADATA_STRING_LENGTH,
                minLength: 1,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
            type: Type.Literal("image"),
        },
        { additionalProperties: false },
    ),
]);

export const agentAcceptedContentSchema = Type.Array(agentAcceptedContentBlockSchema, {
    maxItems: MAX_AGENT_MESSAGE_BLOCKS,
});

export const rigMessageMetadataSchema = Type.Object(
    {
        clientSubmissionId: Type.Optional(boundedIdentitySchema),
        content: agentAcceptedContentSchema,
        delivery: Type.Union([Type.Literal("run"), Type.Literal("steer")]),
        displayText: Type.String({ maxLength: MAX_AGENT_MESSAGE_TEXT_LENGTH }),
        effort: Type.Optional(
            Type.String({
                maxLength: MAX_AGENT_MESSAGE_METADATA_STRING_LENGTH,
                minLength: 1,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
        ),
        identity: Type.Union([
            Type.String({
                maxLength: MAX_AGENT_MESSAGE_ID_LENGTH,
                minLength: 1,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
            Type.Null(),
        ]),
        messageId: boundedIdentitySchema,
        modelId: boundedIdentitySchema,
        mutationId: Type.Optional(boundedIdentitySchema),
        permissionMode: Type.String({
            maxLength: MAX_AGENT_MESSAGE_METADATA_STRING_LENGTH,
            minLength: 1,
            pattern: "^[^\\u0000\\r\\n]+$",
        }),
        providerId: boundedIdentitySchema,
        runId: boundedIdentitySchema,
        serviceTier: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("off")])),
        sessionId: boundedIdentitySchema,
        text: Type.String({ maxLength: MAX_AGENT_MESSAGE_TEXT_LENGTH }),
    },
    { additionalProperties: false },
);

export const rigMessageMetadataEnvelopeSchema = Type.Object(
    { rig: rigMessageMetadataSchema },
    { additionalProperties: false },
);

export const agentSubmissionMessageSchema = Type.Object(
    {
        blocks: agentAcceptedContentSchema,
        id: boundedIdentitySchema,
        identity: Type.Union([
            Type.String({
                maxLength: MAX_AGENT_MESSAGE_ID_LENGTH,
                minLength: 1,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
            Type.Null(),
        ]),
        role: Type.Literal("user"),
    },
    { additionalProperties: false },
);

export const agentSubmissionInputSchema = Type.Object(
    {
        content: Type.Array(
            Type.Union([
                Type.Object(
                    {
                        text: Type.String({ maxLength: MAX_AGENT_MESSAGE_TEXT_LENGTH }),
                        type: Type.Literal("text"),
                    },
                    { additionalProperties: false },
                ),
                Type.Object(
                    {
                        data: Type.String({ maxLength: MAX_AGENT_MESSAGE_IMAGE_BYTES }),
                        mimeType: Type.String({
                            maxLength: MAX_AGENT_MESSAGE_METADATA_STRING_LENGTH,
                            minLength: 1,
                            pattern: "^[^\\u0000\\r\\n]+$",
                        }),
                        type: Type.Literal("image"),
                    },
                    { additionalProperties: false },
                ),
            ]),
            { maxItems: MAX_AGENT_MESSAGE_BLOCKS },
        ),
        role: Type.Literal("user"),
    },
    { additionalProperties: false },
);

export const submissionFingerprintSchema = Type.String({
    maxLength: 64,
    minLength: 64,
    pattern: "^[a-f0-9]{64}$",
});

export type AgentAcceptedContentBlock = Static<typeof agentAcceptedContentBlockSchema>;
export type AgentAcceptedContent = Static<typeof agentAcceptedContentSchema>;
export type AgentSubmissionMessage = Static<typeof agentSubmissionMessageSchema>;
export type AgentSubmissionInput = Static<typeof agentSubmissionInputSchema>;
export type RigMessageMetadata = Static<typeof rigMessageMetadataSchema>;
export type RigMessageMetadataEnvelope = Static<typeof rigMessageMetadataEnvelopeSchema>;

/**
 * A finite JSON value used by protocol pending blocks. This is deliberately separate from the
 * durable submission envelope because provider metadata can use any bounded JSON scalar/object.
 */
export const MAX_PROTOCOL_JSON_DEPTH = 8;
export const MAX_PROTOCOL_JSON_STRING_LENGTH = 1_000_000;
export const MAX_PROTOCOL_JSON_ARRAY_ITEMS = 256;
export const MAX_PROTOCOL_JSON_OBJECT_PROPERTIES = 256;
export const MAX_PROTOCOL_PENDING_BLOCKS_JSON_BYTES = 8 * 1024 * 1024;

const protocolJsonLeafSchema = Type.Union([
    Type.String({ maxLength: MAX_PROTOCOL_JSON_STRING_LENGTH }),
    Type.Number({ maximum: Number.MAX_SAFE_INTEGER, minimum: -Number.MAX_SAFE_INTEGER }),
    Type.Boolean(),
    Type.Null(),
]);

function protocolJsonAtDepth(depth: number): TSchema {
    if (depth <= 0) return protocolJsonLeafSchema;
    const child = protocolJsonAtDepth(depth - 1);
    return Type.Union([
        protocolJsonLeafSchema,
        Type.Array(child, { maxItems: MAX_PROTOCOL_JSON_ARRAY_ITEMS }),
        Type.Record(Type.String({ maxLength: MAX_AGENT_MESSAGE_METADATA_STRING_LENGTH }), child, {
            maxProperties: MAX_PROTOCOL_JSON_OBJECT_PROPERTIES,
        }),
    ]);
}

export const protocolJsonSchema = protocolJsonAtDepth(MAX_PROTOCOL_JSON_DEPTH);

export const protocolTextBlockSchema = Type.Object(
    {
        text: Type.String({ maxLength: MAX_AGENT_MESSAGE_TEXT_LENGTH }),
        type: Type.Literal("text"),
    },
    { additionalProperties: false },
);

export const protocolThinkingBlockSchema = Type.Object(
    {
        encrypted: Type.Optional(Type.String({ maxLength: MAX_AGENT_MESSAGE_TEXT_LENGTH })),
        redacted: Type.Optional(Type.Boolean()),
        thinking: Type.String({ maxLength: MAX_AGENT_MESSAGE_TEXT_LENGTH }),
        type: Type.Literal("thinking"),
    },
    { additionalProperties: false },
);

export const protocolToolCallBlockSchema = Type.Object(
    {
        arguments: protocolJsonSchema,
        id: boundedIdentitySchema,
        incomplete: Type.Optional(Type.Boolean()),
        name: boundedIdentitySchema,
        namespace: Type.Optional(boundedIdentitySchema),
        providerToolCallId: Type.Optional(boundedIdentitySchema),
        type: Type.Literal("tool_call"),
        vendor: Type.Optional(protocolJsonSchema),
    },
    { additionalProperties: false },
);

export const protocolAgentBlockSchema = Type.Union([
    protocolTextBlockSchema,
    protocolThinkingBlockSchema,
    protocolToolCallBlockSchema,
]);

export const protocolErrorMessageSchema = Type.String({
    maxLength: MAX_AGENT_MESSAGE_TEXT_LENGTH,
});

export function protocolJsonWithinByteLimit(value: unknown): boolean {
    try {
        const encoded = JSON.stringify(value);
        return (
            encoded !== undefined &&
            new TextEncoder().encode(encoded).byteLength <= MAX_PROTOCOL_PENDING_BLOCKS_JSON_BYTES
        );
    } catch {
        return false;
    }
}

export function protocolAgentBlockWithinBounds(value: unknown): boolean {
    return Value.Check(protocolAgentBlockSchema, value) && protocolJsonWithinByteLimit(value);
}
