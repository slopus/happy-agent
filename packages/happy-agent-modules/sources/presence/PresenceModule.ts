import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";

import { BUILT_IN_PRESENCES, ONLINE_PRESENCE_ID, isBuiltInPresenceId } from "./PresenceCatalog.js";
import { MAX_PRESENCE_DEFINITIONS, readConfiguredPresence } from "./PresenceConfiguration.js";
import { createPresenceDatabase, presenceMigrations } from "./PresenceDatabase.js";
import {
    assertPresenceEventListener,
    presenceEventSchema,
    type PresenceEvent,
    type PresenceEventListener,
    type PresenceUnsubscribe,
} from "./PresenceEvent.js";
import {
    assertPresenceSchedule,
    assertPresenceScheduleInput,
    presenceScheduleSchema,
    type PresenceSchedule,
    type PresenceScheduleInput,
} from "./PresenceSchedule.js";
import {
    assertPresenceDefinition,
    assertPresenceMutationInput,
    assertPresenceState,
    assertPresenceStoredState,
    assertPresenceToolInput,
    assertPresenceUserInputState,
    assertTemporaryPresenceInput,
    presenceReferenceSchema,
    presenceToolInputSchema,
    type PresenceDefinition,
    type PresenceMutationInput,
    type PresenceState,
    type PresenceStoredState,
    type PresenceToolInput,
    type PresenceUserInputState,
    type TemporaryPresenceInput,
} from "./PresenceState.js";
import {
    presenceUserInputChangeCallbackSchema,
    type PresenceUserInputChangeCallback,
} from "./PresenceUserInput.js";
import {
    assertPresenceDefinitionResult,
    assertPresenceScheduleResult,
    assertPresenceStateResult,
    type PresenceReader,
    type PresenceScheduleStore,
    type PresenceStore,
} from "./PresenceStore.js";
import { getPresenceTool } from "./tools/get_presence.js";
import { listPresenceTool } from "./tools/list_presence.js";
import { setPresenceTool } from "./tools/set_presence.js";

/** The most recurring windows one installation may keep. */
export const MAX_PRESENCE_SCHEDULES = 64;

const scheduleIdSchema = Type.String({ minLength: 1, maxLength: 128 });

type PresenceChange<Result> = {
    readonly result: Result;
    readonly event?: PresenceEvent;
};

/**
 * One shared presence capability for every agent.
 *
 * The catalog of states, and the state this installation starts in, come from the person's own
 * settings, so this module takes the configuration and reads them itself. Agent Base owns durable
 * tool settlement; presence owns only its domain state, validation, transactions, and event
 * semantics, and keeps no operation identities or replay ledger.
 */
export class PresenceModule implements AgentModule, PresenceReader {
    readonly name = "presence";
    readonly migrations = presenceMigrations;
    readonly #store: PresenceStore;
    readonly #configuredCatalog: readonly PresenceDefinition[];
    readonly #initialState: PresenceStoredState | undefined;
    readonly #transactionalListeners = new Set<PresenceEventListener>();
    readonly #listeners = new Set<PresenceEventListener>();
    readonly #userInputSubscribers = new Set<PresenceUserInputChangeCallback>();

    constructor(config: ConfigModule) {
        const configured = readConfiguredPresence(config.configuration.values.presence);
        this.#store = createPresenceDatabase();
        this.#configuredCatalog = cloneCatalog(configured.catalog);
        this.#initialState =
            configured.initialState === undefined ? undefined : cloneValue(configured.initialState);
    }

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks> => {
        const initialState = this.#initialState;
        if (initialState === undefined) return this.#hooks;
        await ctx.inTx(async (txCtx) => {
            const existing = await this.#readConfigured(txCtx);
            if (existing === undefined) {
                const catalog = await this.#readCatalog(txCtx);
                const normalized =
                    initialState.expiresAt === undefined ||
                    initialState.fallbackPresenceId !== undefined
                        ? initialState
                        : {
                              ...initialState,
                              fallbackPresenceId: ONLINE_PRESENCE_ID,
                          };
                assertCatalogSelection(normalized, catalog);
                await this.#store.set(txCtx, cloneValue(normalized));
            }
        });
        return this.#hooks;
    };

    /** Watch every committed presence change; call the returned function to stop watching. */
    onEvent(listener: PresenceEventListener): PresenceUnsubscribe {
        assertPresenceEventListener(listener);
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Watch presence changes from inside the transaction that makes them, so a caller can write
     * its own record in the same commit. A listener that throws rolls the change back.
     */
    onEventTransactional(listener: PresenceEventListener): PresenceUnsubscribe {
        assertPresenceEventListener(listener);
        this.#transactionalListeners.add(listener);
        return () => {
            this.#transactionalListeners.delete(listener);
        };
    }

    /** Read the effective presence at this moment. */
    async read(ctx: Context): Promise<PresenceState | undefined> {
        const value = await this.#store.read(ctx, now());
        if (value === undefined) return undefined;
        assertPresenceStoredState(value);
        const catalog = await this.#readCatalog(ctx);
        const state = materializeStoredState(value, catalog);
        assertPresenceState(state);
        return cloneValue(state);
    }

    /** Alias that reads the same effective state, useful to callers outside an agent. */
    async state(ctx: Context): Promise<PresenceState | undefined> {
        return await this.read(ctx);
    }

    /**
     * The narrow, display-ready projection user input waits on. It intentionally excludes the
     * catalog and the person's own status message.
     */
    async userInputState(ctx: Context): Promise<PresenceUserInputState | undefined> {
        const current = await this.read(ctx);
        if (current === undefined) return undefined;
        return cloneValue(toUserInputState(current));
    }

    /**
     * Watch the effective state for as long as something is waiting on an answer. The callback is
     * given the current state immediately, and again after every committed change; the returned
     * function stops the subscription. This set is only ephemeral observation state — durable
     * presence stays in the module database.
     */
    async subscribeUserInput(
        ctx: Context,
        callback: PresenceUserInputChangeCallback,
    ): Promise<PresenceUnsubscribe> {
        if (!Value.Check(presenceUserInputChangeCallbackSchema, callback)) {
            throw new Error("Presence user-input callback is invalid.");
        }
        this.#userInputSubscribers.add(callback);
        try {
            await invokeVoid(
                callback(ctx, cloneValue(await this.userInputState(ctx))),
                "Presence user-input callback",
            );
        } catch (error: unknown) {
            this.#userInputSubscribers.delete(callback);
            throw error;
        }
        return () => {
            this.#userInputSubscribers.delete(callback);
        };
    }

    async setPresence(
        ctx: Context,
        input: PresenceMutationInput | PresenceToolInput,
    ): Promise<PresenceState> {
        const requested = normalizeMutationInput(input, now());
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const catalog = await this.#readCatalog(txCtx);
            assertCatalogSelection(requested, catalog);
            const previous = await this.#readConfigured(txCtx);
            if (previous !== undefined && sameStoredState(previous, requested)) {
                return {
                    result: materializeStoredState(requested, catalog),
                };
            }

            await this.#store.set(txCtx, cloneValue(requested));
            return {
                result: materializeStoredState(requested, catalog),
                event: {
                    type: "presence_changed",
                    eventId,
                    at,
                    previous:
                        previous === undefined ? null : materializeStoredState(previous, catalog),
                    current: materializeStoredState(requested, catalog),
                },
            };
        });
        assertPresenceStateResult(result);
        return cloneValue(result);
    }

    /** Remove the configured presence, returning false when there was nothing to clear. */
    async clear(ctx: Context): Promise<boolean> {
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const catalog = await this.#readCatalog(txCtx);
            const previous = await this.#readConfigured(txCtx);
            if (previous === undefined) return { result: false };

            await this.#store.clear(txCtx);
            return {
                result: true,
                event: {
                    type: "presence_cleared",
                    eventId,
                    at,
                    previous: materializeStoredState(previous, catalog),
                },
            };
        });
        return result;
    }

    /** Set a temporary value; expiration and fallback are interpreted by the database. */
    async setTemporary(ctx: Context, input: TemporaryPresenceInput): Promise<PresenceState> {
        assertTemporaryPresenceInput(input);
        return await this.setPresence(ctx, {
            ...input,
            effectiveFrom: input.effectiveFrom ?? now(),
        });
    }

    /** List the built-in and configured custom presence definitions in a bounded catalog. */
    async listPresences(ctx: Context): Promise<readonly PresenceDefinition[]> {
        return cloneCatalog(await this.#readCatalog(ctx));
    }

    /** Persist one custom definition so it is available after a fresh module instance. */
    async setPresenceDefinition(
        ctx: Context,
        definition: PresenceDefinition,
    ): Promise<PresenceDefinition> {
        assertPresenceDefinition(definition);
        if (isBuiltInPresenceId(definition.id)) {
            throw new Error("Built-in presence definitions cannot be replaced.");
        }
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const catalog = await this.#readCatalog(txCtx);
            const existing = catalog.find((candidate) => candidate.id === definition.id);
            if (existing !== undefined && sameDefinition(existing, definition)) {
                return { result: cloneValue(existing) };
            }
            if (existing === undefined && catalog.length >= MAX_PRESENCE_DEFINITIONS) {
                throw new Error("Presence catalog limit reached.");
            }
            const stored = await this.#store.catalog.set(txCtx, cloneValue(definition));
            assertPresenceDefinitionResult(stored);
            if (!sameDefinition(stored, definition)) {
                throw new Error("Presence database returned a different definition.");
            }
            return {
                result: cloneValue(stored),
                event: {
                    type: "presence_definition_set",
                    eventId,
                    at,
                    definition: cloneValue(stored),
                },
            };
        });
        assertPresenceDefinitionResult(result);
        return cloneValue(result);
    }

    /** Remove one persisted custom definition; configured and built-in definitions are fixed. */
    async clearPresenceDefinition(ctx: Context, presenceId: string): Promise<boolean> {
        if (!Value.Check(scheduleIdSchema, presenceId)) {
            throw new Error("Presence ID is invalid.");
        }
        if (
            isBuiltInPresenceId(presenceId) ||
            this.#configuredCatalog.some((candidate) => candidate.id === presenceId)
        ) {
            throw new Error("Configured presence definitions cannot be cleared.");
        }
        return await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const current = await this.#readConfigured(txCtx);
            if (current?.presenceId === presenceId) {
                throw new Error("The active presence definition cannot be cleared.");
            }
            if (current?.fallbackPresenceId === presenceId) {
                throw new Error(
                    "This presence is the fallback of the current presence and cannot be cleared.",
                );
            }
            const schedules = await this.#readSchedules(txCtx, this.#scheduleStore());
            if (schedules.some((candidate) => referenceId(candidate.presence) === presenceId)) {
                throw new Error("This presence is used by a schedule and cannot be cleared.");
            }
            const removed = await this.#store.catalog.clear(txCtx, presenceId);
            return {
                result: removed,
                ...(removed
                    ? {
                          event: {
                              type: "presence_definition_cleared" as const,
                              eventId,
                              at,
                              presenceId,
                          },
                      }
                    : {}),
            };
        });
    }

    async listSchedules(ctx: Context): Promise<readonly PresenceSchedule[]> {
        return await this.#readSchedules(ctx, this.#scheduleStore());
    }

    async setSchedule(ctx: Context, input: PresenceScheduleInput): Promise<PresenceSchedule> {
        assertPresenceScheduleInput(input);
        assertKnownTimeZone(input.timeZone);
        const scheduleStore = this.#scheduleStore();
        const requested = normalizeScheduleInput(input);
        const result = await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const catalog = await this.#readCatalog(txCtx);
            assertCatalogReference(requested.presence, catalog);
            const existing = await this.#readSchedules(txCtx, scheduleStore);
            const duplicate = existing.find((candidate) => sameSchedule(candidate, requested));
            if (duplicate !== undefined) {
                return { result: cloneValue(duplicate) };
            }
            if (existing.length >= MAX_PRESENCE_SCHEDULES) {
                throw new Error("Presence schedule limit reached.");
            }

            const stored = await scheduleStore.set(
                txCtx,
                cloneValue(requested),
                globalThis.crypto.randomUUID(),
            );
            assertPresenceScheduleResult(stored);
            assertCanonicalSchedule(stored);
            if (!sameSchedule(stored, requested)) {
                throw new Error("Presence database returned a different schedule.");
            }
            if (existing.some((candidate) => candidate.id === stored.id)) {
                throw new Error("Presence database returned a colliding schedule ID.");
            }
            return {
                result: cloneValue(stored),
                event: {
                    type: "presence_schedule_set",
                    eventId,
                    at,
                    schedule: cloneValue(stored),
                },
            };
        });
        assertPresenceScheduleResult(result);
        return cloneValue(result);
    }

    async clearSchedule(ctx: Context, scheduleId: string): Promise<boolean> {
        if (!Value.Check(scheduleIdSchema, scheduleId)) {
            throw new Error("Presence schedule ID is invalid.");
        }
        const scheduleStore = this.#scheduleStore();
        return await this.#mutate(ctx, async (txCtx, eventId, at) => {
            const removed = await scheduleStore.clear(txCtx, scheduleId);
            return {
                result: removed,
                ...(removed
                    ? {
                          event: {
                              type: "presence_schedule_cleared" as const,
                              eventId,
                              at,
                              scheduleId,
                          },
                      }
                    : {}),
            };
        });
    }

    readonly #hooks: AgentModuleHooks = {
        /**
         * Tell the model the person's presence, and again whenever it changes, as a notice in the
         * conversation.
         *
         * Presence changes while agents work: the person sets it, a temporary state expires, a
         * schedule starts. In the system prompt each change rewrote the prefix of everything
         * already sent, which Claude models with preserved thinking reject and which cost every
         * model its prompt cache. A notice is appended instead.
         *
         * The history remembers the guidance it was last told, so the same state is said once.
         * Both boundaries are checked: a change during work reaches the very next request, and a
         * compacted history, whose store is empty again, is told afresh.
         */
        systemNotificationsTransact: async (ctx: Context, scope: AgentModuleScope) => {
            const current = await this.read(ctx);
            const guidance = current === undefined ? "" : formatPresenceInstruction(current);
            const told = await scope.historyKV.read(ctx, PRESENCE_TOLD_KEY);
            if (told === guidance) return;
            // A history that heard of no presence needs no word that there is none.
            if (told === undefined && guidance === "") return;
            await scope.historyKV.write(ctx, PRESENCE_TOLD_KEY, guidance);
            return [
                {
                    role: "system",
                    content: [{ type: "text", text: guidance === "" ? PRESENCE_UNSET : guidance }],
                },
            ];
        },

        tools: (_ctx: Context, _scope: AgentModuleScope): readonly AnyAgentTool[] => [
            getPresenceTool(this),
            listPresenceTool(this),
            setPresenceTool(this),
        ],
    };

    async #mutate<Result>(
        ctx: Context,
        decide: (txCtx: Context, eventId: string, at: number) => Promise<PresenceChange<Result>>,
    ): Promise<Result> {
        const eventId = globalThis.crypto.randomUUID();
        const at = now();
        return await ctx.inTx(async (txCtx) => {
            const decided = await decide(txCtx, eventId, at);
            const event =
                decided.event === undefined ? undefined : cloneAndFreezeEvent(decided.event);
            if (event !== undefined) {
                const userInputState = await this.#readUserInputState(txCtx, at);
                for (const listener of this.#transactionalListeners) {
                    await invokeVoid(listener(txCtx, event), "Presence transactional listener");
                }
                afterCommit(txCtx, (postCommitCtx) =>
                    this.#notifyPostCommit(postCommitCtx, event, userInputState),
                );
            }
            return cloneValue(decided.result);
        });
    }

    async #readConfigured(ctx: Context): Promise<PresenceStoredState | undefined> {
        const previous = await this.#store.readConfigured(ctx);
        if (previous !== undefined) assertPresenceStoredState(previous);
        return previous === undefined ? undefined : cloneValue(previous);
    }

    async #readCatalog(ctx: Context): Promise<readonly PresenceDefinition[]> {
        const stored = await this.#store.catalog.list(ctx, {
            limit: MAX_PRESENCE_DEFINITIONS + 1,
        });
        if (stored.length > MAX_PRESENCE_DEFINITIONS) {
            throw new Error("Presence database returned more definitions than requested.");
        }
        const byId = new Map<string, PresenceDefinition>();
        for (const definition of BUILT_IN_PRESENCES) byId.set(definition.id, definition);
        for (const definition of this.#configuredCatalog) byId.set(definition.id, definition);
        for (const definition of stored) {
            assertPresenceDefinitionResult(definition);
            byId.set(definition.id, definition);
        }
        if (byId.size > MAX_PRESENCE_DEFINITIONS) {
            throw new Error("Presence catalog exceeds its bound.");
        }
        return [...byId.values()].map((definition) => cloneValue(definition));
    }

    #scheduleStore(): PresenceScheduleStore {
        return this.#store.schedules;
    }

    async #readSchedules(
        ctx: Context,
        scheduleStore: PresenceScheduleStore,
    ): Promise<readonly PresenceSchedule[]> {
        const schedules = await scheduleStore.list(ctx, { limit: MAX_PRESENCE_SCHEDULES });
        if (!Value.Check(Type.Array(presenceScheduleSchema, { maxItems: 10_000 }), schedules)) {
            throw new Error("Presence database returned an invalid schedule list.");
        }
        if (schedules.length > MAX_PRESENCE_SCHEDULES) {
            throw new Error("Presence database returned more schedules than requested.");
        }

        const ids = new Set<string>();
        const cloned: PresenceSchedule[] = [];
        for (const schedule of schedules) {
            assertPresenceSchedule(schedule);
            assertCanonicalSchedule(schedule);
            if (ids.has(schedule.id)) {
                throw new Error("Presence database returned duplicate schedule IDs.");
            }
            ids.add(schedule.id);
            cloned.push(cloneValue(schedule));
        }
        return cloned;
    }

    async #readUserInputState(
        ctx: Context,
        at: number,
    ): Promise<PresenceUserInputState | undefined> {
        const stored = await this.#store.read(ctx, at);
        if (stored === undefined) return undefined;
        assertPresenceStoredState(stored);
        const catalog = await this.#readCatalog(ctx);
        return toUserInputState(materializeStoredState(stored, catalog));
    }

    async #notifyPostCommit(
        ctx: Context,
        event: PresenceEvent,
        current: PresenceUserInputState | undefined,
    ): Promise<void> {
        for (const listener of this.#listeners) {
            try {
                await invokeVoid(listener(ctx, event), "Presence post-commit listener");
            } catch (error: unknown) {
                reportPostCommitFailure(ctx, event, error);
            }
        }

        for (const callback of this.#userInputSubscribers) {
            try {
                await invokeVoid(
                    callback(ctx, cloneValue(current)),
                    "Presence user-input callback",
                );
            } catch (error: unknown) {
                reportPostCommitFailure(ctx, event, error);
            }
        }
    }
}

/**
 * A presence change is durable before anyone is told about it, so a listener that fails is
 * something to report rather than a reason to fail the change that already happened.
 */
function reportPostCommitFailure(ctx: Context, event: PresenceEvent, error: unknown): void {
    try {
        ctx.log.warn(
            "A presence listener failed after the change was saved.",
            {
                eventId: event.eventId,
                type: event.type,
            },
            error,
        );
    } catch {
        // Reporting is advisory and must not turn a committed mutation into a failure.
    }
}

function now(): number {
    return Date.now();
}

/**
 * Reject a time zone the runtime cannot interpret before it reaches durable storage, so schedule
 * evaluation never depends on a value that will throw later.
 */
function assertKnownTimeZone(timeZone: string): void {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
        throw new Error(`"${timeZone}" is not a time zone this system recognizes.`);
    }
}

function normalizeMutationInput(
    input: PresenceMutationInput | PresenceToolInput,
    at: number,
): PresenceStoredState {
    let presenceId: string;
    let message: string | undefined;
    let effectiveFrom: number | undefined;
    let expiresAt: number | undefined;
    let fallbackPresenceId: string | undefined;
    let fallback: PresenceMutationInput["fallback"];

    if (Value.Check(presenceToolInputSchema, input)) {
        assertPresenceToolInput(input);
        presenceId = "presenceId" in input ? input.presenceId : input.status;
        message = input.message;
        expiresAt = input.until;
        fallbackPresenceId = input.fallbackPresenceId;
    } else {
        assertPresenceMutationInput(input);
        presenceId = "presenceId" in input ? input.presenceId : input.status;
        message = input.message;
        effectiveFrom = input.effectiveFrom;
        expiresAt = input.expiresAt;
        fallbackPresenceId = input.fallbackPresenceId;
        fallback = input.fallback;
    }
    if (fallback !== undefined) {
        if (!Value.Check(presenceReferenceSchema, fallback)) {
            throw new Error("Presence fallback is invalid.");
        }
        const referenceId = "presenceId" in fallback ? fallback.presenceId : fallback.status;
        if (referenceId === undefined) throw new Error("Presence fallback is invalid.");
        if (fallbackPresenceId !== undefined && fallbackPresenceId !== referenceId) {
            throw new Error("Presence fallback IDs disagree.");
        }
        fallbackPresenceId = referenceId;
    }
    if (expiresAt !== undefined) {
        effectiveFrom ??= at;
        fallbackPresenceId ??= ONLINE_PRESENCE_ID;
    }
    const result = {
        presenceId,
        ...(message === undefined ? {} : { message }),
        ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(fallbackPresenceId === undefined ? {} : { fallbackPresenceId }),
    };
    assertPresenceStoredState(result);
    if (expiresAt !== undefined && expiresAt <= at) {
        throw new Error("A presence must expire in the future.");
    }
    return result;
}

function assertCatalogSelection(
    selection: PresenceStoredState,
    catalog: readonly PresenceDefinition[],
): void {
    const definition = catalog.find((candidate) => candidate.id === selection.presenceId);
    if (definition === undefined) {
        throw new Error(`There is no presence called "${selection.presenceId}".`);
    }
    if (
        selection.fallbackPresenceId !== undefined &&
        !catalog.some((candidate) => candidate.id === selection.fallbackPresenceId)
    ) {
        throw new Error(`There is no presence called "${selection.fallbackPresenceId}".`);
    }
}

/** The catalog identity a schedule or fallback reference points at, in either reference form. */
function referenceId(reference: PresenceSchedule["presence"]): string {
    return "presenceId" in reference ? reference.presenceId : reference.status;
}

function assertCatalogReference(
    reference: PresenceSchedule["presence"],
    catalog: readonly PresenceDefinition[],
): void {
    const id = referenceId(reference);
    if (!catalog.some((candidate) => candidate.id === id)) {
        throw new Error(`There is no presence called "${id}".`);
    }
    if ("status" in reference && reference.status === "custom" && reference.presenceId !== id) {
        throw new Error("Custom presence reference identity is inconsistent.");
    }
}

function materializeStoredState(
    stored: PresenceStoredState,
    catalog: readonly PresenceDefinition[],
): PresenceState {
    const definition = catalog.find((candidate) => candidate.id === stored.presenceId);
    if (definition === undefined) {
        throw new Error(`Presence definition "${stored.presenceId}" is not configured.`);
    }
    const fallback =
        stored.fallbackPresenceId === undefined
            ? undefined
            : { presenceId: stored.fallbackPresenceId };
    const result = {
        presenceId: definition.id,
        status: definition.status,
        title: definition.title,
        emoji: definition.emoji,
        prompt: definition.prompt,
        answerWaitMs: definition.answerWaitMs,
        ...(stored.message === undefined ? {} : { message: stored.message }),
        ...(stored.effectiveFrom === undefined ? {} : { effectiveFrom: stored.effectiveFrom }),
        ...(stored.expiresAt === undefined
            ? {}
            : { expiresAt: stored.expiresAt, changesAt: stored.expiresAt }),
        ...(stored.fallbackPresenceId === undefined
            ? {}
            : {
                  fallbackPresenceId: stored.fallbackPresenceId,
                  fallback,
              }),
    };
    assertPresenceState(result);
    return result;
}

function toUserInputState(state: PresenceState): PresenceUserInputState {
    const result = {
        answerWaitMs: state.answerWaitMs,
        title: state.title,
        emoji: state.emoji,
        prompt: state.prompt,
        ...(state.expiresAt === undefined ? {} : { changesAt: state.expiresAt }),
    };
    assertPresenceUserInputState(result);
    return result;
}

function sameStoredState(left: PresenceStoredState, right: PresenceStoredState): boolean {
    return (
        left.presenceId === right.presenceId &&
        left.message === right.message &&
        left.effectiveFrom === right.effectiveFrom &&
        left.expiresAt === right.expiresAt &&
        left.fallbackPresenceId === right.fallbackPresenceId
    );
}

function sameDefinition(left: PresenceDefinition, right: PresenceDefinition): boolean {
    return (
        left.id === right.id &&
        left.status === right.status &&
        left.title === right.title &&
        left.emoji === right.emoji &&
        left.prompt === right.prompt &&
        left.answerWaitMs === right.answerWaitMs
    );
}

function normalizeScheduleInput(input: PresenceScheduleInput): PresenceScheduleInput {
    return {
        days: [...input.days].sort((left, right) => left - right),
        startTime: input.startTime,
        endTime: input.endTime,
        timeZone: input.timeZone,
        presence: normalizeReference(input.presence),
    };
}

function normalizeReference(
    reference: PresenceScheduleInput["presence"],
): PresenceScheduleInput["presence"] {
    if ("presenceId" in reference) {
        return {
            presenceId: reference.presenceId,
            ...(reference.message === undefined ? {} : { message: reference.message }),
        };
    }
    return {
        status: reference.status,
        ...(reference.message === undefined ? {} : { message: reference.message }),
    };
}

function assertCanonicalSchedule(schedule: PresenceSchedule): void {
    const canonicalDays = [...schedule.days].sort((left, right) => left - right);
    if (!schedule.days.every((day, index) => day === canonicalDays[index])) {
        throw new Error("Presence schedule days must use canonical ascending order.");
    }
}

function sameSchedule(stored: PresenceSchedule, requested: PresenceScheduleInput): boolean {
    const normalized = normalizeScheduleInput(requested);
    return (
        stored.days.length === normalized.days.length &&
        stored.days.every((day, index) => day === normalized.days[index]) &&
        stored.startTime === normalized.startTime &&
        stored.endTime === normalized.endTime &&
        stored.timeZone === normalized.timeZone &&
        sameReference(stored.presence, normalized.presence)
    );
}

function sameReference(
    left: PresenceSchedule["presence"],
    right: PresenceScheduleInput["presence"],
): boolean {
    const leftId = "presenceId" in left ? left.presenceId : left.status;
    const rightId = "presenceId" in right ? right.presenceId : right.status;
    return leftId === rightId && left.message === right.message;
}

function cloneCatalog(catalog: readonly PresenceDefinition[]): readonly PresenceDefinition[] {
    return catalog.map((definition) => cloneValue(definition));
}

/** The presence guidance the current history was last told; empty once told there is none. */
const PRESENCE_TOLD_KEY = "presenceTold";

/** Said only to a history that was told of a presence which has since been cleared. */
const PRESENCE_UNSET =
    "Current user presence: not set. The earlier presence guidance no longer applies.";

/** Format the full model-facing guidance for the current effective state. */
export function formatPresenceInstruction(state: PresenceState): string {
    assertPresenceState(state);
    const identity = `${state.title} ${state.emoji}`.trim();
    const message =
        state.message === undefined ? "" : ` The user's status message is: ${state.message}.`;
    const prompt = state.prompt.trim();
    return `Current user presence: ${identity}.${message}${prompt.length === 0 ? "" : ` ${prompt}`}`;
}

function cloneAndFreezeEvent(event: PresenceEvent): PresenceEvent {
    if (!Value.Check(presenceEventSchema, event)) {
        throw new Error("Presence module created an invalid event.");
    }
    return deepFreeze(cloneValue(event));
}

function cloneValue<T>(value: T): T {
    return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

async function invokeVoid(value: void | Promise<void> | undefined, label: string): Promise<void> {
    const resolved = await value;
    if (resolved !== undefined) {
        throw new Error(`${label} must return undefined.`);
    }
}
