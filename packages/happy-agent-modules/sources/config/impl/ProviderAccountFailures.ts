import type { SessionEvent } from "@slopus/happy-providers";

const FAILURE_TTL_MS = 15 * 60_000;

/** What an account's own inference proved about its sign-in. */
export type ProviderSignInObservation = "signed_in" | "signed_out";

/**
 * The accounts whose latest inference ended because their sign-in was rejected or their usage ran
 * out.
 *
 * Smart routes fail over past such an account within one agent's turn, but a caller that freezes
 * one account for its whole lifetime, such as a voice call's controller, must avoid choosing it in
 * the first place. One entry per configured provider ID, set by a typed authentication or
 * out-of-tokens failure, cleared by the next completed response, and forgotten after fifteen
 * minutes so a recovered account is not avoided forever.
 */
export class ProviderAccountFailures {
    readonly #failedAt = new Map<string, number>();

    constructor(
        readonly now: () => number = Date.now,
        /**
         * Told what each terminal event proved about the account's sign-in: a completed response or
         * a refusal for spent usage means the vendor accepted it, a typed authentication failure
         * that it rejected it. Other failures prove nothing and are not reported.
         */
        readonly onSignIn?: (providerId: string, signIn: ProviderSignInObservation) => void,
    ) {}

    /** Learn from one terminal inference event of this concrete account. */
    observe(providerId: string, event: Extract<SessionEvent, { type: "done" }>): void {
        if (event.state === "normal" || event.state === "tool_call") {
            this.#failedAt.delete(providerId);
            this.onSignIn?.(providerId, "signed_in");
            return;
        }
        const type = event.state === "error" ? event.providerError?.type : undefined;
        if (type === "authentication" || type === "out_of_tokens") {
            this.#failedAt.set(providerId, this.now());
            this.onSignIn?.(providerId, type === "authentication" ? "signed_out" : "signed_in");
        }
    }

    /** Whether this account's latest inference failed on sign-in or usage, within the last minutes. */
    has(providerId: string): boolean {
        const at = this.#failedAt.get(providerId);
        if (at === undefined) return false;
        if (this.now() - at <= FAILURE_TTL_MS) return true;
        this.#failedAt.delete(providerId);
        return false;
    }
}
