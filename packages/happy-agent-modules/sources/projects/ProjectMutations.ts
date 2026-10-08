import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import { projectEventIdSchema, projectTimestampSchema, type Project } from "./Project.js";
import {
    projectEventListenerSchema,
    projectEventSchema,
    type ProjectEvent,
    type ProjectEventListener,
    type ProjectUnsubscribe,
} from "./ProjectEvent.js";
import { assertProject } from "./ProjectRow.js";
import { type ProjectSettings } from "./ProjectSettings.js";
import {
    assertProjectStoreMutationResult,
    type ProjectStore,
    type ProjectStoreMutationResult,
} from "./ProjectStore.js";
import {
    assertProjectRecord,
    assertProjectSettings,
    assertProjectTransition,
    sameJson,
} from "./ProjectTransition.js";
import { deepFreeze, isDeepFrozen, requirePromise } from "./projectRuntime.js";

/** Distributes over the event union, so each event keeps its own fields. */
export type ProjectEventPayload = ProjectEvent extends infer TEvent
    ? TEvent extends ProjectEvent
        ? Omit<TEvent, "eventId" | "at">
        : never
    : never;

export type ProjectMutationSpec<Result extends ProjectStoreMutationResult> = {
    /** Reads the project this operation may already have, by folder rather than by ID. */
    readonly beforeByPath?: { readonly path: string; readonly runnerId: string | undefined };
    readonly changeable: readonly (keyof Project)[];
    readonly event: (after: Project, before: Project | undefined) => ProjectEventPayload;
    readonly projectId?: string;
    readonly run: (txCtx: Context, before: Project | undefined) => Promise<Result>;
};

/**
 * The path every durable project change takes, and the reads it is decided from.
 *
 * A mutation runs in one transaction: the row is read, the store decides, and the answer is checked
 * against what is actually stored before anything is told about it. One event describes one change,
 * the transactional subscriber sees it inside that transaction, and the post-commit subscriber only
 * after the change is durable. A subscriber that fails cannot undo a committed change.
 */
export class ProjectMutations {
    readonly #store: ProjectStore;
    readonly #transactionalListeners = new Set<ProjectEventListener>();
    readonly #postCommitListeners = new Set<ProjectEventListener>();

    constructor(store: ProjectStore) {
        this.#store = store;
    }

    /** Takes a subscriber that runs inside the transaction the change commits in. */
    onEventTransactional(listener: ProjectEventListener): ProjectUnsubscribe {
        return this.#subscribe(this.#transactionalListeners, listener);
    }

    /** Takes a subscriber that runs once the change is durable. */
    onEvent(listener: ProjectEventListener): ProjectUnsubscribe {
        return this.#subscribe(this.#postCommitListeners, listener);
    }

    #subscribe(
        listeners: Set<ProjectEventListener>,
        listener: ProjectEventListener,
    ): ProjectUnsubscribe {
        if (!Value.Check(projectEventListenerSchema, listener)) {
            throw new Error("A project subscriber must be a function.");
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    /**
     * Runs one durable catalog write: it reads the project the operation names,
     * checks the store's answer against the row that is actually stored, and
     * emits one event when something changed.
     */
    async run<Result extends ProjectStoreMutationResult>(
        ctx: Context,
        spec: ProjectMutationSpec<Result>,
    ): Promise<Result> {
        return await ctx.inTx(async (txCtx) => {
            const before =
                spec.projectId !== undefined
                    ? await this.getRequired(txCtx, spec.projectId)
                    : spec.beforeByPath === undefined
                      ? undefined
                      : await this.findByPath(
                            txCtx,
                            spec.beforeByPath.path,
                            spec.beforeByPath.runnerId,
                        );
            const raw = await spec.run(txCtx, before);
            assertProjectStoreMutationResult(raw);
            if (!("project" in raw)) {
                throw new Error("A project mutation did not return a project.");
            }
            const after = await this.getRequired(txCtx, raw.project.id);
            if (!sameJson(after, raw.project)) {
                throw new Error("A project mutation result does not match what was stored.");
            }
            if (before === undefined) {
                assertProjectRecord(after);
                if (!raw.changed) {
                    throw new Error("A new project must be reported as a change.");
                }
            } else {
                if (after.id !== before.id) {
                    throw new Error("A project mutation changed the identity of the project.");
                }
                assertProjectTransition(before, after, spec.changeable);
                if (raw.changed !== !sameJson(before, after)) {
                    throw new Error("A project mutation result reports the wrong change.");
                }
            }
            if (raw.changed) {
                await this.observeMutation(ctx, txCtx, this.newEvent(spec.event(after, before)));
            }
            return structuredClone(raw);
        });
    }

    async getOptional(ctx: Context, projectId: string): Promise<Project | undefined> {
        const raw = await requirePromise(this.#store.get(ctx, projectId), "Project store get");
        if (raw === undefined) return undefined;
        assertProject(raw);
        assertProjectRecord(raw);
        if (raw.id !== projectId) {
            throw new Error("The project store returned a different project.");
        }
        return structuredClone(raw);
    }

    async getRequired(ctx: Context, projectId: string): Promise<Project> {
        const project = await this.getOptional(ctx, projectId);
        if (project === undefined) throw new Error(`Project "${projectId}" was not found.`);
        return project;
    }

    async findByPath(
        ctx: Context,
        repositoryRef: string,
        runnerId?: string,
    ): Promise<Project | undefined> {
        const raw = await requirePromise(
            this.#store.findByPath(ctx, repositoryRef, runnerId),
            "Project store find by folder",
        );
        if (raw === undefined) return undefined;
        assertProject(raw);
        assertProjectRecord(raw);
        if (raw.repositoryRef !== repositoryRef || raw.runnerId !== runnerId) {
            throw new Error("The project store returned a different folder.");
        }
        return structuredClone(raw);
    }

    async readSettings(ctx: Context, projectId: string): Promise<ProjectSettings> {
        const raw = await requirePromise(
            this.#store.readSettings(ctx, projectId),
            "Project store read settings",
        );
        assertProjectSettings(raw);
        return structuredClone(raw);
    }

    newEvent(payload: ProjectEventPayload): ProjectEvent {
        const eventId = globalThis.crypto.randomUUID();
        if (!Value.Check(projectEventIdSchema, eventId)) {
            throw new Error("The project catalog minted an identity it cannot represent.");
        }
        const at = Date.now();
        if (!Value.Check(projectTimestampSchema, at)) {
            throw new Error("The clock is outside the range a project timestamp can hold.");
        }
        const event = { ...payload, eventId, at };
        if (!Value.Check(projectEventSchema, event)) {
            throw new Error("The project module created an invalid event.");
        }
        return deepFreeze(structuredClone(event)) as ProjectEvent;
    }

    /**
     * Publishes one event: transactionally first, then again once the change is durable.
     *
     * `publishCtx` is the context the caller handed the module. Registering the post-commit
     * callback there is what makes an enclosing transaction the boundary: an event belonging to
     * somebody else's larger write is delivered when that write commits, not when this one does.
     */
    async observe(
        ctx: Context,
        event: ProjectEvent,
        publishCtx: Context = ctx,
        followingPublishCtx?: Context,
    ): Promise<void> {
        if (!Value.Check(projectEventSchema, event) || !isDeepFrozen(event)) {
            throw new Error("The project module created an invalid unfrozen event.");
        }
        // A snapshot, so subscribing or unsubscribing from inside a subscriber cannot change who
        // this event goes to.
        for (const listener of [...this.#transactionalListeners]) await listener(ctx, event);
        afterCommit(publishCtx, (postCommitCtx) => {
            if (followingPublishCtx === undefined) {
                return this.#notifyPostCommit(postCommitCtx, event);
            }
            return afterCommit(followingPublishCtx, (followingCtx) =>
                this.#notifyPostCommit(followingCtx, event),
            );
        });
    }

    /**
     * Publishes a mutation event after both transaction boundaries that may own it.
     *
     * The module transaction must commit before a listener reads the changed row. When the caller
     * supplied its own post-commit boundary, delivery then waits for that boundary as well.
     */
    async observeMutation(callerCtx: Context, txCtx: Context, event: ProjectEvent): Promise<void> {
        if (callerCtx === txCtx) {
            await this.observe(txCtx, event);
            return;
        }
        await this.observe(txCtx, event, txCtx, callerCtx);
    }

    async #notifyPostCommit(ctx: Context, event: ProjectEvent): Promise<void> {
        for (const listener of [...this.#postCommitListeners]) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                ctx.log.error(
                    { error, eventId: event.eventId, type: event.type },
                    "A project subscriber failed after the change was committed.",
                );
            }
        }
    }
}
