import type { TeamUser } from "./TeamUser.js";

/** A conditional team profile mutation was based on an obsolete user version. */
export class TeamProfileVersionConflictError extends Error {
    readonly current: TeamUser;

    constructor(current: TeamUser) {
        super("The profile has changed.");
        this.name = "TeamProfileVersionConflictError";
        this.current = structuredClone(current);
    }
}
