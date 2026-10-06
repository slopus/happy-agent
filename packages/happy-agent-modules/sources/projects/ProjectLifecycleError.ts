import type { Project } from "./Project.js";

/**
 * A well-formed request refused because the project is archived or its version changed.
 *
 * This is a race a caller lost rather than a fault. Attaching a root agent reads the project inside
 * the transaction it attaches in, so an archival that commits first turns an attachment that was
 * legitimate when it started into one that must not land.
 */
export class ProjectLifecycleError extends Error {
    override readonly name = "ProjectLifecycleError";

    readonly current?: Project;

    constructor(message: string, current?: Project) {
        super(message);
        if (current !== undefined) this.current = structuredClone(current);
    }
}
