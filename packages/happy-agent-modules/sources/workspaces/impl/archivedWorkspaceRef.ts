import { createHash } from "node:crypto";

const REF_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/**
 * The ref in the project's repository that keeps what an archived worktree still held.
 *
 * Generated workspace IDs are already valid ref names and are used as they are, so a person can
 * find the save from the ID they see. An ID Git would refuse in a ref name is hashed instead.
 */
export function archivedWorkspaceRef(workspaceId: string): string {
    const name = REF_SAFE_ID.test(workspaceId)
        ? workspaceId
        : createHash("sha256").update(workspaceId).digest("hex");
    return `refs/happy/archived/${name}`;
}
