import { Value } from "@sinclair/typebox/value";

import { projectToolPresentation, type ToolPresentation } from "./ToolPresentation.js";
import type {
    AgentBlock,
    AgentLoopEvent,
    AgentMessage,
    Attachment,
    BackgroundProcess,
    ContentBlock,
    CompactionMessage,
    ErrorMessage,
    ExternalToolCall,
    GitChangeSnapshot,
    McpServerSummary,
    Message,
    PendingSteeringMessage,
    PermissionReviewState,
    ProviderToolCallRecord,
    ProtocolSession,
    SessionActivity,
    ScheduledMessage,
    SessionGoal,
    SessionStatus,
    SessionEvent,
    SessionSharePeerCapability,
    SessionShareMemberState,
    SessionTask,
    SessionStreamHello,
    SessionTokenCount,
    SessionTranscriptWindow,
    SessionUsageSnapshot,
    ShellCommandState,
    SubagentSummary,
    SystemMessage,
    SystemNoticePayload,
    ToolCallBlock,
    ToolCallPresentation,
    ToolResultBlock,
    ToolResultPresentation,
    Usage,
    UserInputRequest,
    UserMessage,
    WorkflowRun,
    WorkflowRunUpdate,
} from "./protocol.js";
import { SERVICE_NOTICE_TEXT_MAX_LENGTH, systemNoticePayloadSchema } from "./protocol.js";
import type {
    ActiveTurn,
    AgentAttachmentsElement,
    AgentTextElement,
    ChatDelta,
    ChatElement,
    ConnectionState,
    SessionState,
    SessionUsage,
    SystemNoticeElement,
    ThinkingElement,
    ToolCallElement,
    ToolPermissionReviewState,
    GroupEndElement,
    GroupEndReason,
    UserMessageElement,
} from "./ChatElement.js";
import { describeProviderToolCall } from "./describeProviderToolCall.js";
import { groupToolCalls } from "./groupToolCalls.js";
import { mergeForwardTranscriptWindow, mergeTranscriptWindow } from "./mergeTranscriptWindow.js";

const IDLE_ACTIVITY: SessionActivity = { kind: "idle", label: "Idle", since: 0 };

/**
 * The live chat state for one session.
 *
 * It holds the element list and the session state, applies protocol events to
 * them, and reports what changed. It knows nothing about transport: the same
 * store is driven by a live stream, by a replay in a test, or by a reconnect.
 *
 * The list is immutable from the outside. An element that did not change keeps
 * its identity across an update, so a consumer can rely on referential equality
 * to decide what to re-render.
 */
export class ChatStore {
    #elements: readonly ChatElement[] = [];
    /** Authoritative insertion order before pending steering is pinned to the tail. */
    #chronologicalElementIds: string[] = [];
    /** Avoids an order scan on the overwhelmingly common no-pending fast path. */
    #hasPinnedSteering = false;
    #session: SessionState;
    #turnId: string | undefined;
    #groupId: string | undefined;
    #groupPlaceholderId: string | undefined;
    #groupRunId: string | undefined;
    #groupStartedAt: number | undefined;
    /** Elements already shown that belong to the group that has not started yet. */
    #pendingNextGroupElementIds: string[] = [];
    /** Stable identity a context note gives to the actionable group that will consume it. */
    #pendingNextGroupId: string | undefined;
    #turnStartedAt = new Map<string, number>();
    /** Runs that have opened at least one group, so their ending has a footer. */
    #runsWithGroups = new Set<string>();
    /** When the last steering or compaction restarted a run's group, by run. */
    #lastBoundaryAt = new Map<string, number>();
    #turnKinds = new Map<string, "compaction">();
    #openTurnIds: string[] = [];
    /** Elements by id, so a delta reaches its element without scanning the list. */
    #byId = new Map<string, ChatElement>();
    /** In-flight tool calls by the daemon's tool-call id. */
    #toolCallElementIds = new Map<string, string>();
    /** Provider-run calls still in flight, keyed by run and provider call id. */
    #providerToolCallElementIds = new Map<string, string>();
    #permissionReviewsByToolCallId = new Map<string, PermissionReviewState>();
    /** Streaming blocks of the message being generated, keyed by content index. */
    #streamingElementIds = new Map<number, string>();
    #streamingMessageId: string | undefined;
    /** Ids of messages already applied, so a replayed message is not duplicated. */
    #appliedMessageIds = new Set<string>();
    #compactionElementIds = new Map<string, string>();
    #retrying = false;
    /** Bumped whenever the element list actually changes. */
    #revision = 0;
    /** Position of each element, so an update never scans the list. */
    #indexById = new Map<string, number>();
    /** Set when a tool call appeared or moved, which is all grouping depends on. */
    #groupingDirty = false;
    /** What the current turn has cost so far, summed across its inferences. */
    #turnUsage: Usage | undefined;
    /**
     * Raw call presentations, kept until the matching result arrives.
     *
     * A call and its result describe the same work at two moments and project
     * into one value, so the earlier half has to survive until the later one is
     * known. Entries are dropped as results land and cleared on reset.
     */
    #callPresentations = new Map<string, ToolCallPresentation>();
    /** Recent event identities make every reducer side effect idempotent. */
    #appliedEventIds = new Set<string>();
    /**
     * The transcript window the list was built from.
     *
     * A recovery that cannot resume is answered with the newest turns only, and
     * this is what the older turns are kept in so they can be merged back in
     * front of it.
     */
    #loadedTranscript: SessionTranscriptWindow | undefined;
    /** Invalidates an earlier-page response whenever the transcript is replaced. */
    #transcriptGeneration = 0;
    #activeLoadMoreAnchor: { before: string; generation: number } | undefined;
    /**
     * Elements from before a rebuild, so identical rows keep their reference.
     *
     * Set only while a transcript is being rebuilt, which bounds the comparison
     * to that work rather than paying for it on every append.
     */
    #priorElements: Map<string, ChatElement> | undefined;

    constructor(sessionId: string) {
        this.#session = {
            activity: IDLE_ACTIVITY,
            archived: false,
            backgroundProcesses: [],
            connection: "connecting",
            cwd: "",
            externalTools: [],
            mcpServers: [],
            modelLocked: false,
            modelId: "",
            models: [],
            pendingSteeringMessages: [],
            pendingUserInputs: [],
            permissionMode: "",
            permissionReviews: [],
            pendingExternalToolCalls: [],
            projectId: "",
            projectSecretIds: [],
            providerId: "",
            secretIds: [],
            scheduledMessages: [],
            sessionSecretIds: [],
            skills: [],
            loadingMore: false,
            sessionId,
            shellCommands: [],
            status: "idle",
            subagents: [],
            tasks: [],
            titleStatus: "idle",
            transcriptComplete: true,
            workflows: [],
            workflowsEnabled: false,
        };
    }

    /**
     * The run to ask for earlier turns from, or undefined when there is nothing
     * older to ask for.
     */
    earliestRunId(): string | undefined {
        if (this.#session.transcriptComplete) return undefined;
        return this.#loadedTranscript?.turns[0]?.runId;
    }

    /**
     * The event id of the newest transcript row this store holds.
     *
     * This is the anchor a catch-up starts from: the daemon returns the turns
     * from here on, so a conversation is not re-sent from the beginning after a
     * gap. Absent when nothing has been loaded yet, which means a full load.
     */
    newestMessageEventId(): string | undefined {
        const transcript = this.#loadedTranscript;
        if (transcript === undefined) return undefined;
        const eventIds = transcript.messageEventId;
        if (eventIds === undefined) return undefined;
        let newest: string | undefined;
        for (const message of transcript.messages) {
            const eventId = eventIds[message.id];
            if (eventId !== undefined && (newest === undefined || eventId > newest)) {
                newest = eventId;
            }
        }
        for (const notice of transcript.notices ?? []) {
            if (newest === undefined || notice.eventId > newest) newest = notice.eventId;
        }
        return newest;
    }

    /**
     * Atomically consumes one rendered load token.
     *
     * A virtual list may call this more than once before React commits the state
     * change. The first call marks the token in flight synchronously; duplicates
     * and stale renders therefore become no-ops before any request is created.
     */
    startLoadingMore(token: string):
        | {
              anchor: { before: string; generation: number };
              deltas: readonly ChatDelta[];
          }
        | undefined {
        const before = this.earliestRunId();
        if (
            before === undefined ||
            this.#session.loadingMore ||
            token !== this.#session.loadMoreToken
        ) {
            return undefined;
        }
        const sessionBefore = this.#session;
        this.#session = {
            ...withoutKeys(this.#session, ["loadMoreError"]),
            loadingMore: true,
        };
        const anchor = { before, generation: this.#transcriptGeneration };
        this.#activeLoadMoreAnchor = anchor;
        return {
            anchor,
            deltas: this.#finish([], this.#revision, sessionBefore),
        };
    }

    /** Reports that loading more history failed, in words a UI can show. */
    failLoadingMore(
        anchor: { before: string; generation: number },
        message: string,
    ): readonly ChatDelta[] {
        if (
            anchor.generation !== this.#transcriptGeneration ||
            anchor.before !== this.earliestRunId()
        ) {
            if (this.#activeLoadMoreAnchor !== anchor) return [];
            const before = this.#session;
            this.#activeLoadMoreAnchor = undefined;
            this.#session = { ...this.#session, loadingMore: false };
            return this.#finish([], this.#revision, before);
        }
        const before = this.#session;
        this.#activeLoadMoreAnchor = undefined;
        this.#session = { ...this.#session, loadMoreError: message, loadingMore: false };
        return this.#finish([], this.#revision, before);
    }

    /**
     * Adds a page of earlier turns in front of the list.
     *
     * The page is older than everything already loaded, so the existing rows keep
     * both their order and their identity and only the new turns are built.
     */
    prependEarlier(
        page: SessionTranscriptWindow,
        anchor?: { before: string; generation: number },
    ): readonly ChatDelta[] {
        const deltas: ChatDelta[] = [];
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        if (
            anchor !== undefined &&
            (anchor.generation !== this.#transcriptGeneration ||
                anchor.before !== this.earliestRunId())
        ) {
            if (this.#activeLoadMoreAnchor !== anchor) return [];
            this.#activeLoadMoreAnchor = undefined;
            this.#session = {
                ...withoutKeys(this.#session, ["loadMoreError"]),
                loadingMore: false,
            };
            return this.#finish(deltas, revisionBefore, sessionBefore);
        }
        const loaded = this.#loadedTranscript;
        const messageCreatedAt = {
            ...(page.messageCreatedAt ?? {}),
            ...(loaded?.messageCreatedAt ?? {}),
        };
        const messageEventId = {
            ...(page.messageEventId ?? {}),
            ...(loaded?.messageEventId ?? {}),
        };
        // Without this an older page's steering loses the moment it was applied
        // on the next rebuild, and with it both of the times it is measured by.
        const messageSteeredAt = {
            ...page.messageSteeredAt,
            ...loaded?.messageSteeredAt,
        };
        const permissionReviews = [
            ...new Map(
                [...(loaded?.permissionReviews ?? []), ...(page.permissionReviews ?? [])].map(
                    (review) => [review.toolCallId, review],
                ),
            ).values(),
        ];
        const notices = [
            ...new Map(
                [...(page.notices ?? []), ...(loaded?.notices ?? [])].map((notice) => [
                    notice.message.id,
                    notice,
                ]),
            ).values(),
        ].sort(
            (left, right) =>
                left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId),
        );
        const merged: SessionTranscriptWindow = {
            complete: page.complete,
            ...(Object.keys(messageCreatedAt).length === 0 ? {} : { messageCreatedAt }),
            ...(Object.keys(messageEventId).length === 0 ? {} : { messageEventId }),
            ...(Object.keys(messageSteeredAt).length === 0 ? {} : { messageSteeredAt }),
            ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
            messages: [...page.messages, ...(loaded?.messages ?? [])],
            ...(notices.length === 0 ? {} : { notices }),
            ...(page.noticesTruncated === true || loaded?.noticesTruncated === true
                ? { noticesTruncated: true }
                : {}),
            turns: [...page.turns, ...(loaded?.turns ?? [])],
        };
        this.#prependTranscriptPage(page);
        for (const review of page.permissionReviews ?? []) {
            this.#permissionReviewsByToolCallId.set(review.toolCallId, review);
        }
        this.#loadedTranscript = merged;
        this.#activeLoadMoreAnchor = undefined;
        const loadMoreToken = merged.complete ? undefined : historyToken(merged);
        this.#session = {
            ...withoutKeys(this.#session, ["loadMoreError", "loadMoreToken"]),
            ...(loadMoreToken === undefined ? {} : { loadMoreToken }),
            loadingMore: false,
            transcriptComplete: merged.complete,
        };
        return this.#finish(deltas, revisionBefore, sessionBefore);
    }

    /**
     * Builds only the older page and inserts it ahead of the current list.
     *
     * Rebuilding from `#loadedTranscript` is incorrect while a page is in flight:
     * committed messages, streaming blocks, retries, and steering can all arrive
     * after the request anchor. A detached store projects the bounded old page,
     * then those immutable rows are prepended without touching the live tail.
     */
    #prependTranscriptPage(page: SessionTranscriptWindow): void {
        const older = new ChatStore(this.#session.sessionId);
        older.#permissionReviewsByToolCallId = new Map([
            ...this.#permissionReviewsByToolCallId,
            ...(page.permissionReviews ?? []).map((review) => [review.toolCallId, review] as const),
        ]);
        older.#resetTranscript(page.messages, [], page);
        const olderPending = new Set(older.#pendingNextGroupElementIds);
        const boundaryGroupId = this.#elements.find(
            (element) =>
                element.groupId.startsWith("group:") &&
                !(element.kind === "user_message" && element.contextOnly === true),
        )?.groupId;
        const existingPendingGroupId = this.#pendingNextGroupElementIds
            .map((elementId) => this.#byId.get(elementId)?.groupId)
            .find((groupId) => groupId !== undefined);
        const targetGroupId =
            boundaryGroupId ??
            existingPendingGroupId ??
            this.#pendingNextGroupId ??
            older.#pendingNextGroupId;
        const additions = older.#elements
            .filter((element) => !this.#byId.has(element.id))
            .map((element) =>
                olderPending.has(element.id) &&
                targetGroupId !== undefined &&
                element.groupId !== targetGroupId
                    ? { ...element, groupId: targetGroupId }
                    : element,
            );
        if (additions.length === 0) return;

        for (const element of additions) this.#byId.set(element.id, element);
        for (const messageId of older.#appliedMessageIds) this.#appliedMessageIds.add(messageId);
        for (const [runId, startedAt] of older.#turnStartedAt) {
            if (!this.#turnStartedAt.has(runId)) this.#turnStartedAt.set(runId, startedAt);
        }
        const additionIds = additions.map((element) => element.id);
        const additionIdSet = new Set(additionIds);
        this.#chronologicalElementIds = [
            ...additionIds,
            ...this.#chronologicalElementIds.filter((id) => !additionIdSet.has(id)),
        ];
        this.#elements = [...additions, ...this.#elements];
        this.#reindex();
        this.#revision += 1;
        if (boundaryGroupId === undefined) {
            this.#pendingNextGroupElementIds = [
                ...older.#pendingNextGroupElementIds.filter((elementId) =>
                    this.#byId.has(elementId),
                ),
                ...this.#pendingNextGroupElementIds.filter(
                    (elementId) => !olderPending.has(elementId),
                ),
            ];
            this.#pendingNextGroupId = targetGroupId;
        }
        if (additions.some((element) => element.kind === "tool_call")) {
            this.#groupingDirty = true;
        }
        this.#presentPendingSteeringAtTail();
    }

    elements(): readonly ChatElement[] {
        return this.#elements;
    }

    session(): SessionState {
        return this.#session;
    }

    /**
     * Applies a local session prediction and returns the exact inverse.
     *
     * The mutation coordinator rolls predictions back in reverse order before
     * applying an authoritative event, then reapplies them in FIFO order. A
     * whole prior reference is therefore both cheaper and more exact than
     * reconstructing optional fields one by one.
     */
    applyOptimisticSession(
        patch: Partial<SessionState>,
        clear: readonly (keyof SessionState)[] = [],
    ): {
        deltas: readonly ChatDelta[];
        undo: () => void;
    } {
        const before = this.#session;
        const previous = new Map<
            keyof SessionState,
            { present: boolean; value: SessionState[keyof SessionState] }
        >();
        for (const key of new Set([...(Object.keys(patch) as (keyof SessionState)[]), ...clear])) {
            previous.set(key, {
                present: Object.hasOwn(before, key),
                value: before[key],
            });
        }
        const updated = { ...this.#session, ...patch };
        for (const key of clear) delete updated[key];
        this.#session = updated;
        const deltas = this.#finish([], this.#revision, before);
        return {
            deltas,
            undo: () => {
                const restored = { ...this.#session } as SessionState;
                for (const [key, prior] of previous) {
                    if (prior.present) {
                        (restored as unknown as Record<keyof SessionState, unknown>)[key] =
                            prior.value;
                    } else {
                        delete restored[key];
                    }
                }
                this.#session = restored;
            },
        };
    }

    /** Applies the owner share returned by a completed sharing mutation. */
    applySessionShare(shared: SessionState["shared"]): readonly ChatDelta[] {
        if (sameSessionShare(this.#session.shared, shared)) return [];
        const sessionBefore = this.#session;
        this.#session =
            shared === undefined
                ? withoutKeys(this.#session, ["shared"])
                : { ...this.#session, shared };
        return this.#finish([], this.#revision, sessionBefore);
    }

    /**
     * Applies one member's capability change reported by the global
     * `session_share_capabilities_changed` event, once its `shareId` matches
     * the share this session currently has. The event carries the member's
     * settled state and its capability list together, so a revoke lands in
     * one frame instead of an access flash followed by a separate refetch.
     */
    applySessionShareMemberCapabilities(
        shareId: string,
        shareMemberId: string,
        capabilities: readonly SessionSharePeerCapability[],
        capabilitiesDescription: string,
        memberState: SessionShareMemberState,
    ): readonly ChatDelta[] {
        if (this.#session.shared?.shareId !== shareId) return [];
        return [
            {
                capabilities,
                capabilitiesDescription,
                memberState,
                shareId,
                shareMemberId,
                type: "session_share_member_capabilities_changed",
            },
        ];
    }

    /** Adds one immediately visible user bubble for a queued send mutation. */
    applyOptimisticMessage(
        mutationId: string,
        text: string,
        createdAt: number,
    ): { deltas: readonly ChatDelta[]; undo: () => void } {
        const elementId = `message:${mutationId}`;
        if (this.#byId.has(elementId)) return { deltas: [], undo: () => undefined };
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        this.#appliedMessageIds.add(mutationId);
        this.#appendUserMessage(
            {
                blocks: [{ text, type: "text" }],
                id: mutationId,
                role: "user",
            },
            createdAt,
            this.#session.activeTurn?.runId ?? `optimistic:${mutationId}`,
            this.#session.activeTurn === undefined ? "sent" : "pending_steering",
        );
        if (this.#session.activeTurn === undefined) {
            this.#pendingNextGroupElementIds.push(`message:${mutationId}`);
        }
        const deltas = this.#finish([], revisionBefore, sessionBefore);
        return {
            deltas,
            undo: () => {
                this.#remove(elementId);
                this.#appliedMessageIds.delete(mutationId);
            },
        };
    }

    /** Adds a background-context bubble without changing live session activity. */
    applyOptimisticContextMessage(
        mutationId: string,
        text: string,
        createdAt: number,
    ): { deltas: readonly ChatDelta[]; undo: () => void } {
        const elementId = `message:${mutationId}`;
        if (this.#byId.has(elementId)) return { deltas: [], undo: () => undefined };
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        this.#appliedMessageIds.add(mutationId);
        this.#appendUserMessage(
            {
                blocks: [{ text, type: "text" }],
                contextOnly: true,
                id: mutationId,
                role: "user",
            },
            createdAt,
            `context:${mutationId}`,
            "sent",
            undefined,
            undefined,
            this.#ensurePendingNextGroupId(mutationId),
        );
        this.#rememberPendingNextGroupElement(elementId);
        const deltas = this.#finish([], revisionBefore, sessionBefore);
        return {
            deltas,
            undo: () => {
                this.#remove(elementId);
                this.#appliedMessageIds.delete(mutationId);
                this.#forgetPendingNextGroupElement(elementId);
            },
        };
    }

    /** Merges an authoritative mutation response without rebuilding the transcript. */
    applySessionSnapshot(session: ProtocolSession): readonly ChatDelta[] {
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        this.#session = {
            ...withoutKeys(this.#session, [
                "draft",
                "draftUpdatedAt",
                "agent",
                "agentId",
                "appendSystemPrompt",
                "environment",
                "effort",
                "goal",
                "git",
                "interruption",
                "lastEventId",
                "recap",
                "serviceTier",
                "shared",
                "title",
                "titleError",
                "tokens",
                "systemPrompt",
                "workspaceId",
            ]),
            archived: session.archived,
            backgroundProcesses: session.backgroundProcesses ?? [],
            cwd: session.cwd,
            externalTools: session.externalTools ?? [],
            mcpServers: session.mcpServers ?? [],
            modelLocked: session.modelLocked,
            modelId: session.modelId,
            models: session.models,
            ...(session.orderKey === undefined ? {} : { orderKey: session.orderKey }),
            pendingSteeringMessages: session.pendingSteeringMessages ?? [],
            pendingExternalToolCalls: session.pendingExternalToolCalls ?? [],
            pendingUserInputs: session.pendingUserInputs,
            permissionReviews: session.permissionReviews ?? [],
            permissionMode: session.permissionMode,
            projectId: session.projectId,
            projectSecretIds: session.projectSecretIds ?? [],
            providerId: session.providerId,
            secretIds: session.secretIds ?? [],
            scheduledMessages: session.scheduledMessages ?? [],
            sessionSecretIds: session.sessionSecretIds ?? [],
            sessionId: session.id,
            shellCommands: session.shellCommands ?? [],
            skills: session.skills ?? [],
            status: session.status,
            subagents: session.subagents ?? [],
            tasks: session.tasks,
            titleStatus: session.titleStatus ?? "idle",
            workflows: session.workflows ?? [],
            workflowsEnabled: session.workflowsEnabled ?? false,
            ...(session.appendSystemPrompt === undefined
                ? {}
                : { appendSystemPrompt: session.appendSystemPrompt }),
            ...(session.agent === undefined ? {} : { agent: session.agent }),
            ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
            ...(session.environment === undefined ? {} : { environment: session.environment }),
            ...(session.interruption === undefined ? {} : { interruption: session.interruption }),
            ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
            ...(session.draft === undefined ? {} : { draft: session.draft }),
            ...(session.draftUpdatedAt === undefined
                ? {}
                : { draftUpdatedAt: session.draftUpdatedAt }),
            ...(session.effort === undefined ? {} : { effort: session.effort }),
            ...(session.git === undefined ? {} : { git: applicationGit(session.git) }),
            ...(session.lastEventId === undefined ? {} : { lastEventId: session.lastEventId }),
            ...(session.goal === undefined ? {} : { goal: session.goal }),
            ...(session.recap === undefined ? {} : { recap: session.recap }),
            ...(session.serviceTier === undefined ? {} : { serviceTier: session.serviceTier }),
            ...(session.shared === undefined ? {} : { shared: session.shared }),
            ...(session.title === undefined ? {} : { title: session.title }),
            ...(session.titleError === undefined ? {} : { titleError: session.titleError }),
            ...(session.systemPrompt === undefined ? {} : { systemPrompt: session.systemPrompt }),
            ...(session.sessionTokenCount === undefined
                ? {}
                : { tokens: session.sessionTokenCount }),
        };
        return this.#finish([], revisionBefore, sessionBefore);
    }

    /** Replaces transcript and session facts after reset, rewind, or compaction. */
    applySessionReplacement(session: ProtocolSession): readonly ChatDelta[] {
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        this.#resetFromSession(session);
        return this.#finish([], revisionBefore, sessionBefore);
    }

    /**
     * Applies the opening frame of a stream.
     *
     * A first connection carries the whole session and rebuilds the list from its
     * transcript. A resume carries only what the event log cannot replay, so the
     * list is left alone and the in-flight message is restored.
     */
    applyHello(hello: SessionStreamHello & { append?: boolean }): readonly ChatDelta[] {
        const deltas: ChatDelta[] = [];
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        if (hello.session !== undefined) {
            const merged =
                hello.transcript === undefined
                    ? undefined
                    : hello.append === true
                      ? this.#appendForwardPage(hello.transcript)
                      : mergeTranscriptWindow(this.#loadedTranscript, hello.transcript);
            this.#resetFromSession(hello.session, merged, hello.usage);
            // The opening frame carries a bounded window, so the caller is told
            // whether the conversation began before the first element it has.
            const loadMoreToken =
                this.#loadedTranscript?.complete === false
                    ? historyToken(this.#loadedTranscript)
                    : undefined;
            this.#session = {
                ...withoutKeys(this.#session, ["loadMoreToken"]),
                ...(loadMoreToken === undefined ? {} : { loadMoreToken }),
                transcriptComplete: this.#loadedTranscript?.complete ?? true,
            };
        }
        if (hello.current !== undefined) {
            const current = hello.current;
            this.#session = {
                ...withoutKeys(this.#session, [
                    "draft",
                    "draftUpdatedAt",
                    "git",
                    "interruption",
                    "titleError",
                    "tokens",
                ]),
                externalTools: current.externalTools ?? this.#session.externalTools,
                mcpServers: current.mcpServers ?? this.#session.mcpServers,
                pendingExternalToolCalls:
                    current.pendingExternalToolCalls ?? this.#session.pendingExternalToolCalls,
                projectSecretIds: current.projectSecretIds ?? this.#session.projectSecretIds,
                secretIds: current.secretIds ?? this.#session.secretIds,
                scheduledMessages: current.scheduledMessages ?? this.#session.scheduledMessages,
                sessionSecretIds: current.sessionSecretIds ?? this.#session.sessionSecretIds,
                skills: current.skills ?? this.#session.skills,
                titleStatus: current.titleStatus ?? this.#session.titleStatus,
                workflows: current.workflows ?? this.#session.workflows,
                workflowsEnabled: current.workflowsEnabled ?? this.#session.workflowsEnabled,
                ...(current.draft === undefined ? {} : { draft: current.draft }),
                ...(current.draftUpdatedAt === undefined
                    ? {}
                    : { draftUpdatedAt: current.draftUpdatedAt }),
                ...(current.git === undefined ? {} : { git: applicationGit(current.git) }),
                ...(current.interruption === undefined
                    ? {}
                    : { interruption: current.interruption }),
                ...(current.sessionTokenCount === undefined
                    ? {}
                    : { tokens: current.sessionTokenCount }),
                ...(current.titleError === undefined ? {} : { titleError: current.titleError }),
                ...(this.#session.usage === undefined || current.sessionTokenCount === undefined
                    ? {}
                    : {
                          usage: {
                              ...this.#session.usage,
                              sessionTokenCount: current.sessionTokenCount,
                          },
                      }),
            };
        }
        this.#setActivity(hello.activity, deltas);
        if (hello.partial !== undefined) {
            this.#applyPartialMessage(hello.partial.message, hello.partial.runId, deltas);
        }
        return this.#finish(deltas, revisionBefore, sessionBefore);
    }

    /**
     * Joins a catch-up page onto the conversation already held.
     *
     * `complete` means something different on a forward page: it says the page
     * reaches the newest turn, not that it holds the conversation from the
     * beginning. Passing it through unchanged would tell the merge to replace
     * everything, throwing away the history this client is catching up on. How
     * far back the transcript reaches is unchanged by a page from the far end,
     * so that answer is kept from what was already loaded.
     */
    #appendForwardPage(page: SessionTranscriptWindow): SessionTranscriptWindow {
        const loaded = this.#loadedTranscript;
        return mergeForwardTranscriptWindow(loaded, page, loaded?.complete ?? page.complete);
    }

    setConnection(connection: ConnectionState): readonly ChatDelta[] {
        if (this.#session.connection === connection) return [];
        this.#session = { ...this.#session, connection };
        return [
            { type: "connection_changed", connection },
            { type: "session_changed", session: this.#session },
        ];
    }

    applyGitSnapshot(git: GitChangeSnapshot): readonly ChatDelta[] {
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        this.#setGit(git);
        return this.#finish([], revisionBefore, sessionBefore);
    }

    /** Applies one session event. Unrecognised events are ignored, not an error. */
    apply(event: SessionEvent): readonly ChatDelta[] {
        if (this.#appliedEventIds.has(event.id)) return [];
        this.#appliedEventIds.add(event.id);
        if (this.#appliedEventIds.size > 4_096) {
            const oldest = this.#appliedEventIds.values().next().value;
            if (oldest !== undefined) this.#appliedEventIds.delete(oldest);
        }
        const deltas: ChatDelta[] = [];
        const revisionBefore = this.#revision;
        const sessionBefore = this.#session;
        this.#session = { ...this.#session, lastEventId: event.id };
        switch (event.type) {
            case "session_updated":
                this.applySessionSnapshot((event.data as { session: ProtocolSession }).session);
                this.#session = { ...this.#session, lastEventId: event.id };
                break;
            case "session_status_changed": {
                // A replayed or delayed event can restate the status the store
                // already holds. Keeping the same session value means React
                // consumers are not re-rendered for news they already have.
                const status = (event.data as { status: SessionStatus }).status;
                if (status !== this.#session.status) {
                    this.#session = { ...this.#session, status };
                }
                break;
            }
            case "session_archived": {
                const archived = (event.data as { archived: boolean }).archived;
                if (archived !== this.#session.archived) {
                    this.#session = { ...this.#session, archived };
                }
                break;
            }
            case "session_activity_changed":
                this.#setActivity((event.data as { activity: SessionActivity }).activity, deltas);
                break;
            case "scheduled_message_changed": {
                const message = (event.data as { message: ScheduledMessage }).message;
                const existing = this.#session.scheduledMessages;
                const index = existing.findIndex((candidate) => candidate.id === message.id);
                const scheduledMessages =
                    index === -1
                        ? [...existing, message].sort(
                              (left, right) => left.createdAt - right.createdAt,
                          )
                        : existing.map((candidate, candidateIndex) =>
                              candidateIndex === index ? message : candidate,
                          );
                this.#session = { ...this.#session, scheduledMessages };
                break;
            }
            case "scheduled_messages_pruned": {
                const messageIds = new Set(
                    (event.data as { messageIds: readonly string[] }).messageIds,
                );
                this.#session = {
                    ...this.#session,
                    scheduledMessages: this.#session.scheduledMessages.filter(
                        (message) => !messageIds.has(message.id),
                    ),
                };
                break;
            }
            case "session_git_changed":
                this.#setGit((event.data as { git: GitChangeSnapshot }).git);
                break;
            case "session_context_changed":
                {
                    const tokens = (event.data as { sessionTokenCount: SessionTokenCount })
                        .sessionTokenCount;
                    this.#session = {
                        ...this.#session,
                        tokens,
                        ...(this.#session.usage === undefined
                            ? {}
                            : { usage: { ...this.#session.usage, sessionTokenCount: tokens } }),
                    };
                }
                break;
            case "session_configuration_changed": {
                const data = event.data as {
                    effort?: string;
                    modelId: string;
                    providerId?: string;
                    serviceTier: string | null;
                };
                const providerId = data.providerId ?? this.#session.providerId;
                const modelChanged =
                    data.modelId !== this.#session.modelId ||
                    providerId !== this.#session.providerId;
                // Effort and service tier are cleared by omission and by null
                // respectively, so both are written every time rather than
                // merged, or a cleared value would linger.
                this.#session = {
                    ...withoutKeys(this.#session, ["effort", "serviceTier"]),
                    modelId: data.modelId,
                    providerId,
                    ...(this.#session.usage === undefined
                        ? {}
                        : {
                              usage: modelChanged
                                  ? {
                                        ...withoutUsageContext(this.#session.usage),
                                        currentProviderId: providerId,
                                    }
                                  : {
                                        ...this.#session.usage,
                                        currentProviderId: providerId,
                                    },
                          }),
                    ...(data.effort === undefined ? {} : { effort: data.effort }),
                    ...(data.serviceTier === null ? {} : { serviceTier: data.serviceTier }),
                };
                break;
            }
            case "session_draft_changed": {
                const data = event.data as { draft?: string; updatedAt: number };
                if (
                    this.#session.draftUpdatedAt !== undefined &&
                    data.updatedAt < this.#session.draftUpdatedAt
                ) {
                    break;
                }
                this.#session = {
                    ...withoutKeys(this.#session, ["draft"]),
                    draftUpdatedAt: data.updatedAt,
                    ...(data.draft === undefined ? {} : { draft: data.draft }),
                };
                break;
            }
            case "permission_mode_changed":
                this.#session = {
                    ...this.#session,
                    permissionMode: (event.data as { permissionMode: string }).permissionMode,
                };
                break;
            case "session_title_changed": {
                const { errorMessage, recap, status, title } = event.data as {
                    errorMessage?: string;
                    recap?: string;
                    status: string;
                    title?: string;
                };
                // Generating and error events report only metadata activity; the
                // daemon deliberately omits the good metadata it still retains.
                // A settled idle/ready event is authoritative and may clear it.
                if (title !== undefined || recap !== undefined) {
                    this.#session = {
                        ...this.#session,
                        ...(title === undefined ? {} : { title }),
                        ...(recap === undefined ? {} : { recap }),
                    };
                }
                if (status === "idle" || status === "ready") {
                    const clear: ("recap" | "title")[] = [];
                    if (title === undefined) clear.push("title");
                    if (recap === undefined) clear.push("recap");
                    this.#session = withoutKeys(this.#session, clear);
                }
                this.#session = {
                    ...withoutKeys(this.#session, ["titleError"]),
                    titleStatus:
                        status === "error" ||
                        status === "generating" ||
                        status === "idle" ||
                        status === "ready"
                            ? status
                            : this.#session.titleStatus,
                    ...(errorMessage === undefined ? {} : { titleError: errorMessage }),
                };
                break;
            }
            case "user_input_requested": {
                const request = event.data as UserInputRequest;
                this.#session = {
                    ...this.#session,
                    pendingUserInputs: [
                        ...this.#session.pendingUserInputs.filter(
                            (pending) => pending.requestId !== request.requestId,
                        ),
                        request,
                    ],
                };
                break;
            }
            case "user_input_resolved": {
                const { requestId } = event.data as { requestId: string };
                this.#session = {
                    ...this.#session,
                    pendingUserInputs: this.#session.pendingUserInputs.filter(
                        (pending) => pending.requestId !== requestId,
                    ),
                };
                break;
            }
            case "secrets_changed": {
                const data = event.data as {
                    projectSecretIds: readonly string[];
                    secretIds: readonly string[];
                    sessionSecretIds: readonly string[];
                };
                this.#session = { ...this.#session, ...data };
                break;
            }
            case "mcp_servers_changed":
                this.#session = {
                    ...this.#session,
                    mcpServers: (event.data as { servers: readonly McpServerSummary[] }).servers,
                };
                break;
            case "workflow_changed": {
                const { update } = event.data as { update: WorkflowRunUpdate };
                const existing = this.#session.workflows.find(
                    (workflow) => workflow.runId === update.runId,
                );
                if (existing === undefined) {
                    if (isCompleteWorkflowUpdate(update)) {
                        this.#session = {
                            ...this.#session,
                            workflows: [...this.#session.workflows, workflowFromUpdate(update)],
                        };
                    }
                    break;
                }
                const { log, ...fields } = update;
                this.#session = {
                    ...this.#session,
                    workflows: this.#session.workflows.map((workflow) =>
                        workflow.runId === update.runId
                            ? {
                                  ...workflow,
                                  ...fields,
                                  logs: log === undefined ? workflow.logs : [...workflow.logs, log],
                              }
                            : workflow,
                    ),
                };
                break;
            }
            case "external_tool_call_requested": {
                const { call } = event.data as { call: ExternalToolCall };
                if (!this.#session.pendingExternalToolCalls.some((item) => item.id === call.id)) {
                    this.#session = {
                        ...this.#session,
                        pendingExternalToolCalls: [...this.#session.pendingExternalToolCalls, call],
                    };
                }
                break;
            }
            case "external_tool_call_resolved": {
                const { call } = event.data as { call: ExternalToolCall };
                this.#session = {
                    ...this.#session,
                    pendingExternalToolCalls:
                        call.status === "pending"
                            ? this.#session.pendingExternalToolCalls.map((item) =>
                                  item.id === call.id ? call : item,
                              )
                            : this.#session.pendingExternalToolCalls.filter(
                                  (item) => item.id !== call.id,
                              ),
                };
                break;
            }
            case "tasks_changed":
                this.#session = {
                    ...this.#session,
                    tasks: (event.data as { tasks: readonly SessionTask[] }).tasks,
                };
                break;
            case "goal_changed": {
                const { goal } = event.data as { goal: SessionGoal | null };
                this.#session =
                    goal === null
                        ? withoutKeys(this.#session, ["goal"])
                        : { ...this.#session, goal };
                break;
            }
            case "subagent_changed": {
                const { subagent } = event.data as { subagent: SubagentSummary };
                this.#session = {
                    ...this.#session,
                    subagents: [
                        ...this.#session.subagents.filter((known) => known.id !== subagent.id),
                        subagent,
                    ].sort((left, right) => left.createdAt - right.createdAt),
                };
                break;
            }
            case "shell_command_started": {
                const command = event.data as {
                    command: string;
                    commandId: string;
                    sessionId: number;
                };
                this.#setShellCommand({ ...command, status: "running" });
                break;
            }
            case "shell_command_finished": {
                const command = event.data as Omit<ShellCommandState, "status">;
                this.#setShellCommand({ ...command, status: "finished" });
                break;
            }
            case "steering_applied": {
                const data = event.data as { messageIds: readonly string[]; runId: string };
                this.#endGroup("steering", "success", event.createdAt, deltas);
                const applied = new Set(data.messageIds);
                const bridgeGroupId = `steering:${event.id}`;
                for (const messageId of data.messageIds) {
                    const elementId = `message:${messageId}`;
                    const element = this.#byId.get(elementId);
                    if (element?.kind === "user_message") {
                        this.#update(elementId, {
                            delivery: "sent",
                            groupId: bridgeGroupId,
                            ...this.#steeringTiming(data.runId, event.createdAt),
                        });
                    }
                }
                this.#moveElementsToTail(
                    data.messageIds.map((messageId) => `message:${messageId}`),
                );
                this.#pendingNextGroupElementIds.push(
                    ...data.messageIds
                        .map((messageId) => `message:${messageId}`)
                        .filter(
                            (elementId) => !this.#pendingNextGroupElementIds.includes(elementId),
                        ),
                );
                this.#session = {
                    ...this.#session,
                    pendingSteeringMessages: this.#session.pendingSteeringMessages.filter(
                        (pending) => !applied.has(pending.message.id),
                    ),
                };
                this.#presentPendingSteeringAtTail();
                break;
            }
            case "message_submitted":
                this.#trackPendingSteering(event);
                this.#applySubmittedMessage(event, deltas);
                break;
            case "run_started":
                {
                    const data = event.data as { kind?: "compaction"; runId: string };
                    this.#startTurn(data.runId, event.createdAt, deltas, data.kind);
                }
                break;
            case "abort_requested": {
                const data = event.data as {
                    continuePendingSteering?: true;
                    runId?: string;
                };
                if (data.continuePendingSteering === true) break;
                const runId = data.runId;
                if (runId === undefined || runId === this.#groupRunId) {
                    this.#endGroup("abort", "stopped", event.createdAt, deltas);
                }
                break;
            }
            case "agent_message":
                {
                    const data = event.data as { message: Message; runId: string };
                    if (!this.#appliedMessageIds.has(data.message.id)) {
                        if (data.message.role === "agent") this.#recordAgentUsage(data.message);
                        if (data.message.role === "compaction") {
                            this.#recordCompactionUsage(data.message);
                        }
                    }
                    this.#applyMessage(data.message, event.createdAt, deltas, data.runId);
                }
                break;
            case "system_notice": {
                const data = event.data as { message: SystemMessage };
                this.#applySystemNotice(data.message, event.createdAt);
                break;
            }
            case "provider_quota_observed": {
                const data = event.data as {
                    providerId: string;
                    quota: SessionUsageSnapshot["quotas"][number]["quota"];
                };
                this.#recordProviderQuota(data.providerId, data.quota);
                break;
            }
            case "agent_event":
                this.#applyAgentEvent(
                    (event.data as { event: AgentLoopEvent }).event,
                    event.createdAt,
                    deltas,
                    (event.data as { runId: string }).runId,
                );
                break;
            case "run_finished": {
                const data = event.data as {
                    attachmentMessageId?: string;
                    attachments?: readonly Attachment[];
                    errorMessage?: string;
                    modelLocked: boolean;
                    runId: string;
                    stopReason: string;
                };
                this.#session = { ...this.#session, modelLocked: data.modelLocked };
                if (
                    data.attachmentMessageId !== undefined &&
                    data.attachments !== undefined &&
                    data.attachments.length > 0
                ) {
                    this.#upsertAgentAttachments(
                        data.attachmentMessageId,
                        data.attachments,
                        event.createdAt,
                        data.runId,
                    );
                }
                const outcome =
                    data.stopReason === "error"
                        ? "error"
                        : data.stopReason === "aborted"
                          ? "stopped"
                          : "success";
                this.#endGroup(
                    outcome === "error" ? "error" : outcome === "stopped" ? "abort" : "completed",
                    outcome,
                    event.createdAt,
                    deltas,
                    data.errorMessage,
                );
                this.#endTurn(data.runId, outcome, data.errorMessage, event.createdAt, deltas);
                break;
            }
            case "run_error": {
                const data = event.data as {
                    errorMessage: string;
                    modelLocked: boolean;
                    runId: string;
                };
                this.#session = {
                    ...this.#session,
                    modelLocked: data.modelLocked,
                };
                this.#endGroup("error", "error", event.createdAt, deltas, data.errorMessage);
                this.#endTurn(data.runId, "error", data.errorMessage, event.createdAt, deltas);
                break;
            }
            case "session_reset":
            case "session_rewound": {
                // Both carry the transcript as it stands afterwards, so the list
                // is rebuilt with real runs and closed turns rather than the
                // per-message boundaries the snapshot alone would imply.
                const data = event.data as {
                    snapshot: {
                        messages: readonly Message[];
                        modelId?: string;
                        providerId?: string;
                    };
                    transcript?: SessionTranscriptWindow;
                };
                const transcript =
                    data.transcript === undefined
                        ? this.#loadedTranscript
                        : mergeTranscriptWindow(this.#loadedTranscript, data.transcript);
                if (transcript === undefined) {
                    // Old turns are immutable even when this event carries only
                    // the new model-context snapshot. Cancel a stale history
                    // request without rebuilding the visible timeline from it.
                    this.#transcriptGeneration += 1;
                    this.#activeLoadMoreAnchor = undefined;
                    this.#session = {
                        ...withoutKeys(this.#session, ["activeTurn", "loadMoreError"]),
                        loadingMore: false,
                    };
                } else {
                    this.#resetTranscript(data.snapshot.messages, deltas, transcript);
                }
                const usage = this.#session.usage;
                const loadMoreToken =
                    transcript?.complete === false ? historyToken(transcript) : undefined;
                this.#session = {
                    ...withoutKeys(this.#session, ["loadMoreError", "loadMoreToken"]),
                    ...(loadMoreToken === undefined ? {} : { loadMoreToken }),
                    loadingMore: false,
                    transcriptComplete: transcript?.complete ?? true,
                    ...(event.type === "session_reset" ? { permissionReviews: [] } : {}),
                    ...(usage === undefined
                        ? {}
                        : event.type === "session_reset"
                          ? {
                                usage: applicationUsage({
                                    currentProviderId:
                                        data.snapshot.providerId ?? usage.currentProviderId,
                                    groups: [],
                                    quotas: usage.quotas,
                                    sessionTokenCount: {
                                        lastContextTokens: 0,
                                        totalTokens: 0,
                                    },
                                }),
                            }
                          : { usage: withoutUsageContext(usage) }),
                };
                if (event.type === "session_reset") {
                    this.#permissionReviewsByToolCallId.clear();
                }
                break;
            }
            default:
                return [];
        }
        return this.#finish(deltas, revisionBefore, sessionBefore);
    }

    /**
     * Completes an application, reporting the list only when it really changed.
     *
     * Many events change an element without producing a delta of their own, so
     * the list revision rather than the delta list decides whether subscribers
     * are told the elements moved.
     */
    #finish(
        deltas: ChatDelta[],
        revisionBefore: number,
        sessionBefore: SessionState,
    ): readonly ChatDelta[] {
        this.#regroup();
        const elementsChanged = this.#revision !== revisionBefore;
        // The session value is replaced rather than mutated whenever any fact on
        // it changes, so an unchanged reference means there is nothing to report.
        // Comparing it here means a new fact is announced without every case
        // having to remember to push a delta of its own.
        const sessionChanged = this.#session !== sessionBefore;
        if (deltas.length === 0 && !elementsChanged && !sessionChanged) return [];
        if (!deltas.some((delta) => delta.type === "session_changed")) {
            deltas.push({ type: "session_changed", session: this.#session });
        }
        if (elementsChanged) {
            deltas.push({ type: "elements_changed", elements: this.#elements });
        }
        return deltas;
    }

    /**
     * Recomputes tool-call grouping when a tool call moved.
     *
     * Grouping is a whole-list scan, so it is skipped entirely for the events
     * that cannot affect it — which is nearly all of them, streaming text
     * deltas above all.
     */
    #regroup(): void {
        if (!this.#groupingDirty) return;
        this.#groupingDirty = false;
        const grouped = groupToolCalls(this.#elements);
        if (grouped === this.#elements) return;
        this.#elements = grouped;
        this.#revision += 1;
        for (const element of grouped) this.#byId.set(element.id, element);
    }

    #resetFromSession(
        session: ProtocolSession,
        transcript?: SessionTranscriptWindow,
        usage?: SessionUsageSnapshot,
    ): void {
        this.#session = {
            ...withoutKeys(this.#session, [
                "agent",
                "agentId",
                "appendSystemPrompt",
                "draft",
                "draftUpdatedAt",
                "environment",
                "effort",
                "goal",
                "git",
                "interruption",
                "lastEventId",
                "recap",
                "serviceTier",
                "shared",
                "title",
                "titleError",
                "tokens",
                "systemPrompt",
                "usage",
                "workspaceId",
            ]),
            archived: session.archived,
            backgroundProcesses: session.backgroundProcesses ?? [],
            cwd: session.cwd,
            externalTools: session.externalTools ?? [],
            mcpServers: session.mcpServers ?? [],
            modelLocked: session.modelLocked,
            modelId: session.modelId,
            models: session.models,
            ...(session.orderKey === undefined ? {} : { orderKey: session.orderKey }),
            pendingExternalToolCalls: session.pendingExternalToolCalls ?? [],
            pendingSteeringMessages: session.pendingSteeringMessages ?? [],
            pendingUserInputs: session.pendingUserInputs,
            permissionReviews: session.permissionReviews ?? [],
            permissionMode: session.permissionMode,
            projectId: session.projectId,
            projectSecretIds: session.projectSecretIds ?? [],
            providerId: session.providerId,
            secretIds: session.secretIds ?? [],
            scheduledMessages: session.scheduledMessages ?? [],
            sessionSecretIds: session.sessionSecretIds ?? [],
            sessionId: session.id,
            shellCommands: session.shellCommands ?? [],
            skills: session.skills ?? [],
            status: session.status,
            subagents: session.subagents ?? [],
            tasks: session.tasks,
            titleStatus: session.titleStatus ?? "idle",
            workflows: session.workflows ?? [],
            workflowsEnabled: session.workflowsEnabled ?? false,
            ...(session.appendSystemPrompt === undefined
                ? {}
                : { appendSystemPrompt: session.appendSystemPrompt }),
            ...(session.agent === undefined ? {} : { agent: session.agent }),
            ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
            ...(session.environment === undefined ? {} : { environment: session.environment }),
            ...(session.interruption === undefined ? {} : { interruption: session.interruption }),
            ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
            ...(session.draft === undefined ? {} : { draft: session.draft }),
            ...(session.draftUpdatedAt === undefined
                ? {}
                : { draftUpdatedAt: session.draftUpdatedAt }),
            ...(session.effort === undefined ? {} : { effort: session.effort }),
            ...(session.git === undefined ? {} : { git: applicationGit(session.git) }),
            ...(session.lastEventId === undefined ? {} : { lastEventId: session.lastEventId }),
            ...(session.goal === undefined ? {} : { goal: session.goal }),
            ...(session.recap === undefined ? {} : { recap: session.recap }),
            ...(session.serviceTier === undefined ? {} : { serviceTier: session.serviceTier }),
            ...(session.shared === undefined ? {} : { shared: session.shared }),
            ...(session.title === undefined ? {} : { title: session.title }),
            ...(session.titleError === undefined ? {} : { titleError: session.titleError }),
            ...(session.systemPrompt === undefined ? {} : { systemPrompt: session.systemPrompt }),
            ...(session.sessionTokenCount === undefined
                ? {}
                : { tokens: session.sessionTokenCount }),
            ...(usage === undefined ? {} : { usage: applicationUsage(usage) }),
        };
        this.#permissionReviewsByToolCallId = new Map(
            [...(session.permissionReviews ?? []), ...(transcript?.permissionReviews ?? [])].map(
                (review) => [review.toolCallId, review],
            ),
        );
        this.#resetTranscript(
            session.snapshot.messages,
            [],
            transcript,
            session.activeTurn === undefined
                ? undefined
                : {
                      runId: session.activeTurn.runId,
                      startedAt: session.activeTurn.startedAt,
                      ...(session.activeTurn.kind === undefined
                          ? {}
                          : { kind: session.activeTurn.kind }),
                  },
            true,
        );
        for (const review of session.permissionReviews ?? []) {
            const elementId = `tool:${review.toolCallId}`;
            if (this.#byId.get(elementId)?.kind === "tool_call") {
                this.#update(elementId, {
                    permissionReview: { ...review, status: "completed" },
                });
            }
        }
        for (const pending of session.pendingSteeringMessages ?? []) {
            this.#applyMessage(
                pending.message,
                pending.createdAt,
                [],
                pending.runId,
                "pending_steering",
            );
        }
        this.#priorElements = undefined;
    }

    /**
     * Rebuilds the list from a committed transcript.
     *
     * When the daemon reported turn boundaries the history is rebuilt as real
     * turns, each closed by its final group, so scrolled-back history renders the
     * same way live output does. Without them each message becomes its own turn,
     * which is all that can honestly be said about messages whose run the daemon
     * no longer knows.
     */
    #resetTranscript(
        messages: readonly Message[],
        deltas: ChatDelta[],
        transcript?: SessionTranscriptWindow,
        activeTurn?: ActiveTurn,
        preservePriorElements = false,
    ): void {
        this.#transcriptGeneration += 1;
        this.#activeLoadMoreAnchor = undefined;
        if (this.#elements.length > 0) this.#revision += 1;
        // Copied, not aliased: the map this reads from is cleared just below.
        this.#priorElements = new Map(this.#byId);
        this.#elements = [];
        this.#chronologicalElementIds = [];
        this.#hasPinnedSteering = false;
        this.#byId.clear();
        this.#indexById.clear();
        this.#groupingDirty = true;
        this.#toolCallElementIds.clear();
        this.#providerToolCallElementIds.clear();
        this.#callPresentations.clear();
        this.#streamingElementIds.clear();
        this.#appliedMessageIds.clear();
        this.#compactionElementIds.clear();
        this.#streamingMessageId = undefined;
        this.#turnId = undefined;
        this.#groupId = undefined;
        this.#groupPlaceholderId = undefined;
        this.#groupRunId = undefined;
        this.#groupStartedAt = undefined;
        this.#pendingNextGroupElementIds = [];
        this.#pendingNextGroupId = undefined;
        this.#runsWithGroups.clear();
        this.#turnStartedAt.clear();
        this.#lastBoundaryAt.clear();
        this.#turnKinds.clear();
        this.#openTurnIds = [];
        this.#turnUsage = undefined;
        this.#retrying = false;
        this.#session = {
            ...withoutKeys(this.#session, ["activeGroup", "activeTurn", "loadMoreError"]),
            loadingMore: false,
        };
        this.#loadedTranscript = transcript;
        try {
            if (
                transcript !== undefined &&
                (transcript.turns.length > 0 || (transcript.notices?.length ?? 0) > 0)
            ) {
                this.#rebuildTurns(transcript.messages, transcript, deltas, activeTurn);
                return;
            }
            for (const message of messages) {
                if (message.internal === true) continue;
                this.#turnId = `history:${message.id}`;
                if (message.role === "user" && message.contextOnly !== true) {
                    this.#pendingNextGroupElementIds.push(`message:${message.id}`);
                }
                this.#applyMessage(
                    message,
                    0,
                    deltas,
                    this.#turnId,
                    "sent",
                    undefined,
                    undefined,
                    false,
                );
            }
            if (activeTurn === undefined) this.#endGroup("completed", "success", 0, deltas);
            this.#turnId = undefined;
            if (activeTurn !== undefined) {
                this.#rememberTurn(activeTurn.runId, activeTurn.startedAt, activeTurn.kind);
                this.#activateTurn(activeTurn.runId, activeTurn.startedAt, deltas, activeTurn.kind);
            }
        } finally {
            if (!preservePriorElements) this.#priorElements = undefined;
        }
    }

    /**
     * Replays committed history as the turns the daemon recorded.
     *
     * A turn that the daemon reported as finished closes its final group with the
     * real outcome and duration, so a footer rendered from history matches what a
     * client watching live would have seen. A turn still running is left open for
     * the live events to finish.
     */
    #rebuildTurns(
        messages: readonly Message[],
        transcript: SessionTranscriptWindow,
        deltas: ChatDelta[],
        activeTurn?: ActiveTurn,
    ): void {
        type TimelineItem =
            | {
                  at: number;
                  eventId?: string;
                  kind: "message";
                  message: Message;
                  order: number;
                  runId: string;
                  /** A boundary message heads its group rather than sitting in it. */
                  steered?: boolean;
              }
            | {
                  at: number;
                  errorMessage?: string;
                  eventId?: string;
                  kind: "end";
                  order: number;
                  outcome: "success" | "error" | "stopped";
                  runId: string;
              }
            | {
                  at: number;
                  eventId?: never;
                  group: NonNullable<SessionTranscriptWindow["turns"][number]["groups"]>[number];
                  kind: "group_start";
                  order: number;
                  runId: string;
              }
            | {
                  at: number;
                  eventId?: never;
                  group: NonNullable<SessionTranscriptWindow["turns"][number]["groups"]>[number];
                  kind: "group_end";
                  order: number;
                  runId: string;
              }
            | {
                  at: number;
                  eventId: string;
                  kind: "notice";
                  message: SystemMessage;
                  order: number;
              }
            | {
                  at: number;
                  call: ProviderToolCallRecord;
                  eventId?: never;
                  kind: "provider_tool_call";
                  order: number;
                  runId: string;
              };
        /**
         * Only one inference occupies the session at a time, so its groups form
         * a single sequence even where runs overlap. Wall-clock alone loses that
         * sequence, because a group can open, produce, and close inside the same
         * millisecond; `groupIndex` carries the order the timestamps cannot.
         */
        type OrderedItem = TimelineItem & { groupIndex: number };
        const messageById = new Map(messages.map((message) => [message.id, message] as const));
        const turnByMessageId = new Map<string, SessionTranscriptWindow["turns"][number]>();
        const groupIndexByMessageId = new Map<string, number>();
        const groupEndings: number[] = [];
        let groupCount = 0;
        for (const turn of transcript.turns) {
            const contextOnlyAnchor =
                turn.kind === undefined &&
                (turn.groups?.length ?? 0) === 0 &&
                turn.messageIds.length > 0 &&
                turn.messageIds.every((messageId) => {
                    const message = messageById.get(messageId);
                    return message?.role === "user" && message.contextOnly === true;
                });
            if (!contextOnlyAnchor) this.#rememberTurn(turn.runId, turn.startedAt, turn.kind);
            for (const messageId of turn.messageIds) turnByMessageId.set(messageId, turn);
            for (const group of turn.groups ?? []) {
                groupIndexByMessageId.set(group.id, groupCount);
                groupCount += 1;
                if (group.endedAt !== undefined) groupEndings.push(group.endedAt);
            }
        }
        groupEndings.sort((left, right) => left - right);
        // Anything not owned by a group belongs after every group that has
        // already closed by then, and before the one still to open. A group's
        // own closing millisecond is not "by then": the last thing a group
        // produced and the footer that closes it routinely share one, and
        // counting the close would put that last thing in the next group.
        const groupsClosedBy = (at: number): number =>
            groupEndings.filter((endedAt) => endedAt < at).length;
        /**
         * Where a boundary message sits: after the group it closed, heading the
         * next one. The clock cannot say, because the boundary and the group it
         * opens routinely share a millisecond. Steering and compaction are the
         * same shape here.
         */
        const boundaryGroupIndex = (messageId: string): number | undefined => {
            const closedGroupId = transcript.messageBoundaryGroupId?.[messageId];
            if (closedGroupId === undefined) return undefined;
            const closed = groupIndexByMessageId.get(closedGroupId);
            return closed === undefined ? undefined : closed + 1;
        };
        const timeline: OrderedItem[] = messages.flatMap((message, order) => {
            const turn = turnByMessageId.get(message.id);
            if (turn === undefined) return [];
            // The agent message an inference produced belongs to that inference,
            // whatever millisecond it was finally persisted in.
            const groupIndex = groupIndexByMessageId.get(message.id);
            const containingGroupId = transcript.messageGroupId?.[message.id];
            const containingGroupIndex =
                containingGroupId === undefined
                    ? undefined
                    : groupIndexByMessageId.get(containingGroupId);
            const group = (turn.groups ?? []).find((known) => known.id === message.id);
            const at =
                group?.startedAt ??
                transcript.messageSteeredAt?.[message.id] ??
                transcript.messageCreatedAt?.[message.id] ??
                turn.startedAt;
            return [
                {
                    at,
                    ...(transcript.messageEventId?.[message.id] === undefined
                        ? {}
                        : { eventId: transcript.messageEventId[message.id] }),
                    groupIndex:
                        groupIndex ??
                        containingGroupIndex ??
                        boundaryGroupIndex(message.id) ??
                        groupsClosedBy(at),
                    kind: "message" as const,
                    message,
                    order,
                    runId: turn.runId,
                    steered:
                        transcript.messageSteeredAt?.[message.id] !== undefined ||
                        message.role === "compaction",
                },
            ];
        });
        const groupIndexOfContainingGroup = (messageId: string): number | undefined => {
            const containingGroupId = transcript.messageGroupId?.[messageId];
            return containingGroupId === undefined
                ? undefined
                : groupIndexByMessageId.get(containingGroupId);
        };
        let order = messages.length;
        // A provider-run call sits with the assistant message it accompanied, which is where a
        // client watching live saw it. It has no group of its own: Rig never executed it, so
        // there is nothing to open or close around it.
        for (const call of transcript.providerToolCalls ?? []) {
            const turn = turnByMessageId.get(call.messageId);
            timeline.push({
                at: call.createdAt,
                call,
                groupIndex:
                    groupIndexByMessageId.get(call.messageId) ??
                    groupIndexOfContainingGroup(call.messageId) ??
                    groupsClosedBy(call.createdAt),
                kind: "provider_tool_call",
                order,
                runId: turn?.runId ?? call.runId,
            });
            order += 1;
        }
        for (const notice of transcript.notices ?? []) {
            timeline.push({
                at: notice.createdAt,
                eventId: notice.eventId,
                groupIndex: groupsClosedBy(notice.createdAt),
                kind: "notice",
                message: notice.message,
                order,
            });
            order += 1;
        }
        for (const turn of transcript.turns) {
            for (const group of turn.groups ?? []) {
                const groupIndex = groupIndexByMessageId.get(group.id) ?? 0;
                timeline.push({
                    at: group.startedAt,
                    group,
                    groupIndex,
                    kind: "group_start",
                    order,
                    runId: turn.runId,
                });
                order += 1;
                if (group.endedAt !== undefined) {
                    timeline.push({
                        at: group.endedAt,
                        group,
                        groupIndex,
                        kind: "group_end",
                        order,
                        runId: turn.runId,
                    });
                    order += 1;
                }
            }
            if (turn.endedAt !== undefined) {
                timeline.push({
                    at: turn.endedAt,
                    ...(turn.errorMessage === undefined ? {} : { errorMessage: turn.errorMessage }),
                    groupIndex: groupsClosedBy(turn.endedAt),
                    kind: "end",
                    order,
                    outcome: turn.outcome ?? "success",
                    runId: turn.runId,
                });
                order += 1;
            }
        }
        const priority = (item: OrderedItem): number =>
            item.kind === "message" && item.steered === true
                ? timelinePriority("compaction")
                : timelinePriority(item.kind);
        // Millisecond timestamps can tie across independently stored rows. Structural
        // priorities preserve group boundaries first; event IDs then retain durable
        // order within a priority, so a cross-kind tie can differ from live arrival.
        timeline.sort(
            (left, right) =>
                left.at - right.at ||
                left.groupIndex - right.groupIndex ||
                priority(left) - priority(right) ||
                compareEventOrder(left.eventId, right.eventId) ||
                left.order - right.order,
        );
        for (const item of timeline) {
            if (item.kind === "notice") {
                this.#applySystemNotice(item.message, item.at);
                continue;
            }
            this.#turnId = item.runId;
            if (item.kind === "provider_tool_call") {
                this.#applyProviderToolCall(
                    {
                        arguments: item.call.arguments,
                        callId: item.call.callId,
                        ...(item.call.status === "interrupted" ? { incomplete: true } : {}),
                        name: item.call.name,
                        type: "server_toolcall_end",
                    } as unknown as AgentLoopEvent,
                    item.at,
                    item.runId,
                );
                continue;
            }
            if (item.kind === "group_start") {
                this.#startGroup(item.group.id, item.runId, item.at, deltas);
            } else if (item.kind === "group_end") {
                this.#endGroup(
                    item.group.reason ?? "completed",
                    item.group.outcome ?? "success",
                    item.at,
                    deltas,
                    item.group.errorMessage,
                );
            } else if (item.kind === "message") {
                const steeredAt = transcript.messageSteeredAt?.[item.message.id];
                if (steeredAt !== undefined) {
                    this.#endGroup("steering", "success", steeredAt, deltas);
                } else if (item.message.role === "user" && item.message.contextOnly !== true) {
                    this.#pendingNextGroupElementIds.push(`message:${item.message.id}`);
                }
                this.#applyMessage(
                    item.message,
                    transcript.messageCreatedAt?.[item.message.id] ?? item.at,
                    deltas,
                    item.runId,
                    "sent",
                    undefined,
                    steeredAt === undefined
                        ? undefined
                        : this.#steeringTiming(item.runId, steeredAt),
                    false,
                );
                if (steeredAt !== undefined) {
                    this.#update(`message:${item.message.id}`, {
                        groupId: `steering:${item.message.id}`,
                    });
                    this.#pendingNextGroupElementIds.push(`message:${item.message.id}`);
                }
            } else {
                this.#endGroup(
                    item.outcome === "error"
                        ? "error"
                        : item.outcome === "stopped"
                          ? "abort"
                          : "completed",
                    item.outcome,
                    item.at,
                    deltas,
                    item.errorMessage,
                );
                this.#endTurn(item.runId, item.outcome, item.errorMessage, item.at, deltas, false);
            }
        }
        const restored =
            activeTurn ??
            this.#openTurnIds
                .map((turnId) => {
                    const startedAt = this.#turnStartedAt.get(turnId);
                    const kind = this.#turnKinds.get(turnId);
                    return startedAt === undefined
                        ? undefined
                        : { runId: turnId, startedAt, ...(kind === undefined ? {} : { kind }) };
                })
                .find((turn): turn is ActiveTurn => turn !== undefined);
        if (restored === undefined) {
            this.#turnId = undefined;
        } else {
            this.#rememberTurn(restored.runId, restored.startedAt, restored.kind);
            this.#activateTurn(restored.runId, restored.startedAt, deltas, restored.kind);
        }
    }

    #setActivity(activity: SessionActivity, deltas: ChatDelta[]): void {
        const wasRetrying = this.#retrying;
        this.#session = { ...this.#session, activity };
        deltas.push({ type: "session_changed", session: this.#session });
        this.#retrying = activity.retry !== undefined;
        if (!this.#retrying && wasRetrying) deltas.push({ type: "retry_finished" });
        const reviewingToolCallIds = new Set(
            (activity.reviewingToolCalls ?? []).map((review) => review.toolCallId),
        );
        for (const [toolCallId, elementId] of this.#toolCallElementIds) {
            if (reviewingToolCallIds.has(toolCallId)) continue;
            const element = this.#byId.get(elementId);
            if (element?.kind === "tool_call" && element.permissionReview?.status === "reviewing") {
                this.#clearPermissionReview(elementId);
            }
        }
        for (const review of activity.reviewingToolCalls ?? []) {
            const elementId = this.#toolCallElementIds.get(review.toolCallId);
            if (elementId === undefined) continue;
            const element = this.#byId.get(elementId);
            if (element?.kind === "tool_call" && element.permissionReview?.status === "completed") {
                continue;
            }
            this.#update(elementId, {
                permissionReview: {
                    action: review.action,
                    status: "reviewing",
                    toolCallId: review.toolCallId,
                },
            });
        }
        for (const call of activity.toolCalls ?? []) {
            const elementId = this.#toolCallElementIds.get(call.toolCallId);
            if (elementId === undefined) continue;
            this.#update(elementId, {
                status: "running",
                ...(call.status === undefined ? {} : { progress: call.status }),
            });
        }
    }

    #startTurn(runId: string, at: number, deltas: ChatDelta[], kind?: "compaction"): void {
        const startedAt = this.#turnStartedAt.get(runId) ?? at;
        this.#rememberTurn(runId, startedAt, kind);
        this.#activateTurn(runId, startedAt, deltas, kind);
    }

    #rememberTurn(runId: string, startedAt: number, kind?: "compaction"): void {
        if (!this.#turnStartedAt.has(runId)) this.#turnStartedAt.set(runId, startedAt);
        if (kind !== undefined) this.#turnKinds.set(runId, kind);
        if (!this.#openTurnIds.includes(runId)) this.#openTurnIds.push(runId);
    }

    #activateTurn(
        runId: string,
        startedAt: number,
        deltas: ChatDelta[],
        kind = this.#turnKinds.get(runId),
    ): void {
        if (
            this.#session.activeTurn?.runId === runId &&
            this.#session.activeTurn.startedAt === startedAt
        ) {
            this.#turnId = runId;
            return;
        }
        this.#turnId = runId;
        this.#session = {
            ...this.#session,
            activeTurn: { runId, startedAt, ...(kind === undefined ? {} : { kind }) },
        };
        this.#streamingElementIds.clear();
        this.#streamingMessageId = undefined;
        this.#turnUsage = undefined;
        deltas.push({
            runId,
            startedAt,
            type: "turn_started",
            ...(kind === undefined ? {} : { kind }),
        });
    }

    /**
     * Opens the inference segment the user is waiting on.
     *
     * A run reaches the model repeatedly to work through its tool calls, and all
     * of that is one thing the person asked for. So a group spans every
     * iteration of the run and closes only when the work stops: the run ends,
     * the user steers it, the user aborts it, or it fails.
     */
    #startGroup(messageId: string, runId: string, at: number, deltas: ChatDelta[]): void {
        if (this.#groupId !== undefined) {
            if (this.#groupRunId === runId) return;
            this.#endGroup("completed", "success", at, deltas);
        }
        const groupId = this.#pendingNextGroupId ?? `group:${messageId}`;
        this.#runsWithGroups.add(runId);
        this.#groupId = groupId;
        this.#groupRunId = runId;
        this.#groupStartedAt = at;
        this.#groupPlaceholderId = `group-start:${messageId}`;
        for (const pendingElementId of this.#pendingNextGroupElementIds) {
            const pending = this.#byId.get(pendingElementId);
            if (pending?.groupId !== groupId) this.#update(pendingElementId, { groupId });
        }
        this.#pendingNextGroupElementIds = [];
        this.#pendingNextGroupId = undefined;
        this.#session = {
            ...this.#session,
            activeGroup: { groupId, runId, startedAt: at },
        };
        this.#turnUsage = undefined;
        this.#append({
            createdAt: at,
            groupId,
            id: this.#groupPlaceholderId,
            kind: "inference",
            runId,
            state: "waiting",
        });
        deltas.push({ groupId, runId, startedAt: at, type: "group_started" });
    }

    /** The group currently open, if one is. */
    #openGroupIdentity(): { groupId: string; runId: string; startedAt: number } | undefined {
        const groupId = this.#groupId;
        const runId = this.#groupRunId;
        const startedAt = this.#groupStartedAt;
        if (groupId === undefined || runId === undefined || startedAt === undefined)
            return undefined;
        return { groupId, runId, startedAt };
    }

    /**
     * The group a run that never reached the model still has to close.
     *
     * A run can fail before inference starts at all, and the question is still
     * asked and still has to end. Without this it would end with nothing: no
     * failure, no footer, and the guarantee that a group always closes broken
     * exactly where a reader most needs to be told what happened.
     *
     * Only the end of a run makes one. Steering and compaction close whatever
     * is open, and when nothing is open there is nothing for them to close.
     */
    #emptyGroupIdentity(
        reason: GroupEndReason,
    ): { groupId: string; runId: string; startedAt: number } | undefined {
        if (reason === "steering" || reason === "compaction") return undefined;
        const runId = this.#turnId;
        if (runId === undefined || this.#runsWithGroups.has(runId)) return undefined;
        const startedAt = this.#turnStartedAt.get(runId);
        if (startedAt === undefined) return undefined;
        return { groupId: `run:${runId}`, runId, startedAt };
    }

    #endGroup(
        reason: GroupEndReason,
        outcome: GroupEndElement["outcome"],
        at: number,
        deltas: ChatDelta[],
        errorMessage?: string,
    ): void {
        const synthesized = this.#openGroupIdentity() === undefined;
        const open = this.#openGroupIdentity() ?? this.#emptyGroupIdentity(reason);
        if (open === undefined) return;
        const { groupId, runId, startedAt } = open;
        const turnKind = this.#turnKinds.get(runId);
        if (synthesized) {
            // The question was waiting for a group that never opened. This is
            // that group, so it takes what belongs to this run; leaving those
            // waiting would hand them to the next run's first group instead.
            // Questions queued behind it keep waiting for their own run.
            this.#pendingNextGroupElementIds = this.#pendingNextGroupElementIds.filter(
                (pendingElementId) => {
                    const element = this.#byId.get(pendingElementId);
                    if (element !== undefined && element.runId !== runId) return true;
                    this.#update(pendingElementId, { groupId });
                    return false;
                },
            );
        }
        // Steering and compaction restart a group, so the group's own start is
        // not where the person's question began. Both are kept.
        // A turn whose start predates the retained log reports 0, meaning
        // unknown. Taking it would report the epoch as the moment the person
        // asked, so the group's own start stands in for it.
        const knownTurnStartedAt = this.#turnStartedAt.get(runId);
        const turnStartedAt =
            knownTurnStartedAt === undefined || knownTurnStartedAt === 0
                ? startedAt
                : Math.min(startedAt, knownTurnStartedAt);
        this.#closeOpenElements(outcome);
        // A real failure gets its own line, the same line a failed attempt gets.
        // Steering, compaction, and abort stop the group without failing it, so
        // they get none.
        const alreadyHasTerminalFailure = [...this.#byId.values()].some(
            (element) =>
                element.kind === "failure" &&
                element.groupId === groupId &&
                element.outcome === "failed",
        );
        if (reason === "error" && errorMessage !== undefined && !alreadyHasTerminalFailure) {
            this.#append({
                createdAt: at,
                groupId,
                id: `failure:${groupId}`,
                kind: "failure",
                outcome: "failed",
                reason: errorMessage,
                runId,
            });
        }
        this.#append({
            createdAt: at,
            elapsedMs: Math.max(0, at - startedAt),
            endedAt: at,
            groupId,
            id: `group-end:${groupId}`,
            kind: "group_end",
            outcome,
            reason,
            runId,
            startedAt,
            ...(turnKind === undefined ? {} : { turnKind }),
            turnElapsedMs: Math.max(0, at - turnStartedAt),
            turnStartedAt,
            ...(errorMessage === undefined ? {} : { errorMessage }),
            ...(this.#turnUsage === undefined ? {} : { usage: this.#turnUsage }),
        });
        this.#session = withoutKeys(this.#session, ["activeGroup"]);
        this.#groupId = undefined;
        this.#groupPlaceholderId = undefined;
        this.#groupRunId = undefined;
        this.#groupStartedAt = undefined;
        this.#streamingElementIds.clear();
        this.#streamingMessageId = undefined;
        this.#turnUsage = undefined;
        deltas.push({
            endedAt: at,
            groupId,
            outcome,
            reason,
            runId,
            startedAt,
            type: "group_ended",
            ...(turnKind === undefined ? {} : { kind: turnKind }),
        });
    }

    /**
     * Closes the current turn after its final group has ended.
     */
    #endTurn(
        turnId: string,
        outcome: GroupEndElement["outcome"],
        errorMessage: string | undefined,
        at: number,
        deltas: ChatDelta[],
        advance = true,
    ): void {
        const startedAt = this.#turnStartedAt.get(turnId);
        if (startedAt === undefined) return;
        const turnKind = this.#turnKinds.get(turnId);
        this.#turnUsage = undefined;
        this.#turnStartedAt.delete(turnId);
        this.#lastBoundaryAt.delete(turnId);
        this.#runsWithGroups.delete(turnId);
        this.#turnKinds.delete(turnId);
        this.#openTurnIds = this.#openTurnIds.filter((openTurnId) => openTurnId !== turnId);
        if (this.#session.activeTurn?.runId === turnId) {
            this.#session = withoutKeys(this.#session, ["activeTurn"]);
            this.#turnId = undefined;
            this.#streamingElementIds.clear();
            this.#streamingMessageId = undefined;
        }
        deltas.push({
            endedAt: at,
            outcome,
            runId: turnId,
            startedAt,
            type: "turn_ended",
            ...(turnKind === undefined ? {} : { kind: turnKind }),
        });
        if (!advance) return;
        const nextTurnId = this.#openTurnIds[0];
        const nextStartedAt =
            nextTurnId === undefined ? undefined : this.#turnStartedAt.get(nextTurnId);
        if (nextTurnId !== undefined && nextStartedAt !== undefined) {
            this.#activateTurn(nextTurnId, nextStartedAt, deltas);
        }
    }

    #closeOpenElements(outcome: GroupEndElement["outcome"]): void {
        for (const elementId of this.#streamingElementIds.values()) {
            const element = this.#byId.get(elementId);
            if (element === undefined) continue;
            if (element.kind === "agent_text" || element.kind === "thinking") {
                if (!element.complete) this.#update(elementId, { complete: true });
            }
        }
        for (const elementId of this.#toolCallElementIds.values()) {
            const element = this.#byId.get(elementId);
            if (element?.kind !== "tool_call") continue;
            if (element.status === "pending" || element.status === "running") {
                this.#update(elementId, {
                    argumentsComplete: true,
                    status: outcome === "stopped" ? "interrupted" : "failed",
                });
            }
            // No result can arrive for this call now, so the raw half kept for
            // pairing is dead. Its projection already reached the element; only
            // the wire value is dropped. Without this an interrupted turn leaks
            // one entry per tool call for the life of the session.
            this.#callPresentations.delete(elementId);
        }
        this.#toolCallElementIds.clear();
        // A provider-run call cannot outlive the response that started it. Stopping the turn
        // stops Rig reading the answer, not the search itself, which already reached the
        // provider's backend — so the row stays and says its outcome is unknown rather than
        // spinning for the life of the session.
        for (const [key, elementId] of this.#providerToolCallElementIds) {
            const element = this.#byId.get(elementId);
            if (element?.kind === "provider_tool_call" && element.status === "running") {
                this.#update(elementId, {
                    status: outcome === "stopped" ? "interrupted" : "failed",
                });
            }
            this.#providerToolCallElementIds.delete(key);
        }
    }

    #applySubmittedMessage(event: SessionEvent, deltas: ChatDelta[]): void {
        const data = event.data as {
            delivery?: "context" | "run" | "steer";
            displayText: string;
            message: Message;
            runId: string;
            source?: "notification";
        };
        if (data.delivery === "run") {
            this.#rememberTurn(data.runId, event.createdAt);
            if (this.#session.activeTurn === undefined) {
                this.#activateTurn(data.runId, event.createdAt, deltas);
            }
            if (!this.#pendingNextGroupElementIds.includes(`message:${data.message.id}`)) {
                this.#pendingNextGroupElementIds.push(`message:${data.message.id}`);
            }
        }
        this.#applyMessage(
            data.message,
            event.createdAt,
            deltas,
            data.runId,
            data.delivery === "steer" ? "pending_steering" : "sent",
            data.source,
        );
    }

    #trackPendingSteering(event: SessionEvent): void {
        const data = event.data as {
            delivery?: "context" | "run" | "steer";
            message: UserMessage;
            runId: string;
        };
        if (data.delivery !== "steer") return;
        const pending: PendingSteeringMessage = {
            createdAt: event.createdAt,
            message: data.message,
            runId: data.runId,
        };
        this.#session = {
            ...this.#session,
            pendingSteeringMessages: [
                ...this.#session.pendingSteeringMessages.filter(
                    (known) => known.message.id !== pending.message.id,
                ),
                pending,
            ],
        };
    }

    #setShellCommand(command: ShellCommandState): void {
        const knownIndex = this.#session.shellCommands.findIndex(
            (known) => known.commandId === command.commandId,
        );
        const shellCommands =
            knownIndex === -1
                ? [...this.#session.shellCommands, command].slice(-100)
                : this.#session.shellCommands.map((known, index) =>
                      index === knownIndex ? command : known,
                  );
        this.#session = { ...this.#session, shellCommands };
    }

    #recordAgentUsage(message: AgentMessage): void {
        if (
            message.usage === undefined ||
            message.providerId === undefined ||
            message.requestedModelId === undefined
        ) {
            return;
        }
        const modelId = message.responseModel ?? message.requestedModelId;
        this.#recordUsageGroup({
            kind: "attributed",
            modelId,
            providerId: message.providerId,
            requestedModelId: message.requestedModelId,
            ...(message.responseModel === undefined
                ? {}
                : { responseModel: message.responseModel }),
            usage: message.usage,
        });
        if (message.contextTokens === undefined) return;
        const usage = this.#session.usage;
        if (usage === undefined) return;
        this.#session = {
            ...this.#session,
            usage: applicationUsage({
                ...usage,
                context: {
                    approximate: false,
                    modelId,
                    providerId: message.providerId,
                    requestedModelId: message.requestedModelId,
                    ...(message.responseModel === undefined
                        ? {}
                        : { responseModel: message.responseModel }),
                    totalTokens: message.contextTokens,
                },
                currentProviderId: message.providerId,
            }),
        };
    }

    #recordCompactionUsage(message: CompactionMessage): void {
        const context = this.#session.usage?.context;
        if (
            message.usage === undefined ||
            (context === undefined && message.requestedModelId === undefined)
        ) {
            return;
        }
        const requestedModelId = message.requestedModelId ?? context?.requestedModelId;
        if (requestedModelId === undefined) return;
        this.#recordUsageGroup({
            kind: "attributed",
            modelId: message.responseModel ?? requestedModelId,
            providerId: message.providerId,
            requestedModelId,
            ...(message.responseModel === undefined
                ? {}
                : { responseModel: message.responseModel }),
            usage: message.usage,
        });
    }

    #recordUsageGroup(group: SessionUsageSnapshot["groups"][number]): void {
        const current =
            this.#session.usage ??
            applicationUsage({
                currentProviderId: this.#session.providerId,
                groups: [],
                quotas: [],
                sessionTokenCount: this.#session.tokens ?? {
                    lastContextTokens: 0,
                    totalTokens: 0,
                },
            });
        const index = current.groups.findIndex(
            (known) =>
                known.providerId === group.providerId &&
                known.modelId === group.modelId &&
                known.role === group.role,
        );
        const groups =
            index === -1
                ? [...current.groups, group]
                : current.groups.map((known, knownIndex) =>
                      knownIndex === index
                          ? { ...known, usage: addUsage(known.usage, group.usage) }
                          : known,
                  );
        this.#session = {
            ...this.#session,
            usage: applicationUsage({ ...current, groups }),
        };
    }

    /**
     * Keeps the newest quota a provider has reported for this session, so the
     * usage display moves as the account is spent rather than only when it is
     * polled.
     */
    #recordProviderQuota(
        providerId: string,
        quota: SessionUsageSnapshot["quotas"][number]["quota"],
    ): void {
        const usage = this.#session.usage;
        if (usage === undefined) return;
        const known = usage.quotas.find((entry) => entry.providerId === providerId);
        if (known !== undefined && known.quota.capturedAt > quota.capturedAt) return;
        const quotas = [
            ...usage.quotas.filter((entry) => entry.providerId !== providerId),
            { providerId, quota },
        ];
        this.#session = {
            ...this.#session,
            usage: { ...usage, quotas },
        };
    }

    /** Applies one committed message, expanding its blocks into elements. */
    #applyMessage(
        message: Message,
        at: number,
        deltas: ChatDelta[],
        turnId = this.#turnId,
        delivery: UserMessageElement["delivery"] = "sent",
        source?: "notification",
        steering?: Pick<UserMessageElement, "steeredAt" | "steeringElapsedMs">,
        emitRetryDelta = true,
    ): void {
        if (message.internal === true) return;
        if (message.role === "system") {
            this.#applySystemNotice(message, at, turnId);
            return;
        }
        if (this.#appliedMessageIds.has(message.id)) {
            if (message.role === "agent") this.#reconcileAgentMessage(message, at);
            if (message.role === "compaction") {
                this.#applyCompactionMessage(message, at, turnId, deltas);
            }
            if (message.role === "user" && delivery === "pending_steering") {
                this.#update(`message:${message.id}`, { delivery });
                this.#presentPendingSteeringAtTail();
            }
            return;
        }
        this.#appliedMessageIds.add(message.id);
        if (message.role === "user") {
            const elementId = `message:${message.id}`;
            const futureGroupId =
                message.contextOnly === true
                    ? this.#ensurePendingNextGroupId(message.id)
                    : this.#pendingNextGroupElementIds.includes(elementId)
                      ? this.#pendingNextGroupId
                      : undefined;
            this.#appendUserMessage(message, at, turnId, delivery, source, steering, futureGroupId);
            if (message.contextOnly === true) {
                this.#rememberPendingNextGroupElement(elementId);
            }
            return;
        }
        if (message.role === "compaction") {
            this.#applyCompactionMessage(message, at, turnId, deltas);
            return;
        }
        if (message.role === "error") {
            this.#applyErrorMessage(message, at, turnId, deltas, emitRetryDelta);
            return;
        }
        const runId = turnId ?? this.#turnId ?? `history:${message.id}`;
        this.#startGroup(message.id, runId, at, deltas);
        this.#appendAgentBlocks(message, at, deltas, turnId);
    }

    #applySystemNotice(message: SystemMessage, at: number, turnId?: string): void {
        if (this.#appliedMessageIds.has(message.id)) return;
        this.#appliedMessageIds.add(message.id);
        const payload = decodeSystemNoticePayload(message);
        if (payload === undefined) return;
        const noticeId = `notice:${message.id}`;
        const element: SystemNoticeElement = {
            createdAt: at,
            id: `message:${message.id}`,
            kind: "system_notice",
            ...(payload.structured === undefined ? {} : { structured: payload.structured }),
            text: payload.text,
            ...(turnId === undefined
                ? { groupId: noticeId, runId: noticeId }
                : this.#elementIdentity(turnId)),
        };
        this.#append(element);
    }

    #applyErrorMessage(
        message: ErrorMessage,
        at: number,
        turnId: string | undefined,
        deltas: ChatDelta[],
        emitRetryDelta: boolean,
    ): void {
        const reason = textOf(message.blocks);
        const runId = turnId ?? `history:${message.id}`;
        const terminalFallbackAlreadyRendered =
            message.outcome === "failed" &&
            [...this.#byId.values()].some(
                (element) =>
                    element.kind === "failure" &&
                    element.outcome === "failed" &&
                    element.reason === reason &&
                    element.runId === runId,
            );
        if (terminalFallbackAlreadyRendered) return;
        this.#append({
            ...(message.attempt === undefined ? {} : { attempt: message.attempt }),
            createdAt: at,
            id: `message:${message.id}`,
            kind: "failure",
            outcome: message.outcome,
            reason,
            ...this.#elementIdentity(runId),
        });
        if (message.outcome === "retried" && emitRetryDelta) {
            deltas.push({
                attempt: message.attempt ?? 1,
                reason,
                type: "retry_started",
            });
        }
    }

    /**
     * Renders the durable compaction message as the row it stands for.
     *
     * Watched live, the row already exists: the compaction's start opened it and
     * closed the group there. This message is the same compaction, so it
     * completes that row rather than adding a second one. Rebuilt from history
     * there is no such row, and this message is the only record of it, so it
     * both draws the row and makes the boundary the reader saw.
     */
    #applyCompactionMessage(
        message: CompactionMessage,
        at: number,
        turnId: string | undefined,
        deltas: ChatDelta[],
    ): void {
        const id = `message:${message.id}`;
        const update = {
            compactionId: message.id,
            estimatedTokensAfter: message.statistics.after.tokens,
            estimatedTokensBefore: message.statistics.before.tokens,
            messagesCompacted: message.replacedMessageIds.length,
            status: "completed" as const,
            tokensAfter: message.statistics.after.tokens,
            tokensAfterExact: message.statistics.after.exact,
            tokensBefore: message.statistics.before.tokens,
        };
        const existing = this.#byId.get(id);
        if (existing?.kind === "compaction") {
            this.#update(id, update);
            return;
        }
        const runId = turnId ?? this.#turnId ?? `history:${message.id}`;
        const timing = this.#boundaryTiming(runId, at);
        this.#endGroup("compaction", "success", at, deltas);
        this.#append({
            ...update,
            ...timing,
            createdAt: at,
            id,
            kind: "compaction",
            ...this.#elementIdentity(runId),
        });
        // It heads the group that follows, exactly as a steering message does.
        this.#pendingNextGroupElementIds.push(id);
    }

    #appendUserMessage(
        message: UserMessage,
        at: number,
        turnId = this.#turnId,
        delivery: UserMessageElement["delivery"] = "sent",
        source?: "notification",
        steering?: Pick<UserMessageElement, "steeredAt" | "steeringElapsedMs">,
        futureGroupId?: string,
    ): void {
        const attachments = message.blocks
            .filter((block): block is Extract<ContentBlock, { type: "image" }> =>
                isImageBlock(block),
            )
            .map((block) => ({ data: block.data, mediaType: block.mediaType }));
        const element: UserMessageElement = {
            createdAt: at,
            delivery,
            ...(message.contextOnly === true ? { contextOnly: true } : {}),
            ...(message.friendAuthor === undefined
                ? {}
                : { friendAuthor: { ...message.friendAuthor } }),
            ...(message.friendMessageDisposition === undefined
                ? {}
                : { friendMessageContext: message.friendMessageDisposition }),
            id: `message:${message.id}`,
            kind: "user_message",
            messageId: message.id,
            ...(source === undefined ? {} : { source }),
            ...(steering === undefined ? {} : steering),
            text: textOf(message.blocks),
            ...(futureGroupId === undefined
                ? this.#elementIdentity(turnId ?? `history:${message.id}`)
                : {
                      groupId: futureGroupId,
                      runId: turnId ?? `history:${message.id}`,
                  }),
            ...(attachments.length === 0 ? {} : { attachments }),
        };
        this.#append(element);
    }

    #steeringTiming(
        turnId: string,
        steeredAt: number,
    ): Pick<UserMessageElement, "steeredAt" | "steeringElapsedMs" | "turnElapsedMs"> {
        return { steeredAt, ...this.#boundaryTiming(turnId, steeredAt) };
    }

    /**
     * Measures a steering or compaction from both starts a reader can mean.
     *
     * Either one restarts the group, so the time since the last boundary is what
     * the block on screen took, while the time since the turn began is what the
     * whole question has cost so far. Which one to show is the UI's choice, so
     * both are recorded and neither is preferred here.
     */
    #boundaryTiming(
        turnId: string,
        at: number,
    ): Pick<UserMessageElement, "steeringElapsedMs" | "turnElapsedMs"> {
        const startedAt = this.#turnStartedAt.get(turnId);
        const turnStartedAt = startedAt === undefined || startedAt === 0 ? undefined : startedAt;
        const previous = this.#lastBoundaryAt.get(turnId) ?? turnStartedAt;
        this.#lastBoundaryAt.set(turnId, at);
        return {
            steeringElapsedMs: previous === undefined ? 0 : Math.max(0, at - previous),
            turnElapsedMs: turnStartedAt === undefined ? 0 : Math.max(0, at - turnStartedAt),
        };
    }

    /**
     * Turns a completed agent message into elements.
     *
     * Blocks already shown while streaming are reconciled rather than appended,
     * so the authoritative message replaces the live rendering without producing
     * a second copy of the same text.
     */
    #appendAgentBlocks(
        message: AgentMessage,
        at: number,
        deltas: ChatDelta[],
        turnId = this.#turnId,
    ): void {
        const elementTurnId = turnId ?? `history:${message.id}`;
        const streamed = this.#streamingMessageId === message.id;
        for (const [contentIndex, block] of message.blocks.entries()) {
            if (isTextBlock(block)) {
                const existing = streamed
                    ? this.#findStreamed("agent_text", contentIndex)
                    : undefined;
                if (existing !== undefined) {
                    this.#update(existing.id, { complete: true, text: block.text });
                    continue;
                }
                if (block.text.length === 0) continue;
                this.#appendGroupContent({
                    complete: true,
                    createdAt: at,
                    id: `${message.id}:agent_text:${contentIndex}`,
                    kind: "agent_text",
                    text: block.text,
                    ...this.#elementIdentity(elementTurnId),
                });
                continue;
            }
            if (isThinkingBlock(block)) {
                const existing = streamed
                    ? this.#findStreamed("thinking", contentIndex)
                    : undefined;
                if (existing !== undefined) {
                    this.#update(existing.id, { complete: true, text: block.thinking });
                    continue;
                }
                if (block.thinking.length === 0) continue;
                this.#appendGroupContent({
                    complete: true,
                    createdAt: at,
                    id: `${message.id}:thinking:${contentIndex}`,
                    kind: "thinking",
                    text: block.thinking,
                    ...this.#elementIdentity(elementTurnId),
                });
                continue;
            }
            if (isToolCallBlock(block)) {
                this.#upsertToolCall(block, at, elementTurnId);
                continue;
            }
            if (isToolResultBlock(block)) this.#applyToolResult(block);
        }
        if (message.usage !== undefined) {
            // A turn that calls tools runs inference more than once, so the cost
            // of the turn is the sum rather than the last message's share.
            this.#turnUsage = addUsage(this.#turnUsage, message.usage);
            deltas.push({ type: "session_changed", session: this.#session });
        }
        if (message.attachments !== undefined && message.attachments.length > 0) {
            this.#upsertAgentAttachments(message.id, message.attachments, at, elementTurnId);
        }
    }

    /** Applies a later copy of a message that is already in the list. */
    #reconcileAgentMessage(message: AgentMessage, at: number): void {
        for (const block of message.blocks) {
            if (isToolCallBlock(block)) this.#upsertToolCall(block, at, this.#turnId ?? "");
            else if (isToolResultBlock(block)) this.#applyToolResult(block);
        }
        if (message.attachments !== undefined && message.attachments.length > 0) {
            this.#upsertAgentAttachments(
                message.id,
                message.attachments,
                at,
                this.#turnId ?? `history:${message.id}`,
            );
        }
    }

    #upsertAgentAttachments(
        messageId: string,
        attachments: readonly Attachment[],
        at: number,
        runId: string,
    ): void {
        const id = `${messageId}:attachments`;
        const existing = this.#byId.get(id);
        if (existing?.kind === "agent_attachments") {
            this.#update(id, { attachments });
            return;
        }
        const element: AgentAttachmentsElement = {
            attachments,
            createdAt: at,
            id,
            kind: "agent_attachments",
            messageId,
            ...this.#elementIdentity(runId),
        };
        this.#appendGroupContent(element);
    }

    /**
     * Restores the message a run is part-way through generating.
     *
     * Only a client that attached mid-turn sees this; the same content arrives as
     * deltas for a client that was already watching, so the elements are keyed
     * the same way and converge either way.
     */
    #applyPartialMessage(message: AgentMessage, runId: string, deltas: ChatDelta[]): void {
        this.#startTurn(runId, this.#session.activity.since, deltas);
        this.#startGroup(message.id, runId, this.#session.activity.since, deltas);
        this.#streamingMessageId = message.id;
        for (const [contentIndex, block] of message.blocks.entries()) {
            if (isTextBlock(block)) {
                this.#openStreamedElement("agent_text", contentIndex, block.text, message.id);
                continue;
            }
            if (isThinkingBlock(block)) {
                this.#openStreamedElement("thinking", contentIndex, block.thinking, message.id);
                continue;
            }
            if (isToolCallBlock(block))
                this.#upsertToolCall(block, this.#session.activity.since, runId);
        }
    }

    #applyAgentEvent(event: AgentLoopEvent, at: number, deltas: ChatDelta[], runId: string): void {
        switch (event.type) {
            case "inference_iteration_start": {
                const messageId = (event as { messageId: string }).messageId;
                this.#startGroup(messageId, runId, at, deltas);
                this.#streamingMessageId = messageId;
                this.#streamingElementIds.clear();
                return;
            }
            case "block_reset":
                // The provider restarted the message mid-stream, so everything
                // already shown for it was tentative. It is dropped rather than
                // left for a later completed message to contradict.
                this.#discardStreamedElements();
                return;
            case "text_start":
            case "text_delta":
            case "text_end":
                this.#applyStreamedText("agent_text", event, at);
                return;
            case "thinking_start":
            case "thinking_delta":
            case "thinking_end":
                this.#applyStreamedText("thinking", event, at);
                return;
            case "toolcall_start":
            case "toolcall_delta":
            case "toolcall_end":
                this.#applyStreamedToolCall(event, at);
                return;
            case "server_toolcall_start":
            case "server_toolcall_delta":
            case "server_toolcall_end":
                this.#applyProviderToolCall(event, at, runId);
                return;
            case "tool_execution_start": {
                const call = (event as { toolCall: ToolCallBlock }).toolCall;
                const elementId = this.#upsertToolCall(call, at, this.#turnId ?? "");
                this.#update(elementId, { status: "running" });
                return;
            }
            case "tool_execution_progress": {
                const data = event as { display: string; toolCallId: string };
                const elementId = this.#toolCallElementIds.get(data.toolCallId);
                if (elementId !== undefined) this.#update(elementId, { progress: data.display });
                return;
            }
            case "tool_execution_status": {
                const data = event as { status: string; toolCallId: string };
                const elementId = this.#toolCallElementIds.get(data.toolCallId);
                if (elementId !== undefined) this.#update(elementId, { progress: data.status });
                return;
            }
            case "tool_execution_end": {
                const result = (event as Extract<AgentLoopEvent, { type: "tool_execution_end" }>)
                    .result;
                const elementId = this.#toolCallElementIds.get(result.toolCallId);
                if (elementId === undefined) return;
                const element = this.#byId.get(elementId);
                this.#toolCallElementIds.delete(result.toolCallId);
                if (
                    element?.kind === "tool_call" &&
                    element.permissionReview?.status === "reviewing"
                ) {
                    this.#clearPermissionReview(elementId);
                }
                this.#update(elementId, {
                    argumentsComplete: true,
                    status: toolStatus(result),
                    ...(result.display === undefined ? {} : { result: result.display }),
                    ...this.#presentationUpdate(elementId, result.presentation),
                });
                return;
            }
            case "context_compaction_started": {
                const data = event as {
                    compactionId: string;
                    estimatedTokensBefore: number;
                };
                // A compaction the user asked for runs on its own, with no
                // turn open. Its own run identifies it.
                const compactionRunId = this.#turnId ?? runId;
                // Compaction is a boundary like steering: the group the reader
                // was watching ends here, and this element heads the next one.
                const timing = this.#boundaryTiming(compactionRunId, at);
                this.#endGroup("compaction", "success", at, deltas);
                // The compaction is durable history in its own right, so the
                // row it opens here is the one its message later completes.
                const id = `message:${data.compactionId}`;
                this.#compactionElementIds.set(data.compactionId, id);
                this.#append({
                    compactionId: data.compactionId,
                    createdAt: at,
                    estimatedTokensBefore: data.estimatedTokensBefore,
                    id,
                    kind: "compaction",
                    status: "running",
                    ...timing,
                    ...this.#elementIdentity(compactionRunId),
                });
                this.#pendingNextGroupElementIds.push(id);
                deltas.push({ type: "compaction_started", compactionId: data.compactionId });
                return;
            }
            case "context_compacted": {
                const data = event as {
                    compactedMessageCount: number;
                    compactionId: string;
                    estimatedTokensAfter: number;
                };
                const elementId = this.#compactionElementIds.get(data.compactionId);
                if (elementId !== undefined) {
                    this.#update(elementId, {
                        estimatedTokensAfter: data.estimatedTokensAfter,
                        messagesCompacted: data.compactedMessageCount,
                    });
                }
                if (this.#session.usage?.context !== undefined) {
                    this.#session = {
                        ...this.#session,
                        usage: {
                            ...this.#session.usage,
                            context: {
                                ...this.#session.usage.context,
                                approximate: true,
                                totalTokens: data.estimatedTokensAfter,
                            },
                        },
                    };
                }
                return;
            }
            case "context_compaction_finished": {
                const data = event as {
                    compactionId: string;
                    status: "cancelled" | "completed" | "failed";
                };
                const elementId = this.#compactionElementIds.get(data.compactionId);
                this.#compactionElementIds.delete(data.compactionId);
                if (elementId !== undefined) this.#update(elementId, { status: data.status });
                deltas.push({ type: "compaction_finished", compactionId: data.compactionId });
                return;
            }
            case "background_processes_changed": {
                const processes =
                    (
                        event as {
                            processes?: readonly BackgroundProcess[];
                        }
                    ).processes ?? [];
                this.#session = { ...this.#session, backgroundProcesses: processes };
                return;
            }
            case "permission_review_started": {
                const review = event as {
                    action: string;
                    toolCallId: string;
                    toolName: string;
                    type: "permission_review_started";
                };
                const elementId = this.#toolCallElementIds.get(review.toolCallId);
                if (elementId !== undefined) {
                    const element = this.#byId.get(elementId);
                    if (
                        element?.kind === "tool_call" &&
                        element.permissionReview?.status === "completed"
                    ) {
                        return;
                    }
                    this.#update(elementId, {
                        permissionReview: {
                            action: review.action,
                            status: "reviewing",
                            toolCallId: review.toolCallId,
                        },
                    });
                }
                return;
            }
            case "permission_review": {
                const review = event as PermissionReviewState & {
                    transcript?: { modelId: string; providerId: string; usage: Usage };
                    type: "permission_review";
                };
                const next: PermissionReviewState = {
                    action: review.action,
                    decision: review.decision,
                    reason: review.reason,
                    risk: review.risk,
                    toolCallId: review.toolCallId,
                    userAuthorization: review.userAuthorization,
                };
                this.#permissionReviewsByToolCallId.set(next.toolCallId, next);
                const elementId = this.#toolCallElementIds.get(next.toolCallId);
                if (elementId !== undefined) {
                    this.#update(elementId, {
                        permissionReview: { ...next, status: "completed" },
                    });
                }
                if (review.transcript !== undefined) {
                    this.#recordUsageGroup({
                        kind: "attributed",
                        modelId: review.transcript.modelId,
                        providerId: review.transcript.providerId,
                        requestedModelId: review.transcript.modelId,
                        role: "permission_review",
                        usage: review.transcript.usage,
                    });
                }
                this.#session = {
                    ...this.#session,
                    permissionReviews: [
                        ...this.#session.permissionReviews.filter(
                            (known) => known.toolCallId !== next.toolCallId,
                        ),
                        next,
                    ].slice(-100),
                };
                return;
            }
            case "temporary_full_access_started": {
                const review = event as PermissionReviewState & {
                    type: "temporary_full_access_started";
                };
                const next: PermissionReviewState = {
                    action: review.action,
                    decision: "allow",
                    fullAccessGranted: true,
                    reason: review.reason,
                    risk: review.risk,
                    toolCallId: review.toolCallId,
                    userAuthorization: review.userAuthorization,
                };
                this.#permissionReviewsByToolCallId.set(next.toolCallId, next);
                const elementId = this.#toolCallElementIds.get(next.toolCallId);
                if (elementId !== undefined) {
                    this.#update(elementId, {
                        permissionReview: { ...next, status: "completed" },
                    });
                }
                this.#session = {
                    ...this.#session,
                    permissionReviews: [
                        ...this.#session.permissionReviews.filter(
                            (known) => known.toolCallId !== next.toolCallId,
                        ),
                        next,
                    ].slice(-100),
                };
                return;
            }
            default:
        }
    }

    /** Drops the tentative elements of the message currently being streamed. */
    #discardStreamedElements(): void {
        for (const elementId of this.#streamingElementIds.values()) {
            const element = this.#byId.get(elementId);
            if (element?.kind === "tool_call" && element.toolCallId.length > 0) {
                this.#toolCallElementIds.delete(element.toolCallId);
            }
            this.#remove(elementId);
        }
        this.#streamingElementIds.clear();
        // A provider-run call that never finished belongs to the abandoned attempt, so its row
        // goes with it rather than spinning forever. One that completed stays: its end event is
        // durable evidence that the provider really did search.
        for (const [key, elementId] of this.#providerToolCallElementIds) {
            this.#remove(elementId);
            this.#providerToolCallElementIds.delete(key);
        }
    }

    #applyStreamedText(kind: "agent_text" | "thinking", event: AgentLoopEvent, at: number): void {
        const data = event as {
            content?: string;
            contentIndex: number;
            delta?: string;
            messageId?: string;
        };
        const key = streamKey(kind, data.contentIndex);
        const existingId = this.#streamingElementIds.get(key);
        if (existingId === undefined) {
            const id = `${data.messageId ?? this.#streamingMessageId ?? "stream"}:${kind}:${data.contentIndex}`;
            const actualId = this.#appendGroupContent({
                complete: false,
                createdAt: at,
                id,
                kind,
                text: data.delta ?? data.content ?? "",
                ...this.#elementIdentity(this.#turnId ?? ""),
            } as AgentTextElement | ThinkingElement);
            this.#streamingElementIds.set(key, actualId);
            return;
        }
        const existing = this.#byId.get(existingId);
        if (
            existing === undefined ||
            (existing.kind !== "agent_text" && existing.kind !== "thinking")
        ) {
            return;
        }
        if (data.content !== undefined) {
            this.#update(existingId, { complete: true, text: data.content });
            return;
        }
        if (data.delta !== undefined) {
            this.#update(existingId, { text: existing.text + data.delta });
        }
    }

    /**
     * Records a call the provider ran on its own backend.
     *
     * Rig never executes one, so this only ever describes what already happened. The start and
     * delta events are live-only; on a reopened session just the end arrives, and the completed
     * row is built from that alone. The element id is derived from the call, so a redelivered
     * event updates the same row instead of adding another.
     */
    #applyProviderToolCall(event: AgentLoopEvent, at: number, runId: string): void {
        const data = event as {
            arguments?: string;
            callId: string;
            delta?: string;
            incomplete?: true;
            name?: string;
            type: string;
        };
        if (data.callId.length === 0) return;
        const key = `${runId}:${data.callId}`;
        const existingId = this.#providerToolCallElementIds.get(key);
        const existing = existingId === undefined ? undefined : this.#byId.get(existingId);
        const current = existing?.kind === "provider_tool_call" ? existing : undefined;

        if (data.type === "server_toolcall_delta") {
            if (current === undefined) return;
            const argumentsText = current.argumentsText + (data.delta ?? "");
            this.#update(current.id, {
                argumentsText,
                presentation: describeProviderToolCall(current.name, argumentsText),
            });
            return;
        }

        const complete = data.type === "server_toolcall_end";
        const name = data.name ?? current?.name ?? "";
        // The end event carries the provider's own final arguments, which is where the sources
        // live; the streamed text is only a fallback for a provider that sends none.
        const argumentsText = complete
            ? data.arguments && data.arguments.length > 0
                ? data.arguments
                : (current?.argumentsText ?? "")
            : (current?.argumentsText ?? "");

        // The closing event says whether the provider reported back. One marked incomplete was
        // written by Rig for a turn that ended first, and is the whole record that the search
        // reached the network at all.
        const status = !complete
            ? "running"
            : data.incomplete === true
              ? "interrupted"
              : "completed";
        if (current !== undefined) {
            this.#update(current.id, {
                argumentsComplete: complete,
                argumentsText,
                name,
                presentation: describeProviderToolCall(name, argumentsText),
                status,
            });
            if (complete) this.#providerToolCallElementIds.delete(key);
            return;
        }

        // Appending may reuse the group's placeholder row, which keeps its own id, so the id it
        // returns is the one to remember rather than the one just proposed.
        const elementId = this.#appendGroupContent({
            argumentsComplete: complete,
            argumentsText,
            createdAt: at,
            id: `provider-tool:${runId}:${data.callId}`,
            kind: "provider_tool_call",
            name,
            presentation: describeProviderToolCall(name, argumentsText),
            providerToolCallId: data.callId,
            status,
            ...this.#elementIdentity(runId),
        });
        if (!complete) this.#providerToolCallElementIds.set(key, elementId);
    }

    #applyStreamedToolCall(event: AgentLoopEvent, at: number): void {
        const data = event as {
            contentIndex: number;
            delta?: string;
            messageId?: string;
            toolCall?: { arguments?: unknown; id: string; name: string };
        };
        const key = streamKey("tool_call", data.contentIndex);
        const existingId = this.#streamingElementIds.get(key);
        if (data.toolCall !== undefined) {
            const existing = existingId === undefined ? undefined : this.#byId.get(existingId);
            if (existing?.kind === "tool_call" && existing.toolCallId.length === 0) {
                this.#streamingElementIds.delete(key);
                this.#toolCallElementIds.set(data.toolCall.id, existing.id);
                this.#replace(existing.id, {
                    ...existing,
                    arguments: data.toolCall.arguments,
                    argumentsComplete: true,
                    name: data.toolCall.name,
                    toolCallId: data.toolCall.id,
                });
                return;
            }
            if (existingId !== undefined) this.#remove(existingId);
            this.#streamingElementIds.delete(key);
            this.#upsertToolCall(
                {
                    arguments: data.toolCall.arguments,
                    id: data.toolCall.id,
                    name: data.toolCall.name,
                    type: "tool_call",
                },
                at,
                this.#turnId ?? "",
            );
            return;
        }
        if (existingId !== undefined) return;
        const id = `${data.messageId ?? this.#streamingMessageId ?? "stream"}:tool:${data.contentIndex}`;
        const actualId = this.#appendGroupContent({
            arguments: undefined,
            argumentsComplete: false,
            createdAt: at,
            id,
            kind: "tool_call",
            name: "",
            status: "pending",
            toolCallId: "",
            ...this.#elementIdentity(this.#turnId ?? ""),
        });
        this.#streamingElementIds.set(key, actualId);
    }

    /** Adds a tool call, or fills in the one already shown for the same call. */
    #upsertToolCall(block: ToolCallBlock, at: number, turnId: string): string {
        const existingId = this.#toolCallElementIds.get(block.id);
        if (existingId !== undefined) {
            if (block.presentation !== undefined) {
                this.#callPresentations.set(existingId, block.presentation);
            }
            this.#update(existingId, {
                argumentsComplete: true,
                arguments: block.arguments,
                name: block.name,
                ...presentationOf(projectToolPresentation(block.presentation, undefined)),
            });
            return existingId;
        }
        const id = `tool:${block.id}`;
        if (block.presentation !== undefined) this.#callPresentations.set(id, block.presentation);
        const element: ToolCallElement = {
            argumentsComplete: true,
            arguments: block.arguments,
            createdAt: at,
            id,
            kind: "tool_call",
            name: block.name,
            status: "pending",
            toolCallId: block.id,
            ...this.#elementIdentity(turnId),
            ...(this.#permissionReviewsByToolCallId.get(block.id) === undefined
                ? {}
                : {
                      permissionReview: {
                          ...(this.#permissionReviewsByToolCallId.get(
                              block.id,
                          ) as PermissionReviewState),
                          status: "completed",
                      } satisfies ToolPermissionReviewState,
                  }),
            ...presentationOf(projectToolPresentation(block.presentation, undefined)),
        };
        const actualId = this.#appendGroupContent(element);
        this.#toolCallElementIds.set(block.id, actualId);
        if (actualId !== id && block.presentation !== undefined) {
            this.#callPresentations.delete(id);
            this.#callPresentations.set(actualId, block.presentation);
        }
        return actualId;
    }

    #applyToolResult(block: ToolResultBlock): void {
        const elementId =
            this.#toolCallElementIds.get(block.toolCallId) ?? `tool:${block.toolCallId}`;
        if (this.#byId.get(elementId) === undefined) return;
        this.#toolCallElementIds.delete(block.toolCallId);
        this.#update(elementId, {
            argumentsComplete: true,
            result: block.display,
            status: toolStatus(block),
            ...this.#presentationUpdate(elementId, block.presentation),
        });
    }

    /**
     * Projects a finished call, pairing the result with the call it belongs to.
     *
     * The raw call presentation is released here: once the result is known the
     * pair has been projected and keeping the earlier half would retain one
     * entry per tool call for the life of the session.
     */
    #presentationUpdate(
        elementId: string,
        result: ToolResultPresentation | undefined,
    ): { presentation?: ToolPresentation } {
        const call = this.#callPresentations.get(elementId);
        this.#callPresentations.delete(elementId);
        return presentationOf(projectToolPresentation(call, result));
    }

    #findStreamed(kind: "agent_text" | "thinking", index: number): ChatElement | undefined {
        const id = this.#streamingElementIds.get(streamKey(kind, index));
        return id === undefined ? undefined : this.#byId.get(id);
    }

    #openStreamedElement(
        kind: "agent_text" | "thinking",
        index: number,
        text: string,
        messageId: string,
    ): void {
        const id = `${messageId}:${kind}:${index}`;
        if (this.#byId.has(id)) {
            this.#update(id, { text });
            this.#streamingElementIds.set(streamKey(kind, index), id);
            return;
        }
        const actualId = this.#appendGroupContent({
            complete: false,
            createdAt: this.#session.activity.since,
            id,
            kind,
            text,
            ...this.#elementIdentity(this.#turnId ?? ""),
        } as AgentTextElement | ThinkingElement);
        this.#streamingElementIds.set(streamKey(kind, index), actualId);
    }

    #append(element: ChatElement): void {
        if (this.#byId.has(element.id)) {
            this.#update(element.id, element as Partial<ChatElement>);
            return;
        }
        const kept = this.#priorElements?.get(element.id);
        if (kept !== undefined && isSameElement(kept, element)) {
            // A rebuild reproduces rows the list already had. Handing back the
            // object a consumer is already holding keeps a reader's scroll
            // anchor and spares React the re-render.
            element = kept;
        }
        this.#byId.set(element.id, element);
        this.#chronologicalElementIds.push(element.id);
        this.#indexById.set(element.id, this.#elements.length);
        this.#elements = [...this.#elements, element];
        this.#revision += 1;
        this.#presentPendingSteeringAtTail();
        // Only a tool call can change how calls are grouped.
        if (element.kind === "tool_call") this.#groupingDirty = true;
    }

    /**
     * Makes the first real output occupy the row inference created up front.
     *
     * Its shape may change from `inference` to text, thinking, or tool call, but
     * its stable element id and list position do not.
     */
    #appendGroupContent(element: ChatElement): string {
        const placeholderId = this.#groupPlaceholderId;
        const placeholder = placeholderId === undefined ? undefined : this.#byId.get(placeholderId);
        if (placeholder?.kind !== "inference") {
            this.#append(element);
            return element.id;
        }
        const replacement = {
            ...element,
            createdAt: placeholder.createdAt,
            groupId: placeholder.groupId,
            id: placeholder.id,
            runId: placeholder.runId,
        } as ChatElement;
        this.#replace(placeholder.id, replacement);
        this.#groupPlaceholderId = undefined;
        return placeholder.id;
    }

    /** Replaces one row exactly, including a change of discriminated-union kind. */
    #replace(id: string, replacement: ChatElement): void {
        const existing = this.#byId.get(id);
        const index = this.#indexById.get(id);
        if (existing === undefined || index === undefined) return;
        const kept = this.#priorElements?.get(id);
        if (kept !== undefined && isSameElement(kept, replacement)) replacement = kept;
        this.#byId.set(id, replacement);
        const next = this.#elements.slice();
        next[index] = replacement;
        this.#elements = next;
        this.#revision += 1;
        if (existing.kind === "tool_call" || replacement.kind === "tool_call") {
            this.#groupingDirty = true;
        }
    }

    /**
     * Replaces one element with an updated copy.
     *
     * Only that element gets a new reference; every other element in the new
     * array is the same object the consumer already rendered. The position is
     * looked up rather than searched, so the cost of a streaming delta does not
     * grow with the length of the conversation.
     */
    #update(id: string, changes: Partial<ChatElement>): void {
        const existing = this.#byId.get(id);
        if (existing === undefined) return;
        let updated = { ...existing, ...changes } as ChatElement;
        if (isUnchanged(existing, updated)) return;
        const kept = this.#priorElements?.get(id);
        if (kept !== undefined && isSameElement(kept, updated)) updated = kept;
        const index = this.#indexById.get(id);
        if (index === undefined) return;
        this.#byId.set(id, updated);
        const next = this.#elements.slice();
        next[index] = updated;
        this.#elements = next;
        this.#revision += 1;
        if (updated.kind === "tool_call" && updated.groupId !== existing.groupId) {
            this.#groupingDirty = true;
        }
    }

    #clearPermissionReview(id: string): void {
        const existing = this.#byId.get(id);
        if (existing?.kind !== "tool_call" || existing.permissionReview === undefined) return;
        const { permissionReview: _permissionReview, ...updated } = existing;
        this.#replace(id, updated);
    }

    #remove(id: string): void {
        if (!this.#byId.has(id)) return;
        const removed = this.#byId.get(id);
        this.#byId.delete(id);
        this.#indexById.delete(id);
        this.#chronologicalElementIds = this.#chronologicalElementIds.filter(
            (elementId) => elementId !== id,
        );
        this.#elements = this.#elements.filter((element) => element.id !== id);
        this.#reindex();
        this.#revision += 1;
        if (removed?.kind === "tool_call") this.#groupingDirty = true;
    }

    /**
     * Presents queued steering as ordinary bubbles pinned after all live work.
     *
     * `#chronologicalElementIds` never changes when a bubble is pinned, so
     * accepting it can restore the authoritative event position using the same
     * element object and id.
     */
    #presentPendingSteeringAtTail(): void {
        const pendingIds = this.#session.pendingSteeringMessages
            .map((pending) => `message:${pending.message.id}`)
            .filter((id) => this.#byId.get(id)?.kind === "user_message");
        if (pendingIds.length === 0 && !this.#hasPinnedSteering) return;
        this.#hasPinnedSteering = pendingIds.length > 0;
        const pending = new Set(pendingIds);
        const orderedIds = [
            ...this.#chronologicalElementIds.filter((id) => this.#byId.has(id) && !pending.has(id)),
            ...pendingIds,
        ];
        if (
            orderedIds.length === this.#elements.length &&
            orderedIds.every((id, index) => this.#elements[index]?.id === id)
        ) {
            return;
        }
        this.#elements = orderedIds.flatMap((id) => {
            const element = this.#byId.get(id);
            return element === undefined ? [] : [element];
        });
        this.#reindex();
        this.#revision += 1;
    }

    /** Places newly applied steering after the group-ending row in event order. */
    #moveElementsToTail(elementIds: readonly string[]): void {
        const moved = elementIds.filter((id) => this.#byId.has(id));
        if (moved.length === 0) return;
        const movedSet = new Set(moved);
        this.#chronologicalElementIds = [
            ...this.#chronologicalElementIds.filter((id) => !movedSet.has(id)),
            ...moved,
        ];
        this.#elements = this.#chronologicalElementIds.flatMap((id) => {
            const element = this.#byId.get(id);
            return element === undefined ? [] : [element];
        });
        this.#reindex();
        this.#revision += 1;
    }

    /** Rebuilds the position index after the list order or length changed. */
    #reindex(): void {
        this.#indexById.clear();
        for (const [index, element] of this.#elements.entries()) {
            this.#indexById.set(element.id, index);
        }
    }

    #elementIdentity(runId: string): { groupId: string; runId: string } {
        return { groupId: this.#groupId ?? `run:${runId}`, runId };
    }

    #ensurePendingNextGroupId(messageId: string): string {
        this.#pendingNextGroupId ??= `group:context:${messageId}`;
        return this.#pendingNextGroupId;
    }

    #rememberPendingNextGroupElement(elementId: string): void {
        if (!this.#pendingNextGroupElementIds.includes(elementId)) {
            this.#pendingNextGroupElementIds.push(elementId);
        }
    }

    #forgetPendingNextGroupElement(elementId: string): void {
        this.#pendingNextGroupElementIds = this.#pendingNextGroupElementIds.filter(
            (pendingElementId) => pendingElementId !== elementId,
        );
        if (this.#pendingNextGroupElementIds.length === 0) {
            this.#pendingNextGroupId = undefined;
        }
    }

    #setGit(git: GitChangeSnapshot): void {
        const current = this.#session.git;
        if (
            current !== undefined &&
            current.generation === git.generation &&
            current.version >= git.version
        ) {
            return;
        }
        const next = applicationGit(git);
        if (current?.revision === next.revision) return;
        this.#session = { ...this.#session, git: next };
    }
}

function streamKey(kind: string, index: number): number {
    // One map holds text, thinking, and tool-call blocks, which are indexed
    // independently by the provider, so the kind has to be part of the key.
    const offset = kind === "agent_text" ? 0 : kind === "thinking" ? 1_000_000 : 2_000_000;
    return offset + index;
}

function compareEventOrder(left: string | undefined, right: string | undefined): number {
    if (left === undefined || right === undefined || left === right) return 0;
    return left < right ? -1 : 1;
}

/** Orders what shares a millisecond: boundary, open, contents, close. */
function timelinePriority(kind: string): number {
    // A compaction closed the group before it and heads the one after, so it
    // stands ahead of that group opening, the way a steering message does.
    if (kind === "compaction") return 0;
    if (kind === "group_start") return 1;
    if (kind === "group_end") return 3;
    if (kind === "end") return 4;
    return 2;
}

function toolStatus(result: {
    failure?: { kind: string };
    isError?: boolean;
}): ToolCallElement["status"] {
    if (result.failure?.kind === "interrupted") return "interrupted";
    return result.isError === true || result.failure !== undefined ? "failed" : "succeeded";
}

function isUnchanged(left: ChatElement, right: ChatElement): boolean {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
        const leftValue = (left as unknown as Record<string, unknown>)[key];
        const rightValue = (right as unknown as Record<string, unknown>)[key];
        if (leftValue !== rightValue) return false;
    }
    return true;
}

function textOf(blocks: readonly ContentBlock[]): string {
    return blocks
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("");
}

function decodeSystemNoticePayload(message: SystemMessage): SystemNoticePayload | undefined {
    const text = textOf(message.blocks).slice(0, SERVICE_NOTICE_TEXT_MAX_LENGTH);
    if (text.length === 0) return undefined;
    try {
        return Value.Decode(systemNoticePayloadSchema, {
            ...(message.structured === undefined ? {} : { structured: message.structured }),
            text,
        });
    } catch {
        try {
            return Value.Decode(systemNoticePayloadSchema, { text });
        } catch {
            return undefined;
        }
    }
}

function isTextBlock(
    block: ContentBlock | AgentBlock,
): block is Extract<ContentBlock, { type: "text" }> {
    return block.type === "text";
}

function isImageBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "image" }> {
    return block.type === "image";
}

function isThinkingBlock(block: AgentBlock): block is Extract<AgentBlock, { type: "thinking" }> {
    return block.type === "thinking";
}

function isToolCallBlock(block: AgentBlock): block is ToolCallBlock {
    return block.type === "tool_call";
}

function isToolResultBlock(block: AgentBlock): block is ToolResultBlock {
    return block.type === "tool_result";
}

/** Sums the cost of two inferences in one turn. */
function addUsage(total: Usage | undefined, next: Usage): Usage {
    if (total === undefined) return next;
    return {
        cacheRead: total.cacheRead + next.cacheRead,
        cacheWrite: total.cacheWrite + next.cacheWrite,
        cost: {
            cacheRead: total.cost.cacheRead + next.cost.cacheRead,
            cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
            input: total.cost.input + next.cost.input,
            output: total.cost.output + next.cost.output,
            total: total.cost.total + next.cost.total,
        },
        input: total.input + next.input,
        output: total.output + next.output,
        totalTokens: total.totalTokens + next.totalTokens,
        ...(total.reasoning === undefined && next.reasoning === undefined
            ? {}
            : { reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) }),
    };
}

function applicationUsage(snapshot: SessionUsageSnapshot): SessionUsage {
    return {
        ...snapshot,
        totalCost: snapshot.groups.reduce((total, group) => total + group.usage.cost.total, 0),
        totalTokens: snapshot.groups.reduce((total, group) => total + group.usage.totalTokens, 0),
    };
}

function historyToken(transcript: SessionTranscriptWindow): string | undefined {
    return transcript.messages[0]?.id;
}

function withoutUsageContext(usage: SessionUsage): SessionUsage {
    const { context: _context, ...withoutContext } = usage;
    return withoutContext;
}

function applicationGit(git: GitChangeSnapshot): GitChangeSnapshot {
    const { facts, ...snapshot } = git;
    const branch = facts?.branch ?? snapshot.branch;
    return {
        ...snapshot,
        ...(branch === undefined ? {} : { branch }),
        revision: `${git.generation}:${String(git.version)}:${String(git.scannedAt)}`,
    };
}

type CompleteWorkflowUpdate = WorkflowRunUpdate &
    Required<
        Pick<
            WorkflowRun,
            | "agentCount"
            | "code"
            | "description"
            | "logs"
            | "name"
            | "startedAt"
            | "status"
            | "taskId"
        >
    >;

function isCompleteWorkflowUpdate(update: WorkflowRunUpdate): update is CompleteWorkflowUpdate {
    return (
        typeof update.agentCount === "number" &&
        typeof update.code === "string" &&
        typeof update.description === "string" &&
        Array.isArray(update.logs) &&
        typeof update.name === "string" &&
        typeof update.startedAt === "number" &&
        typeof update.status === "string" &&
        typeof update.taskId === "string"
    );
}

function workflowFromUpdate(update: CompleteWorkflowUpdate): WorkflowRun {
    const { log, ...workflow } = update;
    return {
        ...workflow,
        logs: log === undefined ? workflow.logs : [...workflow.logs, log],
    };
}

/** Omits the key entirely when there is nothing to present. */
function presentationOf(presentation: ToolPresentation | undefined): {
    presentation?: ToolPresentation;
} {
    return presentation === undefined ? {} : { presentation };
}

/**
 * Copies a session state without the named keys.
 *
 * `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
 * field, so a value that was cleared has to be dropped rather than blanked.
 */
function withoutKeys(session: SessionState, keys: readonly (keyof SessionState)[]): SessionState {
    const next = { ...session };
    for (const key of keys) delete next[key];
    return next;
}

function sameSessionShare(left: SessionState["shared"], right: SessionState["shared"]): boolean {
    return (
        left === right ||
        (left !== undefined &&
            right !== undefined &&
            left.capabilityMemberCount === right.capabilityMemberCount &&
            left.includeFriendMessagesInModel === right.includeFriendMessagesInModel &&
            left.memberCount === right.memberCount &&
            left.shareId === right.shareId &&
            left.state === right.state)
    );
}

/**
 * Whether a rebuilt element says exactly what the one before it said.
 *
 * These are plain value objects built by one code path, so a serialised
 * comparison is both accurate and cheaper than walking them field by field.
 */
function isSameElement(left: ChatElement, right: ChatElement): boolean {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}
