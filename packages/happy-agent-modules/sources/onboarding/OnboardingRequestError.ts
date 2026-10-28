/** Why a press or another onboarding request was refused, as the API reports it. */
export class OnboardingRequestError extends Error {
    readonly code: "not_found" | "conflict" | "invalid";

    constructor(code: "not_found" | "conflict" | "invalid", message: string) {
        super(message);
        this.name = "OnboardingRequestError";
        this.code = code;
    }
}
