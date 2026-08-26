import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/**
 * MCP protocol values are described here independently from the SDK client and transports so the
 * model-facing and persistence boundaries remain TypeBox-validated.
 */

export const MAX_MCP_AGENT_ID_LENGTH = 256;
export const MAX_MCP_SERVER_NAME_LENGTH = 128;
export const MAX_MCP_TOOL_NAME_LENGTH = 128;
export const MAX_MCP_DESCRIPTION_LENGTH = 16_384;
export const MAX_MCP_ERROR_MESSAGE_LENGTH = 2_000;
export const MAX_MCP_URI_LENGTH = 128;
export const MAX_MCP_CURSOR_LENGTH = 32;
export const MAX_MCP_PAGE_SIZE = 100;
export const MAX_MCP_TOTAL_SERVERS = MAX_MCP_PAGE_SIZE * MAX_MCP_PAGE_SIZE;
export const MAX_MCP_CONTENT_BLOCKS = 128;
export const MAX_MCP_RESOURCE_CONTENTS = 128;
export const MAX_MCP_TOTAL_TOOLS = MAX_MCP_PAGE_SIZE * MAX_MCP_PAGE_SIZE;
export const MAX_MCP_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
/** Input-side bounds are larger than the model forwarding budget so translation can report a
 * useful truncation result instead of rejecting an otherwise valid MCP response. */
export const MAX_MCP_INPUT_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;
export const MAX_MCP_INPUT_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_MCP_INPUT_CONTENT_BLOCKS = 2_048;
export const MAX_MCP_INPUT_RESOURCE_CONTENTS = 2_048;
export const MAX_MCP_TEXT_BYTES = 512 * 1024;
export const MAX_MCP_UNKNOWN_RESOURCE_BYTES = 4_096;
export const MAX_MCP_JSON_DEPTH = 8;
export const MAX_MCP_JSON_STRING_LENGTH = 1_000_000;
export const MAX_MCP_JSON_ARRAY_ITEMS = 2_048;
export const MAX_MCP_JSON_OBJECT_PROPERTIES = 2_048;
export const MAX_MCP_JSON_KEY_LENGTH = 256;
export const MAX_MCP_OUTPUT_CHARACTERS = 100_000;
export const MIN_MCP_OUTPUT_CHARACTERS = 256;

const noLineBreaks = "^[^\\u0000\\r\\n]+$";

export const mcpContextSchema = Type.Unsafe<Context>(
    Type.Object({}, { additionalProperties: false }),
);

export const mcpAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_MCP_AGENT_ID_LENGTH,
    pattern: noLineBreaks,
});

/**
 * MCP names are supplied by another process.  Keep control characters available for compatibility
 * with the protocol, but bound them before they can enter a page, tool descriptor, or receipt.
 * Security-facing descriptions use visible escaping rather than silently rewriting a name.
 */
export const mcpServerNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_MCP_SERVER_NAME_LENGTH,
});
export const mcpToolNameSchema = Type.String({
    minLength: 1,
    maxLength: MAX_MCP_TOOL_NAME_LENGTH,
});
export const mcpUriSchema = Type.String({
    minLength: 1,
    maxLength: MAX_MCP_URI_LENGTH,
});
export const mcpCursorSchema = Type.String({
    minLength: 1,
    maxLength: MAX_MCP_CURSOR_LENGTH,
});
export type McpAgentId = Static<typeof mcpAgentIdSchema>;
export type McpServerName = Static<typeof mcpServerNameSchema>;
export type McpToolName = Static<typeof mcpToolNameSchema>;
export type McpUri = Static<typeof mcpUriSchema>;
export type McpCursor = Static<typeof mcpCursorSchema>;

export const mcpPermissionModeSchema = Type.Union([
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
    Type.Literal("auto"),
    Type.Literal("full_access"),
]);
export type McpPermissionMode = Static<typeof mcpPermissionModeSchema>;

const mcpJsonLeafSchema = Type.Union([
    Type.String({ maxLength: MAX_MCP_JSON_STRING_LENGTH }),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
]);

function jsonValueAtDepth(depth: number): TSchema {
    if (depth <= 0) return mcpJsonLeafSchema;
    const child = jsonValueAtDepth(depth - 1);
    return Type.Union([
        mcpJsonLeafSchema,
        Type.Array(child, { maxItems: MAX_MCP_JSON_ARRAY_ITEMS }),
        Type.Record(Type.String({ maxLength: MAX_MCP_JSON_KEY_LENGTH }), child, {
            maxProperties: MAX_MCP_JSON_OBJECT_PROPERTIES,
        }),
    ]);
}

/**
 * A finite JSON value.  MCP arguments and structured output are untrusted JSON, so a recursive
 * schema without a depth and collection bound would make validation itself unbounded.
 */
export const mcpJsonValueSchema = jsonValueAtDepth(MAX_MCP_JSON_DEPTH);
export const mcpJsonObjectSchema = Type.Record(
    Type.String({ maxLength: MAX_MCP_JSON_KEY_LENGTH }),
    mcpJsonValueSchema,
    { maxProperties: MAX_MCP_JSON_OBJECT_PROPERTIES },
);

export type McpJsonValue = Static<typeof mcpJsonValueSchema>;
export type McpJsonObject = Static<typeof mcpJsonObjectSchema>;

/**
 * JSON Schema is a protocol value rather than a module-owned schema.  A bounded JSON object
 * retains vendor keywords while still putting a finite validation boundary around it.
 */
export const mcpInputSchemaSchema = Type.Record(
    Type.String({ maxLength: MAX_MCP_JSON_KEY_LENGTH }),
    mcpJsonValueSchema,
    { maxProperties: MAX_MCP_JSON_OBJECT_PROPERTIES },
);
export type McpInputSchema = Static<typeof mcpInputSchemaSchema>;

export const mcpAnnotationsSchema = Type.Object(
    {
        audience: Type.Optional(
            Type.Array(Type.Union([Type.Literal("user"), Type.Literal("assistant")]), {
                maxItems: 2,
            }),
        ),
        priority: Type.Optional(Type.Number()),
        lastModified: Type.Optional(Type.String({ maxLength: 128 })),
    },
    { additionalProperties: false },
);

const mcpMetaSchema = Type.Optional(mcpJsonObjectSchema);

export const mcpTextContentSchema = Type.Object(
    {
        type: Type.Literal("text"),
        text: Type.String({ maxLength: MAX_MCP_INPUT_TEXT_BYTES }),
        annotations: Type.Optional(mcpAnnotationsSchema),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);

export const mcpImageContentSchema = Type.Object(
    {
        type: Type.Literal("image"),
        data: Type.String({ maxLength: MAX_MCP_INPUT_IMAGE_BASE64_BYTES }),
        mimeType: Type.String({ minLength: 1, maxLength: 128 }),
        annotations: Type.Optional(mcpAnnotationsSchema),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);

export const mcpAudioContentSchema = Type.Object(
    {
        type: Type.Literal("audio"),
        data: Type.String({ maxLength: MAX_MCP_INPUT_IMAGE_BASE64_BYTES }),
        mimeType: Type.String({ minLength: 1, maxLength: 128 }),
        annotations: Type.Optional(mcpAnnotationsSchema),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);

export const mcpResourceLinkSchema = Type.Object(
    {
        type: Type.Literal("resource_link"),
        name: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_MCP_TOOL_NAME_LENGTH })),
        title: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        uri: mcpUriSchema,
        description: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        mimeType: Type.Optional(Type.String({ maxLength: 128 })),
        size: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        annotations: Type.Optional(mcpAnnotationsSchema),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);

export const mcpTextResourceContentsSchema = Type.Object(
    {
        uri: mcpUriSchema,
        mimeType: Type.Optional(Type.String({ maxLength: 128 })),
        text: Type.String({ maxLength: MAX_MCP_INPUT_TEXT_BYTES }),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);

export const mcpBlobResourceContentsSchema = Type.Object(
    {
        uri: mcpUriSchema,
        mimeType: Type.Optional(Type.String({ maxLength: 128 })),
        blob: Type.String({ maxLength: MAX_MCP_INPUT_IMAGE_BASE64_BYTES }),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);

export const mcpEmbeddedResourceSchema = Type.Object(
    {
        type: Type.Literal("resource"),
        resource: Type.Union([mcpTextResourceContentsSchema, mcpBlobResourceContentsSchema]),
        annotations: Type.Optional(mcpAnnotationsSchema),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);

export const mcpContentBlockSchema = Type.Union([
    mcpTextContentSchema,
    mcpImageContentSchema,
    mcpAudioContentSchema,
    mcpResourceLinkSchema,
    mcpEmbeddedResourceSchema,
]);
export type McpContentBlock = Static<typeof mcpContentBlockSchema>;

export const mcpToolResultSchema = Type.Object(
    {
        _meta: mcpMetaSchema,
        content: Type.Optional(
            Type.Array(mcpContentBlockSchema, { maxItems: MAX_MCP_INPUT_CONTENT_BLOCKS }),
        ),
        isError: Type.Optional(Type.Boolean()),
        structuredContent: Type.Optional(mcpJsonValueSchema),
    },
    { additionalProperties: false },
);
export type McpToolResult = Static<typeof mcpToolResultSchema>;

export const mcpReadResourceResultSchema = Type.Object(
    {
        _meta: mcpMetaSchema,
        contents: Type.Array(
            Type.Union([mcpTextResourceContentsSchema, mcpBlobResourceContentsSchema]),
            { maxItems: MAX_MCP_INPUT_RESOURCE_CONTENTS },
        ),
    },
    { additionalProperties: false },
);
export type McpReadResourceResult = Static<typeof mcpReadResourceResultSchema>;

export const mcpToolSchema = Type.Object(
    {
        annotations: Type.Optional(mcpAnnotationsSchema),
        description: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        inputSchema: mcpInputSchemaSchema,
        name: mcpToolNameSchema,
        title: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);
export type McpTool = Static<typeof mcpToolSchema>;

export const mcpResourceSchema = Type.Object(
    {
        annotations: Type.Optional(mcpAnnotationsSchema),
        description: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        mimeType: Type.Optional(Type.String({ maxLength: 128 })),
        name: Type.String({ minLength: 1, maxLength: MAX_MCP_TOOL_NAME_LENGTH }),
        title: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        uri: mcpUriSchema,
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);
export type McpResource = Static<typeof mcpResourceSchema>;

export const mcpResourceTemplateSchema = Type.Object(
    {
        annotations: Type.Optional(mcpAnnotationsSchema),
        description: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        mimeType: Type.Optional(Type.String({ maxLength: 128 })),
        name: Type.String({ minLength: 1, maxLength: MAX_MCP_TOOL_NAME_LENGTH }),
        title: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        uriTemplate: mcpUriSchema,
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);
export type McpResourceTemplate = Static<typeof mcpResourceTemplateSchema>;

export const mcpPromptArgumentSchema = Type.Object(
    {
        description: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        name: Type.String({ minLength: 1, maxLength: MAX_MCP_TOOL_NAME_LENGTH }),
        required: Type.Optional(Type.Boolean()),
        title: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
    },
    { additionalProperties: false },
);

export const mcpPromptSchema = Type.Object(
    {
        arguments: Type.Optional(
            Type.Array(mcpPromptArgumentSchema, { maxItems: MAX_MCP_PAGE_SIZE }),
        ),
        description: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        name: Type.String({ minLength: 1, maxLength: MAX_MCP_TOOL_NAME_LENGTH }),
        title: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);
export type McpPrompt = Static<typeof mcpPromptSchema>;

export const mcpPromptMessageSchema = Type.Object(
    {
        content: mcpContentBlockSchema,
        role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    },
    { additionalProperties: false },
);

export const mcpGetPromptResultSchema = Type.Object(
    {
        description: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        messages: Type.Array(mcpPromptMessageSchema, { maxItems: MAX_MCP_PAGE_SIZE }),
        _meta: mcpMetaSchema,
    },
    { additionalProperties: false },
);
export type McpGetPromptResult = Static<typeof mcpGetPromptResultSchema>;

export const mcpServerStatusSchema = Type.Union([
    Type.Literal("blocked"),
    Type.Literal("connected"),
    Type.Literal("disabled"),
    Type.Literal("failed"),
]);
export type McpServerStatus = Static<typeof mcpServerStatusSchema>;

export const mcpFingerprintSchema = Type.String({
    minLength: 64,
    maxLength: 64,
    pattern: "^[0-9a-f]{64}$",
});

const mcpToolPolicyProperties = {
    disabledTools: Type.Optional(
        Type.Array(mcpToolNameSchema, {
            maxItems: MAX_MCP_PAGE_SIZE,
            uniqueItems: true,
        }),
    ),
    enabledTools: Type.Optional(
        Type.Array(mcpToolNameSchema, {
            maxItems: MAX_MCP_PAGE_SIZE,
            uniqueItems: true,
        }),
    ),
} as const;

export const mcpToolPolicySchema = Type.Object(mcpToolPolicyProperties, {
    additionalProperties: false,
});
export type McpToolPolicy = Static<typeof mcpToolPolicySchema>;

export const mcpServerSummarySchema = Type.Object(
    {
        ...mcpToolPolicyProperties,
        errorMessage: Type.Optional(Type.String({ maxLength: MAX_MCP_ERROR_MESSAGE_LENGTH })),
        fingerprint: Type.Optional(mcpFingerprintSchema),
        name: mcpServerNameSchema,
        promptSupport: Type.Optional(Type.Boolean()),
        resourceSupport: Type.Optional(Type.Boolean()),
        status: mcpServerStatusSchema,
        toolCount: Type.Integer({ minimum: 0, maximum: MAX_MCP_PAGE_SIZE * MAX_MCP_PAGE_SIZE }),
    },
    { additionalProperties: false },
);
export type McpServerSummary = Static<typeof mcpServerSummarySchema>;

export const mcpConnectedServerSchema = Type.Object(
    { name: mcpServerNameSchema },
    { additionalProperties: false },
);
export const mcpConnectedServerListSchema = Type.Array(mcpConnectedServerSchema, {
    maxItems: MAX_MCP_TOTAL_SERVERS,
});
export type McpConnectedServer = Static<typeof mcpConnectedServerSchema>;

export const mcpServerPageQuerySchema = Type.Object(
    {
        cursor: Type.Optional(mcpCursorSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MCP_PAGE_SIZE })),
    },
    { additionalProperties: false },
);
export type McpServerPageQuery = Static<typeof mcpServerPageQuerySchema>;

export const mcpServerPageSchema = Type.Object(
    {
        nextCursor: Type.Optional(mcpCursorSchema),
        servers: Type.Array(mcpServerSummarySchema, { maxItems: MAX_MCP_PAGE_SIZE }),
    },
    { additionalProperties: false },
);
export type McpServerPage = Static<typeof mcpServerPageSchema>;
export const mcpIndexedServerSchema = Type.Object(
    {
        agentId: mcpAgentIdSchema,
        errorMessage: Type.Optional(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH })),
        fingerprint: Type.Optional(mcpFingerprintSchema),
        name: mcpServerNameSchema,
        status: mcpServerStatusSchema,
        toolCount: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type McpIndexedServer = Static<typeof mcpIndexedServerSchema>;

export const mcpToolPageQuerySchema = Type.Object(
    {
        cursor: Type.Optional(mcpCursorSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MCP_PAGE_SIZE })),
        server: mcpServerNameSchema,
    },
    { additionalProperties: false },
);
export type McpToolPageQuery = Static<typeof mcpToolPageQuerySchema>;

export const mcpToolPageSchema = Type.Object(
    {
        nextCursor: Type.Optional(mcpCursorSchema),
        tools: Type.Array(mcpToolSchema, { maxItems: MAX_MCP_PAGE_SIZE }),
    },
    { additionalProperties: false },
);
export type McpToolPage = Static<typeof mcpToolPageSchema>;

export const mcpResourcePageQuerySchema = Type.Object(
    {
        cursor: Type.Optional(mcpCursorSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MCP_PAGE_SIZE })),
        server: mcpServerNameSchema,
    },
    { additionalProperties: false },
);
export type McpResourcePageQuery = Static<typeof mcpResourcePageQuerySchema>;

export const mcpResourcePageSchema = Type.Object(
    {
        nextCursor: Type.Optional(mcpCursorSchema),
        resources: Type.Array(mcpResourceSchema, { maxItems: MAX_MCP_PAGE_SIZE }),
    },
    { additionalProperties: false },
);
export type McpResourcePage = Static<typeof mcpResourcePageSchema>;

export const mcpResourceTemplatePageSchema = Type.Object(
    {
        nextCursor: Type.Optional(mcpCursorSchema),
        resourceTemplates: Type.Array(mcpResourceTemplateSchema, {
            maxItems: MAX_MCP_PAGE_SIZE,
        }),
    },
    { additionalProperties: false },
);
export type McpResourceTemplatePage = Static<typeof mcpResourceTemplatePageSchema>;

export const mcpPromptPageSchema = Type.Object(
    {
        nextCursor: Type.Optional(mcpCursorSchema),
        prompts: Type.Array(mcpPromptSchema, { maxItems: MAX_MCP_PAGE_SIZE }),
    },
    { additionalProperties: false },
);
export type McpPromptPage = Static<typeof mcpPromptPageSchema>;

export const mcpPromptPageQuerySchema = Type.Object(
    {
        cursor: Type.Optional(mcpCursorSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MCP_PAGE_SIZE })),
        server: mcpServerNameSchema,
    },
    { additionalProperties: false },
);
export type McpPromptPageQuery = Static<typeof mcpPromptPageQuerySchema>;

export const mcpListToolsInputSchema = Type.Object(
    { server: mcpServerNameSchema, cursor: Type.Optional(mcpCursorSchema) },
    { additionalProperties: false },
);
export const mcpCallToolInputSchema = Type.Object(
    {
        arguments: Type.Optional(mcpJsonObjectSchema),
        name: mcpToolNameSchema,
        server: mcpServerNameSchema,
    },
    { additionalProperties: false },
);
export const mcpListResourcesInputSchema = Type.Object(
    { server: mcpServerNameSchema, cursor: Type.Optional(mcpCursorSchema) },
    { additionalProperties: false },
);
export const mcpReadResourceInputSchema = Type.Object(
    { server: mcpServerNameSchema, uri: mcpUriSchema },
    { additionalProperties: false },
);
export const mcpListPromptsInputSchema = Type.Object(
    { server: mcpServerNameSchema, cursor: Type.Optional(mcpCursorSchema) },
    { additionalProperties: false },
);
export const mcpGetPromptInputSchema = Type.Object(
    {
        arguments: Type.Optional(
            Type.Record(
                Type.String({ maxLength: MAX_MCP_JSON_KEY_LENGTH }),
                Type.String({ maxLength: MAX_MCP_JSON_STRING_LENGTH }),
                { maxProperties: MAX_MCP_JSON_OBJECT_PROPERTIES },
            ),
        ),
        name: mcpToolNameSchema,
        server: mcpServerNameSchema,
    },
    { additionalProperties: false },
);

export type McpCallToolInput = Static<typeof mcpCallToolInputSchema>;
export type McpReadResourceInput = Static<typeof mcpReadResourceInputSchema>;
export type McpListToolsInput = Static<typeof mcpListToolsInputSchema>;
export type McpListResourcesInput = Static<typeof mcpListResourcesInputSchema>;
export type McpListPromptsInput = Static<typeof mcpListPromptsInputSchema>;
export type McpGetPromptInput = Static<typeof mcpGetPromptInputSchema>;

/**
 * The configuration is a Happy Agent-owned value used by the live MCP client lifecycle and by the
 * stable fingerprint boundary.
 */
const mcpCommonConfig = {
    ...mcpToolPolicyProperties,
    enabled: Type.Optional(Type.Boolean()),
    startupTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
    toolTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
} as const;

export const mcpStdioServerConfigSchema = Type.Object(
    {
        ...mcpCommonConfig,
        args: Type.Optional(
            Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: MAX_MCP_PAGE_SIZE }),
        ),
        command: Type.String({ minLength: 1, maxLength: 4_096 }),
        cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        env: Type.Optional(
            Type.Record(
                Type.String({ minLength: 1, maxLength: 256 }),
                Type.String({ maxLength: 16_384 }),
                {
                    maxProperties: MAX_MCP_JSON_OBJECT_PROPERTIES,
                },
            ),
        ),
        transport: Type.Literal("stdio"),
    },
    { additionalProperties: false },
);

export const mcpHttpServerConfigSchema = Type.Object(
    {
        ...mcpCommonConfig,
        bearerTokenEnvVar: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        headers: Type.Optional(
            Type.Record(
                Type.String({ minLength: 1, maxLength: 256 }),
                Type.String({ maxLength: 16_384 }),
                {
                    maxProperties: MAX_MCP_JSON_OBJECT_PROPERTIES,
                },
            ),
        ),
        oauthClientIdEnvVar: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        oauthClientSecretEnvVar: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        oauthScopes: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
                maxItems: MAX_MCP_PAGE_SIZE,
            }),
        ),
        transport: Type.Literal("http"),
        url: Type.String({ minLength: 1, maxLength: MAX_MCP_URI_LENGTH }),
    },
    { additionalProperties: false },
);

export const mcpServerConfigSchema = Type.Union([
    mcpStdioServerConfigSchema,
    mcpHttpServerConfigSchema,
]);
export type McpServerConfig = Static<typeof mcpServerConfigSchema>;
export type McpStdioServerConfig = Static<typeof mcpStdioServerConfigSchema>;
export type McpHttpServerConfig = Static<typeof mcpHttpServerConfigSchema>;

export const mcpServerConfigSourceSchema = Type.Union([
    Type.Literal("global"),
    Type.Literal("project"),
    Type.Literal("runtime"),
]);
export type McpServerConfigSource = Static<typeof mcpServerConfigSourceSchema>;

export const mcpServerConfigEntrySchema = Type.Object(
    {
        config: mcpServerConfigSchema,
        name: mcpServerNameSchema,
        projectShadowed: Type.Optional(Type.Boolean()),
        source: mcpServerConfigSourceSchema,
    },
    { additionalProperties: false },
);
export type McpServerConfigEntry = Static<typeof mcpServerConfigEntrySchema>;
export const mcpServerConfigEntryListSchema = Type.Array(mcpServerConfigEntrySchema, {
    maxItems: MAX_MCP_PAGE_SIZE,
});
export type McpServerConfigEntryList = Static<typeof mcpServerConfigEntryListSchema>;

export const mcpServerTrustRequestSchema = Type.Object(
    {
        config: mcpServerConfigSchema,
        effectiveCwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        fingerprint: mcpFingerprintSchema,
        name: mcpServerNameSchema,
        source: mcpServerConfigSourceSchema,
    },
    { additionalProperties: false },
);
export type McpServerTrustRequest = Static<typeof mcpServerTrustRequestSchema>;

export const mcpElicitationPropertySchema = Type.Record(
    Type.String({ maxLength: MAX_MCP_JSON_KEY_LENGTH }),
    mcpJsonValueSchema,
    { maxProperties: MAX_MCP_JSON_OBJECT_PROPERTIES },
);
export const mcpElicitationRequestSchema = Type.Object(
    {
        method: Type.Literal("elicitation/create"),
        params: Type.Object(
            {
                message: Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH }),
                requestedSchema: Type.Object(
                    {
                        $schema: Type.Optional(mcpUriSchema),
                        additionalProperties: Type.Optional(Type.Boolean()),
                        properties: Type.Record(
                            Type.String({ maxLength: MAX_MCP_JSON_KEY_LENGTH }),
                            mcpElicitationPropertySchema,
                            { maxProperties: MAX_MCP_JSON_OBJECT_PROPERTIES },
                        ),
                        required: Type.Optional(
                            Type.Array(Type.String({ maxLength: MAX_MCP_JSON_KEY_LENGTH }), {
                                maxItems: MAX_MCP_JSON_OBJECT_PROPERTIES,
                            }),
                        ),
                        type: Type.Literal("object"),
                    },
                    { additionalProperties: false },
                ),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);
export type McpElicitationRequest = Static<typeof mcpElicitationRequestSchema>;

export const mcpElicitationResultSchema = Type.Union([
    Type.Object(
        {
            action: Type.Literal("accept"),
            content: mcpJsonObjectSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object({ action: Type.Literal("decline") }, { additionalProperties: false }),
]);
export type McpElicitationResult = Static<typeof mcpElicitationResultSchema>;

export const mcpUserInputOptionSchema = Type.Object(
    {
        description: Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH }),
        label: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);
export const mcpUserInputQuestionSchema = Type.Object(
    {
        header: Type.String({ minLength: 1, maxLength: 12 }),
        id: Type.String({ minLength: 1, maxLength: MAX_MCP_JSON_KEY_LENGTH }),
        multiSelect: Type.Boolean(),
        options: Type.Array(mcpUserInputOptionSchema, { maxItems: MAX_MCP_PAGE_SIZE }),
        question: Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH }),
        required: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
export const mcpUserInputRequestSchema = Type.Object(
    {
        requestId: Type.String({ minLength: 1, maxLength: MAX_MCP_URI_LENGTH }),
        questions: Type.Array(mcpUserInputQuestionSchema, { maxItems: MAX_MCP_PAGE_SIZE }),
    },
    { additionalProperties: false },
);
export type McpUserInputRequest = Static<typeof mcpUserInputRequestSchema>;

export const mcpUserInputResponseSchema = Type.Object(
    {
        answers: Type.Optional(
            Type.Record(
                Type.String({ maxLength: MAX_MCP_JSON_KEY_LENGTH }),
                Type.Array(Type.String({ maxLength: MAX_MCP_DESCRIPTION_LENGTH }), {
                    maxItems: MAX_MCP_PAGE_SIZE,
                }),
                { maxProperties: MAX_MCP_JSON_OBJECT_PROPERTIES },
            ),
        ),
        status: Type.Union([Type.Literal("answered"), Type.Literal("cancelled")]),
    },
    { additionalProperties: false },
);
export type McpUserInputResponse = Static<typeof mcpUserInputResponseSchema>;
