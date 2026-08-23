/**
 * A well-formed request a project's own lifecycle refuses because the project is archived.
 *
 * This is a race a caller lost rather than a fault. Attaching a root agent reads the project inside
 * the transaction it attaches in, so an archival that commits first turns an attachment that was
 * legitimate when it started into one that must not land.
 */
export class ProjectLifecycleError extends Error {
    override readonly name = "ProjectLifecycleError";
}
