import type {
    MurmurContact,
    MurmurContactProfile,
    MurmurContactRequested,
    MurmurContactUpdated,
    MurmurOutgoingContactRequest,
    MurmurSynchronizeOptions,
    MurmurSynchronizeResult,
    MurmurSyncOptions,
} from "@slopus/murmur";

import type { MurmurClientFacade } from "../../sources/murmur/MurmurService.js";
import type { MurmurPeerProfile } from "../../sources/murmur/MurmurTypes.js";

/** Murmur values are always 32 raw bytes, which the service shows as 43 base64url characters. */
export function identityBytes(fill: number): Uint8Array {
    return new Uint8Array(32).fill(fill);
}

export function encodeIdentity(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}

export const SELF = identityBytes(1);
export const REMOTE = identityBytes(2);
export const SESSION = identityBytes(3);
export const OTHER_SESSION = identityBytes(4);
export const INVITATION = identityBytes(5);

/** The envelope Murmur carries a profile in, built exactly as the service builds its own. */
export function carriedProfile(profile: MurmurPeerProfile): MurmurContactProfile {
    return { profile, version: 1 } as unknown as MurmurContactProfile;
}

export function peerProfile(overrides: Partial<MurmurPeerProfile> = {}): MurmurPeerProfile {
    return {
        createdAt: 2,
        email: "remote@example.test",
        id: "aremoteprofile0000000001",
        name: "Remote",
        parentInstanceId: "aremoteinstance000000001",
        photo: null,
        updatedAt: 2,
        version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
        ...overrides,
    };
}

export interface FakeMurmurClientOptions {
    readonly acceptFailureAfterMutation?: FakeMutationFailure;
    readonly connects?: boolean;
    readonly contacts?: readonly MurmurContact[];
    readonly identity?: Uint8Array;
    readonly incoming?: readonly MurmurContactRequested[];
    readonly invitationWaitsForAbort?: boolean;
    readonly outgoing?: readonly MurmurOutgoingContactRequest[];
    readonly profileUpdateErrors?: readonly unknown[];
    readonly rejectFailureAfterMutation?: FakeMutationFailure;
    readonly removeFailureAfterMutation?: FakeMutationFailure;
    readonly requestFailureAfterMutation?: FakeMutationFailure;
    readonly revocationErrors?: readonly unknown[];
    readonly revocationWaitsForAbort?: boolean;
    readonly onRevokeInvitations?: (signal?: AbortSignal) => Promise<void> | void;
    readonly resolveErrors?: readonly unknown[];
    readonly resolvedIdentity?: Uint8Array;
    readonly syncErrors?: readonly unknown[];
}

export interface FakeMutationFailure {
    readonly operation: unknown;
    readonly reconciliation: unknown;
}

/**
 * A Murmur client that never reaches a relay.
 *
 * The facade the service asks for is narrow on purpose, so every path through sharing can be
 * driven from here: contacts and requests are ordinary arrays, and the relay loop is a promise
 * that only ends when the service aborts it.
 */
export class FakeMurmurClient implements MurmurClientFacade {
    closed = false;
    readonly identity: Uint8Array;
    invitationSignal: AbortSignal | undefined;
    profileUpdateCalls = 0;
    readonly publishedProfiles: MurmurContactProfile[] = [];
    revocationCalls = 0;
    readonly revocationSignals: (AbortSignal | undefined)[] = [];
    resolveCalls = 0;
    /** Every profile this installation put on the wire, newest last. */
    readonly sentProfiles: MurmurContactProfile[] = [];
    syncCalls = 0;
    readonly #acceptFailureAfterMutation: FakeMutationFailure | undefined;
    readonly #contactReadErrors: unknown[] = [];
    readonly #contacts: MurmurContact[];
    readonly #connects: boolean;
    readonly #incoming: MurmurContactRequested[];
    readonly #incomingReadErrors: unknown[] = [];
    readonly #invitationWaitsForAbort: boolean;
    readonly #outgoing: MurmurOutgoingContactRequest[];
    readonly #outgoingReadErrors: unknown[] = [];
    readonly #profileUpdateErrors: unknown[];
    readonly #rejectFailureAfterMutation: FakeMutationFailure | undefined;
    readonly #removeFailureAfterMutation: FakeMutationFailure | undefined;
    readonly #requestFailureAfterMutation: FakeMutationFailure | undefined;
    readonly #revocationErrors: unknown[];
    readonly #revocationWaitsForAbort: boolean;
    readonly #onRevokeInvitations: ((signal?: AbortSignal) => Promise<void> | void) | undefined;
    readonly #resolveErrors: unknown[];
    readonly #resolvedIdentity: Uint8Array;
    readonly #syncErrors: unknown[];
    #contactsGate: Promise<void> | undefined;
    #syncOptions: MurmurSyncOptions | undefined;

    constructor(options: FakeMurmurClientOptions = {}) {
        this.#acceptFailureAfterMutation = options.acceptFailureAfterMutation;
        this.#contacts = [...(options.contacts ?? [])];
        this.#connects = options.connects ?? true;
        this.identity = options.identity ?? SELF;
        this.#incoming = [...(options.incoming ?? [])];
        this.#invitationWaitsForAbort = options.invitationWaitsForAbort ?? false;
        this.#outgoing = [...(options.outgoing ?? [])];
        this.#profileUpdateErrors = [...(options.profileUpdateErrors ?? [])];
        this.#rejectFailureAfterMutation = options.rejectFailureAfterMutation;
        this.#removeFailureAfterMutation = options.removeFailureAfterMutation;
        this.#requestFailureAfterMutation = options.requestFailureAfterMutation;
        this.#revocationErrors = [...(options.revocationErrors ?? [])];
        this.#revocationWaitsForAbort = options.revocationWaitsForAbort ?? false;
        this.#onRevokeInvitations = options.onRevokeInvitations;
        this.#resolveErrors = [...(options.resolveErrors ?? [])];
        this.#resolvedIdentity = options.resolvedIdentity ?? REMOTE;
        this.#syncErrors = [...(options.syncErrors ?? [])];
    }

    /** Holds every later contact read until the returned function lets it through. */
    holdContacts(): () => void {
        let release!: () => void;
        this.#contactsGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        return () => {
            this.#contactsGate = undefined;
            release();
        };
    }

    async acceptContact(sessionId: Uint8Array, profile: MurmurContactProfile): Promise<void> {
        this.sentProfiles.push(profile);
        const index = this.#requestIndex(sessionId);
        const request = this.#incoming[index];
        if (request === undefined) throw new Error("Unknown request");
        this.#incoming.splice(index, 1);
        this.#contacts.push({
            identity: request.identity,
            localProfile: profile,
            profile: request.profile,
            sessionId: request.sessionId,
            status: "active",
        });
        if (this.#acceptFailureAfterMutation !== undefined) {
            this.#contactReadErrors.push(this.#acceptFailureAfterMutation.reconciliation);
            throw this.#acceptFailureAfterMutation.operation;
        }
    }

    close(): void {
        this.closed = true;
    }

    async contactRequests(): Promise<readonly MurmurContactRequested[]> {
        const error = this.#incomingReadErrors.shift();
        if (error !== undefined) throw error;
        return this.#incoming;
    }

    async contacts(): Promise<readonly MurmurContact[]> {
        await this.#contactsGate;
        const error = this.#contactReadErrors.shift();
        if (error !== undefined) throw error;
        return this.#contacts;
    }

    async createInvitation(signal?: AbortSignal): Promise<Uint8Array> {
        this.invitationSignal = signal;
        if (this.#invitationWaitsForAbort) {
            await new Promise<void>((_resolve, reject) => {
                if (signal?.aborted === true) {
                    reject(new Error("The invitation was aborted."));
                    return;
                }
                signal?.addEventListener(
                    "abort",
                    () => reject(new Error("The invitation was aborted.")),
                    { once: true },
                );
            });
        }
        return INVITATION;
    }

    async outgoingContactRequests(): Promise<readonly MurmurOutgoingContactRequest[]> {
        const error = this.#outgoingReadErrors.shift();
        if (error !== undefined) throw error;
        return this.#outgoing;
    }

    seedOutgoing(requests: readonly MurmurOutgoingContactRequest[]): void {
        this.#outgoing.push(...requests);
    }

    async rejectContact(sessionId: Uint8Array): Promise<void> {
        const index = this.#requestIndex(sessionId);
        if (index < 0) throw new Error("Unknown request");
        this.#incoming.splice(index, 1);
        if (this.#rejectFailureAfterMutation !== undefined) {
            this.#incomingReadErrors.push(this.#rejectFailureAfterMutation.reconciliation);
            throw this.#rejectFailureAfterMutation.operation;
        }
    }

    async removeContact(identity: Uint8Array): Promise<void> {
        const index = this.#contacts.findIndex((contact) =>
            Buffer.from(contact.identity).equals(Buffer.from(identity)),
        );
        if (index < 0) throw new Error("Unknown contact");
        this.#contacts.splice(index, 1);
        if (this.#removeFailureAfterMutation !== undefined) {
            this.#contactReadErrors.push(this.#removeFailureAfterMutation.reconciliation);
            throw this.#removeFailureAfterMutation.operation;
        }
    }

    async revokeInvitations(signal?: AbortSignal): Promise<void> {
        this.revocationCalls += 1;
        this.revocationSignals.push(signal);
        await this.#onRevokeInvitations?.(signal);
        if (this.#revocationWaitsForAbort) {
            await new Promise<void>((_resolve, reject) => {
                const aborted = (): void => reject(new DOMException("Aborted", "AbortError"));
                if (signal?.aborted === true) {
                    aborted();
                    return;
                }
                signal?.addEventListener("abort", aborted, { once: true });
            });
        }
        const error = this.#revocationErrors.shift();
        if (error !== undefined) throw error;
    }

    async resolveInvitation(): Promise<{ readonly identityKey: Uint8Array }> {
        this.resolveCalls += 1;
        const error = this.#resolveErrors.shift();
        if (error !== undefined) throw error;
        return { identityKey: this.#resolvedIdentity };
    }

    async requestContact(
        _invitation: Uint8Array,
        profile: MurmurContactProfile,
    ): Promise<{ readonly id: Uint8Array }> {
        this.sentProfiles.push(profile);
        this.#outgoing.push({
            createdAt: 1_000,
            identity: this.#resolvedIdentity,
            sessionId: SESSION,
        });
        if (this.#requestFailureAfterMutation !== undefined) {
            this.#outgoingReadErrors.push(this.#requestFailureAfterMutation.reconciliation);
            throw this.#requestFailureAfterMutation.operation;
        }
        return { id: SESSION };
    }

    async synchronize(
        _options?: MurmurSynchronizeOptions,
        _lifecycle?: Pick<
            MurmurSyncOptions,
            | "onUpdates"
            | "onContactRequested"
            | "onContactAdded"
            | "onContactUpdated"
            | "onContactRemoved"
        >,
    ): Promise<MurmurSynchronizeResult> {
        return {
            inbox: { cursor: null, exhausted: true, processed: 0, rejected: 0 },
            issues: [],
            pendingOutboxes: 0,
            published: 0,
            terminalPublicationFailures: 0,
            transientPublicationFailures: 0,
        };
    }

    async sync(options: MurmurSyncOptions = {}): Promise<void> {
        this.syncCalls += 1;
        this.#syncOptions = options;
        const error = this.#syncErrors.shift();
        if (error !== undefined) throw error;
        if (this.#connects) await options.onConnected?.();
        if (options.abort?.aborted !== true) {
            await new Promise<void>((resolve) => {
                options.abort?.addEventListener("abort", () => resolve(), { once: true });
            });
        }
        await options.onDisconnected?.();
        this.#syncOptions = undefined;
    }

    async updateContactProfile(profile: MurmurContactProfile): Promise<void> {
        this.profileUpdateCalls += 1;
        const error = this.#profileUpdateErrors.shift();
        if (error !== undefined) throw error;
        this.publishedProfiles.push(structuredClone(profile));
        for (let index = 0; index < this.#contacts.length; index += 1) {
            const contact = this.#contacts[index];
            if (contact?.status !== "active") continue;
            this.#contacts[index] = { ...contact, localProfile: structuredClone(profile) };
        }
    }

    async updateRemoteContactProfile(
        identity: Uint8Array,
        profile: MurmurContactProfile,
        id = "contact-profile-update",
    ): Promise<void> {
        const index = this.#contacts.findIndex((contact) =>
            Buffer.from(contact.identity).equals(Buffer.from(identity)),
        );
        const current = this.#contacts[index];
        if (current === undefined) throw new Error("Unknown contact");
        const contact: MurmurContact = { ...current, profile: structuredClone(profile) };
        this.#contacts[index] = contact;
        const update: MurmurContactUpdated = { contact, id };
        await this.#syncOptions?.onContactUpdated?.([update]);
    }

    #requestIndex(sessionId: Uint8Array): number {
        return this.#incoming.findIndex((request) =>
            Buffer.from(request.sessionId).equals(Buffer.from(sessionId)),
        );
    }
}
