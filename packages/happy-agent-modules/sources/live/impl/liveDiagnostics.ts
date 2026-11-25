import {
    liveDesktopTargetSchema,
    liveSessionRefSchema,
    type LiveDesktopAction,
    type LiveDesktopContext,
} from "@slopus/happy-agent-client";
import type { SessionProviderError } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { withLogContext, type Context } from "@steve.kite/stdlib";

const choices = <T extends string>(values: readonly T[]) =>
    Type.Union(values.map((value) => Type.Literal(value)));
const id = Type.String({ maxLength: 512 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const identity = Type.Object(
    {
        connectionId: id,
        projectId: Type.Optional(id),
        workspaceId: Type.Optional(id),
        groupId: Type.Optional(id),
        sessionId: Type.Optional(id),
        botId: Type.Optional(id),
        taskId: Type.Optional(id),
        agentId: Type.Optional(id),
    },
    { additionalProperties: false },
);

export const liveFailureCategorySchema = choices([
    "inference",
    "deadline",
    "invalidAction",
    "limit",
    "uncertainAction",
    "capacity",
]);
export type LiveFailureCategory = Static<typeof liveFailureCategorySchema>;
export const liveControllerDetailSchema = Type.Object(
    {
        phase: choices([
            "providerOpen",
            "providerStream",
            "providerDone",
            "toolValidation",
            "desktopAction",
            "context",
        ]),
        reason: choices([
            "providerRequestFailed",
            "providerError",
            "providerCancelled",
            "providerLengthLimit",
            "missingCompletion",
            "retryRequested",
            "multipleActions",
            "unsupportedSurface",
            "repeatedAction",
            "incompleteAction",
            "invalidArguments",
            "contextLimit",
            "responseLimit",
            "actionLimit",
            "deadline",
            "actionUncertain",
        ]),
        providerErrorKind: Type.Optional(
            choices(["internal_error", "context_overflow", "billing_error", "unknown"]),
        ),
        providerErrorType: Type.Optional(
            choices<SessionProviderError["type"]>([
                "authentication",
                "out_of_tokens",
                "rate_limit",
                "server_overloaded",
                "internal_server_error",
                "network",
                "empty_response",
                "unclassified",
            ]),
        ),
        round: Type.Optional(count),
    },
    { additionalProperties: false },
);
export type LiveControllerDetail = Static<typeof liveControllerDetailSchema>;

const contextSummarySchema = Type.Object(
    {
        activeConnectionId: Type.Union([id, Type.Null()]),
        activeTarget: Type.Union([liveDesktopTargetSchema, Type.Null()]),
        activeSession: Type.Union([liveSessionRefSchema, Type.Null()]),
        connectionCount: count,
        projectCount: count,
        workspaceCount: count,
        sessionCount: count,
        botCount: count,
        publicMessageCount: count,
        publicMessageCharacters: count,
        composerHasDraft: Type.Boolean(),
        writeBlocked: Type.Boolean(),
        truncated: Type.Boolean(),
    },
    { additionalProperties: false },
);

const diagnosticSchema = Type.Object(
    {
        event: choices([
            "session.created",
            "session.status",
            "provider.ready",
            "control.attached",
            "control.lost",
            "control.invalid",
            "context.accepted",
            "transcript.received",
            "delegation.queued",
            "delegation.started",
            "controller.finished",
            "controller.failed",
            "delegation.delivered",
            "delivery.failed",
            "action.requested",
            "action.result",
            "action.expired",
            "action.lateIgnored",
            "appState.accepted",
            "context.built",
            "context.pushed",
            "focus.sent",
        ]),
        controllerProviderId: Type.Optional(id),
        model: Type.Optional(id),
        effort: Type.Optional(Type.String({ maxLength: 32 })),
        serviceTier: Type.Optional(Type.String({ maxLength: 32 })),
        capabilities: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
        appendCount: Type.Optional(count),
        bytes: Type.Optional(count),
        kind: Type.Optional(
            choices([
                "context",
                "directory",
                "focus",
                "reply",
                "error",
                "outcome",
                "greeting",
                "status",
            ]),
        ),
        speakable: Type.Optional(Type.Boolean()),
        focusReason: Type.Optional(choices(["mention", "navigation", "clear"])),
        outcome: Type.Optional(choices(["fixed", "controller"])),
        outcomeHint: Type.Optional(choices(["queued", "later"])),
        inFlight: Type.Optional(count),
        credentialKind: Type.Optional(choices(["codex_subscription", "openai_api_key"])),
        credentialProviderId: Type.Optional(id),
        voiceAgentId: Type.Optional(id),
        status: Type.Optional(choices(["starting", "active", "closing", "closed", "failed"])),
        context: Type.Optional(contextSummarySchema),
        delegationId: Type.Optional(id),
        actionId: Type.Optional(id),
        transcriptId: Type.Optional(id),
        actionType: Type.Optional(
            choices([
                "desktopState",
                "desktopOpen",
                "workspaceCreate",
                "sessionCreate",
                "botCreate",
                "sessionRead",
                "sessionSend",
                "sessionWatch",
                "composerDraftAppend",
                "taskCreate",
                "sessionModelChange",
            ]),
        ),
        target: Type.Optional(identity),
        enabled: Type.Optional(Type.Boolean()),
        role: Type.Optional(choices(["user", "assistant"])),
        characters: Type.Optional(count),
        durationMs: Type.Optional(count),
        /** For `context.built`: how long reading the directory took, and how many rows it held. */
        directoryMs: Type.Optional(count),
        rows: Type.Optional(count),
        fragmentCount: Type.Optional(count),
        snapshotCount: Type.Optional(count),
        actionCount: Type.Optional(count),
        inputTranscriptIds: Type.Optional(Type.Array(id, { maxItems: 32 })),
        resultStatus: Type.Optional(
            choices(["succeeded", "pending", "refused", "failed", "cancelled"]),
        ),
        resultCode: Type.Optional(
            choices([
                "staleContext",
                "unavailable",
                "forbidden",
                "draftConflict",
                "notFound",
                "ended",
                "failed",
            ]),
        ),
        outputType: Type.Optional(choices(["ack", "staged", "context", "created", "session"])),
        category: Type.Optional(liveFailureCategorySchema),
        detail: Type.Optional(liveControllerDetailSchema),
        reason: Type.Optional(
            choices(["responseDelivery", "invalidControlData", "connectionLost", "actionTimeout"]),
        ),
    },
    { additionalProperties: false },
);
export type LiveDiagnostic = Static<typeof diagnosticSchema>;
const diagnosticScopeSchema = Type.Object(
    {
        sessionId: id,
        windowId: id,
        contextRevision: count,
        elapsedMs: count,
        suppressed: count,
    },
    { additionalProperties: false },
);

/** One bounded, structure-only record in the existing local rotating log. Never a raw error. */
export function logLiveDiagnostic(
    ctx: Context,
    scope: Static<typeof diagnosticScopeSchema>,
    diagnostic: LiveDiagnostic,
): void {
    try {
        if (
            !Value.Check(diagnosticScopeSchema, scope) ||
            !Value.Check(diagnosticSchema, diagnostic)
        )
            return;
        const text = JSON.stringify({
            ...diagnostic,
            contextRevision: scope.contextRevision,
            elapsedMs: scope.elapsedMs,
            suppressed: scope.suppressed,
        });
        if (Buffer.byteLength(text) > 32_768) return;
        withLogContext(ctx, {
            module: "live",
            voiceSessionId: scope.sessionId,
            windowId: scope.windowId,
        }).log.info(text);
    } catch {
        // Observation must never change the outcome of a live call.
    }
}

/** IDs and counts reveal stale or foreign context without recording any labels or messages. */
export function liveContextSummary(
    context: LiveDesktopContext,
): Static<typeof contextSummarySchema> {
    return {
        activeConnectionId: context.activeConnectionId,
        activeTarget: context.activeTarget,
        activeSession: context.activeSession?.target ?? null,
        connectionCount: context.connections.length,
        projectCount: context.projects.length,
        workspaceCount: context.workspaces.length,
        sessionCount: context.sessions.length,
        botCount: context.bots.length,
        publicMessageCount: context.activeSession?.messages.length ?? 0,
        publicMessageCharacters:
            context.activeSession?.messages.reduce(
                (sum, message) => sum + message.text.length,
                0,
            ) ?? 0,
        composerHasDraft: context.activeSession?.composerHasDraft ?? false,
        writeBlocked:
            context.activeSession?.writeRefusal !== null &&
            context.activeSession?.writeRefusal !== undefined,
        truncated: context.truncated,
    };
}

/** Never include the text or optional creation prompt from a desktop action. */
export function liveActionSummary(
    action: LiveDesktopAction,
): Pick<LiveDiagnostic, "actionType" | "target" | "characters" | "enabled"> {
    const details: Pick<LiveDiagnostic, "actionType" | "target" | "characters" | "enabled"> = {
        actionType: action.type,
    };
    if ("target" in action) {
        const target = action.target;
        details.target = {
            connectionId: target.connectionId,
            ...("groupId" in target ? { groupId: target.groupId } : {}),
            ...("sessionId" in target ? { sessionId: target.sessionId } : {}),
            ...("agentId" in target ? { agentId: target.agentId } : {}),
        };
        if (action.type === "desktopOpen") {
            if ("projectId" in action.target) details.target.projectId = action.target.projectId;
            if ("workspaceId" in action.target)
                details.target.workspaceId = action.target.workspaceId;
            if ("botId" in action.target) details.target.botId = action.target.botId;
            if ("taskId" in action.target) details.target.taskId = action.target.taskId;
        }
    } else if (action.type === "workspaceCreate") details.target = action.project;
    else if (action.type === "sessionCreate") details.target = action.group;
    else if (action.type === "botCreate" || action.type === "taskCreate")
        details.target = { connectionId: action.connectionId };
    if ("text" in action) details.characters = action.text.length;
    else if ("prompt" in action && action.prompt !== undefined)
        details.characters = action.prompt.length;
    if (action.type === "sessionWatch") details.enabled = action.enabled;
    return details;
}
