/** A team profile mutation cannot be represented as a durable user. */
export class TeamProfileInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TeamProfileInputError";
    }
}
