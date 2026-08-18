import type { IncomingMessage, ServerResponse } from "node:http";

import { createId } from "@paralleldrive/cuid2";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    agentPermissionModeSchema,
    type AgentBaseMessageOptions,
    type AgentConfig,
    type AgentModel,
} from "@slopus/happy-agent-base";
import {
    eventIdSchema,
    permissionEventSchema,
    ProjectRegistrationError,
    userInputEventSchema,
    type AgentEvent,
    type PermissionEvent,
    type PermissionReviewTranscript,
    type ResolvedProjectOwnership,
    type UsageSummary,
    type WorkspacesModule,
} from "@slopus/happy-agent-modules";
import type { SessionInputBlock, SessionUserMessage } from "@slopus/happy-providers";

import {
    conversationScopeSchema,
    conversationSessionIdSchema,
    type ConversationRecord,
    type ConversationScope,
} from "../conversations/ConversationModule.js";
import type { StartedHappyAgent } from "../../start/startHappyAgent.js";
import { readValidatedBody } from "./body.js";
import { AgentHttpError, sendJson, serializeJson } from "./errors.js";
import { createRouteGroup, type AgentHttpRouteGroup } from "./router.js";
import {
    createRigModelCatalog,
    readRigProviderCapabilities,
    type RigModelCatalog,
} from "./rigProtocol.js";
import { createSseWriter } from "./sseWriter.js";
import {
    userInputAnswerForModule,
    userInputAnswersForProtocol,
    userInputRequestForProtocol,
} from "./userInputProtocol.js";
import {
    agentMessageOptions,
    checkAgentSelection,
    type RequestedAgentSelection,
} from "./agentMessageOptions.js";
import {
    catalogSelection,
    permissionModeChangedPayloadSchema,
    persistSessionSelection,
    selectionFromMessageOptions,
    sessionConfigurationChangedPayloadSchema,
    sessionSelection,
    type SessionSelection,
} from "./sessionSelection.js";

const MAX_SESSION_STREAM_PENDING_BYTES = 1_024 * 1_024;

const textBlockSchema = Type.Object(
    { type: Type.Literal("text"), text: Type.String({ maxLength: 262_144 }) },
    { additionalProperties: false },
);
const imageBlockSchema = Type.Object(
    {
        data: Type.String({ maxLength: 16 * 1024 * 1024 }),
        mimeType: Type.String({ minLength: 1, maxLength: 256 }),
        type: Type.Literal("image"),
    },
    { additionalProperties: false },
);
const contentBlockSchema = Type.Union([textBlockSchema, imageBlockSchema]);

const submitMessageSchema = Type.Object(
    {
        await: Type.Optional(Type.Boolean()),
        clientSubmissionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        content: Type.Optional(Type.Array(contentBlockSchema, { maxItems: 256 })),
        debug: Type.Optional(Type.Boolean()),
        displayText: Type.Optional(Type.String({ maxLength: 262_144 })),
        effort: Type.String({ minLength: 1, maxLength: 64 }),
        identity: Type.Optional(
            Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
        ),
        interactive: Type.Optional(Type.Boolean()),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        permissionMode: Type.Optional(agentPermissionModeSchema),
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        serviceTier: Type.Union([Type.Literal("fast"), Type.Null()]),
        systemPrompt: Type.Optional(Type.Union([Type.String({ maxLength: 262_144 }), Type.Null()])),
        text: Type.String({ maxLength: 262_144 }),
    },
    { additionalProperties: false },
);

const createSessionSchema = Type.Object(
    {
        appendSystemPrompt: Type.Optional(Type.String({ maxLength: 262_144 })),
        cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
        effort: Type.String({ minLength: 1, maxLength: 64 }),
        id: Type.Optional(conversationSessionIdSchema),
        identity: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        instructions: Type.Optional(Type.String({ maxLength: 262_144 })),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        permissionMode: Type.Optional(agentPermissionModeSchema),
        projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        scope: Type.Optional(conversationScopeSchema),
        secretIds: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 256 }),
        ),
        serviceTier: Type.Union([Type.Literal("fast"), Type.Null()]),
        trackUnread: Type.Optional(Type.Boolean()),
        workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        workflowsEnabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

const listSessionsSchema = Type.Object(
    {
        archived: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("all")])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    },
    { additionalProperties: false },
);

const broadcastSchema = Type.Object(
    {
        all: Type.Optional(Type.Literal(true)),
        await: Type.Optional(Type.Boolean()),
        clientSubmissionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        content: Type.Optional(Type.Array(contentBlockSchema, { maxItems: 256 })),
        debug: Type.Optional(Type.Boolean()),
        displayText: Type.Optional(Type.String({ maxLength: 262_144 })),
        effort: Type.String({ minLength: 1, maxLength: 64 }),
        identity: Type.Optional(
            Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
        ),
        interactive: Type.Optional(Type.Boolean()),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        permissionMode: Type.Optional(agentPermissionModeSchema),
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        serviceTier: Type.Union([Type.Literal("fast"), Type.Null()]),
        sessionIds: Type.Optional(
            Type.Array(conversationSessionIdSchema, { minItems: 1, maxItems: 500 }),
        ),
        systemPrompt: Type.Optional(Type.Union([Type.String({ maxLength: 262_144 }), Type.Null()])),
        text: Type.String({ maxLength: 262_144 }),
    },
    { additionalProperties: false },
);

const scopeMutationSchema = Type.Object(
    {
        afterId: Type.Union([conversationSessionIdSchema, Type.Null()]),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        scope: Type.Object({ kind: Type.Literal("unsorted") }, { additionalProperties: false }),
    },
    { additionalProperties: false },
);
const reorderSchema = Type.Object(
    { afterId: Type.Union([conversationSessionIdSchema, Type.Null()]) },
    { additionalProperties: false },
);
const draftSchema = Type.Object(
    {
        draft: Type.Union([Type.String({ maxLength: 100_000 }), Type.Null()]),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        origin: Type.Optional(Type.String({ maxLength: 128 })),
        updatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
);
const patchSessionSchema = Type.Object(
    {
        appendSystemPrompt: Type.Union([Type.String({ maxLength: 262_144 }), Type.Null()]),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    },
    { additionalProperties: false },
);
const expectedRunSchema = Type.Object(
    {
        expectedRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        await: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);
const goalSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        objective: Type.String({ minLength: 1, maxLength: 100_000 }),
    },
    { additionalProperties: false },
);
const goalStatusSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        status: Type.Union([
            Type.Literal("active"),
            Type.Literal("paused"),
            Type.Literal("blocked"),
            Type.Literal("complete"),
        ]),
    },
    { additionalProperties: false },
);
const secretSchema = Type.Object(
    {
        scope: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        secretId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);
const userInputSchema = Type.Object(
    {
        // The values a person chose or typed, for each question the client showed them.
        answers: Type.Optional(
            Type.Record(
                Type.String({ minLength: 1, maxLength: 256 }),
                Type.Array(Type.String({ maxLength: 8_192 }), { maxItems: 32 }),
                { maxProperties: 8 },
            ),
        ),
        cancel: Type.Optional(Type.Boolean()),
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        reason: Type.Optional(Type.String({ maxLength: 4_096 })),
    },
    { additionalProperties: false },
);
const workflowStopSchema = Type.Object(
    { mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) },
    { additionalProperties: false },
);
const transferSessionSchema = Type.Object(
    {
        mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);
const unsupportedSchema = Type.Object({}, { additionalProperties: false });

type SubmitMessage = Static<typeof submitMessageSchema>;
type CreateSession = Static<typeof createSessionSchema>;
const unknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
type UnknownRecord = Static<typeof unknownRecordSchema>;
type LoadedSessionDependencies = {
    readonly agent: StartedHappyAgent;
};

/**
 * Session/agent compatibility routes. Dynamic `:sessionId` paths are intentional route templates;
 * the daemon router resolves those templates before invoking this group.
 */
export function createSessionRoutes(): AgentHttpRouteGroup {
    return createRouteGroup("sessions", [
        {
            method: "POST",
            path: "/v0/sessions",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, createSessionSchema);
                if (body.workflowsEnabled === true) assertWorkflowsEnabled(dependencies.agent);
                checkAgentSelection(dependencies.agent.system.models, requestedSelection(body));
                const conversation = dependencies.agent.modules.conversations;
                const existing =
                    body.id === undefined ? undefined : await conversation.get(ctx, body.id);
                if (existing !== undefined) {
                    sendJson(response, 201, {
                        session: await sessionResponse(ctx, dependencies, existing),
                    });
                    return;
                }
                const rootConfig =
                    (await dependencies.agent.system.config(ctx, dependencies.agent.agent.id)) ??
                    {};
                const owner = await resolveSessionOwner(
                    ctx,
                    {
                        rootAgentId: dependencies.agent.rootAgentId,
                        workspaces: dependencies.agent.modules.workspaces,
                    },
                    body,
                );
                // Creating an agent writes the conversation that belongs to it, from defaults that
                // know nothing about this request. The row has to exist with the resolved folder
                // and scope before then, or the session would be recorded in the wrong place with
                // no way to move it afterwards.
                const agentId = createId();
                const session = await conversation.ensure(ctx, {
                    agentId,
                    cwd: owner.cwd,
                    effort: body.effort,
                    ...(body.id === undefined ? {} : { id: body.id }),
                    modelId: body.modelId,
                    ...(body.permissionMode === undefined
                        ? {}
                        : { permissionMode: body.permissionMode }),
                    providerId: body.providerId,
                    scope: owner.scope,
                    ...(body.serviceTier === null ? {} : { serviceTier: body.serviceTier }),
                });
                const agent = await dependencies.agent.system.create(
                    ctx,
                    sessionAgentConfig(rootConfig, owner.cwd),
                    { id: agentId },
                );
                const summary = await sessionSummary(ctx, dependencies, session);
                await dependencies.agent.modules.events.record(ctx, {
                    agentId: agent.id,
                    payload: { session: summary },
                    type: "session.created",
                });
                await conversation.appendEvent(ctx, session.id, {
                    payload: { agentId: agent.id },
                    type: "session_created",
                });
                sendJson(response, 201, {
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions",
            handle: async ({ ctx, dependencies, url, response }) => {
                const parsed = parseListQuery(url);
                const sessions = await dependencies.agent.modules.conversations.list(ctx, parsed);
                sendJson(response, 200, {
                    sessions: await Promise.all(
                        sessions.map(
                            async (session) => await sessionSummary(ctx, dependencies, session),
                        ),
                    ),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/messages",
            handle: async ({ ctx, dependencies, request, response }) => {
                const body = await readValidatedBody(request, broadcastSchema);
                const hasAll = body.all === true;
                const hasTargets = body.sessionIds !== undefined;
                if (hasAll === hasTargets) {
                    throw new AgentHttpError(
                        400,
                        "Broadcast messages require exactly one target selector.",
                    );
                }
                const sessions = hasAll
                    ? await dependencies.agent.modules.conversations.list(ctx, {
                          archived: false,
                          limit: 50,
                      })
                    : await Promise.all(
                          body.sessionIds!.map(
                              async (id) => await requireSession(ctx, dependencies, id),
                          ),
                      );
                const submissions = [];
                for (const session of sessions) {
                    const acceptance = await sendMessage(
                        ctx,
                        dependencies,
                        session,
                        body as SubmitMessage,
                    );
                    submissions.push(acceptance);
                }
                sendJson(response, 202, { submissions });
            },
        },
        ...createReadRoutes(),
        ...createMutationRoutes(),
    ]);
}

function createReadRoutes(): AgentHttpRouteGroup["routes"] {
    return [
        {
            method: "GET",
            path: "/v0/sessions/:sessionId",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, session, {
                        messageLimit: parseLimit(url.searchParams.get("message_limit"), 20, 50),
                    }),
                });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/state",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const after = url.searchParams.get("after") ?? undefined;
                const turnLimit = parseLimit(url.searchParams.get("turns"), 20, 20);
                sendJson(
                    response,
                    200,
                    await rigSessionState(ctx, dependencies, session, {
                        ...(after === undefined ? {} : { after }),
                        turnLimit,
                    }),
                );
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/transcript",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const after = url.searchParams.get("after") ?? undefined;
                const before = url.searchParams.get("before") ?? undefined;
                if (after !== undefined && before !== undefined) {
                    throw new AgentHttpError(
                        400,
                        "A transcript request cannot use both after and before.",
                    );
                }
                for (const cursor of [after, before]) {
                    if (cursor !== undefined && !Value.Check(eventIdSchema, cursor)) {
                        throw new AgentHttpError(400, "The transcript cursor must be a UUIDv7.");
                    }
                }
                sendJson(
                    response,
                    200,
                    await rigTranscript(dependencies, session, 20, {
                        ...(after === undefined ? {} : { after }),
                        ...(before === undefined ? {} : { before }),
                    }),
                );
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/usage",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const summary = await dependencies.agent.modules.usage.read(ctx, session.agentId);
                const catalog = createRigModelCatalog(dependencies.agent.system.models);
                sendJson(response, 200, protocolUsage(session, summary, catalog));
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/current-provider-quota",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const catalog = createRigModelCatalog(dependencies.agent.system.models);
                sendJson(response, 200, {
                    currentProviderId: session.providerId ?? catalog.defaultProviderId,
                });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/subagents",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                // An agent's collaborators are its children, which the agent collection already
                // knows. Their names live in each child's own metadata.
                const children = await dependencies.agent.system.childOf(ctx, session.agentId);
                const catalog = createRigModelCatalog(dependencies.agent.system.models);
                const subagents = await Promise.all(
                    children.map(async (agentId) => {
                        const config = await dependencies.agent.system.config(ctx, agentId);
                        const title = config?.metadata?.title;
                        return {
                            agentId,
                            depth: 1,
                            description: title ?? "Collaborating agent",
                            id: agentId,
                            modelId: catalog.defaultModelId,
                            parentSessionId: session.id,
                            ...(title === undefined ? {} : { taskName: title }),
                        };
                    }),
                );
                sendJson(response, 200, { subagents });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/events",
            handle: async ({ ctx, dependencies, url, response }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const journal = dependencies.agent.modules.events;
                const requestedAfter = url.searchParams.get("after");
                const replay = journal.replay(
                    requestedAfter ?? journal.originCursor(),
                    journal.capacity(),
                );
                if (replay === undefined) {
                    throw new AgentHttpError(409, "Event cursor not found.", {
                        cursor: journal.cursor(),
                    });
                }
                const limit = parseLimit(url.searchParams.get("message_limit"), 50, 100);
                const projected = replay.events
                    .filter((event) => event.agentId === session.agentId)
                    .flatMap((event) => {
                        const result = projectSessionEvent(event, session.id);
                        return result === undefined ? [] : [result];
                    });
                sendJson(response, 200, {
                    events:
                        requestedAfter === null
                            ? initialEventWindow(projected, limit)
                            : projected.slice(0, limit),
                });
            },
        },
        {
            method: "GET",
            path: "/v0/sessions/:sessionId/stream",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                await streamSessionEvents(request, response, dependencies, session, url);
            },
        },
    ];
}

function createMutationRoutes(): AgentHttpRouteGroup["routes"] {
    return [
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/messages",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, submitMessageSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                sendJson(response, 202, await sendMessage(ctx, dependencies, session, body));
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/steer",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, submitMessageSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                sendJson(response, 202, await steerMessage(ctx, dependencies, session, body));
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/abort",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, expectedRunSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                requireExpectedRun(dependencies, session, body.expectedRunId, "aborted");
                await dependencies.agent.system.abort(ctx, session.agentId, {
                    await: body.await ?? true,
                });
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        status: "aborted",
                    },
                );
                const event = await dependencies.agent.modules.conversations.appendEvent(
                    ctx,
                    session.id,
                    {
                        payload: {},
                        type: "abort_requested",
                    },
                );
                sendJson(response, 200, {
                    eventId: event.id,
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/compact",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, expectedRunSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                requireExpectedRun(dependencies, session, body.expectedRunId, "compacted");
                await dependencies.agent.system.compact(ctx, session.agentId, {
                    await: body.await ?? true,
                });
                const event = await dependencies.agent.modules.conversations.appendEvent(
                    ctx,
                    session.id,
                    {
                        payload: {},
                        type: "compaction_requested",
                    },
                );
                // Compaction replaces the conversation, which a person reading the chat would
                // otherwise experience as their history silently disappearing. The journal is what
                // a client reads, so the compaction has to be recorded there to be visible at all.
                await dependencies.agent.modules.events.record(ctx, {
                    agentId: session.agentId,
                    payload: {},
                    type: "session.compaction-requested",
                });
                sendJson(response, 200, {
                    eventId: event.id,
                    result: "completed",
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/read",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        unread: false,
                    },
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/archive",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        archived: true,
                        status: "archived",
                    },
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/unarchive",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        archived: false,
                        status: "idle",
                    },
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/reorder",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, reorderSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const event = await dependencies.agent.modules.conversations.appendEvent(
                    ctx,
                    session.id,
                    {
                        payload: body,
                        type: "session_reordered",
                    },
                );
                sendJson(response, 200, {
                    eventId: event.id,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "PUT",
            path: "/v0/sessions/:sessionId/scope",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, scopeMutationSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        scope: body.scope,
                    },
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "PUT",
            path: "/v0/sessions/:sessionId/draft",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, draftSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const update = body.draft === null ? { draft: "" } : { draft: body.draft };
                const changed = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    update,
                );
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, changed),
                });
            },
        },
        {
            method: "PATCH",
            path: "/v0/sessions/:sessionId",
            handle: async ({ request }) => {
                await readValidatedBody(request, patchSessionSchema);
                throw new AgentHttpError(503, "Prompt replacement is not owned by Agent Base.");
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/goal",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, goalSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const goal = await dependencies.agent.modules.goal.setGoal(
                    ctx,
                    session.agentId,
                    body.objective,
                );
                const event = await dependencies.agent.modules.conversations.appendEvent(
                    ctx,
                    session.id,
                    {
                        payload: goal,
                        type: "goal_changed",
                    },
                );
                sendJson(response, 200, {
                    eventId: event.id,
                    goal,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "PATCH",
            path: "/v0/sessions/:sessionId/goal",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, goalStatusSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const goal = await dependencies.agent.modules.goal.changeGoalStatus(
                    ctx,
                    session.agentId,
                    body.status,
                );
                sendJson(response, 200, {
                    goal,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "DELETE",
            path: "/v0/sessions/:sessionId/goal",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                await dependencies.agent.modules.goal.clearGoal(ctx, session.agentId);
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/secrets",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, secretSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const attachment = await dependencies.agent.modules.secrets.attach(
                    ctx,
                    session.agentId,
                    { scopeRef: body.scope ?? session.id, secretId: body.secretId },
                );
                sendJson(response, 200, {
                    attachment,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "DELETE",
            path: "/v0/sessions/:sessionId/secrets/:secretId",
            handle: async ({ ctx, dependencies, response, url }) => {
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const secretId = lastPathPart(url);
                await dependencies.agent.modules.secrets.detach(ctx, session.agentId, {
                    scopeRef: url.searchParams.get("scope") ?? session.id,
                    secretId,
                });
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/user-input/:requestId",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, userInputSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const requestId = lastPathPart(url);
                const result =
                    body.cancel === true
                        ? await dependencies.agent.modules.userInput.cancel(ctx, session.agentId, {
                              reason: body.reason ?? "Cancelled by client.",
                              requestId,
                          })
                        : await answerUserInput(ctx, dependencies, session, requestId, body);
                sendJson(response, 200, {
                    request: result,
                    session: await sessionResponse(ctx, dependencies, session),
                });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/workflows/:runId/stop",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                assertWorkflowsEnabled(dependencies.agent);
                await readValidatedBody(request, workflowStopSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                // Stopping is settled by the run's own identity, so a client that retries the call
                // gets the run it already cancelled back rather than a second cancellation.
                const run = await dependencies.agent.modules.workflows.cancel(
                    ctx,
                    session.agentId,
                    lastPathPart(url),
                );
                sendJson(response, 200, { workflow: run });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/scheduled-messages/:messageId/cancel",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                await readValidatedBody(request, workflowStopSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                const result = await dependencies.agent.modules.scheduling.cancelSchedule(
                    ctx,
                    session.agentId,
                    {
                        scheduleId: lastPathPart(url),
                    },
                );
                sendJson(response, 200, { scheduledMessage: result });
            },
        },
        {
            method: "POST",
            path: "/v0/sessions/:sessionId/transfer",
            handle: async ({ ctx, dependencies, request, response, url }) => {
                const body = await readValidatedBody(request, transferSessionSchema);
                const session = await requireSession(ctx, dependencies, sessionId(url));
                if (session.scope.kind !== "workspace") {
                    throw new AgentHttpError(
                        409,
                        "Only a session that is already in a workspace can be moved.",
                    );
                }
                const workspaces = dependencies.agent.modules.workspaces;
                const projectId = session.scope.projectId;
                // The transfer is the catalog's state machine: it stages the source workspace's
                // uncommitted work, restores the target when anything goes wrong, and marks a
                // target it could not put back as failed so nothing is offered a broken checkout.
                const { prepared, target } = await transferFailure(
                    async () =>
                        await workspaces.prepareSessionTransfer(
                            ctx,
                            dependencies.agent.rootAgentId,
                            projectId,
                            session.scope.kind === "workspace" ? session.scope.workspaceId : "",
                            body.workspaceId,
                            // Stopping the agent is the last thing before the working tree moves
                            // under it, so a run cannot write into the folder being replaced.
                            async () => {
                                await dependencies.agent.system.abort(ctx, session.agentId, {
                                    await: true,
                                });
                            },
                        ),
                );
                try {
                    await prepared.commitTransfer();
                } catch (error) {
                    await prepared.rollback(error);
                    throw new AgentHttpError(
                        409,
                        "The session could not be moved into that workspace.",
                    );
                }
                // The recorded working directory is part of the conversation row the module owns
                // and cannot yet be changed, so the durable scope moves and the cwd is reported
                // from the workspace it now belongs to.
                const moved = await dependencies.agent.modules.conversations.update(
                    ctx,
                    session.id,
                    {
                        scope: {
                            kind: "workspace",
                            projectId,
                            workspaceId: target.id,
                        },
                    },
                );
                await dependencies.agent.modules.conversations.appendEvent(ctx, session.id, {
                    payload: {
                        commit: prepared.commit,
                        projectId,
                        workspaceId: target.id,
                        ...(body.mutationId === undefined ? {} : { mutationId: body.mutationId }),
                    },
                    type: "session_transferred",
                });
                sendJson(response, 200, {
                    session: await sessionResponse(ctx, dependencies, moved),
                    transfer: {
                        commit: prepared.commit,
                        state: prepared.state,
                        workspace: { id: target.id, name: target.name, path: target.path },
                    },
                });
            },
        },
        ...unsupportedMutations(),
    ];
}

/** Turns the host's transfer refusals into a sentence a person can act on. */
async function transferFailure<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof AgentHttpError) throw error;
        throw new AgentHttpError(
            409,
            error instanceof Error ? error.message : "The session could not be moved.",
        );
    }
}

/**
 * Refuses to act on a run other than the one the caller was looking at.
 *
 * A client watching a chat decides to stop or compact the run it can see, and by the time the
 * request arrives that run may have finished and another may have started. Naming the run is how a
 * client says which one it meant, so a mismatch is refused rather than applied to whatever happens
 * to be running now. A caller that names nothing accepts whatever it finds.
 */
function requireExpectedRun(
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    expectedRunId: string | undefined,
    action: "aborted" | "compacted",
): void {
    if (expectedRunId === undefined) return;
    const active = dependencies.agent.modules.events.activeRunId(session.agentId);
    if (active === expectedRunId) return;
    throw new AgentHttpError(
        409,
        active === undefined
            ? `Run "${expectedRunId}" is no longer running, so nothing was ${action}.`
            : `Run "${expectedRunId}" is no longer running; this chat is now on run "${active}", which was not ${action}.`,
    );
}

function unsupportedMutations(): AgentHttpRouteGroup["routes"] {
    const paths = [
        "/v0/sessions/:sessionId/fork",
        "/v0/sessions/:sessionId/reset",
        "/v0/sessions/:sessionId/rewind",
        "/v0/sessions/:sessionId/context",
        "/v0/sessions/:sessionId/activity",
    ] as const;
    return paths.map((path) => ({
        method: "POST" as const,
        path,
        handle: async ({ request }: { readonly request: IncomingMessage }) => {
            await readValidatedBody(request, unsupportedSchema);
            throw new AgentHttpError(503, "This session operation is not configured.");
        },
    }));
}

async function requireSession(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    id: string,
): Promise<ConversationRecord> {
    const session = await dependencies.agent.modules.conversations.get(ctx, id);
    if (session === undefined) throw new AgentHttpError(404, `Session "${id}" was not found.`);
    return session;
}

/**
 * Record what a person answered.
 *
 * The client sends the values it displayed, so the stored question is read first and the values
 * are interpreted against the choices that question actually offered. An answer that says nothing
 * is a bad request rather than a stored empty outcome.
 */
async function answerUserInput(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    requestId: string,
    body: { readonly answers?: Readonly<Record<string, readonly string[]>> },
): Promise<unknown> {
    const userInput = dependencies.agent.modules.userInput;
    if (body.answers === undefined) throw new AgentHttpError(400, "An answer is required.");
    const request = await userInput.get(ctx, session.agentId, requestId);
    if (request === undefined) {
        throw new AgentHttpError(404, `Question "${requestId}" was not found.`);
    }
    let input;
    try {
        input = userInputAnswerForModule(request, body.answers);
    } catch (error: unknown) {
        throw new AgentHttpError(
            400,
            error instanceof Error ? error.message : "The answer could not be read.",
        );
    }
    return await userInput.answer(ctx, session.agentId, input);
}

async function sessionResponse(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    options: { readonly messageLimit?: number } = {},
): Promise<Record<string, unknown>> {
    const agent = await dependencies.agent.system.resolve(ctx, session.agentId);
    const config = await dependencies.agent.system.config(ctx, session.agentId);
    const transcript = await rigTranscript(dependencies, session, options.messageLimit ?? 20);
    const catalog = createRigModelCatalog(
        dependencies.agent.system.models,
        await readRigProviderCapabilities(
            dependencies.agent.providers,
            dependencies.agent.system.models,
        ),
    );
    const tasks = await dependencies.agent.modules.tasks.list(ctx, session.agentId);
    const goal = await dependencies.agent.modules.goal.goal(ctx, session.agentId);
    const pendingUserInputs = (
        await dependencies.agent.modules.userInput.list(ctx, session.agentId, {
            status: "pending",
        })
    ).map(userInputRequestForProtocol);
    return {
        ...sessionSummaryValue(session, catalog, sessionCatalogSelection(dependencies)),
        activity: activityFor(session, agent.active),
        agent: {
            depth: 0,
            rootSessionId: session.id,
            type: "primary",
        },
        agentId: session.agentId,
        environment: { type: "local" },
        goal,
        ...(config?.metadata === undefined ? {} : { metadata: config.metadata }),
        mcpServers: configuredMcpServers(),
        modelCatalog: catalog,
        modelLocked: false,
        models: catalog.models,
        pendingUserInputs,
        projectSecretIds: [],
        secretIds: [],
        sessionSecretIds: [],
        snapshot: { messages: transcript.messages },
        subagents: [],
        tasks,
        workflows: [],
        workflowsEnabled: dependencies.agent.configuration.values.features.workflows,
    };
}

function configuredMcpServers(): readonly {
    readonly name: string;
    readonly status: "blocked" | "disabled";
    readonly toolCount: 0;
}[] {
    return [];
}

function assertWorkflowsEnabled(agent: StartedHappyAgent): void {
    if (!agent.configuration.values.features.workflows) {
        throw new AgentHttpError(503, "Workflows are turned off in this agent's settings.");
    }
}

export async function sessionSummary(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
): Promise<Record<string, unknown>> {
    const config = await dependencies.agent.system.config(ctx, session.agentId);
    const catalog = createRigModelCatalog(
        dependencies.agent.system.models,
        await readRigProviderCapabilities(
            dependencies.agent.providers,
            dependencies.agent.system.models,
        ),
    );
    return {
        ...sessionSummaryValue(session, catalog, sessionCatalogSelection(dependencies)),
        ...(config?.metadata?.title === undefined ? {} : { title: config.metadata.title }),
        ...(dependencies.agent.modules.events.latestCursor(session.agentId) === undefined
            ? {}
            : { lastEventId: dependencies.agent.modules.events.latestCursor(session.agentId) }),
    };
}

export function sessionSummaryValue(
    session: ConversationRecord,
    catalog = { defaultModelId: "", defaultProviderId: "" },
    fallback?: SessionSelection,
): Record<string, unknown> {
    return {
        archived: session.archived,
        createdAt: session.createdAt,
        cwd: session.cwd,
        effort: session.effort ?? fallback?.effort,
        id: session.id,
        modelId: session.modelId ?? fallback?.modelId ?? catalog.defaultModelId,
        ownerInstanceId: session.ownerInstanceId,
        permissionMode: session.permissionMode ?? fallback?.permissionMode ?? "auto",
        providerId: session.providerId ?? fallback?.providerId ?? catalog.defaultProviderId,
        scope: session.scope,
        ...(session.serviceTier === undefined ? {} : { serviceTier: session.serviceTier }),
        status: session.archived ? "archived" : session.status,
        titleStatus: session.titleStatus === "ready" ? "ready" : "idle",
        ...(session.unread
            ? {
                  trackUnread: true,
                  unread: {
                      reason: "turn_finished",
                      since: session.updatedAt,
                  },
              }
            : {}),
        updatedAt: session.updatedAt,
    };
}

async function rigSessionState(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    options: { readonly after?: string; readonly turnLimit: number },
): Promise<Record<string, unknown>> {
    const transcript = await rigTranscript(
        dependencies,
        session,
        options.turnLimit,
        options.after === undefined ? {} : { after: options.after },
    );
    const protocolSession = await sessionResponse(ctx, dependencies, session, {
        messageLimit: options.turnLimit,
    });
    return {
        activity: activityFor(session),
        ...(options.after === undefined ? {} : { append: true }),
        cursor: dependencies.agent.modules.events.cursor(),
        ...(dependencies.agent.modules.events.latestCursor(session.agentId) === undefined
            ? {}
            : { lastEventId: dependencies.agent.modules.events.latestCursor(session.agentId) }),
        resumed: options.after !== undefined,
        session: {
            ...protocolSession,
            snapshot: { messages: transcript.messages },
        },
        transcript,
    };
}

async function rigTranscript(
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    turnLimit: number,
    cursor: { readonly after?: string; readonly before?: string } = {},
): Promise<Record<string, unknown>> {
    const journal = dependencies.agent.modules.events;
    const replay = journal.replay(journal.originCursor(), journal.capacity());
    if (replay === undefined) {
        throw new Error("The Happy Agent event journal could not build a transcript.");
    }
    const projected = replay.events
        .filter(
            (event) =>
                event.agentId === session.agentId &&
                (cursor.after === undefined || event.id > cursor.after) &&
                (cursor.before === undefined || event.id < cursor.before),
        )
        .flatMap((event) => {
            const value = projectSessionEvent(event, session.id);
            return value === undefined ? [] : [{ event, value }];
        });
    const messages: Record<string, unknown>[] = [];
    const messageCreatedAt: Record<string, number> = {};
    const messageEventId: Record<string, string> = {};
    const turns = new Map<
        string,
        {
            runId: string;
            startedAt: number;
            endedAt?: number;
            outcome?: "success" | "error" | "stopped";
            errorMessage?: string;
            messageIds: string[];
        }
    >();
    const notices: {
        readonly createdAt: number;
        readonly eventId: string;
        readonly message: unknown;
    }[] = [];
    for (const { event, value } of projected) {
        const data = recordValue(value.data);
        if (value.type === "system_notice" && data !== undefined) {
            // Notices have no run of their own, so they are collected on their own rather than
            // forced into a conversational turn. They stay in event-ID order for a stable replay.
            notices.push({ createdAt: event.occurredAt, eventId: event.id, message: data.message });
            continue;
        }
        const runId = typeof data?.runId === "string" ? data.runId : undefined;
        if (data === undefined || runId === undefined) continue;
        const turn = turns.get(runId) ?? {
            messageIds: [],
            runId,
            startedAt: event.occurredAt,
        };
        turn.startedAt = Math.min(turn.startedAt, event.occurredAt);
        if (value.type === "message_submitted" || value.type === "agent_message") {
            const message = recordValue(data.message);
            if (message !== undefined && typeof message.id === "string") {
                messages.push(message);
                turn.messageIds.push(message.id);
                messageCreatedAt[message.id] = event.occurredAt;
                messageEventId[message.id] = event.id;
            }
        }
        if (value.type === "run_error") {
            turn.endedAt = event.occurredAt;
            turn.outcome = "error";
            if (typeof data.errorMessage === "string") turn.errorMessage = data.errorMessage;
        }
        if (value.type === "run_finished") {
            turn.endedAt = event.occurredAt;
            const stopReason = data.stopReason;
            turn.outcome = stopReason === "aborted" ? "stopped" : "success";
        }
        turns.set(runId, turn);
    }
    const orderedTurns = [...turns.values()].sort(
        (left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
    );
    const visibleTurns =
        cursor.after === undefined
            ? orderedTurns.slice(Math.max(0, orderedTurns.length - turnLimit))
            : orderedTurns.slice(0, turnLimit);
    const visibleMessageIds = new Set(visibleTurns.flatMap((turn) => turn.messageIds));
    const visibleMessages = messages.filter(
        (message) => typeof message.id === "string" && visibleMessageIds.has(message.id),
    );
    // Notices are bounded independently of the turn window; keep the newest and say so when an
    // older one was dropped, so a reader knows the notice history is not complete.
    const noticesTruncated = notices.length > MAX_TRANSCRIPT_NOTICES;
    const visibleNotices = noticesTruncated
        ? notices.slice(notices.length - MAX_TRANSCRIPT_NOTICES)
        : notices;
    return {
        complete: visibleTurns.length === orderedTurns.length,
        messageCreatedAt: Object.fromEntries(
            Object.entries(messageCreatedAt).filter(([id]) => visibleMessageIds.has(id)),
        ),
        messageEventId: Object.fromEntries(
            Object.entries(messageEventId).filter(([id]) => visibleMessageIds.has(id)),
        ),
        messages: visibleMessages,
        notices: visibleNotices,
        noticesTruncated,
        turns: visibleTurns,
    };
}

/** How many recent service notices a single transcript response carries. */
const MAX_TRANSCRIPT_NOTICES = 100;

function activityFor(
    session: ConversationRecord,
    active = session.status === "running" || session.status === "queued",
): Record<string, unknown> {
    return active
        ? { kind: "thinking", label: "Agent is working.", since: session.updatedAt }
        : {
              kind: session.status === "error" ? "error" : "idle",
              label: "Idle.",
              since: session.updatedAt,
          };
}

function protocolUsage(
    session: ConversationRecord,
    summary: UsageSummary,
    catalog: RigModelCatalog,
): Record<string, unknown> {
    const currentProviderId = session.providerId ?? catalog.defaultProviderId;
    const defaultModelId = session.modelId ?? catalog.defaultModelId;
    return {
        currentProviderId,
        groups: summary.groups.map((group) => {
            const modelId = group.model ?? defaultModelId;
            return {
                kind: "attributed",
                modelId,
                providerId: group.provider,
                requestedModelId: modelId,
                usage: {
                    cacheRead: 0,
                    cacheWrite: 0,
                    cost: {
                        cacheRead: 0,
                        cacheWrite: 0,
                        input: 0,
                        output: 0,
                        total: 0,
                    },
                    input: group.inputTokens,
                    output: group.outputTokens,
                    totalTokens: group.totalTokens,
                },
            };
        }),
        quotas: [],
        sessionTokenCount: {
            // How big the conversation currently is, as the last response measured it. It reads as
            // zero only until something has been measured; the costs above stay zero because the
            // agent has no price table to turn tokens into money with.
            lastContextTokens: summary.currentContext?.contextTokens ?? 0,
            totalTokens: summary.totalTokens,
        },
    };
}

async function sendMessage(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    body: SubmitMessage,
): Promise<Record<string, unknown>> {
    const text = body.displayText ?? body.text;
    const alreadyNamed = await nameFromFirstMessage(ctx, dependencies, session, text);
    const resumeCursor = dependencies.agent.modules.events.cursor();
    const current = sessionSelection(session, sessionCatalogSelection(dependencies));
    const options = messageOptions(body, dependencies.agent.system.models, current);
    let acceptance;
    try {
        acceptance = await dependencies.agent.system.send(
            ctx,
            session.agentId,
            messageFromBody(body),
            options,
        );
    } catch (cause) {
        throw new Error("Agent Base rejected the session message.", { cause });
    }
    // A queued message does not reach the conversation until the current turn ends, and a wait is
    // precisely a turn held open. Someone writing into the chat is what ends it.
    dependencies.agent.modules.scheduling.interruptWaits(ctx, session.agentId);
    // Someone writing a second time has said more about what this chat is than its title was drawn
    // from, and they may say it while a long turn is still running. The chat gets one second look
    // either way; this is so it does not have to wait for the turn to end to happen.
    if (alreadyNamed) {
        dependencies.agent.modules.conversations.takeSecondLook(ctx, session.agentId, {
            justSaid: text,
        });
    }
    await persistSessionSelection(
        ctx,
        selectionRecorders(dependencies),
        session,
        selectionFromMessageOptions(options, current),
        sessionCatalogSelection(dependencies),
        body.mutationId,
    );
    return {
        accepted: acceptance.accepted,
        delivery: acceptance.delivery,
        eventId:
            dependencies.agent.modules.events.messageCursor(session.agentId, acceptance.id) ??
            resumeCursor,
        id: acceptance.id,
        runId: acceptance.id,
        sessionId: session.id,
    };
}

/**
 * Names the chat, and the workspace and branch it works in, from the first thing a person said.
 *
 * Naming belongs to the titles module, which asks once and hands the folder name to the workspaces
 * catalog itself. What is left here is what a route knows and a module does not: which chat this
 * is, whether a person has already named it, and where the answer is written down.
 *
 * Answers whether the chat already had a title when this message arrived, which is what tells the
 * caller this was not the first thing said here.
 */
async function nameFromFirstMessage(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    firstMessage: string,
): Promise<boolean> {
    if (firstMessage.trim().length === 0) return false;
    const modules = dependencies.agent.modules;
    const config = await dependencies.agent.system.config(ctx, session.agentId);
    const sessionNamed = config?.metadata?.title !== undefined;
    const scope = session.scope;
    const named = await modules.titles.nameFromFirstMessage(ctx, dependencies.agent.rootAgentId, {
        firstMessage,
        sessionNamed,
        ...(session.providerId === undefined ? {} : { providerId: session.providerId }),
        ...(scope.kind === "workspace"
            ? { workspace: { projectId: scope.projectId, workspaceId: scope.workspaceId } }
            : {}),
    });
    await modules.conversations.recordTitle(ctx, session, named.title);
    if (named.workspace !== undefined && scope.kind === "workspace") {
        await modules.events.record(ctx, {
            agentId: session.agentId,
            payload: {
                ...(named.branch === undefined ? {} : { branch: named.branch }),
                projectId: scope.projectId,
                workspaceId: named.workspace.id,
                workspace: {
                    branch: named.workspace.branch,
                    id: named.workspace.id,
                    name: named.workspace.name,
                },
            },
            type: "workspace.updated",
        });
    }
    return sessionNamed;
}

async function steerMessage(
    ctx: import("@steve.kite/stdlib").Context,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    body: SubmitMessage,
): Promise<Record<string, unknown>> {
    const resumeCursor = dependencies.agent.modules.events.cursor();
    const current = sessionSelection(session, sessionCatalogSelection(dependencies));
    const options = messageOptions(body, dependencies.agent.system.models, current);
    const acceptance = await dependencies.agent.system.steer(
        ctx,
        session.agentId,
        messageFromBody(body),
        options,
    );
    dependencies.agent.modules.scheduling.interruptWaits(ctx, session.agentId);
    await persistSessionSelection(
        ctx,
        selectionRecorders(dependencies),
        session,
        selectionFromMessageOptions(options, current),
        sessionCatalogSelection(dependencies),
        body.mutationId,
    );
    return {
        accepted: acceptance.accepted,
        delivery: acceptance.delivery,
        eventId:
            dependencies.agent.modules.events.messageCursor(session.agentId, acceptance.id) ??
            resumeCursor,
        id: acceptance.id,
        runId: acceptance.id,
        sessionId: session.id,
    };
}

function messageFromBody(body: SubmitMessage): SessionUserMessage {
    const content: readonly SessionInputBlock[] =
        body.content === undefined || body.content.length === 0
            ? [{ text: body.text, type: "text" }]
            : body.content;
    return { content, role: "user" };
}

/**
 * What one request named, in the shape the catalog check and the message options both take.
 *
 * The permission mode is the one thing a request may leave out and still have decided for it. A
 * session reports the mode it runs in, from its own record or from the installation's default, but
 * an agent starts in Auto and learns any other mode only from a message. Carrying the session's
 * mode on every message is what makes the reported mode the enforced one.
 */
function requestedSelection(
    body: CreateSession | SubmitMessage,
    current?: SessionSelection,
): RequestedAgentSelection {
    const permissionMode = body.permissionMode ?? current?.permissionMode;
    return {
        effort: body.effort,
        model: body.modelId,
        provider: body.providerId,
        serviceTier: body.serviceTier,
        ...(permissionMode === undefined ? {} : { permissionMode }),
    };
}

function messageOptions(
    body: SubmitMessage,
    models: readonly AgentModel[],
    current: SessionSelection,
): AgentBaseMessageOptions & { readonly await?: boolean } {
    return agentMessageOptions(models, requestedSelection(body, current), {
        ...(body.await === undefined ? {} : { await: body.await }),
        ...(body.clientSubmissionId === undefined ? {} : { id: body.clientSubmissionId }),
    });
}

/** This agent's catalog default selection, in the terms the shared selection helpers take. */
function sessionCatalogSelection(dependencies: LoadedSessionDependencies): SessionSelection {
    return catalogSelection(
        dependencies.agent.system.models,
        dependencies.agent.configuration.values.defaults.permissionMode,
    );
}

/** The recorders `persistSessionSelection` writes a selection change through. */
function selectionRecorders(dependencies: LoadedSessionDependencies): {
    readonly conversations: LoadedSessionDependencies["agent"]["modules"]["conversations"];
    readonly events: LoadedSessionDependencies["agent"]["modules"]["events"];
} {
    return {
        conversations: dependencies.agent.modules.conversations,
        events: dependencies.agent.modules.events,
    };
}

function parseListQuery(url: URL): { readonly archived?: boolean | "all"; readonly limit: number } {
    const raw = url.searchParams.get("archived");
    const archived =
        raw === null
            ? undefined
            : raw === "all"
              ? "all"
              : raw === "true"
                ? true
                : raw === "false"
                  ? false
                  : undefined;
    if (raw !== null && archived === undefined)
        throw new AgentHttpError(400, "The archived query is invalid.");
    const result = {
        ...(archived === undefined ? {} : { archived }),
        limit: parseLimit(url.searchParams.get("limit"), 50, 50),
    };
    if (!Value.Check(listSessionsSchema, result)) {
        throw new AgentHttpError(400, "The session list query is invalid.");
    }
    return result;
}

function parseLimit(value: string | null, fallback: number, maximum: number): number {
    if (value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
        throw new AgentHttpError(400, `The limit must be an integer from 1 to ${maximum}.`);
    }
    return parsed;
}

/**
 * Decides what a new session belongs to, from the folder it starts in.
 *
 * The working directory is the whole answer. A folder inside a managed workspace resolves to that
 * workspace and its project; a folder Rig already knows as a project resolves to it, and starting
 * work there brings it back if it was archived; anything else becomes a project now — the person's
 * home directory as `Home`, any other folder named after itself and set up in the background. A
 * client that names a workspace is asserting a reservation that may not exist on disk yet, so that
 * case takes the stricter path that accepts a folder Git has not created.
 *
 * The result is durable: the scope handed to the conversation is a project or workspace identity a
 * later run can still resolve, not an echo of what the request happened to send.
 */
export async function resolveSessionOwner(
    ctx: import("@steve.kite/stdlib").Context,
    deps: { readonly workspaces: WorkspacesModule; readonly rootAgentId: string },
    body: { readonly cwd: string; readonly projectId?: string; readonly workspaceId?: string },
): Promise<{ readonly cwd: string; readonly scope: ConversationScope }> {
    // The workspaces catalog answers for both: a folder that is a workspace resolves to it and its
    // project, and anything else it hands straight to the projects catalog.
    const workspaces = deps.workspaces;
    const agentId = deps.rootAgentId;
    let owner: ResolvedProjectOwnership;
    try {
        owner =
            body.workspaceId === undefined
                ? await workspaces.resolvePath(ctx, agentId, body.cwd, undefined, body.projectId)
                : await workspaces.resolveSessionOwnership(
                      ctx,
                      agentId,
                      body.cwd,
                      body.workspaceId,
                      body.projectId,
                  );
    } catch (error) {
        if (error instanceof ProjectRegistrationError) {
            throw new AgentHttpError(409, error.message, { code: error.code });
        }
        throw new AgentHttpError(
            400,
            error instanceof Error ? error.message : "The session directory could not be resolved.",
        );
    }
    return {
        cwd: owner.workspace?.path ?? owner.project.repositoryRef,
        scope:
            owner.workspace === undefined
                ? { kind: "project", projectId: owner.project.id }
                : {
                      kind: "workspace",
                      projectId: owner.project.id,
                      workspaceId: owner.workspace.id,
                  },
    };
}

/**
 * The root agent's configuration, moved to the folder this session works in.
 *
 * Everything else is inherited: the models, the modules, the environment the daemon reported. Only
 * the working directory differs, because a session belongs to a project or a workspace and its
 * shell, its file reads and the paths it prints all have to be that folder rather than the
 * daemon's own home.
 */
export function sessionAgentConfig(root: AgentConfig, cwd: string): AgentConfig {
    const compute = root.modules?.compute;
    return {
        ...root,
        ...(root.environment === undefined
            ? {}
            : { environment: { ...root.environment, workingDirectory: cwd } }),
        modules: {
            ...root.modules,
            compute: {
                ...(typeof compute === "object" && compute !== null ? compute : {}),
                cwd,
            },
        },
    };
}

function sessionId(url: URL): string {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    if (id === undefined || !Value.Check(conversationSessionIdSchema, id)) {
        throw new AgentHttpError(400, "The session ID is invalid.");
    }
    return id;
}

function lastPathPart(url: URL): string {
    const part = url.pathname.split("/").filter(Boolean).at(-1);
    if (part === undefined || part.length > 256)
        throw new AgentHttpError(400, "The path ID is invalid.");
    return part;
}

async function streamSessionEvents(
    request: IncomingMessage,
    response: ServerResponse,
    dependencies: LoadedSessionDependencies,
    session: ConversationRecord,
    url: URL,
): Promise<void> {
    const events = dependencies.agent.modules.events;
    const header = request.headers["last-event-id"];
    const headerValue = Array.isArray(header) ? header.at(-1) : header;
    const after = headerValue ?? url.searchParams.get("after") ?? undefined;
    if (
        after !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(after)
    ) {
        throw new AgentHttpError(400, "The event cursor must be a UUIDv7 value.");
    }
    const writer = createSseWriter(request, response);
    let replaying = true;
    const pending: AgentEvent[] = [];
    let pendingBytes = 0;
    const unsubscribe = events.subscribe((event: AgentEvent) => {
        if (event.agentId !== session.agentId || writer.closed) return;
        if (replaying) {
            const bytes = Buffer.byteLength(serializeJson(event), "utf8");
            if (pendingBytes + bytes > MAX_SESSION_STREAM_PENDING_BYTES) {
                writer.close();
                return;
            }
            pending.push(event);
            pendingBytes += bytes;
            return;
        }
        writeEvent(event);
    });
    const replay = events.replay(after, events.capacity());
    if (replay === undefined) {
        unsubscribe();
        writer.close();
        throw new AgentHttpError(409, "Event cursor not found.");
    }
    if (writer.closed) {
        unsubscribe();
        throw new AgentHttpError(503, "The session stream could not buffer its initial updates.");
    }
    response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
    });
    writer.write(
        `event: hello\ndata: ${serializeJson({
            cursor: replay.latestCursor,
            resumed: after !== undefined,
            sessionId: session.id,
        })}\n\n`,
    );
    const replayed = new Set<string>();
    for (const event of replay.events) {
        if (event.agentId !== session.agentId) continue;
        replayed.add(event.id);
        if (!writeEvent(event)) {
            unsubscribe();
            return;
        }
    }
    replaying = false;
    for (const event of pending) {
        if (replayed.has(event.id)) continue;
        if (!writeEvent(event)) {
            unsubscribe();
            return;
        }
    }
    pending.length = 0;
    pendingBytes = 0;
    const heartbeat = setInterval(() => {
        writer.heartbeat(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref();
    await writer.done;
    clearInterval(heartbeat);
    unsubscribe();

    function writeEvent(event: AgentEvent): boolean {
        const projected = projectSessionEvent(event, session.id);
        if (projected === undefined) return true;
        return writer.write(
            `id: ${event.id}\nevent: ${projected.type}\ndata: ${serializeJson(projected)}\n\n`,
        );
    }
}

/** How many recent system notices survive the initial event window regardless of the turn tail. */
const MAX_INITIAL_WINDOW_NOTICES = 100;

/**
 * The initial slice of projected events a resuming client receives.
 *
 * The tail is the newest `limit` events, which is what a client normally wants. But a system notice
 * — the row that explains why a turn stopped — has no run of its own and is bounded independently
 * of the turn tail, exactly as the transcript's notice list is. A busy turn (three refused tool
 * calls and their reviews) can push its turn-stop notice out of the tail while its aborted
 * `run_finished` stays in it, which would hand the client the abort with no explanation. So any
 * notice the tail dropped is carried back in — keeping the newest `MAX_INITIAL_WINDOW_NOTICES` —
 * ahead of the window it precedes, since a dropped event is always older than the tail. This is
 * what makes the initial history reliably carry the explanation, not just the abort.
 */
export function initialEventWindow(
    projected: readonly Record<string, unknown>[],
    limit: number,
): Record<string, unknown>[] {
    const windowed = projected.slice(Math.max(0, projected.length - limit));
    const windowedIds = new Set(windowed.map((event) => event.id));
    const droppedNotices = projected.filter(
        (event) => event.type === "system_notice" && !windowedIds.has(event.id),
    );
    if (droppedNotices.length === 0) return [...windowed];
    const restoredNotices = droppedNotices.slice(
        Math.max(0, droppedNotices.length - MAX_INITIAL_WINDOW_NOTICES),
    );
    return [...restoredNotices, ...windowed];
}

export function projectSessionEvent(
    event: AgentEvent,
    sessionIdValue: string,
): Record<string, unknown> | undefined {
    const payload = recordValue(event.payload);
    if (payload === undefined) return undefined;
    const base = {
        createdAt: event.occurredAt,
        id: event.id,
        sessionId: sessionIdValue,
        worktreeSupport: "unknown",
    };
    if (
        event.type === "session.configuration-changed" &&
        Value.Check(sessionConfigurationChangedPayloadSchema, payload)
    ) {
        return {
            ...base,
            data: payload,
            type: "session_configuration_changed",
        };
    }
    if (
        event.type === "session.permission-mode-changed" &&
        Value.Check(permissionModeChangedPayloadSchema, payload)
    ) {
        return {
            ...base,
            data: payload,
            type: "permission_mode_changed",
        };
    }
    if (event.type === "session.compaction-requested") {
        return {
            ...base,
            data: {
                message: {
                    blocks: [
                        {
                            text: "The conversation was summarised to make room, so earlier messages are no longer part of it.",
                            type: "text",
                        },
                    ],
                    context: "excluded",
                    id: base.id,
                    role: "system",
                    structured: {
                        details:
                            "The conversation was summarised to make room, so earlier messages are no longer part of it.",
                        kind: "notice",
                        level: "info",
                        title: "Conversation compacted",
                    },
                },
            },
            type: "system_notice",
        };
    }
    const runId = typeof payload.runId === "string" ? payload.runId : undefined;
    if (event.type === "message.accepted" && runId !== undefined) {
        const message = recordValue(payload.message);
        const blocks = message === undefined ? [] : providerInputBlocks(message.content);
        return {
            ...base,
            data: {
                delivery: payload.kind === "steering" ? "steer" : "run",
                displayText: blocks
                    .map((block) => (block.type === "text" ? block.text : "[image]"))
                    .join(""),
                message: { blocks, id: payload.id, role: "user" },
                runId,
            },
            type: "message_submitted",
        };
    }
    if (event.type === "provider.event" && runId !== undefined) {
        const providerEvent = recordValue(payload.event);
        const rigEvent = recordValue(payload.rigEvent);
        if (providerEvent === undefined) return undefined;
        if (rigEvent === undefined) {
            return {
                ...base,
                data: { event: providerEvent, runId },
                type: "provider_event",
            };
        }
        return {
            ...base,
            data: { event: rigEvent, providerEvent, runId },
            type: "agent_event",
        };
    }
    if ((event.type === "tool.started" || event.type === "tool.completed") && runId !== undefined) {
        const rigEvent = recordValue(payload.rigEvent);
        if (rigEvent === undefined) return undefined;
        return {
            ...base,
            data: { event: rigEvent, runId },
            type: "agent_event",
        };
    }
    if (event.type === "inference.completed" && runId !== undefined) {
        const inferenceId =
            typeof payload.inferenceId === "string" ? payload.inferenceId : `${runId}-inference`;
        return {
            ...base,
            data: {
                message: {
                    blocks: agentBlocks(payload.blocks),
                    id: inferenceId,
                    role: "agent",
                },
                runId,
            },
            type: "agent_message",
        };
    }
    if (event.type === "loop.settled" && runId !== undefined) {
        const stopReason =
            payload.stopReason === "aborted" ||
            payload.stopReason === "error" ||
            payload.stopReason === "length"
                ? payload.stopReason
                : "stop";
        // A failed run ends as `run_error` rather than `run_finished`, because that is the only
        // terminal event that carries the failure text into the transcript. Emitting exactly one
        // terminal event per run keeps the client's run bookkeeping unambiguous.
        if (stopReason === "error") {
            return {
                ...base,
                data: {
                    errorMessage:
                        typeof payload.errorMessage === "string" && payload.errorMessage.length > 0
                            ? payload.errorMessage
                            : "The agent run failed before it produced an answer.",
                    modelLocked: false,
                    runId,
                },
                type: "run_error",
            };
        }
        return {
            ...base,
            data: { modelLocked: false, runId, stopReason },
            type: "run_finished",
        };
    }
    if (event.type === "permission.event") {
        return projectPermissionEvent(payload, base);
    }
    if (event.type === "user-input.event") {
        return projectUserInputEvent(payload, base);
    }
    return undefined;
}

/**
 * Turn one recorded user-input event into the row a client shows.
 *
 * A pending question becomes the question itself, so a client that joins the stream late still
 * puts it on screen. Every terminal outcome resolves it: an answer carries the values back for
 * the client that did not send them, and a cancellation, an away outcome, or a timeout simply
 * withdraws the question, because none of them leaves anything for a person to answer.
 */
function projectUserInputEvent(
    payload: UnknownRecord,
    base: {
        readonly createdAt: number;
        readonly id: string;
        readonly sessionId: string;
        readonly worktreeSupport: string;
    },
): Record<string, unknown> | undefined {
    if (!Value.Check(userInputEventSchema, payload)) return undefined;
    if (payload.type === "user_input_requested") {
        return {
            ...base,
            data: userInputRequestForProtocol(payload.request),
            type: "user_input_requested",
        };
    }
    if (payload.type === "user_input_answered") {
        return {
            ...base,
            data: {
                answers: userInputAnswersForProtocol(payload.request),
                requestId: payload.requestId,
                status: "answered",
            },
            type: "user_input_resolved",
        };
    }
    return {
        ...base,
        data: { requestId: payload.requestId, status: "cancelled" },
        type: "user_input_resolved",
    };
}

/**
 * Turn one recorded permission event into the row a client shows.
 *
 * The stored payload is arbitrary JSON, so it is decoded against the real `permissionEventSchema`
 * before any field is read. A record that is not a known permission event is dropped rather than
 * rendered from half-present fields — that is what let a corrupt event surface as "-1 of the last
 * -1". Everything below narrows from the decoded value instead of poking at untyped fields.
 *
 * A reviewed or denied action becomes a permission-review annotation that decorates the tool row
 * and carries the review's own token usage. It is projected as a dedicated `permission_review`
 * event, not an `agent_event`: an `agent_event` must name the run it belongs to, and this one has
 * none. The permissions module that produced it runs inside a tool call, and Rig's frozen agent
 * core exposes no owning run id to a module, so the annotation is addressed only by tool-call id.
 * Inventing a run id here would be a lie a consumer could act on; omitting it is the truth.
 *
 * Everything that has no run of its own and nothing to annotate — an action that could not be
 * reviewed, a turn stopped by too many refusals, or a failed elevated-session cleanup — becomes a
 * standalone system notice: a visible, durable row that never enters model context and is not
 * folded into any conversational turn. Mode changes and out-of-mode refusals are already visible
 * through the tool result, so they project to nothing here.
 */
function projectPermissionEvent(
    payload: UnknownRecord,
    base: {
        readonly createdAt: number;
        readonly id: string;
        readonly sessionId: string;
        readonly worktreeSupport: string;
    },
): Record<string, unknown> | undefined {
    if (!Value.Check(permissionEventSchema, payload)) return undefined;
    const permissionEvent: PermissionEvent = payload;
    if (
        permissionEvent.type === "permission_action_reviewed" ||
        permissionEvent.type === "permission_action_denied"
    ) {
        return {
            ...base,
            data: {
                event: {
                    type: "permission_review",
                    action: permissionEvent.action,
                    decision:
                        permissionEvent.type === "permission_action_reviewed" ? "allow" : "deny",
                    reason: permissionEvent.reason,
                    risk: permissionEvent.risk,
                    toolCallId: permissionEvent.callId,
                    userAuthorization: permissionEvent.userAuthorization,
                    ...(permissionEvent.transcript === undefined
                        ? {}
                        : {
                              transcript: permissionReviewTranscriptForProtocol(
                                  permissionEvent.transcript,
                              ),
                          }),
                },
            },
            type: "permission_review",
        };
    }
    if (permissionEvent.type === "permission_action_unproven") {
        const timedOut = permissionEvent.kind === "timed_out";
        return systemNotice(
            base,
            timedOut
                ? "Automatic permission review did not finish"
                : "Automatic permission review could not run",
            timedOut
                ? "The action was not performed because its automatic permission review did not finish in time. No judgment was made that the action was unsafe."
                : "The action was not performed because no reliable automatic permission decision was available. No judgment was made about the action itself.",
        );
    }
    if (permissionEvent.type === "permission_mode_cleanup_failed") {
        return systemNotice(
            base,
            "Permission cleanup failed",
            `Rig could not stop every elevated process after permissions were reduced. ${permissionEvent.reason}`.trimEnd(),
        );
    }
    if (permissionEvent.type === "permission_turn_stopped") {
        const { consecutiveRefusals, recentRefusals, recentWindowLength } = permissionEvent;
        // The user-visible sentence drops the agent-facing directive the event's reason carries.
        // The stable `code` lets the client suppress the generic interruption row for this run
        // without matching the title text.
        return systemNotice(
            base,
            "Automatic permission review stopped the turn",
            `Automatic permission review refused too many actions in this turn (${consecutiveRefusals} in a ` +
                `row, ${recentRefusals} of the last ${recentWindowLength}), so the turn was stopped.`,
            PERMISSION_TURN_STOPPED_NOTICE_CODE,
        );
    }
    return undefined;
}

/**
 * The stable machine code carried on the turn-stop notice. A client suppresses the generic
 * interruption row for the aborted run that follows by keying on this, not on the title text.
 */
const PERMISSION_TURN_STOPPED_NOTICE_CODE = "permission_turn_stopped";

/** Build the visible system-notice row for one permission event. */
function systemNotice(
    base: {
        readonly createdAt: number;
        readonly id: string;
        readonly sessionId: string;
        readonly worktreeSupport: string;
    },
    title: string,
    details: string,
    code?: string,
): Record<string, unknown> {
    return {
        ...base,
        data: {
            message: {
                role: "system",
                id: base.id,
                context: "excluded",
                blocks: [{ type: "text", text: details }],
                structured: {
                    kind: "notice",
                    title,
                    details,
                    level: "warning",
                    ...(code === undefined ? {} : { code }),
                },
            },
        },
        type: "system_notice",
    };
}

/** Widen the module's bounded review usage into the protocol usage shape a client renders. */
function permissionReviewTranscriptForProtocol(
    transcript: PermissionReviewTranscript,
): Record<string, unknown> {
    const usage = transcript.usage;
    return {
        entries: transcript.entries,
        modelId: transcript.modelId,
        providerId: transcript.providerId,
        usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens: usage.totalTokens,
            ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
}

function agentBlocks(value: unknown): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    const result: Record<string, unknown>[] = [];
    for (const entry of value) {
        const block = recordValue(entry);
        if (block?.type === "text" && typeof block.text === "string") {
            result.push({ text: block.text, type: "text" });
            continue;
        }
        if (block?.type === "thinking" && typeof block.thinking === "string") {
            result.push({
                thinking: block.thinking,
                type: "thinking",
                ...(typeof block.encrypted === "string" ? { encrypted: block.encrypted } : {}),
            });
            continue;
        }
        if (
            block?.type === "toolCall" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
        ) {
            result.push({
                arguments: block.arguments ?? {},
                id: block.id,
                name: block.name,
                ...(typeof block.namespace === "string" ? { namespace: block.namespace } : {}),
                ...(typeof block.providerToolCallId === "string"
                    ? { providerToolCallId: block.providerToolCallId }
                    : {}),
                type: "tool_call",
                ...(block.vendor === undefined ? {} : { vendor: block.vendor }),
            });
            continue;
        }
        if (
            block?.type === "tool_result" &&
            typeof block.toolCallId === "string" &&
            typeof block.toolName === "string"
        ) {
            result.push({
                display: typeof block.display === "string" ? block.display : "",
                ...(block.isError === true ? { isError: true } : {}),
                rendered: Array.isArray(block.rendered) ? block.rendered : [],
                toolCallId: block.toolCallId,
                toolName: block.toolName,
                type: "tool_result",
            });
        }
    }
    return result;
}

function providerInputBlocks(value: unknown): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    const result: Record<string, unknown>[] = [];
    for (const block of value) {
        const record = recordValue(block);
        if (record === undefined) return [];
        if (record.type === "text" && typeof record.text === "string") {
            result.push({ text: record.text, type: "text" });
            continue;
        }
        if (
            record.type === "image" &&
            typeof record.data === "string" &&
            typeof record.mimeType === "string"
        ) {
            result.push({ data: record.data, mediaType: record.mimeType, type: "image" });
        }
    }
    return result;
}

function recordValue(value: unknown): UnknownRecord | undefined {
    return Value.Check(unknownRecordSchema, value) ? value : undefined;
}
