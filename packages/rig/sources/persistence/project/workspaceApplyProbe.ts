import { and, eq, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { type GitValues, workspaceGitChanged } from "./projectConditions.js";
import { workspaceScope } from "./workspaceScope.js";

export function workspaceApplyProbe(
    tx: TX,
    projectId: string,
    id: string,
    values: GitValues & { presence: string },
    now: number,
): number {
    return Number(
        tx
            .update(projectWorkspaces)
            .set({
                ...values,
                updatedAtMs: now,
                version: sql`${projectWorkspaces.version} + 1`,
            })
            .where(
                and(
                    workspaceScope(projectId, id),
                    eq(projectWorkspaces.status, "ready"),
                    sql`(
        ${projectWorkspaces.presence} IS NOT ${values.presence} OR ${workspaceGitChanged(values)}
    )`,
                ),
            )
            .run().changes,
    );
}
