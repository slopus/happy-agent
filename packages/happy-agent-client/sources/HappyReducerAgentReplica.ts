import type { Agent, AgentActivityResponse, AgentDraftSnapshot } from "./protocol/agents.js";
import type { AgentBootstrapResponse } from "./protocol/bootstrap.js";
import type { EventCursor, MessageMode, ResourceVersion } from "./protocol/common.js";
import type { HappyAgentEvent, ResourceUpdate } from "./protocol/events.js";
import type { BackgroundProcess } from "./protocol/processes.js";
import type { AgentContextUsage } from "./protocol/usage.js";
import type { HappyReducerAgentModel, HappyReducerAgentState } from "./HappyReducerState.js";

export interface HappyReducerAgentReplica {
    readonly agent: Agent;
    readonly fieldCursors: HappyReducerAgentFieldCursors;
    readonly state: HappyReducerAgentState;
}

interface HappyReducerAgentFieldCursors {
    readonly context: EventCursor;
    readonly draft: EventCursor;
    readonly lastUsedModel: EventCursor;
    readonly processes: EventCursor;
    readonly subagents: EventCursor;
}

export interface HappyReducerAgentEventResult {
    readonly dirty: boolean;
    readonly replica: HappyReducerAgentReplica;
}

interface HappyReducerAgentActivityCursors {
    readonly processes: EventCursor;
    readonly subagents: EventCursor;
}

/** Builds an authoritative snapshot while preserving unchanged public child references. */
export function createHappyReducerAgentReplica(
    bootstrap: AgentBootstrapResponse,
    activity: AgentActivityResponse,
    activityCursors: HappyReducerAgentActivityCursors,
    previous: HappyReducerAgentReplica | undefined,
): HappyReducerAgentReplica {
    const previousState = previous?.state;
    const previousFieldCursors = previous?.fieldCursors;
    const keepPreviousDraft = isNewer(previousFieldCursors?.draft, bootstrap.cursor);
    const draft =
        previousState !== undefined &&
        (keepPreviousDraft || draftsEqual(previousState.draft, bootstrap.draft))
            ? previousState.draft
            : bootstrap.draft;
    const model = modelFromMode(bootstrap.mode);
    const keepPreviousLastUsedModel = isNewer(
        previousFieldCursors?.lastUsedModel,
        bootstrap.cursor,
    );
    const lastUsedModel =
        previousState !== undefined &&
        (keepPreviousLastUsedModel || modelsEqual(previousState.lastUsedModel, model))
            ? previousState.lastUsedModel
            : model;
    const keepPreviousContext = isNewer(previousFieldCursors?.context, bootstrap.cursor);
    const context =
        previousState !== undefined &&
        (keepPreviousContext || contextsEqual(previousState.context, bootstrap.context))
            ? previousState.context
            : bootstrap.context;
    const keepPreviousProcesses = isNewer(
        previousFieldCursors?.processes,
        activityCursors.processes,
    );
    const processes = keepPreviousProcesses
        ? (previousState?.processes ?? activity.processes)
        : reconcileVersionedList(previousState?.processes, activity.processes);
    const keepPreviousSubagents = isNewer(
        previousFieldCursors?.subagents,
        activityCursors.subagents,
    );
    const subagents = keepPreviousSubagents
        ? (previousState?.subagents ?? activity.subagents)
        : reconcileVersionedList(previousState?.subagents, activity.subagents);
    const state =
        previousState !== undefined &&
        previousState.draft === draft &&
        previousState.lastUsedModel === lastUsedModel &&
        previousState.context === context &&
        previousState.processes === processes &&
        previousState.subagents === subagents
            ? previousState
            : { context, draft, lastUsedModel, processes, subagents };
    const rootAgent =
        previous !== undefined && previous.agent.version >= bootstrap.agent.version
            ? previous.agent
            : bootstrap.agent;
    const nextFieldCursors: HappyReducerAgentFieldCursors = {
        context: keepPreviousContext ? previousFieldCursors.context : bootstrap.cursor,
        draft: keepPreviousDraft ? previousFieldCursors.draft : bootstrap.cursor,
        lastUsedModel: keepPreviousLastUsedModel
            ? previousFieldCursors.lastUsedModel
            : bootstrap.cursor,
        processes: keepPreviousProcesses
            ? previousFieldCursors.processes
            : activityCursors.processes,
        subagents: keepPreviousSubagents
            ? previousFieldCursors.subagents
            : activityCursors.subagents,
    };
    const fieldCursors = fieldCursorsEqual(previousFieldCursors, nextFieldCursors)
        ? previousFieldCursors
        : nextFieldCursors;
    if (
        previous?.agent === rootAgent &&
        previous.fieldCursors === fieldCursors &&
        previous.state === state
    ) {
        return previous;
    }
    return { agent: rootAgent, fieldCursors, state };
}

/** Applies one SSE event to one agent replica, or marks it dirty on a broken version chain. */
export function reduceHappyReducerAgentEvent(
    current: HappyReducerAgentReplica,
    event: HappyAgentEvent,
): HappyReducerAgentEventResult {
    let agent = current.agent;
    let fieldCursors = current.fieldCursors;
    let state = current.state;
    let dirty = false;

    if (event.type === "agent.created") {
        if (event.payload.agent.id === agent.id && event.payload.agent.version > agent.version) {
            agent = event.payload.agent;
        }
        if (
            event.payload.agent.parentAgentId === agent.id &&
            event.cursor > fieldCursors.subagents
        ) {
            state = withSubagents(state, upsertNewest(state.subagents, event.payload.agent));
            fieldCursors = withFieldCursor(fieldCursors, "subagents", event.cursor);
        }
    } else if (event.type === "agent.updated") {
        if (event.payload.agentId === agent.id) {
            const result = applyResourceUpdate(agent, event.payload);
            agent = result.value;
            dirty ||= result.dirty;
        }
        const subagentIndex = state.subagents.findIndex(
            (subagent) => subagent.id === event.payload.agentId,
        );
        if (subagentIndex >= 0 && event.cursor > fieldCursors.subagents) {
            const subagent = state.subagents[subagentIndex];
            if (subagent !== undefined) {
                const result = applyResourceUpdate(subagent, event.payload);
                dirty ||= result.dirty;
                if (result.value !== subagent) {
                    state = withSubagents(
                        state,
                        replaceAt(state.subagents, subagentIndex, result.value),
                    );
                }
                if (!result.dirty) {
                    fieldCursors = withFieldCursor(fieldCursors, "subagents", event.cursor);
                }
            }
        }
    } else if (
        event.type === "agent.context.updated" &&
        event.payload.agentId === agent.id &&
        event.cursor > fieldCursors.context
    ) {
        state = withContext(state, event.payload.context);
        fieldCursors = withFieldCursor(fieldCursors, "context", event.cursor);
    } else if (
        event.type === "agent.draft.updated" &&
        event.payload.agentId === agent.id &&
        event.cursor > fieldCursors.draft
    ) {
        state = withDraft(state, event.payload.draft);
        fieldCursors = withFieldCursor(fieldCursors, "draft", event.cursor);
    } else if (
        event.type === "message.created" &&
        event.payload.agentId === agent.id &&
        event.payload.message.role === "user" &&
        event.cursor > fieldCursors.lastUsedModel
    ) {
        state = withLastUsedModel(state, modelFromMode(event.payload.message.mode));
        fieldCursors = withFieldCursor(fieldCursors, "lastUsedModel", event.cursor);
    } else if (
        event.type === "process.started" &&
        event.payload.process.agentId === agent.id &&
        event.cursor > fieldCursors.processes
    ) {
        state = withProcesses(state, upsertNewest(state.processes, event.payload.process));
        fieldCursors = withFieldCursor(fieldCursors, "processes", event.cursor);
    } else if (event.type === "process.updated" || event.type === "process.exited") {
        const processIndex = state.processes.findIndex(
            (process) => process.id === event.payload.processId,
        );
        if (processIndex >= 0 && event.cursor > fieldCursors.processes) {
            const process = state.processes[processIndex];
            if (process !== undefined) {
                const result = applyResourceUpdate(process, event.payload);
                dirty ||= result.dirty;
                if (result.value !== process) {
                    state = withProcesses(
                        state,
                        replaceAt(state.processes, processIndex, result.value),
                    );
                }
                if (!result.dirty) {
                    fieldCursors = withFieldCursor(fieldCursors, "processes", event.cursor);
                }
            }
        }
    }

    return {
        dirty,
        replica:
            agent === current.agent &&
            fieldCursors === current.fieldCursors &&
            state === current.state
                ? current
                : { agent, fieldCursors, state },
    };
}

function isNewer(cursor: EventCursor | undefined, baseline: EventCursor): cursor is EventCursor {
    return cursor !== undefined && cursor > baseline;
}

function fieldCursorsEqual(
    left: HappyReducerAgentFieldCursors | undefined,
    right: HappyReducerAgentFieldCursors,
): left is HappyReducerAgentFieldCursors {
    return (
        left !== undefined &&
        left.context === right.context &&
        left.draft === right.draft &&
        left.lastUsedModel === right.lastUsedModel &&
        left.processes === right.processes &&
        left.subagents === right.subagents
    );
}

function withFieldCursor<TKey extends keyof HappyReducerAgentFieldCursors>(
    cursors: HappyReducerAgentFieldCursors,
    field: TKey,
    cursor: EventCursor,
): HappyReducerAgentFieldCursors {
    if (cursors[field] === cursor) return cursors;
    return { ...cursors, [field]: cursor };
}

function applyResourceUpdate<TResource extends { readonly version: ResourceVersion }>(
    current: TResource,
    update: ResourceUpdate<TResource>,
): { readonly dirty: boolean; readonly value: TResource } {
    if (current.version >= update.version) return { dirty: false, value: current };
    if (current.version !== update.previousVersion) return { dirty: true, value: current };
    return {
        dirty: false,
        value: { ...current, ...update.changes, version: update.version },
    };
}

function reconcileVersionedList<
    TResource extends { readonly id: string; readonly version: string },
>(
    previous: readonly TResource[] | undefined,
    incoming: readonly TResource[],
): readonly TResource[] {
    if (previous === undefined) return incoming;
    const previousById = new Map(previous.map((resource) => [resource.id, resource]));
    let changed = previous.length !== incoming.length;
    const reconciled = incoming.map((resource, index) => {
        const existing = previousById.get(resource.id);
        const selected =
            existing !== undefined && existing.version >= resource.version ? existing : resource;
        if (selected !== previous[index]) changed = true;
        return selected;
    });
    return changed ? reconciled : previous;
}

function upsertNewest<TResource extends { readonly id: string; readonly version: string }>(
    resources: readonly TResource[],
    incoming: TResource,
): readonly TResource[] {
    const index = resources.findIndex((resource) => resource.id === incoming.id);
    if (index < 0) return [incoming, ...resources];
    const current = resources[index];
    if (current === undefined || current.version >= incoming.version) return resources;
    return replaceAt(resources, index, incoming);
}

function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
    const next = values.slice();
    next[index] = value;
    return next;
}

function withContext(
    state: HappyReducerAgentState,
    context: AgentContextUsage | null,
): HappyReducerAgentState {
    if (contextsEqual(state.context, context)) return state;
    return { ...state, context };
}

function withDraft(
    state: HappyReducerAgentState,
    draft: AgentDraftSnapshot,
): HappyReducerAgentState {
    if (draftsEqual(state.draft, draft)) return state;
    return { ...state, draft };
}

function withLastUsedModel(
    state: HappyReducerAgentState,
    lastUsedModel: HappyReducerAgentModel | null,
): HappyReducerAgentState {
    if (modelsEqual(state.lastUsedModel, lastUsedModel)) return state;
    return { ...state, lastUsedModel };
}

function withProcesses(
    state: HappyReducerAgentState,
    processes: readonly BackgroundProcess[],
): HappyReducerAgentState {
    if (state.processes === processes) return state;
    return { ...state, processes };
}

function withSubagents(
    state: HappyReducerAgentState,
    subagents: readonly Agent[],
): HappyReducerAgentState {
    if (state.subagents === subagents) return state;
    return { ...state, subagents };
}

function modelFromMode(mode: MessageMode | null): HappyReducerAgentModel | null {
    return mode === null ? null : { modelId: mode.modelId, providerId: mode.providerId };
}

function modelsEqual(
    left: HappyReducerAgentModel | null,
    right: HappyReducerAgentModel | null,
): boolean {
    return (
        left === right ||
        (left !== null &&
            right !== null &&
            left.modelId === right.modelId &&
            left.providerId === right.providerId)
    );
}

function contextsEqual(left: AgentContextUsage | null, right: AgentContextUsage | null): boolean {
    return (
        left === right ||
        (left !== null &&
            right !== null &&
            left.approximate === right.approximate &&
            left.contextTokens === right.contextTokens &&
            left.contextWindow === right.contextWindow &&
            left.modelId === right.modelId &&
            left.providerId === right.providerId)
    );
}

function draftsEqual(left: AgentDraftSnapshot, right: AgentDraftSnapshot): boolean {
    if (left === right) return true;
    if (left.updatedAt !== right.updatedAt) return false;
    if (left.value === right.value) return true;
    if (left.value === null || right.value === null) return false;
    return (
        left.value.text === right.value.text &&
        left.value.effort === right.value.effort &&
        left.value.modelId === right.value.modelId &&
        left.value.permissionMode === right.value.permissionMode &&
        left.value.providerId === right.value.providerId &&
        left.value.serviceTier === right.value.serviceTier
    );
}
