import { createHash, randomBytes } from "node:crypto";

import { DiscoveryTransportError, MurmurClient, type MurmurStore } from "@slopus/murmur";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentDatabase,
    type AgentModule,
    type AgentModuleMigration,
} from "@slopus/happy-agent-base";
import { afterCommit, detach, type Context, type RootContext } from "@steve.kite/stdlib";

import {
    ProfileModule,
    type ProfileChangedEvent,
    type ProfileUnsubscribe,
} from "../profile/index.js";

import {
    advanceMurmurPublicState,
    ensureMurmurPublicState,
    murmurMigrations,
    readMurmurBinding,
    replaceMurmurIdentity,
    updateMurmurPublicState,
} from "./MurmurDatabase.js";
import { MurmurService, type MurmurClientFacade } from "./MurmurService.js";
import { SqliteMurmurStore } from "./SqliteMurmurStore.js";
import { StagedMurmurStore } from "./StagedMurmurStore.js";
import {
    MURMUR_RELATIONSHIP_LIMIT,
    MurmurOperationError,
    type MurmurChangedEvent,
    type MurmurDurableOutgoingRequest,
    type MurmurEventListener,
    type MurmurEventOrigin,
    type MurmurInvitation,
    type MurmurPendingOperation,
    type MurmurPeerProfile,
    type MurmurPublicState,
    type MurmurPublicStateContent,
    type MurmurSharingSnapshot,
    type MurmurSnapshot,
    type MurmurUnsubscribe,
} from "./MurmurTypes.js";

const MANAGED_MURMUR_RELAY = "https://murmur.cluster-fluster.com/";

interface OwnedMurmurStore extends MurmurStore {
    close(): Promise<void>;
}

interface OpenMurmur {
    readonly service: MurmurService;
    readonly store: OwnedMurmurStore;
}

/** Durable opt-in contact sharing over one locally owned Murmur identity. */
export class MurmurModule<Database extends AgentDatabase = AgentDatabase> implements AgentModule<
    never,
    Database
> {
    readonly name = "murmur";
    readonly migrations: readonly AgentModuleMigration<Database>[];
    readonly #listeners = new Set<MurmurEventListener>();
    readonly #profile: ProfileModule;
    readonly #profileUnsubscribe: ProfileUnsubscribe;
    #closing = false;
    #lifetime: RootContext | undefined;
    #open: OpenMurmur | undefined;
    #profilePublish: Promise<void> | undefined;
    #profilePublishRequested = false;
    #tail: Promise<void> = Promise.resolve();

    constructor(profile: ProfileModule) {
        this.#profile = profile;
        this.migrations = murmurMigrations as readonly AgentModuleMigration<Database>[];
        this.#profileUnsubscribe = profile.onEvent((ctx, event) => {
            afterCommit(ctx, () => {
                const lifetime = this.#lifetime;
                if (lifetime === undefined) return;
                return this.#profileChanged(lifetime.named("murmur-local-profile-changed"), event);
            });
        });
    }

    /** Whether an enrolled identity has a local client open. */
    get running(): boolean {
        return this.#open !== undefined;
    }

    onEvent(listener: MurmurEventListener): MurmurUnsubscribe {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Initialize the projection, reopen enrolled state, and reconcile interrupted operations. */
    async open(ctx: Context): Promise<void> {
        await this.#transition(async () => {
            if (this.#closing || this.#open !== undefined) return;
            this.#lifetimeFrom(ctx);
            const state = await ensureMurmurPublicState(ctx);
            if (!state.enrolled) {
                const enroll = state.pendingOperations.find(
                    (operation) => operation.type === "enroll",
                );
                if (enroll !== undefined) await this.#executeEnroll(ctx, enroll.id, "background");
                return;
            }

            const opened = await this.#start(ctx, "existing");
            this.#open = opened;
            try {
                const runtime = await this.#runtimeSnapshot(ctx, opened);
                await this.#projectRuntime(ctx, runtime, "background", {
                    dropUnresolvedOutgoing: true,
                    forceVersion: true,
                });
                opened.service.start(ctx);
                await this.#recoverPendingOperations(ctx);
                this.#scheduleProfilePublish();
            } catch (error: unknown) {
                this.#open = undefined;
                await this.#stop(ctx, opened);
                throw error;
            }
        });
    }

    /** Explicitly opts this installation in, creating its profile and identity exactly once. */
    async enroll(ctx: Context): Promise<MurmurSharingSnapshot> {
        return await this.#transition(async () => {
            this.#requireAvailable();
            const state = await ensureMurmurPublicState(ctx);
            if (state.enrolled) return this.#stateSnapshot(state);
            const existing = state.pendingOperations.find(
                (operation) => operation.type === "enroll",
            );
            const operationId = existing?.id ?? createInternalId();
            return await this.#stageOperation(
                ctx,
                (current) => ({
                    ...content(current),
                    pendingOperations:
                        existing === undefined
                            ? [...current.pendingOperations, { id: operationId, type: "enroll" }]
                            : current.pendingOperations,
                }),
                async (postCommitCtx) =>
                    await this.#executeEnroll(postCommitCtx, operationId, "mutation"),
            );
        });
    }

    /** Reads only the durable authoritative projection and never depends on the live client. */
    async snapshot(ctx: Context): Promise<MurmurSharingSnapshot> {
        return this.#stateSnapshot(await ensureMurmurPublicState(ctx));
    }

    /** Creates a five-minute sensitive invitation. It does not change public state. */
    async createInvitation(ctx: Context, signal?: AbortSignal): Promise<MurmurInvitation> {
        return await this.#transition(async () => {
            await this.#requireEnrolledState(ctx);
            try {
                return await this.#requireOpen().service.createInvitation(ctx, signal);
            } catch (error: unknown) {
                throw unavailable("Sharing could not create an invitation right now.", error);
            }
        });
    }

    /** Reserve one bounded outgoing entry before Murmur can redeem the capability. */
    async requestContact(
        ctx: Context,
        invitation: string,
        signal?: AbortSignal,
    ): Promise<MurmurSharingSnapshot> {
        return await this.#transition(async () => {
            const state = await this.#requireEnrolledState(ctx);
            const digest = invitationDigest(invitation);
            const existing = state.outgoingRequests.find(
                (request) => request.invitationDigest === digest,
            );
            if (existing?.status === "active") return this.#stateSnapshot(state);
            if (
                existing === undefined &&
                state.outgoingRequests.length >= MURMUR_RELATIONSHIP_LIMIT
            ) {
                throw new MurmurOperationError(
                    "full",
                    "Sharing already has too many outgoing requests.",
                );
            }
            const publicId = existing?.id ?? createPublicRequestId(invitation, state);
            return await this.#stageOperation(
                ctx,
                (current) => ({
                    ...content(current),
                    outgoingRequests:
                        existing === undefined
                            ? [
                                  ...current.outgoingRequests,
                                  {
                                      id: publicId,
                                      identity: null,
                                      invitationDigest: digest,
                                      sessionId: null,
                                      status: "pending",
                                  },
                              ]
                            : current.outgoingRequests,
                }),
                async (postCommitCtx) =>
                    await this.#executeRequest(
                        postCommitCtx,
                        publicId,
                        invitation,
                        signal,
                        "mutation",
                    ),
            );
        });
    }

    async acceptContact(ctx: Context, requestId: string): Promise<MurmurSharingSnapshot> {
        return await this.#transition(async () => {
            const state = await this.#requireEnrolledState(ctx);
            const pending = state.pendingOperations.find(
                (
                    operation,
                ): operation is Extract<MurmurPendingOperation, { type: "accept" | "reject" }> =>
                    (operation.type === "accept" || operation.type === "reject") &&
                    operation.requestId === requestId,
            );
            if (pending?.type === "reject") {
                throw new MurmurOperationError(
                    "conflict",
                    "The sharing request already has a pending rejection.",
                );
            }
            const request = state.incomingRequests.find((candidate) => candidate.id === requestId);
            if (request === undefined) {
                throw new MurmurOperationError("not_found", "The sharing request was not found.");
            }
            if (state.contacts.length >= MURMUR_RELATIONSHIP_LIMIT) {
                throw new MurmurOperationError("full", "Sharing already has too many contacts.");
            }
            if (request.profile === null) {
                throw new MurmurOperationError(
                    "conflict",
                    "The sharing request does not contain a readable profile.",
                );
            }
            const operation = pending ?? pendingRequestOperation("accept", request);
            return await this.#stageOperation(
                ctx,
                (current) => addPendingOperation(current, operation),
                async (postCommitCtx) =>
                    await this.#executeRequestDecision(postCommitCtx, operation, "mutation"),
            );
        });
    }

    async rejectContact(ctx: Context, requestId: string): Promise<MurmurSharingSnapshot> {
        return await this.#transition(async () => {
            const state = await this.#requireEnrolledState(ctx);
            const pending = state.pendingOperations.find(
                (
                    operation,
                ): operation is Extract<MurmurPendingOperation, { type: "accept" | "reject" }> =>
                    (operation.type === "accept" || operation.type === "reject") &&
                    operation.requestId === requestId,
            );
            if (pending?.type === "accept") {
                throw new MurmurOperationError(
                    "conflict",
                    "The sharing request already has a pending acceptance.",
                );
            }
            const request = state.incomingRequests.find((candidate) => candidate.id === requestId);
            if (request === undefined) {
                throw new MurmurOperationError("not_found", "The sharing request was not found.");
            }
            const operation = pending ?? pendingRequestOperation("reject", request);
            return await this.#stageOperation(
                ctx,
                (current) => addPendingOperation(current, operation),
                async (postCommitCtx) =>
                    await this.#executeRequestDecision(postCommitCtx, operation, "mutation"),
            );
        });
    }

    async removeContact(ctx: Context, identity: string): Promise<MurmurSharingSnapshot> {
        return await this.#transition(async () => {
            const state = await this.#requireEnrolledState(ctx);
            const contact = state.contacts.find((candidate) => candidate.identity === identity);
            if (contact === undefined) {
                throw new MurmurOperationError("not_found", "The sharing contact was not found.");
            }
            if (contact.status === "removing") return this.#stateSnapshot(state);
            const operation =
                state.pendingOperations.find(
                    (candidate): candidate is Extract<MurmurPendingOperation, { type: "remove" }> =>
                        candidate.type === "remove" && candidate.identity === identity,
                ) ??
                ({
                    id: createInternalId(),
                    identity,
                    type: "remove",
                } satisfies MurmurPendingOperation);
            return await this.#stageOperation(
                ctx,
                (current) => addPendingOperation(current, operation),
                async (postCommitCtx) =>
                    await this.#executeRemoval(postCommitCtx, operation, "mutation"),
            );
        });
    }

    /** Reset is staged on memory; old durable keys remain intact until replacement open succeeds. */
    async reset(ctx: Context, signal?: AbortSignal): Promise<MurmurSharingSnapshot> {
        return await this.#transition(async () => {
            const state = await this.#requireEnrolledState(ctx);
            const existing = state.pendingOperations.find(
                (operation) => operation.type === "reset",
            );
            const operationId = existing?.id ?? createInternalId();
            return await this.#stageOperation(
                ctx,
                (current) => ({
                    ...content(current),
                    pendingOperations:
                        existing === undefined
                            ? [...current.pendingOperations, { id: operationId, type: "reset" }]
                            : current.pendingOperations,
                }),
                async (postCommitCtx) =>
                    await this.#executeReset(postCommitCtx, operationId, "mutation", signal),
            );
        });
    }

    async close(ctx: Context): Promise<void> {
        this.#closing = true;
        this.#profileUnsubscribe();
        await this.#transition(async () => {
            const open = this.#open;
            this.#open = undefined;
            if (open !== undefined) await this.#stop(ctx, open);
        });
        await this.#profilePublish;
    }

    /** The only network seam. The relay is product-managed and is not user configuration. */
    protected async openClient(_ctx: Context, store: MurmurStore): Promise<MurmurClientFacade> {
        return await MurmurClient.open({ relay: MANAGED_MURMUR_RELAY, store });
    }

    async #executeEnroll(
        ctx: Context,
        operationId: string,
        origin: MurmurEventOrigin,
    ): Promise<MurmurSharingSnapshot> {
        const current = await ensureMurmurPublicState(ctx);
        if (current.enrolled) {
            await this.#removePendingOperation(ctx, operationId);
            return this.#stateSnapshot(await ensureMurmurPublicState(ctx));
        }
        const profile = await this.#profile.ensure(ctx);
        let opened = this.#open;
        let created = false;
        try {
            if (opened === undefined) {
                opened = await this.#start(
                    ctx,
                    (await readMurmurBinding(ctx)) === undefined ? profile.id : "existing",
                );
                created = true;
                this.#open = opened;
            }
            const runtime = await this.#runtimeSnapshot(ctx, opened);
            const next = await this.#advance(ctx, origin, (state) => ({
                ...reconcileRuntimeContent(state, runtime, false),
                enrolled: true,
                localProfileVersion: profile.version,
                pendingOperations: state.pendingOperations.filter(
                    (operation) => operation.id !== operationId,
                ),
            }));
            opened.service.start(ctx);
            this.#scheduleProfilePublish();
            return this.#stateSnapshot(next);
        } catch (error: unknown) {
            if (created && opened !== undefined) {
                this.#open = undefined;
                await this.#stop(ctx, opened).catch(() => undefined);
            }
            throw unavailable("Sharing could not create its local identity.", error);
        }
    }

    async #executeRequest(
        ctx: Context,
        publicId: string,
        invitation: string,
        signal: AbortSignal | undefined,
        origin: MurmurEventOrigin,
    ): Promise<MurmurSharingSnapshot> {
        let state = await this.#requireEnrolledState(ctx);
        let reservation = state.outgoingRequests.find((request) => request.id === publicId);
        if (reservation === undefined || reservation.status === "active") {
            return this.#stateSnapshot(state);
        }
        const open = this.#requireOpen();
        let runtime = await this.#runtimeSnapshot(ctx, open);
        const reservedIdentity = reservation.identity;
        if (
            reservedIdentity !== null &&
            runtime.outgoingRequests.some((request) => request.identity === reservedIdentity)
        ) {
            return this.#stateSnapshot(await this.#projectRuntime(ctx, runtime, origin));
        }

        let identity: string;
        try {
            identity = await open.service.resolveInvitation(invitation, signal);
        } catch (error: unknown) {
            await this.#removeOutgoingReservation(ctx, publicId);
            throw invitationFailure(error);
        }
        try {
            validateRequestedIdentity(state, identity, publicId);
        } catch (error: unknown) {
            await this.#removeOutgoingReservation(ctx, publicId);
            throw error;
        }
        state = await updateMurmurPublicState(ctx, (current) => ({
            ...content(current),
            outgoingRequests: current.outgoingRequests.map((request) =>
                request.id === publicId && request.status === "pending"
                    ? { ...request, identity }
                    : request,
            ),
        }));
        reservation = state.outgoingRequests.find((request) => request.id === publicId);
        if (reservation === undefined || reservation.status === "active") {
            return this.#stateSnapshot(state);
        }

        try {
            await open.service.requestContact(ctx, invitation, identity, signal);
        } catch (error: unknown) {
            try {
                runtime = await this.#runtimeSnapshot(ctx, open);
                if (runtime.outgoingRequests.some((request) => request.identity === identity)) {
                    return this.#stateSnapshot(await this.#projectRuntime(ctx, runtime, origin));
                }
            } catch {
                throw unavailable(
                    "Sharing could not reconcile the interrupted contact request.",
                    error,
                );
            }
            await this.#removeOutgoingReservation(ctx, publicId);
            throw invitationFailure(error);
        }
        runtime = await this.#runtimeSnapshot(ctx, open);
        return this.#stateSnapshot(await this.#projectRuntime(ctx, runtime, origin));
    }

    async #executeRequestDecision(
        ctx: Context,
        operation: Extract<MurmurPendingOperation, { type: "accept" | "reject" }>,
        origin: MurmurEventOrigin,
    ): Promise<MurmurSharingSnapshot> {
        const open = this.#requireOpen();
        let runtime = await this.#runtimeSnapshot(ctx, open);
        if (
            !runtime.incomingRequests.some((request) => request.sessionId === operation.sessionId)
        ) {
            const desired =
                operation.type === "reject" ||
                runtime.contacts.some((contact) => contact.identity === operation.identity);
            const projected = await this.#projectRuntime(
                ctx,
                runtime,
                desired ? origin : "background",
            );
            if (desired) {
                if (operation.type === "accept") this.#scheduleProfilePublish();
                return this.#stateSnapshot(projected);
            }
            throw new MurmurOperationError("not_found", "The sharing request was not found.");
        }
        try {
            if (operation.type === "accept") {
                await open.service.acceptContact(ctx, operation.requestId);
            } else {
                await open.service.rejectContact(ctx, operation.requestId);
            }
        } catch (error: unknown) {
            try {
                runtime = await this.#runtimeSnapshot(ctx, open);
                const desired =
                    operation.type === "accept"
                        ? runtime.contacts.some(
                              (contact) => contact.identity === operation.identity,
                          )
                        : !runtime.incomingRequests.some(
                              (request) => request.sessionId === operation.sessionId,
                          );
                const projected = await this.#projectRuntime(
                    ctx,
                    runtime,
                    desired ? origin : "background",
                );
                if (desired) {
                    if (operation.type === "accept") this.#scheduleProfilePublish();
                    return this.#stateSnapshot(projected);
                }
            } catch {
                throw unavailable("The sharing request could not be reconciled.", error);
            }
            throw unavailable(
                operation.type === "accept"
                    ? "The sharing request could not be accepted."
                    : "The sharing request could not be rejected.",
                error,
            );
        }
        runtime = await this.#runtimeSnapshot(ctx, open);
        const projected = await this.#projectRuntime(ctx, runtime, origin);
        if (operation.type === "accept") this.#scheduleProfilePublish();
        return this.#stateSnapshot(projected);
    }

    async #executeRemoval(
        ctx: Context,
        operation: Extract<MurmurPendingOperation, { type: "remove" }>,
        origin: MurmurEventOrigin,
    ): Promise<MurmurSharingSnapshot> {
        const open = this.#requireOpen();
        let runtime = await this.#runtimeSnapshot(ctx, open);
        const contact = runtime.contacts.find(
            (candidate) => candidate.identity === operation.identity,
        );
        if (contact === undefined) {
            return this.#stateSnapshot(await this.#projectRuntime(ctx, runtime, origin));
        }
        if (contact.status === "removing") {
            return this.#stateSnapshot(await this.#projectRuntime(ctx, runtime, "background"));
        }
        try {
            await open.service.removeContact(ctx, operation.identity);
        } catch (error: unknown) {
            try {
                runtime = await this.#runtimeSnapshot(ctx, open);
                const desired = runtime.contacts.every(
                    (candidate) =>
                        candidate.identity !== operation.identity ||
                        candidate.status === "removing",
                );
                const projected = await this.#projectRuntime(
                    ctx,
                    runtime,
                    desired ? origin : "background",
                );
                if (desired) return this.#stateSnapshot(projected);
            } catch {
                throw unavailable("The sharing contact removal could not be reconciled.", error);
            }
            throw unavailable("The sharing contact could not be removed.", error);
        }
        runtime = await this.#runtimeSnapshot(ctx, open);
        return this.#stateSnapshot(await this.#projectRuntime(ctx, runtime, origin));
    }

    async #executeReset(
        ctx: Context,
        operationId: string,
        origin: MurmurEventOrigin,
        signal?: AbortSignal,
    ): Promise<MurmurSharingSnapshot> {
        const state = await this.#requireEnrolledState(ctx);
        if (!state.pendingOperations.some((operation) => operation.id === operationId)) {
            return this.#stateSnapshot(state);
        }
        const binding = await readMurmurBinding(ctx);
        if (binding === undefined) throw unavailable("Sharing has no local profile binding.");
        const profile = await this.#profile.getById(ctx, binding.profileId);
        if (profile === undefined || !(await this.#profile.isLocal(ctx, binding.profileId))) {
            throw unavailable("Sharing has no readable local profile.");
        }

        const stagedStore = new StagedMurmurStore();
        let staged: OpenMurmur | undefined;
        let previousStopped = false;
        try {
            staged = await this.#start(ctx, "unbound", stagedStore);
            const runtime = await this.#runtimeSnapshot(ctx, staged);
            const stagedEntries = await stagedStore.snapshot();

            const previous = this.#open;
            if (previous === undefined) {
                throw unavailable("Sharing has no old identity to reset.");
            }
            this.#open = undefined;
            previousStopped = true;
            await this.#stop(ctx, previous);

            try {
                await this.#revokeInvitationsFromStagedOldIdentity(ctx, signal);
            } catch (error: unknown) {
                throw unavailable("Sharing could not confirm invitation revocation.", error);
            }

            try {
                const next = await replaceMurmurIdentity(ctx, {
                    identity: runtime.identity,
                    profileId: binding.profileId,
                    store: stagedEntries,
                    transform: (current) => ({
                        connection: "connecting",
                        contacts: [],
                        enrolled: true,
                        identity: runtime.identity,
                        incomingRequests: [],
                        localProfileVersion: profile.version,
                        outgoingRequests: [],
                        pendingOperations: current.pendingOperations.filter(
                            (operation) => operation.id !== operationId,
                        ),
                        profileId: binding.profileId,
                    }),
                });
                await stagedStore.attach(new SqliteMurmurStore(this.#lifetimeFrom(ctx)));
                this.#open = staged;
                staged.service.start(ctx);
                await this.#notify(ctx, next, origin);
                this.#scheduleProfilePublish();
                return this.#stateSnapshot(next);
            } catch (error: unknown) {
                await this.#stop(ctx, staged).catch(() => undefined);
                staged = undefined;
                throw unavailable("Sharing could not install its replacement identity.", error);
            }
        } catch (error: unknown) {
            if (staged !== undefined && this.#open?.service !== staged.service) {
                await this.#stop(ctx, staged).catch(() => undefined);
            } else if (staged === undefined) {
                await stagedStore.close().catch(() => undefined);
            }
            if (previousStopped && this.#open === undefined) {
                await this.#restorePreviousIdentity(ctx).catch((restoreError: unknown) => {
                    ctx.log.warn(
                        "Sharing retained its old identity but could not reopen it immediately.",
                        {},
                        restoreError,
                    );
                });
            }
            if (error instanceof MurmurOperationError) throw error;
            throw unavailable("Sharing could not create a replacement identity.", error);
        }
    }

    /**
     * Revoke through a bounded clone because Murmur records failed revocations in its store.
     *
     * On success the clone is irrelevant because reset replaces the old keyspace. On failure it
     * is discarded, leaving the live identity's original keys and outstanding invitations
     * exactly as they were before reset began.
     */
    async #revokeInvitationsFromStagedOldIdentity(
        ctx: Context,
        signal?: AbortSignal,
    ): Promise<void> {
        const durable = new SqliteMurmurStore(this.#lifetimeFrom(ctx));
        let copied: StagedMurmurStore;
        try {
            copied = await StagedMurmurStore.copyOf(durable);
        } finally {
            await durable.close();
        }
        const revocation = await this.#start(ctx, "existing", copied);
        try {
            await revocation.service.revokeInvitations(ctx, signal);
        } finally {
            await this.#stop(ctx, revocation);
        }
    }

    async #restorePreviousIdentity(ctx: Context): Promise<void> {
        if (this.#open !== undefined || this.#closing) return;
        const restored = await this.#start(ctx, "existing");
        this.#open = restored;
        restored.service.start(ctx);
    }

    async #recoverPendingOperations(ctx: Context): Promise<void> {
        const state = await ensureMurmurPublicState(ctx);
        for (const operation of state.pendingOperations) {
            if (operation.type === "enroll") continue;
            if (operation.type === "reset") {
                await this.#executeReset(ctx, operation.id, "background").catch(
                    (error: unknown) => {
                        ctx.log.warn(
                            "Sharing could not finish a recovered identity reset.",
                            {},
                            error,
                        );
                    },
                );
                continue;
            }
            if (operation.type === "accept" || operation.type === "reject") {
                await this.#executeRequestDecision(ctx, operation, "background").catch(
                    (error: unknown) => {
                        ctx.log.warn(
                            "Sharing could not finish a recovered request decision.",
                            {},
                            error,
                        );
                    },
                );
                continue;
            }
            await this.#executeRemoval(ctx, operation, "background").catch((error: unknown) => {
                ctx.log.warn("Sharing could not finish a recovered contact removal.", {}, error);
            });
        }
    }

    async #stageOperation(
        ctx: Context,
        stage: (current: MurmurPublicState) => MurmurPublicStateContent,
        execute: (postCommitCtx: Context) => Promise<MurmurSharingSnapshot>,
    ): Promise<MurmurSharingSnapshot> {
        let transactionReturned = false;
        const operationCtx = this.#lifetimeFrom(ctx).named("murmur-pending-operation");
        let staged: MurmurPublicState | undefined;
        let result: MurmurSharingSnapshot | undefined;
        let executionError: unknown;
        await ctx.inTx(async (txCtx) => {
            staged = await updateMurmurPublicState(txCtx, stage);
            afterCommit(txCtx, async () => {
                const run = async (): Promise<void> => {
                    try {
                        result = await execute(operationCtx);
                    } catch (error: unknown) {
                        executionError = error;
                        if (transactionReturned) {
                            operationCtx.log.warn(
                                "Sharing could not finish a committed pending operation.",
                                {},
                                error,
                            );
                        }
                    }
                };
                if (transactionReturned) await this.#transition(run);
                else await run();
            });
        });
        transactionReturned = true;
        if (executionError !== undefined) throw executionError;
        if (result !== undefined) return result;
        if (staged === undefined) throw new Error("Sharing did not persist its pending operation.");
        return this.#stateSnapshot(staged);
    }

    async #projectRuntime(
        ctx: Context,
        runtime: MurmurSnapshot,
        origin: MurmurEventOrigin,
        options: {
            readonly dropUnresolvedOutgoing?: boolean;
            readonly forceVersion?: boolean;
        } = {},
    ): Promise<MurmurPublicState> {
        const current = await ensureMurmurPublicState(ctx);
        const nextContent = reconcileRuntimeContent(
            current,
            runtime,
            options.dropUnresolvedOutgoing ?? false,
        );
        if (
            options.forceVersion === true ||
            publicFingerprint(current) !== publicFingerprint({ ...current, ...nextContent })
        ) {
            return await this.#advance(ctx, origin, () => nextContent);
        }
        return await updateMurmurPublicState(ctx, () => nextContent);
    }

    async #advance(
        ctx: Context,
        origin: MurmurEventOrigin,
        transform: (current: MurmurPublicState) => MurmurPublicStateContent,
    ): Promise<MurmurPublicState> {
        return await ctx.inTx(async (txCtx) => {
            const state = await advanceMurmurPublicState(txCtx, transform);
            afterCommit(
                txCtx,
                async (postCommitCtx) => await this.#notify(postCommitCtx, state, origin),
            );
            return state;
        });
    }

    async #notify(
        ctx: Context,
        state: Pick<MurmurPublicState, "updatedAt" | "version">,
        origin: MurmurEventOrigin,
    ): Promise<void> {
        const event: MurmurChangedEvent = {
            createdAt: state.updatedAt,
            data: { origin, version: state.version },
            id: state.version,
            type: "murmur_changed",
        };
        for (const listener of Array.from(this.#listeners)) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                ctx.log.warn("A sharing subscriber failed after commit.", {}, error);
            }
        }
    }

    async #profileChanged(ctx: Context, event: ProfileChangedEvent): Promise<void> {
        if (this.#closing || this.#lifetime === undefined) return;
        await this.#transition(async () => {
            const state = await ensureMurmurPublicState(ctx);
            if (!state.enrolled || state.localProfileVersion === event.data.version) return;
            await this.#advance(ctx, "background", (current) => ({
                ...content(current),
                localProfileVersion: event.data.version,
            }));
            this.#scheduleProfilePublish();
        });
    }

    #scheduleProfilePublish(): void {
        if (this.#closing || this.#lifetime === undefined) return;
        this.#profilePublishRequested = true;
        if (this.#profilePublish !== undefined) return;
        const ctx = this.#lifetime.named("murmur-profile-publish");
        const running = Promise.resolve()
            .then(async () => {
                while (!this.#closing && this.#profilePublishRequested) {
                    this.#profilePublishRequested = false;
                    await this.#transition(async () => {
                        if (this.#closing || this.#open === undefined) return;
                        await this.#open.service.publishProfile(ctx);
                    });
                }
            })
            .catch((error: unknown) => {
                ctx.log.warn(
                    "Sharing could not queue the latest profile for its contacts.",
                    {},
                    error,
                );
            })
            .finally(() => {
                if (this.#profilePublish !== running) return;
                this.#profilePublish = undefined;
                if (this.#profilePublishRequested) this.#scheduleProfilePublish();
            });
        this.#profilePublish = running;
    }

    async #start(
        ctx: Context,
        binding: "existing" | "unbound" | string,
        suppliedStore?: OwnedMurmurStore,
    ): Promise<OpenMurmur> {
        const lifetime = this.#lifetimeFrom(ctx);
        const store = suppliedStore ?? new SqliteMurmurStore(lifetime);
        let service: MurmurService | undefined;
        try {
            const client = await this.openClient(ctx, store);
            service = new MurmurService({
                client,
                lifetime,
                profile: this.#profile,
                publish: (publishCtx) => {
                    if (this.#closing) return;
                    void this.#transition(async () => {
                        if (this.#closing || this.#open?.service !== service) return;
                        const runtime = await this.#runtimeSnapshot(publishCtx, {
                            service: service!,
                            store,
                        });
                        await this.#projectRuntime(publishCtx, runtime, "background");
                    }).catch((error: unknown) => {
                        publishCtx.log.warn(
                            "Sharing could not publish a background change.",
                            {},
                            error,
                        );
                    });
                },
            });
            if (binding === "existing") await service.initializeBinding(ctx);
            else if (binding !== "unbound") await service.bindProfile(ctx, binding);
            return { service, store };
        } catch (error: unknown) {
            try {
                if (service !== undefined) await service.close(ctx);
            } finally {
                await store.close();
            }
            throw error;
        }
    }

    async #stop(ctx: Context, open: OpenMurmur): Promise<void> {
        try {
            await open.service.close(ctx);
        } finally {
            await open.store.close();
        }
    }

    async #runtimeSnapshot(ctx: Context, open: OpenMurmur): Promise<MurmurSnapshot> {
        try {
            return await open.service.snapshot(ctx);
        } catch (error: unknown) {
            throw unavailable("Sharing could not read its local state.", error);
        }
    }

    async #requireEnrolledState(ctx: Context): Promise<MurmurPublicState> {
        this.#requireAvailable();
        const state = await ensureMurmurPublicState(ctx);
        if (!state.enrolled) {
            throw new MurmurOperationError("not_enrolled", "Sharing is not enrolled.");
        }
        return state;
    }

    #stateSnapshot(state: MurmurPublicState): MurmurSharingSnapshot {
        if (!state.enrolled) {
            return { status: "unenrolled", updatedAt: state.updatedAt, version: state.version };
        }
        if (state.identity === null || state.profileId === null) {
            throw new Error("The durable enrolled sharing projection has no identity binding.");
        }
        return {
            connection: state.connection,
            contacts: structuredClone(state.contacts),
            identity: state.identity,
            incomingRequests: structuredClone(state.incomingRequests),
            outgoingRequests: state.outgoingRequests.flatMap((request) =>
                request.status === "active"
                    ? [
                          {
                              id: request.id,
                              identity: request.identity,
                              sessionId: request.sessionId,
                          },
                      ]
                    : [],
            ),
            profileId: state.profileId,
            status: "enrolled",
            updatedAt: state.updatedAt,
            version: state.version,
        };
    }

    async #removePendingOperation(ctx: Context, operationId: string): Promise<void> {
        await updateMurmurPublicState(ctx, (current) => ({
            ...content(current),
            pendingOperations: current.pendingOperations.filter(
                (operation) => operation.id !== operationId,
            ),
        }));
    }

    async #removeOutgoingReservation(ctx: Context, publicId: string): Promise<void> {
        await updateMurmurPublicState(ctx, (current) => ({
            ...content(current),
            outgoingRequests: current.outgoingRequests.filter((request) => request.id !== publicId),
        }));
    }

    #requireAvailable(): void {
        if (this.#closing) throw unavailable("Sharing is closing.");
    }

    #requireOpen(): OpenMurmur {
        this.#requireAvailable();
        const open = this.#open;
        if (open === undefined) throw unavailable("Sharing is temporarily unavailable.");
        return open;
    }

    #lifetimeFrom(ctx: Context): RootContext {
        if (this.#lifetime !== undefined) return this.#lifetime;
        const database = agentDatabase(ctx);
        if (database === undefined)
            throw new Error("Sharing was opened without an agent database.");
        this.#lifetime = withAgentDatabase(detach(ctx), database) as RootContext;
        return this.#lifetime;
    }

    #transition<Result>(operation: () => Promise<Result>): Promise<Result> {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}

function content(state: MurmurPublicState): MurmurPublicStateContent {
    const { updatedAt: _updatedAt, version: _version, ...rest } = state;
    return rest;
}

function addPendingOperation(
    current: MurmurPublicState,
    operation: MurmurPendingOperation,
): MurmurPublicStateContent {
    const duplicate = current.pendingOperations.some(
        (candidate) =>
            candidate.type === operation.type &&
            (("requestId" in candidate &&
                "requestId" in operation &&
                candidate.requestId === operation.requestId) ||
                ("identity" in candidate &&
                    "identity" in operation &&
                    candidate.identity === operation.identity)),
    );
    return {
        ...content(current),
        pendingOperations: duplicate
            ? current.pendingOperations
            : [...current.pendingOperations, operation],
    };
}

function pendingRequestOperation(
    type: "accept" | "reject",
    request: MurmurSnapshot["incomingRequests"][number],
): Extract<MurmurPendingOperation, { type: "accept" | "reject" }> {
    return {
        id: createInternalId(),
        identity: request.identity,
        requestId: request.id,
        sessionId: request.sessionId,
        type,
    };
}

function reconcileRuntimeContent(
    state: MurmurPublicState,
    runtime: MurmurSnapshot,
    dropUnresolvedOutgoing: boolean,
): MurmurPublicStateContent {
    const runtimeSessions = new Map(
        runtime.outgoingRequests.map((request) => [request.sessionId, request]),
    );
    const matchedRuntimeSessions = new Set<string>();
    const outgoingRequests: MurmurDurableOutgoingRequest[] = [];
    for (const durable of state.outgoingRequests) {
        const runtimeRequest =
            durable.status === "active"
                ? runtimeSessions.get(durable.sessionId)
                : runtime.outgoingRequests.find(
                      (request) =>
                          durable.identity !== null && request.identity === durable.identity,
                  );
        if (runtimeRequest !== undefined) {
            matchedRuntimeSessions.add(runtimeRequest.sessionId);
            outgoingRequests.push({
                id: durable.id,
                identity: runtimeRequest.identity,
                invitationDigest: durable.invitationDigest,
                sessionId: runtimeRequest.sessionId,
                status: "active",
            });
        } else if (durable.status === "pending" && !dropUnresolvedOutgoing) {
            outgoingRequests.push(durable);
        }
    }
    const reservedIds = new Set(outgoingRequests.map((request) => request.id));
    for (const runtimeRequest of runtime.outgoingRequests) {
        if (matchedRuntimeSessions.has(runtimeRequest.sessionId)) continue;
        if (outgoingRequests.length >= MURMUR_RELATIONSHIP_LIMIT) break;
        const id = createRecoveredPublicRequestId(reservedIds);
        reservedIds.add(id);
        outgoingRequests.push({
            id,
            identity: runtimeRequest.identity,
            invitationDigest: null,
            sessionId: runtimeRequest.sessionId,
            status: "active",
        });
    }

    const contacts = runtime.contacts;
    const pendingOperations = state.pendingOperations.filter((operation) => {
        if (operation.type === "enroll") return !state.enrolled;
        if (operation.type === "reset") return true;
        if (operation.type === "accept" || operation.type === "reject") {
            return runtime.incomingRequests.some(
                (request) => request.sessionId === operation.sessionId,
            );
        }
        return runtime.contacts.some(
            (contact) => contact.identity === operation.identity && contact.status === "active",
        );
    });
    return {
        connection: runtime.connection,
        contacts,
        enrolled: state.enrolled,
        identity: runtime.identity,
        incomingRequests: runtime.incomingRequests,
        localProfileVersion: state.localProfileVersion,
        outgoingRequests,
        pendingOperations,
        profileId: runtime.profileId,
    };
}

function publicFingerprint(state: MurmurPublicState): string {
    if (!state.enrolled) return "unenrolled";
    return JSON.stringify({
        connection: state.connection,
        contacts: state.contacts.map((contact) => ({
            identity: contact.identity,
            profile: publicProfile(contact.profile),
            status: contact.status,
        })),
        identity: state.identity,
        incomingRequests: state.incomingRequests.map((request) => ({
            id: request.id,
            identity: request.identity,
            profile: publicProfile(request.profile),
        })),
        outgoingRequests: state.outgoingRequests.flatMap((request) =>
            request.status === "active" ? [{ id: request.id, identity: request.identity }] : [],
        ),
        status: "enrolled",
    });
}

function publicProfile(profile: MurmurPeerProfile | null): unknown {
    return profile === null
        ? null
        : {
              email: profile.email,
              name: profile.name,
              photo: profile.photo === null ? null : { thumbhash: profile.photo.thumbhash },
              updatedAt: profile.updatedAt,
              version: profile.version,
          };
}

function validateRequestedIdentity(
    state: MurmurPublicState,
    identity: string,
    publicId: string,
): void {
    if (identity === state.identity) {
        throw new MurmurOperationError("conflict", "An installation cannot contact itself.");
    }
    if (state.contacts.some((contact) => contact.identity === identity)) {
        throw new MurmurOperationError("conflict", "That identity is already a contact.");
    }
    if (state.incomingRequests.some((request) => request.identity === identity)) {
        throw new MurmurOperationError(
            "conflict",
            "That identity already has an incoming request.",
        );
    }
    if (
        state.outgoingRequests.some(
            (request) => request.id !== publicId && request.identity === identity,
        )
    ) {
        throw new MurmurOperationError(
            "conflict",
            "That identity already has a different outgoing request.",
        );
    }
}

function createPublicRequestId(invitation: string, state: MurmurPublicState): string {
    const reserved = new Set(state.outgoingRequests.map((request) => request.id));
    for (;;) {
        const id = createInternalId();
        if (id !== invitation && !reserved.has(id)) return id;
    }
}

function createRecoveredPublicRequestId(reserved: ReadonlySet<string>): string {
    for (;;) {
        const id = createInternalId();
        if (!reserved.has(id)) return id;
    }
}

function createInternalId(): string {
    return randomBytes(32).toString("base64url");
}

function invitationDigest(invitation: string): string {
    return createHash("sha256").update(invitation, "utf8").digest("hex");
}

function invitationFailure(error: unknown): MurmurOperationError {
    if (error instanceof MurmurOperationError) return error;
    if (
        (error instanceof DiscoveryTransportError &&
            (error.status < 400 ||
                error.status >= 500 ||
                error.status === 408 ||
                error.status === 429)) ||
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error &&
            (error.message === "Discovery relay request timed out" ||
                error.message.startsWith("Discovery relay response ") ||
                error.message.startsWith("Invalid discovery relay response")))
    ) {
        return unavailable("The managed sharing service is unavailable.", error);
    }
    return new MurmurOperationError(
        "invalid_invitation",
        "The sharing invitation is invalid, expired, or already used.",
        { cause: error },
    );
}

function unavailable(message: string, cause?: unknown): MurmurOperationError {
    return new MurmurOperationError(
        "unavailable",
        message,
        cause === undefined ? undefined : { cause },
    );
}
