import { and, eq, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export function workspaceMarkReady(tx: TX, projectId: string, id: string, now: number): number {
    return Number(
        tx
            .update(projectWorkspaces)
            .set({
                error: null,
                presence: "present",
                status: "ready",
                updatedAtMs: now,
                version: sql`${projectWorkspaces.version} + 1`,
            })
            .where(and(workspaceScope(projectId, id), eq(projectWorkspaces.status, "initializing")))
            .run().changes,
    );
}
