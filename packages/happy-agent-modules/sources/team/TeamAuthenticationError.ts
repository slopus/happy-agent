export class TeamAuthenticationError extends Error {
    constructor() {
        super("Unauthorized");
        this.name = "TeamAuthenticationError";
    }
}
