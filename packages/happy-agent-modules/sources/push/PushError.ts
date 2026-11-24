/** Why a push operation was refused: malformed input, someone else's registration, or the limit. */
export type PushErrorCode = "invalid_request" | "not_found" | "registrations_full";

/** A refused push operation. Nothing changed; the message is safe to show and names no token. */
export class PushError extends Error {
    override readonly name = "PushError";
    readonly code: PushErrorCode;

    constructor(code: PushErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}
