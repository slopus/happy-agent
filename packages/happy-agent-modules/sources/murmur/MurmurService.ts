import {
    DISCOVERY_INVITATION_TTL_MILLISECONDS,
    type MurmurContact,
    type MurmurContactProfile,
    type MurmurContactRequested,
    type MurmurOutgoingContactRequest,
    type MurmurSynchronizeOptions,
    type MurmurSynchronizeResult,
    type MurmurSyncOptions,
} from "@slopus/murmur";
import { Value } from "@sinclair/typebox/value";
import type { Context, RootContext } from "@steve.kite/stdlib";

import type { ProfileModule } from "../profile/ProfileModule.js";

import { readMurmurBinding, bindMurmurProfile } from "./MurmurDatabase.js";
import {
    MURMUR_RELATIONSHIP_LIMIT,
    murmurCarriedProfileSchema,
    type MurmurConnection,
    type MurmurContactRecord,
    type MurmurIncomingRequest,
    type MurmurInvitation,
    type MurmurOutgoingRequest,
    type MurmurPeerProfile,
    type MurmurSnapshot,
} from "./MurmurTypes.js";

const SYNC_RETRY_INITIAL_MILLISECONDS = 1_000;
const SYNC_RETRY_MAXIMUM_MILLISECONDS = 60_000;

/**
 * Exactly as much of a Murmur client as sharing uses.
 *
 * Narrowing it here is what lets a test drive every path below without a relay, and keeps the
 * rest of Murmur's session surface out of a capability that is only about people.
 */
export interface MurmurClientFacade {
    readonly identity: Uint8Array;
    acceptContact(sessionId: Uint8Array, profile: MurmurContactProfile): Promise<void>;
    close(): void;
    contactRequests(): Promise<readonly MurmurContactRequested[]>;
    contacts(): Promise<readonly MurmurContact[]>;
    createInvitation(signal?: AbortSignal): Promise<Uint8Array>;
    outgoingContactRequests(): Promise<readonly MurmurOutgoingContactRequest[]>;
    rejectContact(sessionId: Uint8Array): Promise<void>;
    removeContact(identity: Uint8Array): Promise<void>;
    revokeInvitations(signal?: AbortSignal): Promise<void>;
    resolveInvitation(
        invitation: Uint8Array,
        signal?: AbortSignal,
    ): Promise<{ readonly identityKey: Uint8Array }>;
    requestContact(
        invitation: Uint8Array,
        profile: MurmurContactProfile,
        signal?: AbortSignal,
    ): Promise<{ readonly id: Uint8Array }>;
    synchronize(
        options?: MurmurSynchronizeOptions,
        lifecycle?: Pick<
            MurmurSyncOptions,
            | "onUpdates"
            | "onContactRequested"
            | "onContactAdded"
            | "onContactUpdated"
            | "onContactRemoved"
        >,
    ): Promise<MurmurSynchronizeResult>;
    sync(options?: MurmurSyncOptions): Promise<void>;
    updateContactProfile(profile: MurmurContactProfile): Promise<void>;
}

export interface MurmurServiceOptions {
    readonly client: MurmurClientFacade;
    /**
     * The lifetime the relay loop runs on, with the agent database attached.
     *
     * The loop outlives every call that touches it, so it must never borrow the context of the
     * request that happened to start it. The module derives this once and hands it down.
     */
    readonly lifetime: RootContext;
    /** The catalog holding the one person this installation shares as. */
    readonly profile: ProfileModule;
    readonly publish: (ctx: Context) => void;
}

/**
 * Contacts over one live Murmur identity.
 *
 * Everything durable belongs to Murmur's own store or to the binding row; what is held here is
 * only what a live connection means — the client, the abort that stops it, and the connection
 * state a client is shown while it lasts.
 */
export class MurmurService {
    readonly #abort = new AbortController();
    readonly #activeOperations = new Set<Promise<unknown>>();
    readonly #client: MurmurClientFacade;
    readonly #identity: string;
    readonly #profile: ProfileModule;
    readonly #publish: (ctx: Context) => void;
    readonly #root: RootContext;
    #closePromise: Promise<void> | undefined;
    #closing = false;
    #connection: MurmurConnection = "connecting";
    #publishTimer: ReturnType<typeof setTimeout> | undefined;
    #started = false;
    #sync: Promise<void> | undefined;

    constructor(options: MurmurServiceOptions) {
        this.#client = options.client;
        this.#identity = encodeBytes(options.client.identity);
        this.#profile = options.profile;
        this.#publish = options.publish;
        this.#root = options.lifetime;
    }

    /** The identity every contact of this installation knows it by. */
    get identity(): string {
        return this.#identity;
    }

    /**
     * Re-asserts a binding this installation already made.
     *
     * A restart opens the same identity from the same store, so the binding row is confirmed
     * rather than created; a mismatch means the store and the record disagree about who this is,
     * and that is refused here rather than discovered halfway through a contact exchange.
     */
    async initializeBinding(ctx: Context): Promise<void> {
        const binding = await readMurmurBinding(ctx);
        if (binding === undefined) return;
        await bindMurmurProfile(ctx, binding.profileId, this.#identity, Date.now());
    }

    start(_ctx: Context): void {
        if (this.#closing) throw new Error("Sharing is closing.");
        if (this.#started) return;
        this.#started = true;
        this.#sync = this.#synchronize();
    }

    async snapshot(ctx: Context): Promise<MurmurSnapshot> {
        return this.#run(ctx, async () => {
            const [contacts, incomingRequests, outgoingRequests, binding] = await Promise.all([
                this.#client.contacts(),
                this.#client.contactRequests(),
                this.#client.outgoingContactRequests(),
                readMurmurBinding(ctx),
            ]);
            return {
                connection: this.#connection,
                contacts: contacts.slice(0, MURMUR_RELATIONSHIP_LIMIT).map(toContactRecord),
                identity: this.#identity,
                incomingRequests: incomingRequests
                    .slice(0, MURMUR_RELATIONSHIP_LIMIT)
                    .map(toIncomingRequest),
                outgoingRequests: outgoingRequests
                    .slice(0, MURMUR_RELATIONSHIP_LIMIT)
                    .map(toOutgoingRequest),
                profileId: binding?.profileId ?? null,
            };
        });
    }

    async bindProfile(ctx: Context, profileId: string): Promise<void> {
        if (this.#closing) throw new Error("Sharing is closing.");
        const profile = await this.#profile.getById(ctx, profileId);
        if (profile === undefined || !(await this.#profile.isLocal(ctx, profileId))) {
            throw new Error("Sharing requires a profile owned by this installation.");
        }
        await bindMurmurProfile(ctx, profileId, this.#identity, Date.now());
    }

    async createInvitation(ctx: Context, signal?: AbortSignal): Promise<MurmurInvitation> {
        await this.#requireLocalProfile(ctx);
        const createdAt = Date.now();
        return this.#run(ctx, async () => {
            const invitation = await this.#client.createInvitation(this.#operationSignal(signal));
            return {
                expiresAt: createdAt + DISCOVERY_INVITATION_TTL_MILLISECONDS,
                invitation: encodeBytes(invitation),
            };
        });
    }

    async requestContact(
        ctx: Context,
        invitation: string,
        identity: string,
        signal?: AbortSignal,
    ): Promise<MurmurOutgoingRequest> {
        const profile = encodeProfile(await this.#requireLocalProfile(ctx));
        const resolvedIdentity = encodeBytes(decodeBytes(identity));
        return this.#run(ctx, async () => {
            const decodedInvitation = decodeBytes(invitation);
            const operationSignal = this.#operationSignal(signal);
            const session = await this.#client.requestContact(
                decodedInvitation,
                profile,
                operationSignal,
            );
            const sessionId = encodeBytes(session.id);
            return { id: sessionId, identity: resolvedIdentity, sessionId };
        });
    }

    /** Resolves an invitation to its identity without exposing the discovery bundle. */
    async resolveInvitation(invitation: string, signal?: AbortSignal): Promise<string> {
        return await this.#run(this.#root, async () => {
            const bundle = await this.#client.resolveInvitation(
                decodeBytes(invitation),
                this.#operationSignal(signal),
            );
            return encodeBytes(bundle.identityKey);
        });
    }

    async acceptContact(ctx: Context, requestId: string): Promise<void> {
        const profile = encodeProfile(await this.#requireLocalProfile(ctx));
        await this.#run(ctx, async () => {
            const request = await this.#request(requestId);
            if (decodeProfile(request.profile) === null) {
                throw new Error("The contact request does not contain a valid profile.");
            }
            await this.#client.acceptContact(request.sessionId, profile);
        });
    }

    async rejectContact(ctx: Context, requestId: string): Promise<void> {
        await this.#run(ctx, async () => {
            const request = await this.#request(requestId);
            await this.#client.rejectContact(request.sessionId);
        });
    }

    async removeContact(ctx: Context, identity: string): Promise<void> {
        await this.#run(ctx, async () => {
            await this.#client.removeContact(decodeBytes(identity));
        });
    }

    /** Revoke every owner-created relay invitation without changing Happy's durable projection. */
    async revokeInvitations(ctx: Context, signal?: AbortSignal): Promise<void> {
        await this.#run(ctx, async () => {
            await this.#client.revokeInvitations(this.#operationSignal(signal));
        });
    }

    /** Atomically retain and queue the latest local profile to every active contact. */
    async publishProfile(ctx: Context): Promise<void> {
        const profile = await this.#requireLocalProfile(ctx);
        await this.#run(ctx, async () => {
            await this.#client.updateContactProfile(encodeProfile(profile));
        });
    }

    close(ctx: Context): Promise<void> {
        this.#closePromise ??= this.#finishClose(ctx);
        return this.#closePromise;
    }

    async #finishClose(_ctx: Context): Promise<void> {
        this.#closing = true;
        if (this.#publishTimer !== undefined) {
            clearTimeout(this.#publishTimer);
            this.#publishTimer = undefined;
        }
        this.#abort.abort();
        await this.#sync;
        while (this.#activeOperations.size > 0) {
            await Promise.allSettled(this.#activeOperations);
        }
        this.#client.close();
    }

    /**
     * One relay connection, kept up for as long as sharing is on.
     *
     * A dropped connection is ordinary rather than exceptional — a laptop closes, a network
     * changes — so the loop reports it, backs off, and tries again instead of ending. Only an
     * abort ends it.
     */
    async #synchronize(): Promise<void> {
        let retryMilliseconds = SYNC_RETRY_INITIAL_MILLISECONDS;
        const contactLifecycle = {
            onContactAdded: () => this.#scheduleChanged(),
            onContactRemoved: () => this.#scheduleChanged(),
            onContactRequested: () => this.#scheduleChanged(),
            onContactUpdated: () => this.#scheduleChanged(),
            onUpdates: () => undefined,
        } satisfies Pick<
            MurmurSyncOptions,
            | "onUpdates"
            | "onContactRequested"
            | "onContactAdded"
            | "onContactUpdated"
            | "onContactRemoved"
        >;
        while (!this.#abort.signal.aborted) {
            try {
                await this.#worker("murmur-synchronize", async () => {
                    await this.#client.synchronize(
                        { signal: this.#abort.signal },
                        contactLifecycle,
                    );
                });
                await this.#client.sync({
                    abort: this.#abort.signal,
                    ...contactLifecycle,
                    onConnected: () =>
                        this.#worker("murmur-connected", async (workerCtx) => {
                            retryMilliseconds = SYNC_RETRY_INITIAL_MILLISECONDS;
                            this.#setConnection(workerCtx, "connected");
                        }),
                    onDisconnected: () => void this.#setConnectionFromWorker("disconnected"),
                });
                if (this.#abort.signal.aborted) return;
                throw new Error("Murmur synchronization stopped unexpectedly.");
            } catch (error: unknown) {
                if (this.#abort.signal.aborted) return;
                await this.#setConnectionFromWorker("disconnected");
                this.#root.log.warn("Sharing could not reach the relay.", {}, error);
            }
            await this.#waitForSyncRetry(retryMilliseconds);
            retryMilliseconds = Math.min(SYNC_RETRY_MAXIMUM_MILLISECONDS, retryMilliseconds * 2);
            if (!this.#abort.signal.aborted) await this.#setConnectionFromWorker("connecting");
        }
    }

    async #request(requestId: string): Promise<MurmurContactRequested> {
        const request = (await this.#client.contactRequests()).find(
            (candidate) => candidate.id === requestId,
        );
        if (request === undefined) throw new Error("Contact request not found.");
        return request;
    }

    async #requireLocalProfile(ctx: Context): Promise<MurmurPeerProfile> {
        const binding = await readMurmurBinding(ctx);
        const profile =
            binding === undefined ? undefined : await this.#profile.getById(ctx, binding.profileId);
        if (profile === undefined || !(await this.#profile.isLocal(ctx, profile.id))) {
            throw new Error("Choose a local profile before using sharing.");
        }
        return profile;
    }

    #run<Result>(ctx: Context, operation: (ctx: Context) => Promise<Result>): Promise<Result> {
        if (this.#closing) return Promise.reject(new Error("Sharing is closing."));
        const result = Promise.resolve().then(() => operation(ctx));
        this.#activeOperations.add(result);
        void result.then(
            () => this.#activeOperations.delete(result),
            () => this.#activeOperations.delete(result),
        );
        return result;
    }

    #operationSignal(signal: AbortSignal | undefined): AbortSignal {
        return signal === undefined
            ? this.#abort.signal
            : AbortSignal.any([signal, this.#abort.signal]);
    }

    async #waitForSyncRetry(milliseconds: number): Promise<void> {
        await new Promise<void>((resolve) => {
            let finished = false;
            const finish = (): void => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                this.#abort.signal.removeEventListener("abort", finish);
                resolve();
            };
            const timer = setTimeout(finish, milliseconds);
            timer.unref?.();
            this.#abort.signal.addEventListener("abort", finish, { once: true });
            if (this.#abort.signal.aborted) finish();
        });
    }

    #setConnection(ctx: Context, connection: MurmurConnection): void {
        if (this.#connection === connection) return;
        this.#connection = connection;
        this.#changed(ctx);
    }

    async #setConnectionFromWorker(connection: MurmurConnection): Promise<void> {
        await this.#worker(`murmur-${connection}`, async (workerCtx) => {
            this.#setConnection(workerCtx, connection);
        });
    }

    /**
     * Collapses a burst of relay callbacks into one change.
     *
     * Synchronizing after a while offline delivers many contact events at once, and a client
     * only ever needs to know that the state moved.
     */
    #scheduleChanged(): void {
        if (this.#publishTimer !== undefined) return;
        this.#publishTimer = setTimeout(() => {
            this.#publishTimer = undefined;
            void this.#worker("murmur-publish-change", async (workerCtx) => {
                this.#changed(workerCtx);
            });
        }, 0);
        this.#publishTimer.unref?.();
    }

    #changed(ctx: Context): void {
        this.#publish(ctx);
    }

    /**
     * Background work on the sharing lifetime, which nobody is waiting on.
     *
     * There is no caller to hand a failure back to — the relay callback that started it has
     * already returned — so it is written to the log the lifetime carries and the loop goes on.
     */
    async #worker(name: string, work: (ctx: Context) => Promise<void>): Promise<void> {
        const workerCtx = this.#root.named(name);
        try {
            await work(workerCtx);
        } catch (error: unknown) {
            workerCtx.log.warn("Sharing could not finish background work.", {}, error);
        }
    }
}

function encodeProfile(profile: MurmurPeerProfile): MurmurContactProfile {
    return { profile, version: 1 } as unknown as MurmurContactProfile;
}

function decodeProfile(profile: MurmurContactProfile): MurmurPeerProfile | null {
    if (!Value.Check(murmurCarriedProfileSchema, profile)) return null;
    return (profile as unknown as { profile: MurmurPeerProfile }).profile;
}

function toContactRecord(contact: MurmurContact): MurmurContactRecord {
    return {
        identity: encodeBytes(contact.identity),
        profile: decodeProfile(contact.profile),
        status: contact.status,
    };
}

function toIncomingRequest(request: MurmurContactRequested): MurmurIncomingRequest {
    return {
        id: request.id,
        identity: encodeBytes(request.identity),
        profile: decodeProfile(request.profile),
        sessionId: encodeBytes(request.sessionId),
    };
}

function toOutgoingRequest(request: MurmurOutgoingContactRequest): MurmurOutgoingRequest {
    const sessionId = encodeBytes(request.sessionId);
    return { id: sessionId, identity: encodeBytes(request.identity), sessionId };
}

function encodeBytes(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}

function decodeBytes(value: string): Uint8Array {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== 32 || encodeBytes(decoded) !== value) {
        throw new Error("The Murmur identity or invitation is invalid.");
    }
    return decoded;
}
