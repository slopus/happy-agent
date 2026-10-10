import { Value } from "@sinclair/typebox/value";
import { afterCommit, asyncLock, type Context } from "@steve.kite/stdlib";

import {
    workspaceTimestampSchema,
    type Workspace,
    type WorkspaceMutationOperation,
} from "./Workspace.js";
import { assertWorkspaceRecord } from "./WorkspaceRecord.js";
import {
    workspaceEventIdSchema,
    workspaceEventListenerSchema,
    workspaceEventSchema,
    type WorkspaceEvent,
    type WorkspaceEventListener,
    type WorkspaceUnsubscribe,
} from "./WorkspaceEvent.js";
import {
    assertWorkspace,
    assertWorkspaceMutationResult,
    assertWorkspaceTransactionChange,
    sameJson,
    workspaceMutationRequestSchema,
    workspaceMutationResultSchema,
    type WorkspaceMutationRequest,
    type WorkspaceMutationResult,
    type WorkspaceStore,
    type WorkspaceTransactionChange,
} from "./WorkspaceStore.js";
import { deepFreeze, isDeepFrozen, requirePromise } from "./workspaceRuntime.js";

/** Distributes over the event union, so each event keeps its own fields. */
export type WorkspaceEventPayload = WorkspaceEvent extends infer TEvent
    ? TEvent extends WorkspaceEvent
        ? Omit<TEvent, "eventId" | "at">
        : never
    : never;

/**
 * The path every durable workspace change takes.
 *
 * A mutation runs in one transaction: the row is read, the store decides, and the answer is checked
 * against the row that is actually stored before anything is told about it. One event describes one
 * change, the transactional observer sees it inside that transaction, and the post-commit observer
 * only after the change is durable. An observer that fails cannot undo a committed change.
 */
export class WorkspaceMutations {
    readonly #store: WorkspaceStore;
    readonly #transactionalListeners = new Set<WorkspaceEventListener>();
    readonly #postCommitListeners = new Set<WorkspaceEventListener>();
    /**
     * One durable change at a time. Two callers that ask at the same moment would otherwise each open
     * a root transaction, and a mutation already running inside one joins it instead of waiting on
     * itself.
     */
    readonly #oneAtATime = asyncLock({ reentry: "allow" });

    constructor(store: WorkspaceStore) {
        this.#store = store;
    }

    /** Takes a subscriber that runs inside the transaction the change commits in. */
    onEventTransactional(listener: WorkspaceEventListener): WorkspaceUnsubscribe {
        return this.#subscribe(this.#transactionalListeners, listener);
    }

    /** Takes a subscriber that runs once the change is durable. */
    onEvent(listener: WorkspaceEventListener): WorkspaceUnsubscribe {
        return this.#subscribe(this.#postCommitListeners, listener);
    }

    #subscribe(
        listeners: Set<WorkspaceEventListener>,
        listener: WorkspaceEventListener,
    ): WorkspaceUnsubscribe {
        if (!Value.Check(workspaceEventListenerSchema, listener)) {
            throw new Error("A workspace subscriber must be a function.");
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    /** `runResult` for the callers that only care about the row it produced. */
    async run(
        ctx: Context,
        operation: WorkspaceMutationOperation,
        operationId: string,
        workspaceId: string,
        perform: (
            txCtx: Context,
            request: WorkspaceMutationRequest,
        ) => Promise<WorkspaceMutationResult>,
        describe: (
            before: Workspace | undefined,
            after: Workspace,
        ) => WorkspaceEventPayload | undefined,
    ): Promise<Workspace> {
        return (await this.runResult(ctx, operation, operationId, workspaceId, perform, describe))
            .workspace;
    }

    async runResult(
        ctx: Context,
        operation: WorkspaceMutationOperation,
        operationId: string,
        workspaceId: string,
        perform: (
            txCtx: Context,
            request: WorkspaceMutationRequest,
        ) => Promise<WorkspaceMutationResult>,
        describe: (
            before: Workspace | undefined,
            after: Workspace,
        ) => WorkspaceEventPayload | undefined,
    ): Promise<WorkspaceMutationResult> {
        const request: WorkspaceMutationRequest = { operation, operationId };
        if (!Value.Check(workspaceMutationRequestSchema, request)) {
            throw new Error("Workspace module created an invalid operation.");
        }

        const change = await this.runTransaction(ctx, async (txCtx) => {
            const before = await this.getOptional(txCtx, workspaceId);

            const raw = await requirePromise(
                perform(txCtx, request),
                `Workspace store ${operation}`,
            );
            assertWorkspaceMutationResult(raw);
            if (raw.operation !== operation || raw.operationId !== operationId) {
                throw new Error("Workspace mutation result identity does not match the request.");
            }
            if (raw.workspace.id !== workspaceId) {
                throw new Error("Workspace mutation result has a different workspace identity.");
            }

            const after = await this.getRequired(txCtx, workspaceId);
            if (!sameJson(after, raw.workspace)) {
                throw new Error(
                    `Workspace ${operation} result does not match authoritative state.`,
                );
            }
            const changed = !sameJson(before, after);
            if (raw.changed !== changed) {
                throw new Error(`Workspace ${operation} changed flag is not authoritative.`);
            }
            if (changed && before !== undefined && after.version !== before.version + 1) {
                throw new Error(`Workspace ${operation} did not advance its version by one.`);
            }
            const result = structuredClone(raw);
            if (!changed) return { result };
            const payload = describe(before, after);
            if (payload === undefined) return { result };
            const event = this.newEvent(payload);
            await this.observe(txCtx, event);
            return { result, event };
        });
        return structuredClone(requireMutationResult(change.result));
    }

    async runTransaction(
        ctx: Context,
        work: (txCtx: Context) => Promise<WorkspaceTransactionChange>,
    ): Promise<WorkspaceTransactionChange> {
        // Every entry acquires the database before the module lock, including callers
        // that already carry a transaction. The opposite order can wait on that caller
        // while it waits on this lock, blocking the whole shared database.
        return await ctx.inTx(
            async (txCtx) =>
                await this.#oneAtATime.runInLock(txCtx, async (lockCtx) => {
                    let expected: WorkspaceTransactionChange | undefined;
                    const raw = await requirePromise(
                        lockCtx.inTx(async (txCtx) => {
                            const change = await work(txCtx);
                            expected = deepFreeze(structuredClone(change));
                            return structuredClone(expected);
                        }),
                        "Workspace store transaction",
                    );
                    assertWorkspaceTransactionChange(raw);
                    if (expected === undefined || !sameJson(raw, expected)) {
                        throw new Error("Workspace transaction returned a substituted change.");
                    }
                    return raw;
                }),
        );
    }

    async getRequired(ctx: Context, workspaceId: string): Promise<Workspace> {
        const workspace = await this.getOptional(ctx, workspaceId);
        if (workspace === undefined) {
            throw new Error(`Workspace "${workspaceId}" was not found.`);
        }
        return workspace;
    }

    async getOptional(ctx: Context, workspaceId: string): Promise<Workspace | undefined> {
        const raw = await requirePromise(this.#store.get(ctx, workspaceId), "Workspace store get");
        if (raw === undefined) return undefined;
        assertWorkspace(raw);
        assertWorkspaceRecord(raw);
        if (raw.id !== workspaceId) {
            throw new Error("Workspace store returned a different workspace identity.");
        }
        return structuredClone(raw);
    }

    newEvent(payload: WorkspaceEventPayload): WorkspaceEvent {
        const eventId = globalThis.crypto.randomUUID();
        if (!Value.Check(workspaceEventIdSchema, eventId)) {
            throw new Error("The workspaces catalog minted an identity it cannot represent.");
        }
        const at = Date.now();
        if (!Value.Check(workspaceTimestampSchema, at)) {
            throw new Error("The clock is outside the range a workspace timestamp can hold.");
        }
        const event = { ...payload, eventId, at };
        if (!Value.Check(workspaceEventSchema, event)) {
            throw new Error("Workspace module created an invalid event.");
        }
        return deepFreeze(structuredClone(event)) as WorkspaceEvent;
    }

    async observe(ctx: Context, event: WorkspaceEvent): Promise<void> {
        if (!Value.Check(workspaceEventSchema, event) || !isDeepFrozen(event)) {
            throw new Error("Workspace module created an invalid unfrozen event.");
        }
        // A snapshot, so subscribing or unsubscribing from inside a subscriber cannot change who
        // this event goes to.
        for (const listener of Array.from(this.#transactionalListeners)) {
            await listener(ctx, event);
        }
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyPostCommit(ctx: Context, event: WorkspaceEvent): Promise<void> {
        for (const listener of Array.from(this.#postCommitListeners)) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                ctx.log.error(
                    { error, eventId: event.eventId, type: event.type },
                    "A workspace subscriber failed after the change was committed.",
                );
            }
        }
    }
}

function requireMutationResult(
    result: WorkspaceTransactionChange["result"],
): WorkspaceMutationResult {
    if (!Value.Check(workspaceMutationResultSchema, result)) {
        throw new Error("Workspace mutation did not return a workspace.");
    }
    return result;
}
