/**
 * A well-formed request a workspace's own lifecycle refuses: it is being archived, or already is.
 *
 * This is a race a caller lost rather than a fault. Attaching an agent reads the workspace inside
 * the transaction it attaches in, so an archival that commits first turns an attachment that was
 * legitimate when it started into one that must not land.
 */
export class WorkspaceLifecycleError extends Error {
    override readonly name = "WorkspaceLifecycleError";
}
