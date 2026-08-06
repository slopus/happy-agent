import { and, asc, eq, sql } from "drizzle-orm";

import { projectWorkspaces } from "../database/schema.js";
import { projectNameKey, projectStorageKey } from "../../project/projectIdentity.js";
import { generateKeyBetween } from "../../utils/fractionalIndexing.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export interface WorkspaceReserveInput {
    baseCommit?: string;
    baseRef?: string;
    creatorSessionId?: string;
    gitCommonDir?: string;
    id: string;
    isStorageKeyUnavailable?: (storageKey: string) => boolean;
    name: string;
    now: number;
    pathForStorageKey: (storageKey: string) => string;
    projectId: string;
    storageKeySeed?: string;
}

export function workspaceReserve(
    tx: TX,
    input: WorkspaceReserveInput,
): { created: boolean; workspaceId: string } {
    return inTx(tx, (tx) => {
        // The identity may already name this workspace, because a create is
        // repeated until it is known to have landed. It is the same workspace
        // only if it describes the same one.
        const retry = tx
            .select({
                baseRef: projectWorkspaces.baseRef,
                id: projectWorkspaces.id,
                projectId: projectWorkspaces.projectId,
            })
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.id, input.id))
            .get();
        if (retry !== undefined) {
            if (retry.projectId !== input.projectId) {
                throw new Error("That workspace ID already names a workspace in another project.");
            }
            if (input.baseRef !== undefined && retry.baseRef !== input.baseRef) {
                throw new Error(
                    "That workspace ID already names a workspace with a different base.",
                );
            }
            return { created: false, workspaceId: retry.id };
        }

        const name = reserveUnique(input.name, (candidate) => {
            return (
                tx
                    .select({ id: projectWorkspaces.id })
                    .from(projectWorkspaces)
                    .where(
                        and(
                            eq(projectWorkspaces.projectId, input.projectId),
                            eq(projectWorkspaces.nameKey, projectNameKey(candidate)),
                        ),
                    )
                    .get() !== undefined
            );
        });
        const storageKey = reserveUniqueKey(
            input.storageKeySeed ?? projectStorageKey(input.name),
            (candidate) => {
                return (
                    input.isStorageKeyUnavailable?.(candidate) === true ||
                    tx
                        .select({ id: projectWorkspaces.id })
                        .from(projectWorkspaces)
                        .where(
                            and(
                                eq(projectWorkspaces.projectId, input.projectId),
                                sql`${projectWorkspaces.storageKey} = ${candidate} COLLATE NOCASE`,
                            ),
                        )
                        .get() !== undefined
                );
            },
        );
        const first = tx
            .select({ orderKey: projectWorkspaces.orderKey })
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.projectId, input.projectId))
            .orderBy(asc(projectWorkspaces.orderKey))
            .limit(1)
            .get();
        tx.insert(projectWorkspaces)
            .values({
                baseCommit: input.baseCommit ?? null,
                baseRef: input.baseRef ?? null,
                creatorSessionId: input.creatorSessionId,
                createdAtMs: input.now,
                gitAhead: 0,
                gitBehind: 0,
                // Git discovery follows the durable reservation. Ready workspaces always replace
                // this sentinel with the resolved common directory before materialization.
                gitCommonDir: input.gitCommonDir ?? "",
                gitDetached: false,
                id: input.id,
                kind: "git_worktree",
                name,
                nameKey: projectNameKey(name),
                orderKey: generateKeyBetween(null, first?.orderKey ?? null),
                path: input.pathForStorageKey(storageKey),
                presence: "present",
                projectId: input.projectId,
                status: "initializing",
                storageKey,
                updatedAtMs: input.now,
                version: 1,
            })
            .run();
        return { created: true, workspaceId: input.id };
    });
}

function reserveUnique(base: string, taken: (candidate: string) => boolean): string {
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base} (${String(suffix)})`;
        if (!taken(candidate)) return candidate;
    }
}

function reserveUniqueKey(base: string, taken: (candidate: string) => boolean): string {
    if (!taken(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base}-${String(suffix)}`;
        if (!taken(candidate)) return candidate;
    }
}
