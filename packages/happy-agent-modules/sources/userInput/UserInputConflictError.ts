import type { UserInputRequest } from "./UserInputRequest.js";

/** An answer to a request that was already settled: the request as it now stands. */
export class UserInputConflictError extends Error {
    readonly request: Exclude<UserInputRequest, { status: "pending" }>;

    constructor(request: Exclude<UserInputRequest, { status: "pending" }>) {
        super("The question has already been resolved.");
        this.name = "UserInputConflictError";
        this.request = request;
    }
}
