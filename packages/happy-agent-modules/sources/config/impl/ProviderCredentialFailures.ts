import type { MessageError } from "@slopus/happy-agent-client";

import type {
    ProviderCredentialsUnavailableError,
    ProviderSignIn,
} from "./ProviderCredentialsUnavailableError.js";

const FAILURE_TTL_MS = 15 * 60_000;

/** What configuration knows about a failure it raised because a provider had no credential. */
export interface UnavailableCredentialFailure {
    readonly providerId: string;
    readonly signIn: ProviderSignIn;
    /** Legacy owner-only details, kept for clients older than protocol 30. */
    readonly error: MessageError;
}

/**
 * The latest missing-credential failure each configured provider raised.
 *
 * Agent Base reports a run that failed while opening its provider only as text, so history cannot
 * see the typed error. Configuration remembers the exact text it raised for each provider, and a
 * failure carrying that same text gets its typed details; any other text stays generic. One entry
 * per configured provider ID, replaced on every failure, cleared on the next successful
 * construction, and forgotten after fifteen minutes.
 */
export class ProviderCredentialFailures {
    readonly #entries = new Map<
        string,
        { message: string; failure: UnavailableCredentialFailure; at: number }
    >();

    constructor(
        readonly now: () => number = Date.now,
        /** Told each time a provider is found to have no credential at all. */
        readonly onMissing?: (providerId: string) => void,
    ) {}

    record(error: ProviderCredentialsUnavailableError): void {
        this.onMissing?.(error.providerId);
        this.#entries.set(error.providerId, {
            message: error.message,
            failure: {
                providerId: error.providerId,
                signIn: { ...error.signIn },
                error: structuredClone(error.failure),
            },
            at: this.now(),
        });
    }

    clear(providerId: string): void {
        this.#entries.delete(providerId);
    }

    /** Whether this provider's last construction found no credential, within the last minutes. */
    has(providerId: string): boolean {
        const entry = this.#entries.get(providerId);
        if (entry === undefined) return false;
        if (this.now() - entry.at <= FAILURE_TTL_MS) return true;
        this.#entries.delete(providerId);
        return false;
    }

    /**
     * The typed failure for exactly this raised text, if one of these providers raised it. Default
     * sign-ins of the same vendor raise the same sentence, so the text alone cannot name the
     * provider; the caller says which providers the failed run could have used.
     */
    find(
        message: string,
        providerIds: readonly string[],
    ): UnavailableCredentialFailure | undefined {
        const now = this.now();
        for (const providerId of providerIds) {
            const entry = this.#entries.get(providerId);
            if (entry === undefined) continue;
            if (now - entry.at > FAILURE_TTL_MS) {
                this.#entries.delete(providerId);
                continue;
            }
            if (entry.message === message) return structuredClone(entry.failure);
        }
        return undefined;
    }
}
