import type { AgentDatabase } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";

import { workspacePathSchema, type Workspace, type WorkspaceReserveHooks } from "../Workspace.js";
import {
    workspaceBranchName,
    workspaceNameKey,
    workspaceStorageKey,
} from "../WorkspaceIdentity.js";
import type {
    WorkspaceMutationRequest,
    WorkspaceMutationResult,
    WorkspaceStoreReserveInput,
} from "../WorkspaceStore.js";
import type { WorkspacesModule } from "../WorkspacesModule.js";
import {
    uniqueWorkspaceBranch,
    uniqueWorkspaceName,
    uniqueWorkspaceStorageKey,
} from "./workspaceNaming.js";
import { lowestOrderKey, orderKeyBetween } from "./workspaceOrdering.js";
import {
    assertWorkspace,
    insertWorkspace,
    isUniquenessConflict,
    readProjectWorkspaces,
    readWorkspaceAncestorIds,
    readWorkspaceChildren,
    readWorkspace,
} from "./workspaceRecords.js";

/**
 * How many times a reservation re-reads the project and picks again after another reservation took
 * the name it had chosen. Each attempt claims one more suffix, so a handful covers far more
 * simultaneous creations than a person can ask for.
 */
const RESERVATION_ATTEMPTS = 8;

/**
 * Reserves one workspace: a name, a folder key, a branch, and the folder they live in, written
 * before any Git or filesystem work starts.
 *
 * Two things make the reservation trustworthy. The names are chosen against the catalog's live view
 * of Git and the filesystem rather than against the table alone. And the choice is only provisional
 * until the row is written: the unique indexes decide the winner, and the loser picks again from a
 * fresh snapshot instead of failing the person who asked for it.
 *
 * The folder is recorded as missing. It becomes present once the checkout is really there.
 */
export async function reserveWorkspace(
    database: AgentDatabase,
    input: WorkspaceStoreReserveInput,
    hooks: WorkspaceReserveHooks,
    catalog: WorkspacesModule,
    operation: WorkspaceMutationRequest,
    now: () => number,
): Promise<WorkspaceMutationResult> {
    const unchanged = (workspace: Workspace): WorkspaceMutationResult => ({
        operationId: operation.operationId,
        operation: operation.operation,
        changed: false,
        workspace,
    });

    const existing = await readWorkspace(database, input.id);
    if (existing !== undefined) {
        assertReservationStillMeans(existing, input);
        return unchanged(existing);
    }

    const probe = reservationProbe(input.projectRef, hooks, catalog);
    const seed = input.storageKeySeed ?? workspaceStorageKey(input.name);
    await assertParentIsInProject(database, input);

    for (let attempt = 1; ; attempt += 1) {
        const projectWorkspaces = await readProjectWorkspaces(database, input.projectRef);
        const siblings = await readWorkspaceChildren(database, input.projectRef, input.parentId);
        const name = uniqueWorkspaceName(input.name, (candidate) =>
            projectWorkspaces.some(
                (row) => workspaceNameKey(row.name) === workspaceNameKey(candidate),
            ),
        );
        const storageKey = await uniqueWorkspaceStorageKey(seed, async (candidate) => {
            if (
                projectWorkspaces.some(
                    (row) =>
                        row.storageKey.toLocaleLowerCase("en-US") ===
                        candidate.toLocaleLowerCase("en-US"),
                )
            ) {
                return true;
            }
            return await probe.isStorageKeyUnavailable(candidate);
        });
        const branch = await uniqueWorkspaceBranch(
            workspaceBranchName(input.storageKeySeed ?? name),
            async (candidate) => {
                if (projectWorkspaces.some((row) => row.branch === candidate)) return true;
                return await probe.isBranchUnavailable(candidate);
            },
        );
        const path = probe.pathForStorageKey(storageKey);
        if (!Value.Check(workspacePathSchema, path)) {
            throw new Error(
                "A workspace folder must be an absolute path the host already normalized.",
            );
        }
        const at = now();
        const workspace: Workspace = {
            id: input.id,
            projectRef: input.projectRef,
            parentId: input.parentId,
            name,
            nameConfigured: input.nameConfigured,
            branch,
            storageKey,
            kind: input.kind,
            path,
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
            ...(input.gitCommonDir === undefined ? {} : { gitCommonDir: input.gitCommonDir }),
            // Nothing has been created yet. The host says when the folder is really there.
            presence: "missing",
            status: "initializing",
            // A new workspace goes to the top of the list; that is where the work just started.
            orderKey: orderKeyBetween(null, lowestOrderKey(siblings)),
            version: 1,
            ...(input.creatorSessionId === undefined
                ? {}
                : { creatorSessionId: input.creatorSessionId }),
            ...(input.subtaskAgentId === undefined ? {} : { subtaskAgentId: input.subtaskAgentId }),
            gitAhead: 0,
            gitBehind: 0,
            gitDetached: false,
            initializationAttempt: 1,
            createdAt: at,
            updatedAt: at,
        };
        assertWorkspace(workspace);
        try {
            await insertWorkspace(database, workspace);
        } catch (error: unknown) {
            if (!isUniquenessConflict(error)) throw error;
            // Someone else may have been this same reservation, retried.
            const raced = await readWorkspace(database, input.id);
            if (raced !== undefined) {
                assertReservationStillMeans(raced, input);
                return unchanged(raced);
            }
            if (attempt >= RESERVATION_ATTEMPTS) {
                throw new Error(
                    "Too many workspaces were created in this project at once. Try again.",
                );
            }
            continue;
        }
        return {
            operationId: operation.operationId,
            operation: operation.operation,
            changed: true,
            workspace,
        };
    }
}

/**
 * A repeated reservation must describe the work the first one recorded. Everything the reservation
 * decided is compared, not only the project: a second call that means something else is a mistake
 * worth reporting rather than a silent alias for an unrelated workspace.
 */
export function assertReservationStillMeans(
    existing: Workspace,
    input: WorkspaceStoreReserveInput,
): void {
    if (existing.projectRef !== input.projectRef) {
        throw new Error("That workspace ID already names a workspace in another project.");
    }
    if (existing.subtaskAgentId !== input.subtaskAgentId) {
        throw new Error("That workspace ID belongs to another subtask.");
    }
    if (existing.parentId !== input.parentId) {
        throw new Error("That workspace ID already names a workspace under another parent.");
    }
    if (existing.kind !== input.kind) {
        throw new Error("That workspace ID already names a workspace of another kind.");
    }
    // A repeat that leaves the base out is asking for a workspace cut from the project's default,
    // which is a different workspace from one cut from a named ref — so the comparison runs both
    // ways rather than treating an absent base as "whatever was stored".
    //
    // Both ways is only meaningful while the row still is the reservation. Initialization records
    // the ref Git actually resolved into the same field, so a workspace that asked for no base ends
    // up storing the project default it was cut from. Past that point the stored base answers a
    // different question than the input does, and only a repeat that positively names a conflicting
    // base is a mistake; an absent one is the same request it always was.
    const requestIsStillTheRow = existing.version === 1;
    if (
        requestIsStillTheRow
            ? existing.baseRef !== input.baseRef
            : input.baseRef !== undefined && existing.baseRef !== input.baseRef
    ) {
        throw new Error("That workspace ID already names a workspace with a different base.");
    }
    if (input.baseCommit !== undefined && existing.baseCommit !== input.baseCommit) {
        throw new Error("That workspace ID already names a workspace cut from a different commit.");
    }
    if (input.gitCommonDir !== undefined && existing.gitCommonDir !== input.gitCommonDir) {
        throw new Error("That workspace ID already names a workspace in another Git directory.");
    }
    if (
        input.creatorSessionId !== undefined &&
        existing.creatorSessionId !== input.creatorSessionId
    ) {
        throw new Error("That workspace ID already names a workspace created by another session.");
    }
    if (existing.nameConfigured !== input.nameConfigured) {
        throw new Error(
            "That workspace ID already names a workspace whose name was configured differently.",
        );
    }
    if (!answersTo(existing.name, input.name, / \(\d+\)$/u, (value) => workspaceNameKey(value))) {
        throw new Error("That workspace ID already names a workspace called something else.");
    }
    if (
        input.storageKeySeed !== undefined &&
        !answersTo(existing.storageKey, input.storageKeySeed, /-\d+$/u, (value) =>
            value.toLocaleLowerCase("en-US"),
        )
    ) {
        throw new Error("That workspace ID already names a workspace in another folder.");
    }
}

async function assertParentIsInProject(
    database: AgentDatabase,
    input: WorkspaceStoreReserveInput,
): Promise<void> {
    if (input.id === input.projectRef) {
        throw new Error("A workspace cannot use its project's implicit root ID.");
    }
    if (input.parentId === input.id) {
        throw new Error("A workspace cannot be its own parent.");
    }
    if (input.parentId === input.projectRef) return;
    const parent = await readWorkspace(database, input.parentId);
    if (parent === undefined) {
        throw new Error(`Workspace parent "${input.parentId}" was not found.`);
    }
    if (parent.projectRef !== input.projectRef) {
        throw new Error("A workspace parent must belong to the same project.");
    }
    await readWorkspaceAncestorIds(database, parent);
}

/**
 * Where a workspace would live, and whether its branch or folder name is already taken.
 *
 * The catalog answers all three from its live view of Git and the filesystem. A caller may narrow
 * any of them further for one reservation — a name it knows is spoken for is unavailable whatever
 * Git says — and each answer it gives has to be a real yes or no, because a truthy stand-in would
 * quietly decide that a branch is taken.
 */
function reservationProbe(
    projectRef: string,
    hooks: WorkspaceReserveHooks,
    catalog: WorkspacesModule,
): {
    isBranchUnavailable: (branch: string) => Promise<boolean>;
    isStorageKeyUnavailable: (storageKey: string) => Promise<boolean>;
    pathForStorageKey: (storageKey: string) => string;
} {
    const branch = hooks.isBranchUnavailable?.bind(hooks);
    const storageKey = hooks.isStorageKeyUnavailable?.bind(hooks);
    const path = hooks.pathForStorageKey?.bind(hooks);
    return {
        isBranchUnavailable: async (candidate) =>
            (branch === undefined ? false : await availability(branch(candidate), "branch")) ||
            catalog.isBranchUnavailable(projectRef, candidate),
        isStorageKeyUnavailable: async (candidate) =>
            (storageKey === undefined
                ? false
                : await availability(storageKey(candidate), "folder")) ||
            catalog.isStorageKeyUnavailable(projectRef, candidate),
        pathForStorageKey: (candidate) =>
            path === undefined ? catalog.pathForStorageKey(projectRef, candidate) : path(candidate),
    };
}

/** A yes or no about a name, or a refusal to read anything else as one. */
async function availability(answer: boolean | Promise<boolean>, subject: string): Promise<boolean> {
    const settled = await answer;
    if (typeof settled !== "boolean") {
        throw new Error(
            `The answer about whether a ${subject} name is already taken must be a boolean.`,
        );
    }
    return settled;
}

/**
 * Whether a stored value is the requested one. The first reservation may have moved onto a counted
 * suffix because something else already answered to the name, so the suffix a reservation adds is
 * still the same request — but only the suffix this kind of value takes. A name someone deliberately
 * ended in `-2` is a different name, not a suffixed one.
 */
function answersTo(
    stored: string,
    requested: string,
    suffix: RegExp,
    key: (value: string) => string,
): boolean {
    const requestedKey = key(requested);
    if (key(stored) === requestedKey) return true;
    return key(stored.replace(suffix, "")) === requestedKey;
}
