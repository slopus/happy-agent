import { sql } from "drizzle-orm";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import {
    DiscoveryTransportError,
    type MurmurContact,
    type MurmurContactRequested,
    type MurmurStore,
} from "@slopus/murmur";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    MURMUR_STORE_TABLE,
    murmurMigrations,
    readMurmurBinding,
    readMurmurPublicState,
} from "../../sources/murmur/MurmurDatabase.js";
import { MurmurModule } from "../../sources/murmur/MurmurModule.js";
import type { MurmurClientFacade } from "../../sources/murmur/MurmurService.js";
import {
    MurmurOperationError,
    murmurSharingSnapshotSchema,
    type MurmurChangedEvent,
} from "../../sources/murmur/MurmurTypes.js";
import { ProfileModule } from "../../sources/profile/ProfileModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import {
    FakeMurmurClient,
    INVITATION,
    REMOTE,
    SESSION,
    carriedProfile,
    encodeIdentity,
    identityBytes,
    peerProfile,
} from "./fakeMurmurClient.js";

const LOCAL_INSTANCE_ID = "alocalinstance000000001";

class ScriptedMurmurModule extends MurmurModule {
    readonly clients: FakeMurmurClient[] = [];
    readonly #open: (store: MurmurStore, clients: FakeMurmurClient[]) => Promise<FakeMurmurClient>;

    constructor(
        profile: ProfileModule,
        open: (store: MurmurStore, clients: FakeMurmurClient[]) => Promise<FakeMurmurClient>,
    ) {
        super(profile);
        this.#open = open;
    }

    protected override async openClient(
        _ctx: Context,
        store: MurmurStore,
    ): Promise<MurmurClientFacade> {
        return await this.#open(store, this.clients);
    }
}

async function storedKeys(test: { context: Context }): Promise<readonly string[]> {
    const rows = await agentDatabaseRows<{ key: string }>(
        test.context.db,
        sql`SELECT key FROM ${sql.raw(MURMUR_STORE_TABLE)} ORDER BY key`,
    );
    return rows.map((row) => row.key);
}

async function createFixture(
    name: string,
    clientOptions: ConstructorParameters<typeof FakeMurmurClient>[0] = {},
    failOpenAt?: number,
) {
    const profiles = new ProfileModule();
    const test = moduleDatabase([...murmurMigrations, ...profiles.migrations], name);
    await test.ready;
    profiles.open(LOCAL_INSTANCE_ID);
    const profile = await profiles.create(test.context, {
        email: "steve@example.test",
        name: "Steve",
    });
    const module = new ScriptedMurmurModule(profiles, async (store, clients) => {
        const openNumber = clients.length + 1;
        if (openNumber === failOpenAt) {
            await store.set(`murmur/staged-open/${openNumber}`, identityBytes(openNumber));
            throw new Error("injected replacement open failure");
        }
        const storedIdentity = [
            ...(await store.scan("murmur/session-states/", { limit: 1 })),
        ][0]?.[1];
        const client = new FakeMurmurClient({
            connects: false,
            ...clientOptions,
            identity: clientOptions.identity ?? storedIdentity ?? identityBytes(openNumber),
        });
        clients.push(client);
        if (storedIdentity === undefined) {
            await store.set(`murmur/session-states/${openNumber}`, client.identity);
        }
        return client;
    });
    return { clients: module.clients, module, profile, profiles, test };
}

async function expectCode(promise: Promise<unknown>, code: MurmurOperationError["code"]) {
    await expect(promise).rejects.toMatchObject({ code });
}

describe("MurmurModule", () => {
    it("keeps a stable durable unenrolled snapshot until the API explicitly enrolls", async () => {
        const fixture = await createFixture("murmur-module-unenrolled");
        const ctx = fixture.test.context;
        try {
            await fixture.module.open(ctx);
            const first = await fixture.module.snapshot(ctx);
            const second = await fixture.module.snapshot(ctx);
            expect(first).toEqual(second);
            expect(first).toMatchObject({ status: "unenrolled" });
            expect(Value.Check(murmurSharingSnapshotSchema, first)).toBe(true);
            expect(fixture.module.running).toBe(false);
            expect(fixture.clients).toEqual([]);
            await expect(storedKeys(fixture.test)).resolves.toEqual([]);
            await expectCode(fixture.module.createInvitation(ctx), "not_enrolled");
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("enrolls once, binds the singleton profile, and emits exactly the returned version", async () => {
        const fixture = await createFixture("murmur-module-enroll");
        const ctx = fixture.test.context;
        const events: MurmurChangedEvent[] = [];
        try {
            await fixture.module.open(ctx);
            fixture.module.onEvent((_eventCtx, event) => {
                events.push(event);
            });
            const enrolled = await fixture.module.enroll(ctx);
            expect(enrolled).toMatchObject({
                identity: encodeIdentity(identityBytes(1)),
                profileId: fixture.profile.id,
                status: "enrolled",
            });
            expect(events.map((event) => event.data.version)).toEqual([enrolled.version]);
            expect(Value.Check(murmurSharingSnapshotSchema, enrolled)).toBe(true);
            await expect(readMurmurBinding(ctx)).resolves.toMatchObject({
                murmurIdentity: enrolled.status === "enrolled" ? enrolled.identity : undefined,
                profileId: fixture.profile.id,
            });

            const again = await fixture.module.enroll(ctx);
            expect(again).toEqual(enrolled);
            expect(events).toHaveLength(1);
            expect(fixture.clients).toHaveLength(1);
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("isolates failing subscribers and stops notifying an unsubscribed listener", async () => {
        const fixture = await createFixture("murmur-module-subscriber-isolation");
        const ctx = fixture.test.context;
        const heard: MurmurChangedEvent[] = [];
        let failures = 0;
        try {
            await fixture.module.open(ctx);
            fixture.module.onEvent(() => {
                failures += 1;
                throw new Error("injected subscriber failure");
            });
            const unsubscribe = fixture.module.onEvent((_eventCtx, event) => {
                heard.push(event);
            });

            await expect(fixture.module.enroll(ctx)).resolves.toMatchObject({ status: "enrolled" });
            expect(failures).toBe(1);
            expect(heard).toHaveLength(1);

            unsubscribe();
            unsubscribe();
            await expect(fixture.module.reset(ctx)).resolves.toMatchObject({ status: "enrolled" });
            expect(failures).toBe(2);
            expect(heard).toHaveLength(1);
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("automatically reopens only an enrolled identity and advances restart high water", async () => {
        const fixture = await createFixture("murmur-module-restart");
        const ctx = fixture.test.context;
        try {
            await fixture.module.open(ctx);
            const enrolled = await fixture.module.enroll(ctx);
            await fixture.module.close(ctx);

            const restarted = new ScriptedMurmurModule(
                fixture.profiles,
                async () => new FakeMurmurClient({ connects: false, identity: identityBytes(1) }),
            );
            const events: MurmurChangedEvent[] = [];
            restarted.onEvent((_eventCtx, event) => {
                events.push(event);
            });
            try {
                await restarted.open(ctx);
                const snapshot = await restarted.snapshot(ctx);
                expect(snapshot).toMatchObject({
                    identity: encodeIdentity(identityBytes(1)),
                    status: "enrolled",
                });
                expect(snapshot.version > enrolled.version).toBe(true);
                expect(events.map((event) => event.data.version)).toEqual([snapshot.version]);
            } finally {
                await restarted.close(ctx);
            }
        } finally {
            fixture.test.close();
        }
    });

    it("mints a public outgoing id unrelated to the invitation and no-ops a duplicate", async () => {
        const fixture = await createFixture("murmur-module-request");
        const ctx = fixture.test.context;
        const invitation = encodeIdentity(INVITATION);
        const events: MurmurChangedEvent[] = [];
        try {
            await fixture.module.open(ctx);
            await fixture.module.enroll(ctx);
            fixture.module.onEvent((_eventCtx, event) => {
                events.push(event);
            });
            const requested = await fixture.module.requestContact(ctx, invitation);
            expect(requested.status).toBe("enrolled");
            if (requested.status !== "enrolled") throw new Error("Expected enrollment.");
            expect(requested.outgoingRequests).toHaveLength(1);
            expect(requested.outgoingRequests[0]?.id).not.toBe(invitation);
            expect(requested.outgoingRequests[0]?.identity).toBe(encodeIdentity(REMOTE));
            expect(fixture.clients[0]?.resolveCalls).toBe(1);
            expect(events.map((event) => event.data.version)).toEqual([requested.version]);

            const duplicate = await fixture.module.requestContact(ctx, invitation);
            expect(duplicate).toEqual(requested);
            expect(fixture.clients[0]?.sentProfiles).toHaveLength(1);
            expect(fixture.clients[0]?.resolveCalls).toBe(1);
            expect(events).toHaveLength(1);
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("does not redeem a reserved request until its caller transaction commits", async () => {
        const fixture = await createFixture("murmur-module-request-rollback");
        const ctx = fixture.test.context;
        try {
            await fixture.module.open(ctx);
            const enrolled = await fixture.module.enroll(ctx);
            await expect(
                ctx.inTx(async (txCtx) => {
                    await fixture.module.requestContact(txCtx, encodeIdentity(INVITATION));
                    throw new Error("roll back the caller");
                }),
            ).rejects.toThrow("roll back the caller");

            await expect(fixture.module.snapshot(ctx)).resolves.toEqual(enrolled);
            expect(fixture.clients[0]?.sentProfiles).toEqual([]);
            const durable = await readMurmurPublicState(ctx);
            expect(durable?.outgoingRequests).toEqual([]);
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("preserves the public outgoing id and invitation idempotence across restart", async () => {
        const fixture = await createFixture("murmur-module-request-restart");
        const ctx = fixture.test.context;
        const invitation = encodeIdentity(INVITATION);
        try {
            await fixture.module.open(ctx);
            await fixture.module.enroll(ctx);
            const requested = await fixture.module.requestContact(ctx, invitation);
            if (requested.status !== "enrolled") throw new Error("Expected enrollment.");
            const publicId = requested.outgoingRequests[0]?.id;
            await fixture.module.close(ctx);

            const restarted = new ScriptedMurmurModule(
                fixture.profiles,
                async () =>
                    new FakeMurmurClient({
                        connects: false,
                        identity: identityBytes(1),
                        outgoing: [{ createdAt: 1_000, identity: REMOTE, sessionId: SESSION }],
                    }),
            );
            const events: MurmurChangedEvent[] = [];
            restarted.onEvent((_eventCtx, event) => {
                events.push(event);
            });
            try {
                await restarted.open(ctx);
                const reopened = await restarted.snapshot(ctx);
                expect(reopened.status === "enrolled" && reopened.outgoingRequests[0]?.id).toBe(
                    publicId,
                );
                events.length = 0;

                const duplicate = await restarted.requestContact(ctx, invitation);
                expect(duplicate).toEqual(reopened);
                expect(events).toEqual([]);
            } finally {
                await restarted.close(ctx);
            }
        } finally {
            fixture.test.close();
        }
    });

    it("accepts and rejects incoming requests durably while offline", async () => {
        const incoming = (id: string, sessionFill: number): MurmurContactRequested => ({
            id,
            identity: REMOTE,
            profile: carriedProfile(peerProfile()),
            sessionId: identityBytes(sessionFill),
        });
        const fixture = await createFixture("murmur-module-decisions", {
            incoming: [incoming("accept-me", 3), incoming("reject-me", 4)],
        });
        const ctx = fixture.test.context;
        try {
            await fixture.module.open(ctx);
            await fixture.module.enroll(ctx);
            const accepted = await fixture.module.acceptContact(ctx, "accept-me");
            expect(accepted.status === "enrolled" && accepted.contacts).toHaveLength(1);
            expect(
                accepted.status === "enrolled"
                    ? accepted.incomingRequests.map((request) => request.id)
                    : [],
            ).toEqual(["reject-me"]);

            const rejected = await fixture.module.rejectContact(ctx, "reject-me");
            expect(rejected.status === "enrolled" && rejected.incomingRequests).toHaveLength(0);
            await expectCode(fixture.module.rejectContact(ctx, "missing"), "not_found");
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("removes contacts, rejects missing targets, and resets to a fresh enrolled identity", async () => {
        const contact: MurmurContact = {
            identity: REMOTE,
            localProfile: carriedProfile(peerProfile()),
            profile: carriedProfile(peerProfile()),
            sessionId: SESSION,
            status: "active",
        };
        const fixture = await createFixture("murmur-module-reset", { contacts: [contact] });
        const ctx = fixture.test.context;
        try {
            await fixture.module.open(ctx);
            const enrolled = await fixture.module.enroll(ctx);
            const removed = await fixture.module.removeContact(ctx, encodeIdentity(REMOTE));
            expect(removed.status === "enrolled" && removed.contacts).toHaveLength(0);
            await expectCode(
                fixture.module.removeContact(ctx, encodeIdentity(REMOTE)),
                "not_found",
            );

            const reset = await fixture.module.reset(ctx);
            expect(reset).toMatchObject({
                identity: encodeIdentity(identityBytes(2)),
                status: "enrolled",
            });
            expect(reset.version > enrolled.version).toBe(true);
            expect(fixture.clients[0]?.closed).toBe(true);
            await expect(storedKeys(fixture.test)).resolves.toEqual(["murmur/session-states/2"]);
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("keeps the old identity, binding, keys, and snapshot usable when replacement open fails", async () => {
        const fixture = await createFixture("murmur-module-reset-open-failure", {}, 2);
        const ctx = fixture.test.context;
        const events: MurmurChangedEvent[] = [];
        try {
            await fixture.module.open(ctx);
            const before = await fixture.module.enroll(ctx);
            const binding = await readMurmurBinding(ctx);
            const keys = await storedKeys(fixture.test);
            fixture.module.onEvent((_eventCtx, event) => {
                events.push(event);
            });

            await expectCode(fixture.module.reset(ctx), "unavailable");

            await expect(fixture.module.snapshot(ctx)).resolves.toEqual(before);
            await expect(readMurmurBinding(ctx)).resolves.toEqual(binding);
            await expect(storedKeys(fixture.test)).resolves.toEqual(keys);
            expect(events).toEqual([]);
            expect(fixture.clients).toHaveLength(1);
            expect(fixture.clients[0]?.closed).toBe(false);
            await expect(fixture.module.createInvitation(ctx)).resolves.toMatchObject({
                invitation: encodeIdentity(INVITATION),
            });
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("revokes an outstanding invitation through the old identity before replacement", async () => {
        let contextDuringRevocation: Context | undefined;
        let keysDuringRevocation: readonly string[] | undefined;
        const fixture = await createFixture("murmur-module-reset-revokes", {
            onRevokeInvitations: async () => {
                if (contextDuringRevocation === undefined) {
                    throw new Error("The reset test did not install its context.");
                }
                keysDuringRevocation = await storedKeys({ context: contextDuringRevocation });
            },
        });
        const ctx = fixture.test.context;
        contextDuringRevocation = ctx;
        try {
            await fixture.module.open(ctx);
            const enrolled = await fixture.module.enroll(ctx);
            await fixture.module.createInvitation(ctx);

            const reset = await fixture.module.reset(ctx);

            expect(reset).toMatchObject({
                identity: encodeIdentity(identityBytes(2)),
                status: "enrolled",
            });
            expect(reset.version > enrolled.version).toBe(true);
            expect(keysDuringRevocation).toEqual(["murmur/session-states/1"]);
            expect(fixture.clients[2]?.identity).toEqual(identityBytes(1));
            expect(fixture.clients[2]?.revocationCalls).toBe(1);
            await expect(storedKeys(fixture.test)).resolves.toEqual(["murmur/session-states/2"]);
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("keeps the authoritative identity, store, binding, version, and events unchanged when revocation fails", async () => {
        const fixture = await createFixture("murmur-module-reset-revocation-failure", {
            revocationErrors: [new Error("injected relay revocation failure")],
        });
        const ctx = fixture.test.context;
        const events: MurmurChangedEvent[] = [];
        try {
            await fixture.module.open(ctx);
            const before = await fixture.module.enroll(ctx);
            await fixture.module.createInvitation(ctx);
            const binding = await readMurmurBinding(ctx);
            const keys = await storedKeys(fixture.test);
            fixture.module.onEvent((_eventCtx, event) => {
                events.push(event);
            });

            await expectCode(fixture.module.reset(ctx), "unavailable");

            await expect(fixture.module.snapshot(ctx)).resolves.toEqual(before);
            await expect(readMurmurBinding(ctx)).resolves.toEqual(binding);
            await expect(storedKeys(fixture.test)).resolves.toEqual(keys);
            expect(events).toEqual([]);
            expect(fixture.clients[2]?.revocationCalls).toBe(1);
            expect(fixture.clients[0]?.closed).toBe(true);
            expect(fixture.clients[1]?.closed).toBe(true);
            expect(fixture.clients[2]?.closed).toBe(true);
            expect(fixture.clients[3]?.identity).toEqual(identityBytes(1));
            expect(fixture.clients[3]?.closed).toBe(false);
            await expect(fixture.module.createInvitation(ctx)).resolves.toMatchObject({
                invitation: encodeIdentity(INVITATION),
            });
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("keeps the unchanged identity usable when a retained reset retry fails during restart", async () => {
        const fixture = await createFixture("murmur-module-reset-restart-revocation-failure", {
            revocationErrors: [new Error("injected relay revocation failure")],
        });
        const ctx = fixture.test.context;
        try {
            await fixture.module.open(ctx);
            const before = await fixture.module.enroll(ctx);
            await expectCode(fixture.module.reset(ctx), "unavailable");
            await fixture.module.close(ctx);

            const restarted = new ScriptedMurmurModule(
                fixture.profiles,
                async (_store, clients) => {
                    const client = new FakeMurmurClient({
                        connects: false,
                        identity: identityBytes(1),
                        revocationErrors: [new Error("injected relay revocation failure")],
                    });
                    clients.push(client);
                    return client;
                },
            );
            try {
                await expect(restarted.open(ctx)).resolves.toBeUndefined();
                await expect(restarted.snapshot(ctx)).resolves.toMatchObject({
                    identity: before.status === "enrolled" ? before.identity : undefined,
                    status: "enrolled",
                });
                expect(restarted.running).toBe(true);
                expect(restarted.clients).toHaveLength(4);
                expect(restarted.clients[3]?.closed).toBe(false);
                await expect(restarted.createInvitation(ctx)).resolves.toMatchObject({
                    invitation: encodeIdentity(INVITATION),
                });
            } finally {
                await restarted.close(ctx);
            }
        } finally {
            if (fixture.module.running) await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("treats aborted revocation as an unavailable reset with no public change", async () => {
        const fixture = await createFixture("murmur-module-reset-revocation-abort", {
            revocationWaitsForAbort: true,
        });
        const ctx = fixture.test.context;
        const events: MurmurChangedEvent[] = [];
        try {
            await fixture.module.open(ctx);
            const before = await fixture.module.enroll(ctx);
            const binding = await readMurmurBinding(ctx);
            const keys = await storedKeys(fixture.test);
            fixture.module.onEvent((_eventCtx, event) => {
                events.push(event);
            });
            const abort = new AbortController();
            abort.abort();

            await expectCode(fixture.module.reset(ctx, abort.signal), "unavailable");

            await expect(fixture.module.snapshot(ctx)).resolves.toEqual(before);
            await expect(readMurmurBinding(ctx)).resolves.toEqual(binding);
            await expect(storedKeys(fixture.test)).resolves.toEqual(keys);
            expect(events).toEqual([]);
            expect(fixture.clients[2]?.revocationSignals[0]?.aborted).toBe(true);
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("recovers a request that mutated Murmur before both the operation and reconciliation failed", async () => {
        const fixture = await createFixture("murmur-module-request-interrupted", {
            requestFailureAfterMutation: {
                operation: new Error("request response was lost"),
                reconciliation: new Error("local request read failed"),
            },
        });
        const ctx = fixture.test.context;
        const invitation = encodeIdentity(INVITATION);
        try {
            await fixture.module.open(ctx);
            await fixture.module.enroll(ctx);
            await expectCode(fixture.module.requestContact(ctx, invitation), "unavailable");

            const interrupted = await readMurmurPublicState(ctx);
            expect(interrupted?.outgoingRequests).toEqual([
                expect.objectContaining({
                    identity: encodeIdentity(REMOTE),
                    status: "pending",
                }),
            ]);
            const publicId = interrupted?.outgoingRequests[0]?.id;
            const readable = await fixture.module.snapshot(ctx);
            expect(readable.status === "enrolled" && readable.outgoingRequests).toEqual([]);
            await fixture.module.close(ctx);

            const restarted = new ScriptedMurmurModule(
                fixture.profiles,
                async () =>
                    new FakeMurmurClient({
                        connects: false,
                        identity: identityBytes(1),
                        outgoing: [{ createdAt: 1_000, identity: REMOTE, sessionId: SESSION }],
                    }),
            );
            try {
                await restarted.open(ctx);
                const recovered = await restarted.snapshot(ctx);
                expect(recovered.status === "enrolled" && recovered.outgoingRequests).toEqual([
                    {
                        id: publicId,
                        identity: encodeIdentity(REMOTE),
                        sessionId: encodeIdentity(SESSION),
                    },
                ]);
                expect((await readMurmurPublicState(ctx))?.outgoingRequests[0]?.status).toBe(
                    "active",
                );
            } finally {
                await restarted.close(ctx);
            }
        } finally {
            fixture.test.close();
        }
    });

    it("recovers accept, reject, and remove mutations from their durable intents after restart", async () => {
        const incoming = (id: string): MurmurContactRequested => ({
            id,
            identity: REMOTE,
            profile: carriedProfile(peerProfile()),
            sessionId: SESSION,
        });
        const contact: MurmurContact = {
            identity: REMOTE,
            localProfile: carriedProfile(peerProfile()),
            profile: carriedProfile(peerProfile()),
            sessionId: SESSION,
            status: "active",
        };

        const accepted = await createFixture("murmur-module-accept-interrupted", {
            acceptFailureAfterMutation: {
                operation: new Error("accept response was lost"),
                reconciliation: new Error("local contact read failed"),
            },
            incoming: [incoming("accept-me")],
        });
        try {
            await accepted.module.open(accepted.test.context);
            await accepted.module.enroll(accepted.test.context);
            await expectCode(
                accepted.module.acceptContact(accepted.test.context, "accept-me"),
                "unavailable",
            );
            expect((await readMurmurPublicState(accepted.test.context))?.pendingOperations).toEqual(
                [expect.objectContaining({ requestId: "accept-me", type: "accept" })],
            );
            await accepted.module.close(accepted.test.context);
            const restarted = new ScriptedMurmurModule(
                accepted.profiles,
                async () =>
                    new FakeMurmurClient({
                        connects: false,
                        contacts: [contact],
                        identity: identityBytes(1),
                    }),
            );
            try {
                await restarted.open(accepted.test.context);
                const snapshot = await restarted.snapshot(accepted.test.context);
                expect(snapshot.status === "enrolled" && snapshot.contacts).toHaveLength(1);
                expect(
                    (await readMurmurPublicState(accepted.test.context))?.pendingOperations,
                ).toEqual([]);
            } finally {
                await restarted.close(accepted.test.context);
            }
        } finally {
            accepted.test.close();
        }

        const rejected = await createFixture("murmur-module-reject-interrupted", {
            incoming: [incoming("reject-me")],
            rejectFailureAfterMutation: {
                operation: new Error("reject response was lost"),
                reconciliation: new Error("local request read failed"),
            },
        });
        try {
            await rejected.module.open(rejected.test.context);
            await rejected.module.enroll(rejected.test.context);
            await expectCode(
                rejected.module.rejectContact(rejected.test.context, "reject-me"),
                "unavailable",
            );
            await rejected.module.close(rejected.test.context);
            const restarted = new ScriptedMurmurModule(
                rejected.profiles,
                async () => new FakeMurmurClient({ connects: false, identity: identityBytes(1) }),
            );
            try {
                await restarted.open(rejected.test.context);
                const snapshot = await restarted.snapshot(rejected.test.context);
                expect(snapshot.status === "enrolled" && snapshot.incomingRequests).toEqual([]);
                expect(
                    (await readMurmurPublicState(rejected.test.context))?.pendingOperations,
                ).toEqual([]);
            } finally {
                await restarted.close(rejected.test.context);
            }
        } finally {
            rejected.test.close();
        }

        const removed = await createFixture("murmur-module-remove-interrupted", {
            contacts: [contact],
            removeFailureAfterMutation: {
                operation: new Error("remove response was lost"),
                reconciliation: new Error("local contact read failed"),
            },
        });
        try {
            await removed.module.open(removed.test.context);
            await removed.module.enroll(removed.test.context);
            await expectCode(
                removed.module.removeContact(removed.test.context, encodeIdentity(REMOTE)),
                "unavailable",
            );
            await removed.module.close(removed.test.context);
            const restarted = new ScriptedMurmurModule(
                removed.profiles,
                async () => new FakeMurmurClient({ connects: false, identity: identityBytes(1) }),
            );
            try {
                await restarted.open(removed.test.context);
                const snapshot = await restarted.snapshot(removed.test.context);
                expect(snapshot.status === "enrolled" && snapshot.contacts).toEqual([]);
                expect(
                    (await readMurmurPublicState(removed.test.context))?.pendingOperations,
                ).toEqual([]);
            } finally {
                await restarted.close(removed.test.context);
            }
        } finally {
            removed.test.close();
        }
    });

    it("publishes local profiles and reconciles authenticated Murmur contact refreshes", async () => {
        const contact: MurmurContact = {
            identity: REMOTE,
            localProfile: carriedProfile(peerProfile()),
            profile: carriedProfile(peerProfile()),
            sessionId: SESSION,
            status: "active",
        };
        const fixture = await createFixture("murmur-module-profile-refresh", {
            contacts: [contact],
        });
        const ctx = fixture.test.context;
        const events: MurmurChangedEvent[] = [];
        try {
            await fixture.module.open(ctx);
            await fixture.module.enroll(ctx);
            fixture.module.onEvent((_eventCtx, event) => {
                events.push(event);
            });
            await expect.poll(() => fixture.clients[0]?.publishedProfiles.length ?? 0).toBe(1);
            await expect.poll(() => fixture.clients[0]?.syncCalls ?? 0).toBe(1);

            const beforeLocalChange = await fixture.module.snapshot(ctx);
            const updatedLocal = await fixture.profiles.update(ctx, fixture.profile.id, {
                name: "Steve Korshakov",
            });
            if (updatedLocal === undefined) throw new Error("The local profile disappeared.");
            await expect.poll(() => fixture.clients[0]?.publishedProfiles.length ?? 0).toBe(2);
            expect(fixture.clients[0]?.publishedProfiles[1]).toMatchObject({
                profile: { name: "Steve Korshakov", version: updatedLocal.version },
            });
            const afterLocalChange = await fixture.module.snapshot(ctx);
            expect(afterLocalChange.version > beforeLocalChange.version).toBe(true);
            expect(events.at(-1)?.data).toMatchObject({
                origin: "background",
                version: afterLocalChange.version,
            });

            const refreshedPeer = peerProfile({
                name: "Remote Refreshed",
                updatedAt: 3,
                version: "02991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
            });
            await fixture.clients[0]?.updateRemoteContactProfile(
                REMOTE,
                carriedProfile(refreshedPeer),
                "profile-update-1",
            );
            await expect
                .poll(async () => {
                    const snapshot = await fixture.module.snapshot(ctx);
                    return snapshot.status === "enrolled"
                        ? snapshot.contacts[0]?.profile?.version
                        : undefined;
                })
                .toBe(refreshedPeer.version);
            const received = await fixture.module.snapshot(ctx);
            expect(received.status === "enrolled" && received.contacts[0]?.profile).toMatchObject({
                name: "Remote Refreshed",
                version: refreshedPeer.version,
            });
            expect(events.at(-1)?.data).toMatchObject({
                origin: "background",
                version: received.version,
            });
            await fixture.module.close(ctx);

            const restarted = new ScriptedMurmurModule(
                fixture.profiles,
                async () =>
                    new FakeMurmurClient({
                        connects: false,
                        contacts: [{ ...contact, profile: carriedProfile(refreshedPeer) }],
                        identity: identityBytes(1),
                    }),
            );
            try {
                await restarted.open(ctx);
                const persisted = await restarted.snapshot(ctx);
                expect(
                    persisted.status === "enrolled" && persisted.contacts[0]?.profile,
                ).toMatchObject({ name: "Remote Refreshed", version: refreshedPeer.version });
            } finally {
                await restarted.close(ctx);
            }
        } finally {
            fixture.test.close();
        }
    });

    it("publishes the latest carried local profile after a failed enqueue and restart", async () => {
        const fixture = await createFixture("murmur-module-profile-restart-convergence", {
            profileUpdateErrors: [
                new Error("injected initial profile enqueue failure"),
                new Error("injected changed profile enqueue failure"),
            ],
        });
        const ctx = fixture.test.context;
        try {
            await fixture.module.open(ctx);
            await fixture.module.enroll(ctx);
            await expect.poll(() => fixture.clients[0]?.profileUpdateCalls ?? 0).toBe(1);

            const updated = await fixture.profiles.update(ctx, fixture.profile.id, {
                name: "Steve After Restart",
            });
            if (updated === undefined) throw new Error("The local profile disappeared.");
            await expect.poll(() => fixture.clients[0]?.profileUpdateCalls ?? 0).toBe(2);
            await expect
                .poll(async () => (await readMurmurPublicState(ctx))?.localProfileVersion)
                .toBe(updated.version);
            await fixture.module.close(ctx);

            let restartedClient: FakeMurmurClient | undefined;
            const restarted = new ScriptedMurmurModule(fixture.profiles, async () => {
                restartedClient = new FakeMurmurClient({
                    connects: false,
                    identity: identityBytes(1),
                });
                return restartedClient;
            });
            try {
                await restarted.open(ctx);
                await expect.poll(() => restartedClient?.publishedProfiles.length ?? 0).toBe(1);
                expect(restartedClient?.publishedProfiles[0]).toMatchObject({
                    profile: {
                        name: "Steve After Restart",
                        version: updated.version,
                    },
                });
            } finally {
                await restarted.close(ctx);
            }
        } finally {
            if (fixture.module.running) await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("enforces request capacity and relationship conflicts before changing state", async () => {
        const full = await createFixture("murmur-module-full", {
            outgoing: Array.from({ length: 256 }, (_, index) => ({
                createdAt: index,
                identity: REMOTE,
                sessionId: identityBytes((index % 250) + 2),
            })),
        });
        try {
            await full.module.open(full.test.context);
            await full.module.enroll(full.test.context);
            const durable = await readMurmurPublicState(full.test.context);
            expect(durable?.outgoingRequests).toHaveLength(256);
            expect(durable).not.toHaveProperty("invitationRequests");
            expect(durable).not.toHaveProperty("outgoingRequestIds");
            await expectCode(
                full.module.requestContact(full.test.context, encodeIdentity(INVITATION)),
                "full",
            );
        } finally {
            await full.module.close(full.test.context);
            full.test.close();
        }

        const existing = await createFixture("murmur-module-existing-contact", {
            contacts: [
                {
                    identity: REMOTE,
                    localProfile: carriedProfile(peerProfile()),
                    profile: carriedProfile(peerProfile()),
                    sessionId: SESSION,
                    status: "active",
                },
            ],
        });
        try {
            await existing.module.open(existing.test.context);
            await existing.module.enroll(existing.test.context);
            await expectCode(
                existing.module.requestContact(existing.test.context, encodeIdentity(INVITATION)),
                "conflict",
            );
        } finally {
            await existing.module.close(existing.test.context);
            existing.test.close();
        }

        const self = await createFixture("murmur-module-self-contact", {
            resolvedIdentity: identityBytes(1),
        });
        try {
            await self.module.open(self.test.context);
            await self.module.enroll(self.test.context);
            await expectCode(
                self.module.requestContact(self.test.context, encodeIdentity(INVITATION)),
                "conflict",
            );
            expect((await readMurmurPublicState(self.test.context))?.outgoingRequests).toEqual([]);
        } finally {
            await self.module.close(self.test.context);
            self.test.close();
        }
    });

    it("classifies invalid invitations and no-ops a contact already removing", async () => {
        const invalid = await createFixture("murmur-module-invalid-invitation", {
            resolveErrors: [new Error("invalid discovery bundle")],
        });
        try {
            await invalid.module.open(invalid.test.context);
            await invalid.module.enroll(invalid.test.context);
            await expectCode(
                invalid.module.requestContact(invalid.test.context, encodeIdentity(INVITATION)),
                "invalid_invitation",
            );
        } finally {
            await invalid.module.close(invalid.test.context);
            invalid.test.close();
        }

        const removing = await createFixture("murmur-module-removing-noop", {
            contacts: [
                {
                    identity: REMOTE,
                    localProfile: carriedProfile(peerProfile()),
                    profile: carriedProfile(peerProfile()),
                    sessionId: SESSION,
                    status: "removing",
                },
            ],
        });
        try {
            await removing.module.open(removing.test.context);
            const before = await removing.module.enroll(removing.test.context);
            const events: MurmurChangedEvent[] = [];
            removing.module.onEvent((_eventCtx, event) => {
                events.push(event);
            });
            const after = await removing.module.removeContact(
                removing.test.context,
                encodeIdentity(REMOTE),
            );
            expect(after).toEqual(before);
            expect(events).toEqual([]);
        } finally {
            await removing.module.close(removing.test.context);
            removing.test.close();
        }
    });

    it("separates relay failures from invalid invitation failures", async () => {
        for (const [name, error] of [
            ["timeout", new Error("Discovery relay request timed out")],
            ["server", new DiscoveryTransportError(503, "unavailable")],
            ["throttled", new DiscoveryTransportError(429, "rate_limited")],
        ] as const) {
            const fixture = await createFixture(`murmur-module-invitation-${name}`, {
                resolveErrors: [error],
            });
            try {
                await fixture.module.open(fixture.test.context);
                await fixture.module.enroll(fixture.test.context);
                await expectCode(
                    fixture.module.requestContact(fixture.test.context, encodeIdentity(INVITATION)),
                    "unavailable",
                );
            } finally {
                await fixture.module.close(fixture.test.context);
                fixture.test.close();
            }
        }
    });
});
