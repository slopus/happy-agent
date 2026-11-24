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
/** A task's workspace is its group and its one agent is its session. Requires `appState`. */
export const liveTaskTargetSchema = Type.Object(
    { kind: Type.Literal("task"), connectionId, groupId, sessionId, taskId: liveDesktopIdSchema },
    closed,
);
export type LiveTaskTarget = Static<typeof liveTaskTargetSchema>;
export const liveDesktopTargetSchema = Type.Union([
    liveProjectTargetSchema,
    liveWorkspaceTargetSchema,
    liveSessionTargetSchema,
    liveBotTargetSchema,
    liveTaskTargetSchema,
]);
export type LiveDesktopTarget = Static<typeof liveDesktopTargetSchema>;
/** The conversation of the daemon's own agent on the call's local connection. Requires `agentTargets`. */
export const liveAgentTargetSchema = Type.Object(
    {
        kind: Type.Literal("agent"),
        connectionId,
        agentId: Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }),
    },
    closed,
);
export type LiveAgentTarget = Static<typeof liveAgentTargetSchema>;
/** What an action may name wherever it takes a desktop target. */
export const liveActionTargetSchema = Type.Union([liveDesktopTargetSchema, liveAgentTargetSchema]);
export type LiveActionTarget = Static<typeof liveActionTargetSchema>;
/** What an action may name wherever it takes a session reference. */
export const liveActionSessionSchema = Type.Union([liveSessionRefSchema, liveAgentTargetSchema]);
export type LiveActionSession = Static<typeof liveActionSessionSchema>;

/** Additive desktop capabilities, negotiated when a call is created. Unknown names are ignored. */
/**
 * Why a call failed, for a desktop to say how it ended. Optional and additive: a daemon that does
 * not know the cause omits it, and `error` remains the human-readable explanation.
 */
export const liveFailureReasonSchema = Type.Union([
    Type.Literal("signIn"),
    Type.Literal("apiKey"),
    Type.Literal("forbidden"),
    Type.Literal("unsupported"),
    Type.Literal("usageExhausted"),
    Type.Literal("setupTimeout"),
    Type.Literal("readinessTimeout"),
    Type.Literal("connectionLost"),
    Type.Literal("controlLost"),
    Type.Literal("restart"),
]);
export type LiveFailureReason = Static<typeof liveFailureReasonSchema>;

export const LIVE_DESKTOP_CAPABILITIES = [
    "appState",
    "voiceFocus",
    "taskCreate",
    "sessionModelChange",
    "agentTargets",
    "failureReasons",
] as const;
export type LiveDesktopCapability = (typeof LIVE_DESKTOP_CAPABILITIES)[number];
export const liveDesktopCapabilitiesSchema = Type.Array(
    Type.String({ minLength: 1, maxLength: 64 }),
    { maxItems: 16, uniqueItems: true },
);

export const liveDesktopSessionStatusSchema = Type.Union([
    Type.Literal("idle"),
    Type.Literal("running"),
    Type.Literal("awaitingInput"),
    Type.Literal("waiting"),
    Type.Literal("error"),
    Type.Literal("unknown"),
]);
export type LiveDesktopSessionStatus = Static<typeof liveDesktopSessionStatusSchema>;
export const liveWorkspaceStatusSchema = Type.Union([
    Type.Literal("ready"),
    Type.Literal("preparing"),
    Type.Literal("error"),
    Type.Literal("unknown"),
]);
export type LiveWorkspaceStatus = Static<typeof liveWorkspaceStatusSchema>;
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
                { target: liveWorkspaceTargetSchema, name, status: liveWorkspaceStatusSchema },
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

/** Epoch milliseconds floored to the minute; the daemon formats it in the AppState time zone. */
const lastActivityAt = Type.Union([
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    Type.Null(),
]);
const providerId = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const modelId = Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" });
const effort = Type.String({ minLength: 1, maxLength: 128 });
export const liveAppStateSessionSchema = Type.Object(
    {
        target: liveSessionRefSchema,
        title: Type.Union([name, Type.Null()]),
        status: liveDesktopSessionStatusSchema,
        lastActivityAt,
    },
    closed,
);
export type LiveAppStateSession = Static<typeof liveAppStateSessionSchema>;
const appStateSessions = Type.Array(liveAppStateSessionSchema, { maxItems: 100 });
export const liveAppStateModelSchema = Type.Object(
    {
        providerId,
        providerName: name,
        modelId,
        name,
        efforts: Type.Array(effort, { maxItems: 16 }),
        defaultEffort: Type.Union([effort, Type.Null()]),
    },
    closed,
);
export type LiveAppStateModel = Static<typeof liveAppStateModelSchema>;
export const liveAppStateServerSchema = Type.Object(
    {
        connectionId,
        name,
        kind: Type.Union([Type.Literal("local"), Type.Literal("remote")]),
        online: Type.Boolean(),
        catalog: Type.Union([
            Type.Literal("ready"),
            Type.Literal("loading"),
            Type.Literal("error"),
        ]),
        bots: Type.Array(
            Type.Object(
                {
                    target: liveBotTargetSchema,
                    name,
                    status: liveDesktopSessionStatusSchema,
                    lastActivityAt,
                },
                closed,
            ),
            { maxItems: 100 },
        ),
        tasks: Type.Array(
            Type.Object(
                {
                    target: liveTaskTargetSchema,
                    name,
                    status: liveDesktopSessionStatusSchema,
                    lastActivityAt,
                },
                closed,
            ),
            { maxItems: 100 },
        ),
        projects: Type.Array(
            Type.Object(
                {
                    target: liveProjectTargetSchema,
                    name,
                    sessions: appStateSessions,
                    workspaces: Type.Array(
                        Type.Object(
                            {
                                target: liveWorkspaceTargetSchema,
                                name,
                                status: liveWorkspaceStatusSchema,
                                sessions: appStateSessions,
                            },
                            closed,
                        ),
                        { maxItems: 100 },
                    ),
                },
                closed,
            ),
            { maxItems: 100 },
        ),
        models: Type.Array(liveAppStateModelSchema, { maxItems: 200 }),
    },
    closed,
);
export type LiveAppStateServer = Static<typeof liveAppStateServerSchema>;

/** The whole visible sidebar in canonical order, plus the focused conversation. */
export const liveAppStateSchema = Type.Object(
    {
        timeZone: Type.String({
            minLength: 1,
            maxLength: 64,
            pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
        }),
        servers: Type.Array(liveAppStateServerSchema, { maxItems: 32 }),
        focused: Type.Union([
            Type.Object(
                {
                    target: liveDesktopTargetSchema,
                    title: Type.Union([name, Type.Null()]),
                    latestMessage: Type.Union([
                        Type.Object(
                            {
                                state: Type.Literal("loaded"),
                                role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
                                text,
                                truncated: Type.Boolean(),
                            },
                            closed,
                        ),
                        Type.Object({ state: Type.Literal("empty") }, closed),
                        Type.Object({ state: Type.Literal("notLoaded") }, closed),
                    ]),
                },
                closed,
            ),
            Type.Null(),
        ]),
        truncated: Type.Boolean(),
    },
    closed,
);
export type LiveAppState = Static<typeof liveAppStateSchema>;

export const liveDesktopActionSchema = Type.Union([
    Type.Object({ type: Type.Literal("desktopState") }, closed),
    Type.Object({ type: Type.Literal("desktopOpen"), target: liveActionTargetSchema }, closed),
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
    Type.Object({ type: Type.Literal("sessionRead"), target: liveActionSessionSchema }, closed),
    Type.Object(
        { type: Type.Literal("sessionSend"), target: liveActionSessionSchema, text: actionText },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("sessionWatch"),
            target: liveActionSessionSchema,
            enabled: Type.Boolean(),
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("composerDraftAppend"),
            target: liveActionSessionSchema,
            text: actionText,
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("taskCreate"),
            connectionId,
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" })),
            text: actionText,
            model: Type.Optional(Type.Object({ providerId, modelId }, closed)),
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("sessionModelChange"),
            target: liveActionSessionSchema,
            providerId,
            modelId,
        },
        closed,
    ),
]);
export type LiveDesktopAction = Static<typeof liveDesktopActionSchema>;

export const liveDesktopActionOutputSchema = Type.Union([
    Type.Object({ type: Type.Literal("ack") }, closed),
    Type.Object({ type: Type.Literal("staged") }, closed),
    Type.Object({ type: Type.Literal("context"), context: liveDesktopContextSchema }, closed),
    Type.Object({ type: Type.Literal("created"), target: liveActionTargetSchema }, closed),
    Type.Object(
        {
            type: Type.Literal("session"),
            ...sessionSnapshotProperties,
            target: liveActionSessionSchema,
        },
        closed,
    ),
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
    Type.Object({ type: Type.Literal("appState"), appState: liveAppStateSchema }, closed),
]);
export type LiveControlClientMessage = Static<typeof liveControlClientMessageSchema>;

export const liveControlServerMessageSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("hello"),
            sessionId: liveResourceIdSchema,
            windowId: liveDesktopIdSchema,
            contextRevision: liveContextRevisionSchema,
            /** The accepted capabilities, present only when the desktop requested some. */
            capabilities: Type.Optional(liveDesktopCapabilitiesSchema),
        },
        closed,
    ),
    Type.Object(
        {
            type: Type.Literal("voiceFocus"),
            focusId: liveDesktopIdSchema,
            contextRevision: liveContextRevisionSchema,
            target: Type.Union([liveDesktopTargetSchema, Type.Null()]),
            reason: Type.Union([Type.Literal("mention"), Type.Literal("navigation")]),
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
            /** Sent only to a desktop that negotiated `failureReasons`. */
            reason: Type.Optional(liveFailureReasonSchema),
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
