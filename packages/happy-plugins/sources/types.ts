import { type Static, type TSchema, Type } from "@sinclair/typebox";

import type {
    CreateHappyComputeInput,
    ExecHappyComputeInput,
    HappyComputeEventSubscription,
    HappyComputeExecResult,
    HappyComputeInstance,
    HappyComputePreparationEvent,
    HappyComputeProvider,
    HappyComputeProviderHandlers,
    HappyComputeRegistration,
    ReadHappyComputeInput,
    RegisterHappyComputeProviderInput,
    StopHappyComputeInput,
    WriteHappyComputeInput,
} from "./computeTypes.js";
import {
    happyComputeProviderContributionSchema,
    happyComputeProviderManifestSchema,
} from "./computeTypes.js";

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ minLength: 1 });
const clientChosenIdSchema = Type.String({
    maxLength: 24,
    minLength: 24,
    pattern: "^[a-z0-9]{24}$",
});

// Must stay in sync with MAX_INSTALLED_PLUGINS in Rig's plugin discovery.
export const HAPPY_PLUGIN_MAX_LIST_ITEMS = 64;
export const HAPPY_PLUGIN_MAX_ICON_BYTES = 4 * 1024 * 1024;
export const HAPPY_PLUGIN_MAX_ICON_DIMENSION = 2_048;
export const HAPPY_PLUGIN_MAX_INTERCEPT_DOMAINS = 16;
export const HAPPY_PLUGIN_MAX_NETWORK_BODY_BYTES = 256 * 1024;
export const HAPPY_PLUGIN_MAX_NETWORK_EVENT_BYTES = 512 * 1024;
export const HAPPY_PLUGIN_MAX_NETWORK_HEADER_BYTES = 64 * 1024;
export const HAPPY_PLUGIN_MAX_NETWORK_HEADER_COUNT = 128;
export const HAPPY_PLUGIN_MAX_NETWORK_HEADER_VALUE_LENGTH = 8_192;
export const HAPPY_PLUGIN_MAX_NETWORK_METHOD_LENGTH = 64;
export const HAPPY_PLUGIN_MAX_NETWORK_URL_LENGTH = 8_192;

export const happyProjectSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        id: nonEmptyText,
        name: nonEmptyText,
        path: nonEmptyText,
    },
    exact,
);
export type HappyProject = Static<typeof happyProjectSchema>;

export const happyWorkspaceStatusSchema = Type.Union([
    Type.Literal("initializing"),
    Type.Literal("ready"),
    Type.Literal("failed"),
    Type.Literal("archiving"),
    Type.Literal("archived"),
]);
export type HappyWorkspaceStatus = Static<typeof happyWorkspaceStatusSchema>;

export const happyWorkspaceSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        baseRef: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
        id: nonEmptyText,
        name: nonEmptyText,
        path: nonEmptyText,
        projectId: nonEmptyText,
        status: happyWorkspaceStatusSchema,
        version: Type.Integer({ minimum: 0 }),
    },
    exact,
);
export type HappyWorkspace = Static<typeof happyWorkspaceSchema>;

export const happyWorkspaceEventSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("workspace_created"),
            workspace: happyWorkspaceSchema,
        },
        exact,
    ),
    Type.Object(
        {
            type: Type.Literal("workspace_updated"),
            workspace: happyWorkspaceSchema,
        },
        exact,
    ),
]);
export type HappyWorkspaceEvent = Static<typeof happyWorkspaceEventSchema>;

export interface HappyWorkspaceSubscription {
    readonly failure: string | undefined;
    readonly status: HappyPluginStreamStatus;
    close(): Promise<void>;
}

export const happySessionSchema = Type.Object(
    {
        agentId: nonEmptyText,
        archived: Type.Boolean(),
        cwd: nonEmptyText,
        id: nonEmptyText,
        projectId: nonEmptyText,
        status: nonEmptyText,
        title: Type.Optional(Type.String()),
        workspaceId: Type.Optional(nonEmptyText),
    },
    exact,
);
export type HappySession = Static<typeof happySessionSchema>;

export const createWorkspaceInputSchema = Type.Object(
    {
        baseRef: Type.Optional(Type.String()),
        /** Stable client identity used to reconcile retries with the original reservation. */
        id: Type.Optional(clientChosenIdSchema),
        name: nonEmptyText,
        projectId: nonEmptyText,
    },
    exact,
);
export type CreateWorkspaceInput = Static<typeof createWorkspaceInputSchema>;

export const createWorkspaceBodySchema = Type.Omit(createWorkspaceInputSchema, ["projectId"]);

export const renameWorkspaceInputSchema = Type.Object(
    {
        name: nonEmptyText,
        projectId: nonEmptyText,
        version: Type.Integer({ minimum: 0 }),
        workspaceId: nonEmptyText,
    },
    exact,
);
export type RenameWorkspaceInput = Static<typeof renameWorkspaceInputSchema>;

export const renameWorkspaceBodySchema = Type.Pick(renameWorkspaceInputSchema, ["name", "version"]);

export const archiveWorkspaceInputSchema = Type.Object(
    {
        projectId: nonEmptyText,
        version: Type.Integer({ minimum: 0 }),
        workspaceId: nonEmptyText,
    },
    exact,
);
export type ArchiveWorkspaceInput = Static<typeof archiveWorkspaceInputSchema>;

export const archiveWorkspaceBodySchema = Type.Pick(archiveWorkspaceInputSchema, ["version"]);

export const listWorkspacesInputSchema = Type.Object(
    { projectId: Type.Optional(nonEmptyText) },
    exact,
);
export type ListWorkspacesInput = Static<typeof listWorkspacesInputSchema>;

export const HAPPY_PLUGIN_DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const HAPPY_PLUGIN_MAX_COMMAND_TIMEOUT_MS = 5 * 60_000;
export const HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const HAPPY_PLUGIN_MAX_FILE_BYTES = 1024 * 1024;

const workspaceIdSchema = nonEmptyText;
const workspaceRelativePathSchema = Type.String({ maxLength: 4_096, minLength: 1 });
const fileBytesBase64Schema = Type.String({
    maxLength: Math.ceil(HAPPY_PLUGIN_MAX_FILE_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});
const commandOutputBytesBase64Schema = Type.String({
    maxLength: Math.ceil(HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const executeWorkspaceCommandInputSchema = Type.Object(
    {
        command: Type.String({ maxLength: 64 * 1024, minLength: 1 }),
        timeoutMs: Type.Optional(
            Type.Integer({
                default: HAPPY_PLUGIN_DEFAULT_COMMAND_TIMEOUT_MS,
                maximum: HAPPY_PLUGIN_MAX_COMMAND_TIMEOUT_MS,
                minimum: 1,
            }),
        ),
        workspaceId: workspaceIdSchema,
    },
    exact,
);
export type ExecuteWorkspaceCommandInput = Static<typeof executeWorkspaceCommandInputSchema>;

export const executeWorkspaceCommandBodySchema = Type.Omit(executeWorkspaceCommandInputSchema, [
    "workspaceId",
]);

export const executeWorkspaceCommandResultSchema = Type.Object(
    {
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stderr: Type.String({ maxLength: HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES }),
        stderrTruncated: Type.Boolean(),
        stdout: Type.String({ maxLength: HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES }),
        stdoutTruncated: Type.Boolean(),
        timedOut: Type.Boolean(),
    },
    exact,
);
export type ExecuteWorkspaceCommandResult = Static<typeof executeWorkspaceCommandResultSchema>;

export const executeWorkspaceCommandResponseSchema = Type.Object(
    {
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stderrBase64: commandOutputBytesBase64Schema,
        stderrTruncated: Type.Boolean(),
        stdoutBase64: commandOutputBytesBase64Schema,
        stdoutTruncated: Type.Boolean(),
        timedOut: Type.Boolean(),
    },
    exact,
);
export type ExecuteWorkspaceCommandResponse = Static<typeof executeWorkspaceCommandResponseSchema>;

export const readWorkspaceFileInputSchema = Type.Object(
    {
        path: workspaceRelativePathSchema,
        workspaceId: workspaceIdSchema,
    },
    exact,
);
export type ReadWorkspaceFileInput = Static<typeof readWorkspaceFileInputSchema>;

export const readWorkspaceFileBodySchema = Type.Omit(readWorkspaceFileInputSchema, ["workspaceId"]);

export const readWorkspaceFileResultSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: HAPPY_PLUGIN_MAX_FILE_BYTES, minimum: 0 }),
        content: Type.String(),
    },
    exact,
);
export type ReadWorkspaceFileResult = Static<typeof readWorkspaceFileResultSchema>;

export const readWorkspaceFileResponseSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: HAPPY_PLUGIN_MAX_FILE_BYTES, minimum: 0 }),
        contentBase64: fileBytesBase64Schema,
    },
    exact,
);
export type ReadWorkspaceFileResponse = Static<typeof readWorkspaceFileResponseSchema>;

export const writeWorkspaceFileInputSchema = Type.Object(
    {
        content: Type.String({ maxLength: HAPPY_PLUGIN_MAX_FILE_BYTES }),
        path: workspaceRelativePathSchema,
        workspaceId: workspaceIdSchema,
    },
    exact,
);
export type WriteWorkspaceFileInput = Static<typeof writeWorkspaceFileInputSchema>;

export const writeWorkspaceFileBodySchema = Type.Object(
    {
        contentBase64: fileBytesBase64Schema,
        path: workspaceRelativePathSchema,
    },
    exact,
);

export const writeWorkspaceFileResultSchema = Type.Object(
    {
        bytesWritten: Type.Integer({ maximum: HAPPY_PLUGIN_MAX_FILE_BYTES, minimum: 0 }),
    },
    exact,
);
export type WriteWorkspaceFileResult = Static<typeof writeWorkspaceFileResultSchema>;

export const createSessionInputSchema = Type.Object(
    {
        appendSystemPrompt: Type.Optional(Type.String()),
        cwd: nonEmptyText,
        effort: Type.Optional(Type.String()),
        modelId: Type.Optional(Type.String()),
        providerId: Type.Optional(Type.String()),
        workspaceId: Type.Optional(Type.String()),
    },
    exact,
);
export type CreateSessionInput = Static<typeof createSessionInputSchema>;

export const sendAgentMessageInputSchema = Type.Object(
    {
        agentId: nonEmptyText,
        message: nonEmptyText,
    },
    exact,
);
export type SendAgentMessageInput = Static<typeof sendAgentMessageInputSchema>;

export const sendAgentMessageBodySchema = Type.Pick(sendAgentMessageInputSchema, ["message"]);

export const agentMessageDeliverySchema = Type.Object(
    {
        delivered: Type.Literal(true),
        runId: nonEmptyText,
        sessionId: nonEmptyText,
    },
    exact,
);
export type AgentMessageDelivery = Static<typeof agentMessageDeliverySchema>;

export const happySlotNameSchema = Type.Union([
    Type.Literal("status-line"),
    Type.Literal("above-composer"),
    Type.Literal("title"),
    Type.Literal("sidebar"),
]);
export type HappySlotName = Static<typeof happySlotNameSchema>;

export const happySlotScopeSchema = Type.Union([
    Type.Literal("everywhere"),
    Type.Literal("project"),
    Type.Literal("workspace"),
    Type.Literal("session"),
]);
export type HappySlotScope = Static<typeof happySlotScopeSchema>;

export const happySlotActionSchema = Type.Union([
    Type.Object({ message: Type.String(), type: Type.Literal("send-current-chat") }, exact),
    Type.Object(
        {
            path: Type.Optional(Type.String()),
            query: Type.Optional(Type.Record(Type.String(), Type.String())),
            type: Type.Literal("open-applet"),
            applet: Type.String(),
        },
        exact,
    ),
    Type.Object(
        {
            message: Type.String(),
            sessionId: Type.String(),
            type: Type.Literal("send-chat"),
        },
        exact,
    ),
    Type.Object(
        {
            message: Type.String(),
            sessionId: Type.String(),
            type: Type.Literal("draft-chat"),
        },
        exact,
    ),
    Type.Object(
        {
            effort: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
            projectId: Type.Optional(Type.String()),
            prompt: Type.Optional(Type.String()),
            provider: Type.Optional(Type.String()),
            readOnly: Type.Optional(Type.Boolean()),
            serviceTier: Type.Optional(Type.Literal("fast")),
            title: Type.Optional(Type.String()),
            type: Type.Literal("new-chat"),
            workspaceId: Type.Optional(Type.String()),
        },
        exact,
    ),
]);
export type HappySlotAction = Static<typeof happySlotActionSchema>;

export const happySlotContentSchema = Type.Union([
    Type.Object({ markdown: Type.String(), type: Type.Literal("text") }, exact),
    Type.Object(
        {
            action: happySlotActionSchema,
            label: Type.String(),
            type: Type.Literal("button"),
        },
        exact,
    ),
]);
export type HappySlotContent = Static<typeof happySlotContentSchema>;

export const happySlotEntryAuthorSchema = Type.Union([
    Type.Object({ sessionId: Type.String(), type: Type.Literal("agent") }, exact),
    Type.Object(
        {
            folder: Type.String(),
            name: Type.String(),
            type: Type.Literal("plugin"),
        },
        exact,
    ),
]);
export type HappySlotEntryAuthor = Static<typeof happySlotEntryAuthorSchema>;

export const happySlotEntrySchema = Type.Object(
    {
        author: happySlotEntryAuthorSchema,
        content: happySlotContentSchema,
        createdAt: Type.Number(),
        description: Type.String(),
        id: Type.String(),
        projectId: Type.Optional(Type.String()),
        purpose: Type.String(),
        scope: happySlotScopeSchema,
        sessionId: Type.Optional(Type.String()),
        slot: happySlotNameSchema,
        updatedAt: Type.Number(),
        workspaceId: Type.Optional(Type.String()),
    },
    exact,
);
export type HappySlotEntry = Static<typeof happySlotEntrySchema>;

export const happySlotEntryIdSchema = Type.String({ minLength: 1 });

export const createHappySlotEntryInputSchema = Type.Object(
    {
        content: happySlotContentSchema,
        description: Type.String(),
        projectId: Type.Optional(Type.String()),
        purpose: Type.String(),
        scope: happySlotScopeSchema,
        sessionId: Type.Optional(Type.String()),
        slot: happySlotNameSchema,
        workspaceId: Type.Optional(Type.String()),
    },
    exact,
);
export type CreateHappySlotEntryInput = Static<typeof createHappySlotEntryInputSchema>;

export const listHappySlotEntriesInputSchema = Type.Object(
    {
        projectId: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        slot: Type.Optional(happySlotNameSchema),
        workspaceId: Type.Optional(Type.String()),
    },
    exact,
);
export type ListHappySlotEntriesInput = Static<typeof listHappySlotEntriesInputSchema>;

export const updateHappySlotEntryInputSchema = Type.Object(
    {
        content: Type.Optional(happySlotContentSchema),
        description: Type.Optional(Type.String()),
        purpose: Type.Optional(Type.String()),
        slot: Type.Optional(happySlotNameSchema),
    },
    exact,
);
export type UpdateHappySlotEntryInput = Static<typeof updateHappySlotEntryInputSchema>;

export const happySlotEntryResponseSchema = Type.Object({ entry: happySlotEntrySchema }, exact);
export const listHappySlotEntriesResponseSchema = Type.Object(
    { entries: Type.Array(happySlotEntrySchema) },
    exact,
);

export const HAPPY_PLUGIN_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const happyPublishedMediaNameSchema = Type.String({
    maxLength: 255,
    minLength: 3,
    pattern: "^[^/\\\\]+\\.[A-Za-z0-9]{1,10}$",
});
const happyPublishedMediaPathSchema = Type.String({
    maxLength: 4_096,
    minLength: 3,
    pattern: "^.+\\.[A-Za-z0-9]{1,10}$",
});
const happyPublishedMediaBytesBase64Schema = Type.String({
    maxLength: Math.ceil(HAPPY_PLUGIN_MAX_MEDIA_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const publishHappyMediaInputSchema = Type.Union([
    Type.Object(
        {
            bytes: Type.Uint8Array({ maxByteLength: HAPPY_PLUGIN_MAX_MEDIA_BYTES }),
            name: happyPublishedMediaNameSchema,
        },
        exact,
    ),
    Type.Object(
        {
            name: Type.Optional(happyPublishedMediaNameSchema),
            path: happyPublishedMediaPathSchema,
        },
        exact,
    ),
]);
export type PublishHappyMediaInput = Static<typeof publishHappyMediaInputSchema>;

export const publishHappyMediaBodySchema = Type.Union([
    Type.Object(
        {
            contentBase64: happyPublishedMediaBytesBase64Schema,
            name: happyPublishedMediaNameSchema,
        },
        exact,
    ),
    Type.Object(
        {
            name: Type.Optional(happyPublishedMediaNameSchema),
            path: happyPublishedMediaPathSchema,
        },
        exact,
    ),
]);

export const publishedHappyMediaSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: HAPPY_PLUGIN_MAX_MEDIA_BYTES, minimum: 0 }),
        location: Type.String({ pattern: "^generated/[A-Za-z0-9][A-Za-z0-9._-]*$" }),
        name: happyPublishedMediaNameSchema,
    },
    exact,
);
export type PublishedHappyMedia = Static<typeof publishedHappyMediaSchema>;

export const listProjectsResponseSchema = Type.Object(
    { projects: Type.Array(happyProjectSchema) },
    exact,
);
export const listWorkspacesResponseSchema = Type.Object(
    { workspaces: Type.Array(happyWorkspaceSchema) },
    exact,
);
export const workspaceResponseSchema = Type.Object({ workspace: happyWorkspaceSchema }, exact);
export const listSessionsResponseSchema = Type.Object(
    { sessions: Type.Array(happySessionSchema) },
    exact,
);
export const sessionResponseSchema = Type.Object({ session: happySessionSchema }, exact);

export const happyMcpTextContentSchema = Type.Object(
    { text: Type.String(), type: Type.Literal("text") },
    exact,
);
export const happyMcpImageContentSchema = Type.Object(
    {
        data: Type.String(),
        mimeType: Type.String({ pattern: "^image/" }),
        type: Type.Literal("image"),
    },
    exact,
);
export const happyMcpContentSchema = Type.Union([
    happyMcpTextContentSchema,
    happyMcpImageContentSchema,
]);
export type HappyMcpContent = Static<typeof happyMcpContentSchema>;

export const happyMcpToolResultSchema = Type.Object(
    {
        content: Type.Array(happyMcpContentSchema, { maxItems: 128 }),
        isError: Type.Optional(Type.Boolean()),
        structuredContent: Type.Optional(Type.Unknown()),
    },
    exact,
);
export type HappyMcpToolResult = Static<typeof happyMcpToolResultSchema>;

/**
 * The JSON Schema subset accepted at the plugin socket boundary.
 *
 * `defineMcpTool` additionally checks the complete in-process value with TypeBox's schema guard
 * before this serializable form crosses the socket.
 */
export const happyMcpInputSchemaSchema = Type.Object(
    {
        additionalProperties: Type.Optional(Type.Union([Type.Boolean(), Type.Unknown()])),
        properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        required: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
        type: Type.Literal("object"),
    },
    { additionalProperties: true },
);
export type HappyMcpInputSchema = Static<typeof happyMcpInputSchemaSchema>;

export const happyMcpToolRegistrationSchema = Type.Object(
    {
        _meta: Type.Optional(
            Type.Object(
                {
                    ui: Type.Object(
                        {
                            visibility: Type.Array(
                                Type.Union([Type.Literal("model"), Type.Literal("app")]),
                                { maxItems: 2, minItems: 1, uniqueItems: true },
                            ),
                        },
                        exact,
                    ),
                },
                exact,
            ),
        ),
        description: Type.String({ minLength: 1 }),
        inputSchema: happyMcpInputSchemaSchema,
        name: nonEmptyText,
    },
    exact,
);
export type HappyMcpToolRegistration = Static<typeof happyMcpToolRegistrationSchema>;

export const happyMcpServerRegistrationSchema = Type.Object(
    {
        name: nonEmptyText,
        tools: Type.Array(happyMcpToolRegistrationSchema, { maxItems: 64, minItems: 1 }),
        version: Type.Optional(nonEmptyText),
    },
    exact,
);
export type HappyMcpServerRegistration = Static<typeof happyMcpServerRegistrationSchema>;

export const registerHappyMcpServerResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);
export type RegisterHappyMcpServerResponse = Static<typeof registerHappyMcpServerResponseSchema>;

export const happyMcpCallEventSchema = Type.Object(
    {
        arguments: Type.Unknown(),
        callId: nonEmptyText,
        tool: nonEmptyText,
        type: Type.Literal("call"),
    },
    exact,
);
export const happyMcpCancelEventSchema = Type.Object(
    { callId: nonEmptyText, type: Type.Literal("cancel") },
    exact,
);
export const happyMcpEventSchema = Type.Union([happyMcpCallEventSchema, happyMcpCancelEventSchema]);
export type HappyMcpEvent = Static<typeof happyMcpEventSchema>;

export const happyMcpCallCompletionSchema = Type.Union([
    Type.Object({ result: happyMcpToolResultSchema }, exact),
    Type.Object({ error: nonEmptyText }, exact),
]);
export type HappyMcpCallCompletion = Static<typeof happyMcpCallCompletionSchema>;

export interface HappyMcpToolContext {
    /** Aborted when Rig cancels the model call, times it out, or retires this plugin generation. */
    readonly signal: AbortSignal;
}

export interface HappyMcpTool<TInputSchema extends TSchema = TSchema> {
    readonly description: string;
    readonly inputSchema: TInputSchema;
    readonly name: string;
    /**
     * Official MCP Apps visibility. Omit it to make the tool available to both models and apps.
     */
    readonly visibility?: readonly ("app" | "model")[];
    execute(
        input: Static<TInputSchema>,
        context: HappyMcpToolContext,
    ): HappyMcpToolResult | Promise<HappyMcpToolResult>;
}

export interface StartHappyMcpServerOptions {
    name: string;
    tools: readonly HappyMcpTool[];
    version?: string;
}

export interface HappyMcpServer {
    /** The connection failure that closed this server, when one occurred. */
    readonly failure: string | undefined;
    readonly name: string;
    /** This server's registration for the current plugin process generation. */
    readonly registrationId: string;
    readonly status: HappyMcpServerStatus;
    close(): Promise<void>;
}
export type HappyMcpServerStatus = "closed" | "connected";

export const HAPPY_PLUGIN_MAX_APPS = 8;
export const HAPPY_PLUGIN_MAX_APP_RESOURCES = 64;
export const HAPPY_PLUGIN_MAX_RESOURCE_BYTES = 256 * 1024;
export const HAPPY_PLUGIN_MAX_APP_BYTES = 1024 * 1024;
export const HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES = 256 * 1024;
export const HAPPY_PLUGIN_TRACING_QUEUE_SIZE = 128;
export const HAPPY_PLUGIN_MAX_STORAGE_KEYS = 1_024;
export const HAPPY_PLUGIN_MAX_STORAGE_VALUE_BYTES = 64 * 1024;
export const HAPPY_PLUGIN_MAX_STORAGE_BYTES = 5 * 1024 * 1024;

export const happyPluginAppIdSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$",
});
export const happyPluginResourcePathSchema = Type.String({
    maxLength: 160,
    minLength: 1,
    pattern: "^(?!/)(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)[A-Za-z0-9][A-Za-z0-9._/-]*$",
});
export const happyPluginResourceUriSchema = Type.String({
    pattern: "^ui://[^/?#]+/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?/[A-Za-z0-9][A-Za-z0-9._/-]*$",
});
export const happyPluginResourceMediaTypeSchema = Type.Union([
    Type.Literal("application/json"),
    Type.Literal("font/woff2"),
    Type.Literal("image/jpeg"),
    Type.Literal("image/png"),
    Type.Literal("image/svg+xml"),
    Type.Literal("image/webp"),
    Type.Literal("text/css"),
    Type.Literal("text/html"),
    Type.Literal("text/javascript"),
]);
export type HappyPluginResourceMediaType = Static<typeof happyPluginResourceMediaTypeSchema>;

export const happyPluginAppSidebarSchema = Type.Object(
    {
        icon: Type.Optional(happyPluginResourcePathSchema),
        label: Type.String({ maxLength: 64, minLength: 1 }),
        order: Type.Integer({ maximum: 1_000, minimum: -1_000 }),
    },
    exact,
);
export type HappyPluginAppSidebar = Static<typeof happyPluginAppSidebarSchema>;

export const happyPluginAppManifestSchema = Type.Object(
    {
        id: happyPluginAppIdSchema,
        page: happyPluginResourcePathSchema,
        root: happyPluginResourcePathSchema,
        sidebar: happyPluginAppSidebarSchema,
        title: Type.String({ maxLength: 128, minLength: 1 }),
    },
    exact,
);
export type HappyPluginAppManifest = Static<typeof happyPluginAppManifestSchema>;

export const happyPluginVersionSchema = Type.String({
    default: "0.0.0",
    pattern:
        "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
});
export type HappyPluginVersion = Static<typeof happyPluginVersionSchema>;

export const happyPluginSystemPromptContributionSchema = Type.Union([
    Type.Object(
        {
            text: Type.String({ maxLength: HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES, minLength: 1 }),
        },
        exact,
    ),
    Type.Object(
        {
            path: Type.String({ maxLength: 4_096, minLength: 1 }),
        },
        exact,
    ),
]);
export type HappyPluginSystemPromptContribution = Static<
    typeof happyPluginSystemPromptContributionSchema
>;

export const happyPluginDockerSchema = Type.Union([
    Type.Literal(true),
    Type.Object(
        {
            image: Type.String({
                maxLength: 512,
                minLength: 1,
                pattern: "^\\S+$",
            }),
        },
        exact,
    ),
]);
export type HappyPluginDocker = Static<typeof happyPluginDockerSchema>;

export const happyPluginCategorySchema = Type.Union([
    Type.Literal("automation"),
    Type.Literal("collaboration"),
    Type.Literal("data"),
    Type.Literal("developer-tools"),
    Type.Literal("media"),
    Type.Literal("productivity"),
    Type.Literal("utilities"),
    Type.Literal("other"),
]);
export type HappyPluginCategory = Static<typeof happyPluginCategorySchema>;

export const happyPluginManifestSchema = Type.Object(
    {
        apps: Type.Optional(
            Type.Array(happyPluginAppManifestSchema, {
                maxItems: HAPPY_PLUGIN_MAX_APPS,
                uniqueItems: true,
            }),
        ),
        author: Type.String({
            maxLength: 80,
            minLength: 1,
            pattern:
                "^(?!\\s)(?!.*\\s$)[^\\x00-\\x1F\\x7F-\\x9F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]+$",
        }),
        category: happyPluginCategorySchema,
        compute: Type.Optional(happyComputeProviderManifestSchema),
        description: Type.String({ maxLength: 512, minLength: 1 }),
        docker: Type.Optional(happyPluginDockerSchema),
        icon: Type.String({ maxLength: 4_096, pattern: "^.+\\.[pP][nN][gG]$" }),
        interceptDomains: Type.Optional(
            Type.Array(
                Type.String({
                    maxLength: 253,
                    minLength: 1,
                    pattern:
                        "^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$",
                }),
                {
                    maxItems: HAPPY_PLUGIN_MAX_INTERCEPT_DOMAINS,
                    uniqueItems: true,
                },
            ),
        ),
        main: Type.Optional(
            Type.String({
                pattern:
                    "^(?!.*\\.[dD]\\.[cCmM]?[tT][sS]$).+\\.(?:[cCmM]?[jJ][sS]|[cCmM]?[tT][sS])$",
            }),
        ),
        name: Type.String({ maxLength: 128, minLength: 1 }),
        skills: Type.Optional(Type.String({ minLength: 1 })),
        systemPrompt: Type.Optional(happyPluginSystemPromptContributionSchema),
        version: Type.Optional(happyPluginVersionSchema),
    },
    exact,
);
export type HappyPluginManifest = Static<typeof happyPluginManifestSchema>;

const happyNetworkHeaderValueSchema = Type.Union([
    Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_HEADER_VALUE_LENGTH }),
    Type.Array(Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_HEADER_VALUE_LENGTH }), {
        maxItems: 32,
    }),
]);
export const happyNetworkHeadersSchema = Type.Record(
    Type.String({ maxLength: 256, minLength: 1 }),
    happyNetworkHeaderValueSchema,
    { maxProperties: HAPPY_PLUGIN_MAX_NETWORK_HEADER_COUNT },
);
export type HappyNetworkHeaders = Static<typeof happyNetworkHeadersSchema>;

const happyNetworkBodyBase64Schema = Type.String({
    maxLength: Math.ceil(HAPPY_PLUGIN_MAX_NETWORK_BODY_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const happyNetworkRequestSchema = Type.Object(
    {
        body: Type.Uint8Array({ maxByteLength: HAPPY_PLUGIN_MAX_NETWORK_BODY_BYTES }),
        headers: happyNetworkHeadersSchema,
        hostname: Type.String({ maxLength: 253, minLength: 1 }),
        method: Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_METHOD_LENGTH, minLength: 1 }),
        mode: Type.Union([Type.Literal("handle"), Type.Literal("observe")]),
        url: Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_URL_LENGTH, minLength: 1 }),
    },
    exact,
);
export type HappyNetworkRequest = Static<typeof happyNetworkRequestSchema>;

export const happyNetworkRequestEventSchema = Type.Object(
    {
        bodyBase64: happyNetworkBodyBase64Schema,
        callId: nonEmptyText,
        headers: happyNetworkHeadersSchema,
        hostname: Type.String({ maxLength: 253, minLength: 1 }),
        method: Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_METHOD_LENGTH, minLength: 1 }),
        mode: Type.Union([Type.Literal("handle"), Type.Literal("observe")]),
        type: Type.Literal("request"),
        url: Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_URL_LENGTH, minLength: 1 }),
    },
    exact,
);
export type HappyNetworkRequestEvent = Static<typeof happyNetworkRequestEventSchema>;

export const happyNetworkTunnelEventSchema = Type.Object(
    {
        bytesFromClient: Type.Integer({ minimum: 0 }),
        bytesFromServer: Type.Integer({ minimum: 0 }),
        hostname: Type.String({ maxLength: 253, minLength: 1 }),
        port: Type.Integer({ maximum: 65_535, minimum: 1 }),
        type: Type.Literal("tunnel"),
    },
    exact,
);
export type HappyNetworkTunnel = Static<typeof happyNetworkTunnelEventSchema>;

export const happyNetworkEventSchema = Type.Union([
    happyNetworkRequestEventSchema,
    happyNetworkTunnelEventSchema,
]);
export type HappyNetworkEvent = Static<typeof happyNetworkEventSchema>;

export const happyNetworkPassThroughSchema = Type.Object(
    { type: Type.Literal("pass_through") },
    exact,
);
export const happyNetworkModifiedRequestSchema = Type.Object(
    {
        body: Type.Optional(
            Type.Uint8Array({ maxByteLength: HAPPY_PLUGIN_MAX_NETWORK_BODY_BYTES }),
        ),
        headers: Type.Optional(happyNetworkHeadersSchema),
        method: Type.Optional(
            Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_METHOD_LENGTH, minLength: 1 }),
        ),
        type: Type.Literal("request"),
        url: Type.Optional(
            Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_URL_LENGTH, minLength: 1 }),
        ),
    },
    exact,
);
export const happyNetworkSyntheticResponseSchema = Type.Object(
    {
        body: Type.Optional(
            Type.Uint8Array({ maxByteLength: HAPPY_PLUGIN_MAX_NETWORK_BODY_BYTES }),
        ),
        headers: Type.Optional(happyNetworkHeadersSchema),
        status: Type.Integer({ maximum: 599, minimum: 200 }),
        type: Type.Literal("response"),
    },
    exact,
);
export const happyNetworkRequestResultSchema = Type.Union([
    happyNetworkPassThroughSchema,
    happyNetworkModifiedRequestSchema,
    happyNetworkSyntheticResponseSchema,
]);
export type HappyNetworkRequestResult = Static<typeof happyNetworkRequestResultSchema>;

export const happyNetworkRequestCompletionSchema = Type.Union([
    happyNetworkPassThroughSchema,
    Type.Object({ error: nonEmptyText, type: Type.Literal("error") }, exact),
    Type.Object(
        {
            bodyBase64: Type.Optional(happyNetworkBodyBase64Schema),
            headers: Type.Optional(happyNetworkHeadersSchema),
            method: Type.Optional(
                Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_METHOD_LENGTH, minLength: 1 }),
            ),
            type: Type.Literal("request"),
            url: Type.Optional(
                Type.String({ maxLength: HAPPY_PLUGIN_MAX_NETWORK_URL_LENGTH, minLength: 1 }),
            ),
        },
        exact,
    ),
    Type.Object(
        {
            bodyBase64: Type.Optional(happyNetworkBodyBase64Schema),
            headers: Type.Optional(happyNetworkHeadersSchema),
            status: Type.Integer({ maximum: 599, minimum: 200 }),
            type: Type.Literal("response"),
        },
        exact,
    ),
]);
export type HappyNetworkRequestCompletion = Static<typeof happyNetworkRequestCompletionSchema>;

export const registerHappyNetworkListenerResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);

export interface HappyNetworkSubscription {
    close(): Promise<void>;
}

export type HappyNetworkRequestHandler = (
    request: HappyNetworkRequest,
) => HappyNetworkRequestResult | Promise<HappyNetworkRequestResult>;

export type HappyNetworkTunnelHandler = (tunnel: HappyNetworkTunnel) => void | Promise<void>;

export const happyPluginStateSchema = Type.Union([
    Type.Literal("failed"),
    Type.Literal("running"),
    Type.Literal("stopped"),
]);
export type HappyPluginState = Static<typeof happyPluginStateSchema>;

export const happyPluginStatusSchema = Type.String({
    maxLength: 512,
    minLength: 1,
    pattern: "\\S",
});
export type HappyPluginStatus = Static<typeof happyPluginStatusSchema>;

export const happyPluginSchema = Type.Object(
    {
        compute: Type.Optional(happyComputeProviderContributionSchema),
        folder: Type.String({ maxLength: 255, minLength: 1 }),
        isSelf: Type.Boolean(),
        name: nonEmptyText,
        state: happyPluginStateSchema,
        status: Type.Optional(happyPluginStatusSchema),
        version: happyPluginVersionSchema,
    },
    exact,
);
export type HappyPlugin = Static<typeof happyPluginSchema>;

export const happySystemPromptHookInputSchema = Type.Object(
    {
        systemPrompt: Type.String({ maxLength: HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES }),
        userPrompt: Type.String({ maxLength: HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES }),
    },
    exact,
);
export type HappySystemPromptHookInput = Static<typeof happySystemPromptHookInputSchema>;

export const happySystemPromptHookResultSchema = Type.Object(
    {
        systemPrompt: Type.Optional(
            Type.String({ maxLength: HAPPY_PLUGIN_MAX_SYSTEM_PROMPT_BYTES }),
        ),
    },
    exact,
);
export type HappySystemPromptHookResult = Static<typeof happySystemPromptHookResultSchema>;

export const happySystemPromptHookEventSchema = Type.Object(
    {
        callId: nonEmptyText,
        input: happySystemPromptHookInputSchema,
        type: Type.Literal("system_prompt"),
    },
    exact,
);
export type HappySystemPromptHookEvent = Static<typeof happySystemPromptHookEventSchema>;

export const happySystemPromptHookCompletionSchema = Type.Object(
    {
        result: happySystemPromptHookResultSchema,
    },
    exact,
);
export type HappySystemPromptHookCompletion = Static<typeof happySystemPromptHookCompletionSchema>;

export const happyTracingUsageSchema = Type.Object(
    {
        cacheRead: Type.Number({ minimum: 0 }),
        cacheWrite: Type.Number({ minimum: 0 }),
        input: Type.Number({ minimum: 0 }),
        output: Type.Number({ minimum: 0 }),
        reasoning: Type.Optional(Type.Number({ minimum: 0 })),
        totalTokens: Type.Number({ minimum: 0 }),
    },
    exact,
);
export type HappyTracingUsage = Static<typeof happyTracingUsageSchema>;

const happyTracingBase = {
    sessionId: nonEmptyText,
    timestamp: Type.Number(),
};
export const happyTracingEventSchema = Type.Union([
    Type.Object(
        {
            ...happyTracingBase,
            model: nonEmptyText,
            provider: nonEmptyText,
            type: Type.Literal("turn_started"),
        },
        exact,
    ),
    Type.Object(
        {
            ...happyTracingBase,
            iteration: Type.Integer({ minimum: 1 }),
            model: nonEmptyText,
            provider: nonEmptyText,
            type: Type.Literal("inference_request_started"),
        },
        exact,
    ),
    Type.Object(
        {
            ...happyTracingBase,
            durationMs: Type.Number({ minimum: 0 }),
            iteration: Type.Integer({ minimum: 1 }),
            model: nonEmptyText,
            provider: nonEmptyText,
            success: Type.Boolean(),
            type: Type.Literal("inference_request_finished"),
            usage: Type.Optional(happyTracingUsageSchema),
        },
        exact,
    ),
    Type.Object(
        {
            ...happyTracingBase,
            name: nonEmptyText,
            toolCallId: nonEmptyText,
            type: Type.Literal("tool_call_started"),
        },
        exact,
    ),
    Type.Object(
        {
            ...happyTracingBase,
            durationMs: Type.Number({ minimum: 0 }),
            name: nonEmptyText,
            success: Type.Boolean(),
            toolCallId: nonEmptyText,
            type: Type.Literal("tool_call_finished"),
        },
        exact,
    ),
    Type.Object(
        {
            ...happyTracingBase,
            durationMs: Type.Number({ minimum: 0 }),
            model: nonEmptyText,
            provider: nonEmptyText,
            stopReason: Type.String(),
            success: Type.Boolean(),
            type: Type.Literal("turn_finished"),
        },
        exact,
    ),
]);
export type HappyTracingEvent = Static<typeof happyTracingEventSchema>;

export const registerHappyPluginStreamResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);

export const happyPluginStreamStatusSchema = Type.Union([
    Type.Literal("closed"),
    Type.Literal("connected"),
    Type.Literal("reconnecting"),
]);
export type HappyPluginStreamStatus = Static<typeof happyPluginStreamStatusSchema>;

export interface HappySystemPromptHook {
    readonly failure: string | undefined;
    readonly registrationId: string;
    readonly status: HappyPluginStreamStatus;
    close(): Promise<void>;
}

export interface HappyTracingSubscription {
    readonly failure: string | undefined;
    readonly registrationId: string;
    readonly status: HappyPluginStreamStatus;
    close(): Promise<void>;
}

export const listPluginsResponseSchema = Type.Object(
    {
        plugins: Type.Array(happyPluginSchema, { maxItems: HAPPY_PLUGIN_MAX_LIST_ITEMS }),
    },
    exact,
);

export const happyPluginAppResourceSummarySchema = Type.Object(
    {
        mimeType: Type.String(),
        path: happyPluginResourcePathSchema,
        size: Type.Integer({ maximum: HAPPY_PLUGIN_MAX_RESOURCE_BYTES, minimum: 0 }),
        uri: happyPluginResourceUriSchema,
    },
    exact,
);
export type HappyPluginAppResourceSummary = Static<typeof happyPluginAppResourceSummarySchema>;

export const happyPluginAppToolSummarySchema = Type.Object(
    {
        _meta: Type.Object(
            {
                ui: Type.Object(
                    {
                        resourceUri: Type.String({ pattern: "^ui://" }),
                        visibility: Type.Array(
                            Type.Union([Type.Literal("model"), Type.Literal("app")]),
                            { maxItems: 2, minItems: 1, uniqueItems: true },
                        ),
                    },
                    exact,
                ),
            },
            exact,
        ),
        description: nonEmptyText,
        name: nonEmptyText,
        server: nonEmptyText,
    },
    exact,
);
export type HappyPluginAppToolSummary = Static<typeof happyPluginAppToolSummarySchema>;

/**
 * One host-visible application.
 *
 * `id` is stable across restarts and replacements. `generation` is deliberately not: every plugin
 * process receives a new opaque value so an old renderer cannot address replacement code.
 */
export const happyPluginAppContributionSchema = Type.Object(
    {
        appId: happyPluginAppIdSchema,
        generation: nonEmptyText,
        id: nonEmptyText,
        page: happyPluginResourcePathSchema,
        pluginFolder: nonEmptyText,
        resourceUri: happyPluginResourceUriSchema,
        resources: Type.Array(happyPluginAppResourceSummarySchema, {
            maxItems: HAPPY_PLUGIN_MAX_APP_RESOURCES,
            minItems: 1,
        }),
        sidebar: happyPluginAppSidebarSchema,
        title: Type.String({ maxLength: 128, minLength: 1 }),
        tools: Type.Array(happyPluginAppToolSummarySchema),
    },
    exact,
);
export type HappyPluginAppContribution = Static<typeof happyPluginAppContributionSchema>;

export const happyProviderUsageWindowSchema = Type.Object(
    {
        durationMs: Type.Union([Type.Number(), Type.Null()]),
        resetsAt: Type.Union([Type.Number(), Type.Null()]),
        startsAt: Type.Union([Type.Number(), Type.Null()]),
        usedPercent: Type.Number(),
    },
    exact,
);
export type HappyProviderUsageWindow = Static<typeof happyProviderUsageWindowSchema>;

export const happyProviderUsageCreditsSchema = Type.Object(
    {
        available: Type.Boolean(),
        remainingCents: Type.Union([Type.Number(), Type.Null()]),
        unlimited: Type.Boolean(),
        usedPercent: Type.Union([Type.Number(), Type.Null()]),
    },
    exact,
);
export type HappyProviderUsageCredits = Static<typeof happyProviderUsageCreditsSchema>;

export const happyProviderUsageSchema = Type.Object(
    {
        capturedAt: Type.Number(),
        credits: Type.Union([happyProviderUsageCreditsSchema, Type.Null()]),
        exhausted: Type.Boolean(),
        planName: Type.Union([Type.String(), Type.Null()]),
        providerId: nonEmptyText,
        vendor: Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("grok")]),
        windows: Type.Object(
            {
                fiveHour: Type.Union([happyProviderUsageWindowSchema, Type.Null()]),
                monthly: Type.Union([happyProviderUsageWindowSchema, Type.Null()]),
                weekly: Type.Union([happyProviderUsageWindowSchema, Type.Null()]),
                fableWeekly: Type.Optional(
                    Type.Union([happyProviderUsageWindowSchema, Type.Null()]),
                ),
            },
            exact,
        ),
    },
    exact,
);
export type HappyProviderUsage = Static<typeof happyProviderUsageSchema>;

export const happyProviderUsageTokensSchema = Type.Object(
    {
        inferences: Type.Integer({ minimum: 0 }),
        input: Type.Integer({ minimum: 0 }),
        output: Type.Integer({ minimum: 0 }),
        total: Type.Integer({ minimum: 0 }),
        turns: Type.Integer({ minimum: 0 }),
    },
    exact,
);
export type HappyProviderUsageTokens = Static<typeof happyProviderUsageTokensSchema>;

export const happyProviderUsageEntrySchema = Type.Object(
    {
        checkedAt: Type.Union([Type.Number(), Type.Null()]),
        error: Type.Union([Type.String(), Type.Null()]),
        providerId: nonEmptyText,
        tokens: happyProviderUsageTokensSchema,
        usage: Type.Union([happyProviderUsageSchema, Type.Null()]),
    },
    exact,
);
export type HappyProviderUsageEntry = Static<typeof happyProviderUsageEntrySchema>;

export const listHappyProviderUsageResponseSchema = Type.Object(
    {
        providers: Type.Array(happyProviderUsageEntrySchema),
    },
    exact,
);

export const happyPluginTestSeedSchema = Type.Object(
    {
        computeProvider: Type.Optional(happyComputeProviderManifestSchema),
        plugins: Type.Optional(
            Type.Array(happyPluginSchema, { maxItems: HAPPY_PLUGIN_MAX_LIST_ITEMS }),
        ),
        providerUsage: Type.Optional(Type.Array(happyProviderUsageEntrySchema)),
        projects: Type.Optional(Type.Array(happyProjectSchema)),
        sessions: Type.Optional(Type.Array(happySessionSchema)),
        workspaces: Type.Optional(Type.Array(happyWorkspaceSchema)),
    },
    exact,
);
export type HappyPluginTestSeed = Static<typeof happyPluginTestSeedSchema>;

export const happyPluginTestRequestSchema = Type.Object(
    {
        body: Type.Optional(Type.Unknown()),
        method: nonEmptyText,
        path: nonEmptyText,
    },
    exact,
);
export type HappyPluginTestRequest = Static<typeof happyPluginTestRequestSchema>;

export const createHappyPluginClientOptionsSchema = Type.Object(
    {
        socketPath: Type.Optional(Type.String()),
        token: Type.Optional(Type.String()),
    },
    exact,
);
export type CreateHappyPluginClientOptions = Static<typeof createHappyPluginClientOptionsSchema>;

export const happyPluginReadyBodySchema = Type.Object({ status: happyPluginStatusSchema }, exact);
export const updateHappyPluginStatusBodySchema = happyPluginReadyBodySchema;

/**
 * The public API available to a running Happy plugin.
 *
 * Use the exported {@link happy} singleton in normal plugin code. Happy injects and authenticates
 * its transport when the plugin process starts.
 */
export interface HappyPluginClient {
    /**
     * Declares startup complete after every MCP server and other contribution has registered.
     *
     * Happy rejects registrations made after this call.
     */
    ready(status: HappyPluginStatus): Promise<void>;
    /** Send a durable notification to an agent identified by a session's stable Agent ID. */
    readonly agents: {
        sendMessage(input: SendAgentMessageInput): Promise<AgentMessageDelivery>;
    };
    /** Register or consume generation-scoped filesystem-and-command compute providers. */
    readonly compute: {
        create(input: CreateHappyComputeInput): Promise<HappyComputeInstance>;
        readonly events: {
            subscribe(
                handler: (event: HappyComputePreparationEvent) => void | Promise<void>,
            ): Promise<HappyComputeEventSubscription>;
        };
        exec(input: ExecHappyComputeInput): Promise<HappyComputeExecResult>;
        readonly files: {
            read(input: ReadHappyComputeInput): Promise<Uint8Array>;
            write(input: WriteHappyComputeInput): Promise<void>;
        };
        readonly instances: {
            list(): Promise<readonly HappyComputeInstance[]>;
        };
        list(): Promise<readonly HappyComputeProvider[]>;
        register(
            handlers: HappyComputeProviderHandlers,
            options?: RegisterHappyComputeProviderInput,
        ): Promise<HappyComputeRegistration>;
        stop(input: StopHappyComputeInput): Promise<void>;
    };
    /** Register middleware that may replace the composed system prompt before an agent turn. */
    readonly hooks: {
        onSystemPrompt(
            handler: (
                input: HappySystemPromptHookInput,
            ) => HappySystemPromptHookResult | Promise<HappySystemPromptHookResult>,
        ): Promise<HappySystemPromptHook>;
    };
    /** Inspect projects known to the local Happy daemon. */
    readonly projects: {
        list(): Promise<readonly HappyProject[]>;
    };
    /** Contribute MCP tools to ordinary Happy agent sessions. */
    readonly mcp: {
        startServer(options: StartHappyMcpServerOptions): Promise<HappyMcpServer>;
    };
    /** Publish a bounded file into Happy's shared generated-media folder. */
    readonly media: {
        publish(input: PublishHappyMediaInput): Promise<PublishedHappyMedia>;
    };
    /**
     * Observe or handle manifest-declared network destinations reached through Happy's managed
     * proxy. The sandbox network allowlist remains authoritative.
     */
    readonly network: {
        onRequest(handler: HappyNetworkRequestHandler): Promise<HappyNetworkSubscription>;
        onTunnel(handler: HappyNetworkTunnelHandler): Promise<HappyNetworkSubscription>;
    };
    /** Inspect plugins registered with the owning Happy daemon. */
    readonly plugins: {
        list(): Promise<readonly HappyPlugin[]>;
    };
    /** Inspect provider-neutral account usage held by the local daemon. */
    readonly providers: {
        usage(): Promise<readonly HappyProviderUsageEntry[]>;
    };
    /** Inspect existing sessions or create a new agent session. */
    readonly sessions: {
        create(input: CreateSessionInput): Promise<HappySession>;
        list(): Promise<readonly HappySession[]>;
    };
    /** Add and manage persistent entries in Happy's fixed UI slots. */
    readonly slots: {
        create(input: CreateHappySlotEntryInput): Promise<HappySlotEntry>;
        list(input?: ListHappySlotEntriesInput): Promise<readonly HappySlotEntry[]>;
        remove(id: string): Promise<HappySlotEntry>;
        update(id: string, input: UpdateHappySlotEntryInput): Promise<HappySlotEntry>;
    };
    /** Observe bounded, non-blocking agent lifecycle events. */
    readonly tracing: {
        subscribe(
            handler: (event: HappyTracingEvent) => void | Promise<void>,
        ): Promise<HappyTracingSubscription>;
    };
    /** Update the plugin-authored human-readable status shown by Happy. */
    readonly status: {
        set(status: HappyPluginStatus): Promise<void>;
    };
    /** Inspect and mutate Happy-managed Git workspaces. */
    readonly workspaces: {
        archive(input: ArchiveWorkspaceInput): Promise<HappyWorkspace>;
        create(input: CreateWorkspaceInput): Promise<HappyWorkspace>;
        exec(input: ExecuteWorkspaceCommandInput): Promise<ExecuteWorkspaceCommandResult>;
        readonly files: {
            read(input: ReadWorkspaceFileInput): Promise<ReadWorkspaceFileResult>;
            write(input: WriteWorkspaceFileInput): Promise<WriteWorkspaceFileResult>;
        };
        list(input?: ListWorkspacesInput): Promise<readonly HappyWorkspace[]>;
        rename(input: RenameWorkspaceInput): Promise<HappyWorkspace>;
        /** Observe workspace reservations and readiness changes through Rig's live event stream. */
        subscribe(
            handler: (event: HappyWorkspaceEvent) => void | Promise<void>,
        ): Promise<HappyWorkspaceSubscription>;
    };
}
