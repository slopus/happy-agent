/** Fixed diagnostics: provider errors and desktop contents must never enter voice or logs. */
export class LiveControllerError extends Error {
    constructor(
        readonly category:
            | "inference"
            | "deadline"
            | "invalidAction"
            | "limit"
            | "uncertainAction"
            | "capacity",
    ) {
        const explanation = {
            inference: "The desktop controller could not complete this request.",
            deadline: "The desktop controller could not complete this request before its deadline.",
            invalidAction:
                "The desktop controller could not complete this request because it returned an unsupported or invalid action.",
            limit: "The desktop controller could not complete this request within its limits.",
            uncertainAction:
                "The desktop controller could not complete this request because a desktop action did not return a confirmed outcome.",
            capacity: "Voice reached its desktop action limit. Start a new call explicitly.",
        }[category];
        super(explanation);
        this.name = "LiveControllerError";
    }

    /** A failed delegation may follow earlier successful or still-running mutations. */
    get voiceContext(): string {
        return `${this.message} Some actions may already have completed or may still complete. Do not retry any action automatically or claim it succeeded. Explain the failure, let the person inspect the app, and continue the conversation.`;
    }
}
