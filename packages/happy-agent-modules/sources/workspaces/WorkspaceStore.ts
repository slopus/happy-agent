import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    workspaceBranchSchema,
    workspaceGitCommonDirSchema,
    workspaceGitFactsSchema,
    workspaceIdSchema,
    workspaceKindSchema,
    workspaceMutationOperationSchema,
    workspaceNameSchema,
    workspaceOperationIdSchema,
    workspaceParentIdSchema,
    workspacePathSchema,
    workspacePresenceSchema,
    workspaceProjectRefSchema,
    workspaceReserveHooksSchema,
    workspaceSchema,
    workspaceSessionIdSchema,
    workspaceStorageKeySchema,
    workspaceBaseRefSchema,
    workspaceCommitSchema,
    workspaceErrorSchema,
    workspaceInitializationFactsSchema,
    workspaceTimestampSchema,
    workspaceVersionSchema,
    type Workspace,
    type WorkspaceGitFacts,
    type WorkspaceReserveHooks,
} from "./Workspace.js";
import type { WorkspacesModule } from "./WorkspacesModule.js";
import { WorkspaceInputError } from "./WorkspaceInputError.js";
import { workspaceBranchName, workspaceNameKey } from "./WorkspaceIdentity.js";
import {
    workspaceBranchMetadataSchema,
    type WorkspaceBranchMetadata,
} from "./WorkspaceBranchMetadata.js";
import { workspaceContextSchema, workspaceEventSchema } from "./WorkspaceEvent.js";
import { workspaceMigrations } from "./WorkspaceMigrations.js";
import {
    workspacePageQuerySchema,
    workspacePageSchema,
    workspaceListSchema,
    type WorkspacePage,
    type WorkspacePageQuery,
    type WorkspaceList,
} from "./WorkspacePage.js";
import { byOrder, orderKeyBetween } from "./store/workspaceOrdering.js";
import {
    assertWorkspace,
    readProjectWorkspacesFor,
    readWorkspaceChildren,
    readWorkspace,
    readWorkspaceByPath,
    readWorkspacePage,
    sameJson,
    writeWorkspace,
} from "./store/workspaceRecords.js";
import { uniqueWorkspaceBranch, uniqueWorkspaceName } from "./store/workspaceNaming.js";
import { reserveWorkspace } from "./store/workspaceReservation.js";

export const workspaceMutationRequestSchema = Type.Object(
    {
        operation: workspaceMutationOperationSchema,
        operationId: workspaceOperationIdSchema,
    },
    { additionalProperties: false },
);

/**
 * The reservation the module hands the store. The module has already resolved the acting agent,
 * the project, the workspace kind, and whether the name was chosen deliberately; the store decides
 * the name, storage key, branch, path, and order that do not collide with anything.
 */
export const workspaceStoreReserveInputSchema = Type.Object(
    {
        id: workspaceIdSchema,
        projectRef: workspaceProjectRefSchema,
        parentId: workspaceParentIdSchema,
        name: workspaceNameSchema,
        nameConfigured: Type.Boolean(),
        kind: workspaceKindSchema,
        baseRef: Type.Optional(workspaceBaseRefSchema),
        baseCommit: Type.Optional(workspaceCommitSchema),
        gitCommonDir: Type.Optional(workspaceGitCommonDirSchema),
        creatorSessionId: Type.Optional(workspaceSessionIdSchema),
        storageKeySeed: Type.Optional(workspaceStorageKeySchema),
    },
    { additionalProperties: false },
);

export const workspaceStoreRenameInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        name: workspaceNameSchema,
        expectedVersion: Type.Optional(workspaceVersionSchema),
    },
    { additionalProperties: false },
);

export const workspaceStoreInheritNameInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, name: workspaceNameSchema },
    { additionalProperties: false },
);

export const workspaceStoreSetBranchInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, branch: workspaceBranchSchema },
    { additionalProperties: false },
);

export const workspaceStoreRecordInitializationInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, facts: workspaceInitializationFactsSchema },
    { additionalProperties: false },
);

export const workspaceStoreWorkspaceInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema },
    { additionalProperties: false },
);

export const workspaceStoreFailInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, error: workspaceErrorSchema },
    { additionalProperties: false },
);

export const workspaceStoreReorderInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        afterId: Type.Union([workspaceIdSchema, Type.Null()]),
        expectedVersion: Type.Optional(workspaceVersionSchema),
    },
    { additionalProperties: false },
);

export const workspaceStoreArchiveInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        expectedVersion: Type.Optional(workspaceVersionSchema),
    },
    { additionalProperties: false },
);

export const workspaceStoreApplyGitFactsInputSchema = Type.Object(
    { workspaceId: workspaceIdSchema, facts: workspaceGitFactsSchema },
    { additionalProperties: false },
);

export const workspaceStoreApplyProbeInputSchema = Type.Object(
    {
        workspaceId: workspaceIdSchema,
        presence: workspacePresenceSchema,
        facts: workspaceGitFactsSchema,
    },
    { additionalProperties: false },
);

/** One shape for every durable workspace mutation: what was asked, and the row it produced. */
export const workspaceMutationResultSchema = Type.Object(
    {
        operationId: workspaceOperationIdSchema,
        operation: workspaceMutationOperationSchema,
        changed: Type.Boolean(),
        workspace: workspaceSchema,
    },
    { additionalProperties: false },
);

export const workspaceTransactionChangeSchema = Type.Object(
    {
        result: workspaceMutationResultSchema,
        event: Type.Optional(workspaceEventSchema),
    },
    { additionalProperties: false },
);

/** Every durable mutation reads the same way: context, agent, what to change, and which call. */
const mutation = <TInput extends TSchema>(input: TInput) =>
    Type.Function(
        [workspaceContextSchema, input, workspaceMutationRequestSchema],
        Type.Promise(workspaceMutationResultSchema),
    );

/**
 * This contract is private to the module-owned SQLite adapter. A caller never injects a store: the
 * catalog opens its own and answers the questions the store has to ask while it decides.
 */
export const workspaceStoreSchema = Type.Object(
    {
        reserve: Type.Function(
            [
                workspaceContextSchema,
                workspaceStoreReserveInputSchema,
                workspaceReserveHooksSchema,
                workspaceMutationRequestSchema,
            ],
            Type.Promise(workspaceMutationResultSchema),
        ),
        list: Type.Function(
            [workspaceContextSchema, workspacePageQuerySchema],
            Type.Promise(workspacePageSchema),
        ),
        get: Type.Function(
            [workspaceContextSchema, workspaceIdSchema],
            Type.Promise(Type.Union([workspaceSchema, Type.Undefined()])),
        ),
        getByPath: Type.Function(
            [workspaceContextSchema, workspacePathSchema],
            Type.Promise(Type.Union([workspaceSchema, Type.Undefined()])),
        ),
        rename: mutation(workspaceStoreRenameInputSchema),
        inheritName: mutation(workspaceStoreInheritNameInputSchema),
        setBranch: mutation(workspaceStoreSetBranchInputSchema),
        recordInitialization: mutation(workspaceStoreRecordInitializationInputSchema),
        markReady: mutation(workspaceStoreWorkspaceInputSchema),
        markFailed: mutation(workspaceStoreFailInputSchema),
        markInitializationFailed: mutation(workspaceStoreFailInputSchema),
        reorder: mutation(workspaceStoreReorderInputSchema),
        beginArchive: mutation(workspaceStoreArchiveInputSchema),
        completeArchive: mutation(workspaceStoreWorkspaceInputSchema),
        applyGitFacts: mutation(workspaceStoreApplyGitFactsInputSchema),
        applyProbe: mutation(workspaceStoreApplyProbeInputSchema),
    },
    { additionalProperties: false },
);

export type WorkspaceStore = Static<typeof workspaceStoreSchema>;
export type WorkspaceStoreReserveInput = Static<typeof workspaceStoreReserveInputSchema>;
export type WorkspaceStoreRenameInput = Static<typeof workspaceStoreRenameInputSchema>;
export type WorkspaceStoreInheritNameInput = Static<typeof workspaceStoreInheritNameInputSchema>;
export type WorkspaceStoreSetBranchInput = Static<typeof workspaceStoreSetBranchInputSchema>;
export type WorkspaceStoreRecordInitializationInput = Static<
    typeof workspaceStoreRecordInitializationInputSchema
>;
export type WorkspaceStoreWorkspaceInput = Static<typeof workspaceStoreWorkspaceInputSchema>;
export type WorkspaceStoreFailInput = Static<typeof workspaceStoreFailInputSchema>;
export type WorkspaceStoreReorderInput = Static<typeof workspaceStoreReorderInputSchema>;
export type WorkspaceStoreArchiveInput = Static<typeof workspaceStoreArchiveInputSchema>;
export type WorkspaceStoreApplyGitFactsInput = Static<
    typeof workspaceStoreApplyGitFactsInputSchema
>;
export type WorkspaceStoreApplyProbeInput = Static<typeof workspaceStoreApplyProbeInputSchema>;
export type WorkspaceMutationRequest = Static<typeof workspaceMutationRequestSchema>;
export type WorkspaceMutationResult = Static<typeof workspaceMutationResultSchema>;
export type WorkspaceTransactionChange = Static<typeof workspaceTransactionChangeSchema>;

export type { Workspace, WorkspaceBranchMetadata, WorkspacePage, WorkspacePageQuery };

export { orderKeyBetween, sameJson, workspaceMigrations, assertWorkspace };

export function assertWorkspaceStore(value: unknown): asserts value is WorkspaceStore {
    if (!Value.Check(workspaceStoreSchema, value)) {
        throw new Error("The workspace store is invalid.");
    }
}

export function assertWorkspacePage(value: unknown): asserts value is WorkspacePage {
    if (!Value.Check(workspacePageSchema, value)) {
        throw new Error("Workspace store returned an invalid page.");
    }
}

export function assertWorkspaceList(value: unknown): asserts value is WorkspaceList {
    if (!Value.Check(workspaceListSchema, value)) {
        throw new Error("Workspace store returned an invalid workspace list.");
    }
}

export function assertWorkspaceBranchMetadata(
    value: unknown,
): asserts value is WorkspaceBranchMetadata {
    if (!Value.Check(workspaceBranchMetadataSchema, value)) {
        throw new Error("Workspace store returned invalid branch metadata.");
    }
}

export function assertWorkspaceMutationResult(
    value: unknown,
): asserts value is WorkspaceMutationResult {
    if (!Value.Check(workspaceMutationResultSchema, value)) {
        throw new Error("Workspace store returned an invalid mutation result.");
    }
}

export function assertWorkspaceTransactionChange(
    value: unknown,
): asserts value is WorkspaceTransactionChange {
    if (!Value.Check(workspaceTransactionChangeSchema, value)) {
        throw new Error("Workspace store transaction returned an invalid change.");
    }
}

export function createWorkspaceStore(catalog: WorkspacesModule): WorkspaceStore {
    const now = (): number => {
        const at = Date.now();
        if (!Value.Check(workspaceTimestampSchema, at)) {
            throw new Error("The clock is outside the range a workspace timestamp can hold.");
        }
        return at;
    };

    /**
     * One durable write. The row the decision was read from is part of the update predicate, so a
     * mutation either applies to exactly that row or is refused, and the version it produces is
     * always the one after the version it read.
     */
    const update = async (
        ctx: Context,
        workspaceId: string,
        operation: WorkspaceMutationRequest,
        decide: (before: Workspace) => Workspace | undefined | Promise<Workspace | undefined>,
    ): Promise<WorkspaceMutationResult> => {
        const database = ctx.db;
        const before = await readWorkspace(database, workspaceId);
        if (before === undefined) throw new Error(`Workspace "${workspaceId}" was not found.`);
        const decided = await decide(before);
        if (decided === undefined) {
            return {
                operationId: operation.operationId,
                operation: operation.operation,
                changed: false,
                workspace: before,
            };
        }
        const workspace: Workspace = {
            ...decided,
            version: before.version + 1,
            updatedAt: Math.max(now(), before.updatedAt + 1),
        };
        assertWorkspace(workspace);
        const stored = await writeWorkspace(database, workspace, before.version);
        return {
            operationId: operation.operationId,
            operation: operation.operation,
            changed: true,
            workspace: stored,
        };
    };

    return {
        reserve: async (ctx, input, hooks, operation) =>
            await reserveWorkspace(ctx.db, input, hooks, catalog, operation, now),

        list: async (ctx, query) => {
            const cursor = query.cursor ?? 0;
            const limit = query.limit ?? 50;
            const rows = await readWorkspacePage(ctx.db, {
                projectRef: query.projectRef,
                includeArchived: query.includeArchived === true,
                cursor,
                limit,
            });
            const workspaces = rows.slice(0, limit);
            return {
                workspaces,
                cursor,
                ...(rows.length > limit ? { nextCursor: cursor + workspaces.length } : {}),
            };
        },

        get: async (ctx, workspaceId) => await readWorkspace(ctx.db, workspaceId),

        getByPath: async (ctx, path) => await readWorkspaceByPath(ctx.db, path),

        rename: async (ctx, input, operation) => {
            const siblings = await readProjectWorkspacesFor(ctx.db, input.workspaceId);
            return await update(ctx, input.workspaceId, operation, async (before) => {
                assertExpectedVersion(
                    before,
                    input.expectedVersion,
                    "The workspace changed before it could be renamed.",
                );
                if (isSettled(before)) return undefined;
                const named = await renameTo(before, input.name, siblings, catalog);
                // A person naming a workspace settles the question: a first chat never renames it
                // again, even when the name it chose happens to match.
                return named === undefined && before.nameConfigured
                    ? undefined
                    : { ...(named ?? before), nameConfigured: true };
            });
        },

        inheritName: async (ctx, input, operation) => {
            const siblings = await readProjectWorkspacesFor(ctx.db, input.workspaceId);
            return await update(ctx, input.workspaceId, operation, async (before) =>
                before.nameConfigured || isSettled(before)
                    ? undefined
                    : await renameTo(before, input.name, siblings, catalog),
            );
        },

        setBranch: async (ctx, input, operation) =>
            await update(ctx, input.workspaceId, operation, (before) =>
                isSettled(before) || before.branch === input.branch
                    ? undefined
                    : { ...before, branch: input.branch },
            ),

        recordInitialization: async (ctx, input, operation) =>
            await update(ctx, input.workspaceId, operation, (before) => {
                // A workspace archived or failed while Git discovery was running keeps its
                // terminal state and ignores the late result.
                if (before.status !== "initializing") return undefined;
                const next: Workspace = {
                    ...before,
                    baseCommit: input.facts.baseCommit,
                    baseRef: input.facts.baseRef,
                    gitCommonDir: input.facts.gitCommonDir,
                };
                return sameJson(next, before) ? undefined : next;
            }),

        markReady: async (ctx, input, operation) =>
            await update(ctx, input.workspaceId, operation, (before) => {
                if (before.status !== "initializing") return undefined;
                const next = { ...before, presence: "present" as const, status: "ready" as const };
                delete next.initializationError;
                return next;
            }),

        markFailed: async (ctx, input, operation) =>
            await update(ctx, input.workspaceId, operation, (before) =>
                before.status === "ready"
                    ? { ...before, status: "failed", initializationError: input.error }
                    : undefined,
            ),

        markInitializationFailed: async (ctx, input, operation) =>
            await update(ctx, input.workspaceId, operation, (before) =>
                before.status === "initializing"
                    ? {
                          ...before,
                          status: "failed",
                          initializationError: input.error,
                          initializationAttempt: Math.min(
                              before.initializationAttempt + 1,
                              1_000_000,
                          ),
                      }
                    : undefined,
            ),

        reorder: async (ctx, input, operation) => {
            const database = ctx.db;
            if (input.afterId === input.workspaceId) {
                throw new WorkspaceInputError("A workspace cannot be placed after itself.");
            }
            const target = await readWorkspace(database, input.workspaceId);
            if (target === undefined) {
                throw new Error(`Workspace "${input.workspaceId}" was not found.`);
            }
            const ordered = (
                await readWorkspaceChildren(database, target.projectRef, target.parentId)
            )
                .filter((row) => row.id !== input.workspaceId)
                .sort(byOrder);
            const afterIndex =
                input.afterId === null ? -1 : ordered.findIndex((row) => row.id === input.afterId);
            if (input.afterId !== null && afterIndex === -1) {
                throw new WorkspaceInputError(
                    "The workspace to place after is not a sibling of this workspace.",
                );
            }
            const orderKey = orderKeyBetween(
                afterIndex === -1 ? null : (ordered[afterIndex]?.orderKey ?? null),
                ordered[afterIndex + 1]?.orderKey ?? null,
            );
            return await update(ctx, input.workspaceId, operation, (before) => {
                assertExpectedVersion(
                    before,
                    input.expectedVersion,
                    "The workspace changed before it could be reordered.",
                );
                return before.orderKey === orderKey ? undefined : { ...before, orderKey };
            });
        },

        beginArchive: async (ctx, input, operation) => {
            const before = await readWorkspace(ctx.db, input.workspaceId);
            if (
                before !== undefined &&
                before.status !== "archived" &&
                before.status !== "archiving"
            ) {
                const activeChildren = await readWorkspaceChildren(
                    ctx.db,
                    before.projectRef,
                    before.id,
                    false,
                );
                if (activeChildren.length > 0) {
                    throw new Error(
                        "A workspace with an active child workspace cannot be archived.",
                    );
                }
            }
            return await update(ctx, input.workspaceId, operation, (current) => {
                assertExpectedVersion(
                    current,
                    input.expectedVersion,
                    "The workspace changed before it could be archived.",
                );
                if (isSettled(current)) return undefined;
                const next: Workspace = {
                    ...current,
                    status: "archiving",
                    archivedAt: Math.max(now(), current.updatedAt + 1),
                };
                delete next.initializationError;
                return next;
            });
        },

        completeArchive: async (ctx, input, operation) =>
            await update(ctx, input.workspaceId, operation, (before) => {
                if (before.status !== "archiving") return undefined;
                const next: Workspace = {
                    ...before,
                    status: "archived",
                };
                delete next.initializationError;
                return next;
            }),

        applyGitFacts: async (ctx, input, operation) =>
            await update(ctx, input.workspaceId, operation, (before) =>
                // Archival is the terminal decision. A scan that was already running when it was
                // made describes a workspace nobody has any more.
                isSettled(before) ? undefined : withGitFacts(before, input.facts),
            ),

        applyProbe: async (ctx, input, operation) =>
            await update(ctx, input.workspaceId, operation, (before) => {
                // A probe describes a workspace someone can use. Anything still being built or
                // taken down is described by its own lifecycle transition instead.
                if (before.status !== "ready") return undefined;
                const next = withGitFacts(before, input.facts) ?? before;
                const probed: Workspace = { ...next, presence: input.presence };
                return sameJson(probed, before) ? undefined : probed;
            }),
    };
}

/** Archival is terminal: an observation that arrives afterwards changes nothing. */
function isSettled(workspace: Workspace): boolean {
    return workspace.status === "archiving" || workspace.status === "archived";
}

/**
 * Moves a workspace onto a name nothing else in the project answers to, and moves its branch with
 * it. Returns undefined when neither the name nor the branch would actually change.
 */
async function renameTo(
    before: Workspace,
    requested: string,
    siblings: readonly Workspace[],
    catalog: WorkspacesModule,
): Promise<Workspace | undefined> {
    const others = siblings.filter((row) => row.id !== before.id);
    const name = uniqueWorkspaceName(requested, (candidate) =>
        others.some((row) => workspaceNameKey(row.name) === workspaceNameKey(candidate)),
    );
    const branch = await uniqueWorkspaceBranch(workspaceBranchName(name), async (candidate) => {
        // A workspace never collides with itself: Git already holds the branch it is on, so a
        // name that slugs back to it must not be pushed onto a suffix for nothing.
        if (candidate === before.branch) return false;
        if (others.some((row) => row.branch === candidate)) return true;
        return catalog.isBranchUnavailable(before.projectRef, candidate);
    });
    return name === before.name && branch === before.branch
        ? undefined
        : { ...before, name, branch };
}

function withGitFacts(before: Workspace, facts: WorkspaceGitFacts): Workspace | undefined {
    const next: Workspace = {
        ...before,
        ...(facts.branch === undefined ? {} : { branch: facts.branch }),
        gitAhead: facts.ahead,
        gitBehind: facts.behind,
        gitDetached: facts.detached,
    };
    if (facts.head === undefined) delete next.gitHead;
    else next.gitHead = facts.head;
    if (facts.upstream === undefined) delete next.gitUpstream;
    else next.gitUpstream = facts.upstream;
    return sameJson(next, before) ? undefined : next;
}

function assertExpectedVersion(
    workspace: Workspace,
    expectedVersion: number | undefined,
    message: string,
): void {
    if (expectedVersion !== undefined && workspace.version !== expectedVersion) {
        throw new Error(message);
    }
}

export type { WorkspaceReserveHooks };
