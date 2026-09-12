/** A display-safe failure from global skill management. */
export class GlobalSkillsError extends Error {
    constructor(
        readonly status: number,
        readonly code:
            | "invalid_request"
            | "not_found"
            | "forbidden"
            | "too_large"
            | "conflict"
            | "internal",
        message: string,
        readonly details: Readonly<Record<string, unknown>> = {},
    ) {
        super(message);
        this.name = "GlobalSkillsError";
    }
}
