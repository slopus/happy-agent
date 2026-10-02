/** The fixed, window-scoped desktop control surface exposed to GPT-Live. */
import { Type, type Static } from "@sinclair/typebox";

const closed = { additionalProperties: false } as const;
export const liveResourceIdSchema = Type.String({
    minLength: 2,
    maxLength: 32,
    pattern: "^[a-z][a-z0-9]*$",
});
export const liveDesktopIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f-\\u009f]+$",
});
export const liveContextRevisionSchema = Type.Integer({
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});
const name = Type.String({ maxLength: 256 });
const text = Type.String({ maxLength: 16_384 });
const actionText = Type.String({ minLength: 1, maxLength: 16_384, pattern: "\\S" });
const connectionId = liveDesktopIdSchema;
const groupId = liveDesktopIdSchema;
const projectId = liveDesktopIdSchema;
const sessionId = liveDesktopIdSchema;

export const liveProjectRefSchema = Type.Object({ connectionId, projectId }, closed);
export type LiveProjectRef = Static<typeof liveProjectRefSchema>;
export const liveGroupRefSchema = Type.Object({ connectionId, groupId }, closed);
export type LiveGroupRef = Static<typeof liveGroupRefSchema>;
export const liveSessionRefSchema = Type.Object({ connectionId, groupId, sessionId }, closed);
export type LiveSessionRef = Static<typeof liveSessionRefSchema>;

export const liveProjectTargetSchema = Type.Object(
    { kind: Type.Literal("project"), connectionId, projectId, groupId },
    closed,
);
export const liveWorkspaceTargetSchema = Type.Object(
    {
        kind: Type.Literal("workspace"),
        connectionId,
        projectId,
        groupId,
        workspaceId: liveDesktopIdSchema,
    },
    closed,
);
export const liveSessionTargetSchema = Type.Object(
    { kind: Type.Literal("session"), connectionId, groupId, sessionId },
    closed,
);
export const liveBotTargetSchema = Type.Object(
    { kind: Type.Literal("bot"), connectionId, groupId, sessionId, botId: liveDesktopIdSchema },
    closed,
);
export const liveDesktopTargetSchema = Type.Union([
    liveProjectTargetSchema,
    liveWorkspaceTargetSchema,
    liveSessionTargetSchema,
    liveBotTargetSchema,
]);
export type LiveDesktopTarget = Static<typeof liveDesktopTargetSchema>;

export const liveDesktopSessionStatusSchema = Type.Union([
    Type.Literal("idle"),
    Type.Literal("running"),
    Type.Literal("awaitingInput"),
    Type.Literal("waiting"),
    Type.Literal("error"),
    Type.Literal("unknown"),
]);
export type LiveDesktopSessionStatus = Static<typeof liveDesktopSessionStatusSchema>;
export const livePublicTextSchema = Type.Object(
    {
        id: liveDesktopIdSchema,
        role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
        text,
    },
    closed,
);
export type LivePublicText = Static<typeof livePublicTextSchema>;
const publicMessages = Type.Array(livePublicTextSchema, { maxItems: 50 });
const sessionSnapshotProperties = {
    target: liveSessionRefSchema,
    status: liveDesktopSessionStatusSchema,
    messages: publicMessages,
    truncated: Type.Boolean(),
};

export const liveDesktopContextSchema = Type.Object(
    {
        windowId: liveDesktopIdSchema,
        connections: Type.Array(
            Type.Object({ connectionId, name, online: Type.Boolean() }, closed),
            { maxItems: 100 },
        ),
        activeConnectionId: Type.Union([connectionId, Type.Null()]),
        activeTarget: Type.Union([liveDesktopTargetSchema, Type.Null()]),
        projects: Type.Array(Type.Object({ target: liveProjectTargetSchema, name }, closed), {
            maxItems: 100,
        }),
        workspaces: Type.Array(
            Type.Object(
                {
                    target: liveWorkspaceTargetSchema,
                    name,
                    status: Type.Union([
                        Type.Literal("ready"),
                        Type.Literal("preparing"),
                        Type.Literal("error"),
                        Type.Literal("unknown"),
                    ]),
                },
                closed,
            ),
            { maxItems: 100 },
        ),
        sessions: Type.Array(
            Type.Object(
                {
                    target: liveSessionRefSchema,
                    title: Type.Union([name, Type.Null()]),
                    status: liveDesktopSessionStatusSchema,
                },
                closed,
            ),
            { maxItems: 100 },
        ),
        bots: Type.Array(
            Type.Object(
                { target: liveBotTargetSchema, name, status: liveDesktopSessionStatusSchema },
                closed,
            ),
            { maxItems: 100 },
        ),
        activeSession: Type.Union([
            Type.Object(
                {
                    target: liveSessionRefSchema,
                    status: liveDesktopSessionStatusSchema,
                    messages: publicMessages,
                    composerHasDraft: Type.Boolean(),
                    writeRefusal: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]),
                },
                closed,
            ),
            Type.Null(),
        ]),
        truncated: Type.Boolean(),
    },
    closed,
);
export type LiveDesktopContext = Static<typeof liveDesktopContextSchema>;

export const liveDesktopActionSchema = Type.Union([
    Type.Object({ type: Type.Literal("desktopState") }, closed),
    Type.Object({ type: Type.Literal("desktopOpen"), target: liveDesktopTargetSchema }, closed),
    Type.Object({ type: Type.Literal("workspaceCreate"), project: liveProjectRefSchema }, closed),
    Type.Object(
        {
            type: Type.Literal("sessionCreate"),
            group: liveGroupRefSchema,
            prompt: Type.Optional(actionText),
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("botCreate"),
            connectionId,
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" })),
            prompt: Type.Optional(actionText),
        },
        closed,
    ),
    Type.Object({ type: Type.Literal("sessionRead"), target: liveSessionRefSchema }, closed),
    Type.Object(
        { type: Type.Literal("sessionSend"), target: liveSessionRefSchema, text: actionText },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("sessionWatch"),
            target: liveSessionRefSchema,
            enabled: Type.Boolean(),
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("composerDraftAppend"),
            target: liveSessionRefSchema,
            text: actionText,
        },
        closed,
    ),
]);
export type LiveDesktopAction = Static<typeof liveDesktopActionSchema>;

export const liveDesktopActionOutputSchema = Type.Union([
    Type.Object({ type: Type.Literal("ack") }, closed),
    Type.Object({ type: Type.Literal("staged") }, closed),
    Type.Object({ type: Type.Literal("context"), context: liveDesktopContextSchema }, closed),
    Type.Object({ type: Type.Literal("created"), target: liveDesktopTargetSchema }, closed),
    Type.Object({ type: Type.Literal("session"), ...sessionSnapshotProperties }, closed),
]);
export const liveDesktopActionResultSchema = Type.Union([
    Type.Object(
        { status: Type.Literal("succeeded"), output: liveDesktopActionOutputSchema },
        closed,
    ),
    Type.Object({ status: Type.Literal("pending") }, closed),
    Type.Object(
        {
            status: Type.Union([
                Type.Literal("refused"),
                Type.Literal("failed"),
                Type.Literal("cancelled"),
            ]),
            code: Type.Union([
                Type.Literal("staleContext"),
                Type.Literal("unavailable"),
                Type.Literal("forbidden"),
                Type.Literal("draftConflict"),
                Type.Literal("notFound"),
                Type.Literal("ended"),
                Type.Literal("failed"),
            ]),
            message: Type.String({ maxLength: 1024 }),
        },
        closed,
    ),
]);
export type LiveDesktopActionResult = Static<typeof liveDesktopActionResultSchema>;

export const liveControlClientMessageSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("desktopContext"),
            revision: liveContextRevisionSchema,
            context: liveDesktopContextSchema,
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("actionResult"),
            actionId: liveDesktopIdSchema,
            result: liveDesktopActionResultSchema,
        },
        closed,
    ),
    Type.Object({ type: Type.Literal("sessionUpdate"), ...sessionSnapshotProperties }, closed),
]);
export type LiveControlClientMessage = Static<typeof liveControlClientMessageSchema>;

export const liveControlServerMessageSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("hello"),
            sessionId: liveResourceIdSchema,
            windowId: liveDesktopIdSchema,
            contextRevision: liveContextRevisionSchema,
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("actionRequested"),
            actionId: liveDesktopIdSchema,
            contextRevision: liveContextRevisionSchema,
            inputTranscriptIds: Type.Array(liveDesktopIdSchema, {
                maxItems: 32,
                uniqueItems: true,
            }),
            action: liveDesktopActionSchema,
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("status"),
            status: Type.Union([
                Type.Literal("starting"),
                Type.Literal("active"),
                Type.Literal("closing"),
                Type.Literal("closed"),
                Type.Literal("failed"),
            ]),
            error: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]),
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("transcript"),
            transcriptId: liveDesktopIdSchema,
            role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
            text,
            startMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
            endMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("transcript"),
            transcriptId: liveDesktopIdSchema,
            role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
            text,
        },
        closed,
    ),
]);
export type LiveControlServerMessage = Static<typeof liveControlServerMessageSchema>;
