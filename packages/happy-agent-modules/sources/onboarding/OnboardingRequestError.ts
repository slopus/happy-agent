import type { HistoryMessage } from "../history/index.js";

/** Why a press or another onboarding request was refused, as the API reports it. */
export class OnboardingRequestError extends Error {
    readonly code: "not_found" | "conflict" | "invalid";
    /** For a conflict on a press: the pressed message as it now stands. */
    readonly pressed: HistoryMessage | undefined;

    constructor(
        code: "not_found" | "conflict" | "invalid",
        message: string,
        pressed?: HistoryMessage,
    ) {
        super(message);
        this.name = "OnboardingRequestError";
        this.code = code;
        this.pressed = pressed;
    }
}
