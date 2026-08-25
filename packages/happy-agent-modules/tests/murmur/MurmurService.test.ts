import { DISCOVERY_INVITATION_TTL_MILLISECONDS, type MurmurContactProfile } from "@slopus/murmur";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import { murmurMigrations, readMurmurBinding } from "../../sources/murmur/MurmurDatabase.js";
import { MurmurService } from "../../sources/murmur/MurmurService.js";
import {
    MURMUR_RELATIONSHIP_LIMIT,
    murmurInvitationSchema,
    murmurSnapshotSchema,
} from "../../sources/murmur/MurmurTypes.js";
import { ProfileModule } from "../../sources/profile/ProfileModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import {
    FakeMurmurClient,
    INVITATION,
    OTHER_SESSION,
    REMOTE,
    SESSION,
    carriedProfile,
    encodeIdentity,
    identityBytes,
    peerProfile,
} from "./fakeMurmurClient.js";

const LOCAL_INSTANCE_ID = "alocalinstance000000001";

async function createFixture(name: string, client = new FakeMurmurClient()) {
    const profiles = new ProfileModule();
    const test = moduleDatabase([...murmurMigrations, ...profiles.migrations], name);
    await test.ready;
    profiles.open(LOCAL_INSTANCE_ID);
    const service = new MurmurService({
        client,
        lifetime: test.rootContext,
        profile: profiles,
        publish: () => undefined,
    });
    return { client, profiles, service, test };
}

async function createLocalProfile(fixture: Awaited<ReturnType<typeof createFixture>>) {
    return await fixture.profiles.create(fixture.test.context, {
        email: "steve@example.test",
        name: "Steve",
    });
}

describe("MurmurService", () => {
    it("reads the whole sharing screen in one snapshot", async () => {
        const client = new FakeMurmurClient({
            incoming: [
                {
                    id: "request-1",
                    identity: REMOTE,
                    profile: carriedProfile(peerProfile()),
                    sessionId: SESSION,
                },
            ],
        });
        const fixture = await createFixture("murmur-service-snapshot", client);
        try {
            const profile = await createLocalProfile(fixture);
            await fixture.service.bindProfile(fixture.test.context, profile.id);

            const snapshot = await fixture.service.snapshot(fixture.test.context);
            expect(Value.Check(murmurSnapshotSchema, snapshot)).toBe(true);
            expect(snapshot).toMatchObject({
                connection: "connecting",
                contacts: [],
                identity: fixture.service.identity,
                outgoingRequests: [],
                profileId: profile.id,
            });
            expect(snapshot.identity).toHaveLength(43);
            expect(snapshot.incomingRequests[0]).toEqual({
                id: "request-1",
                identity: encodeIdentity(REMOTE),
                profile: peerProfile(),
                sessionId: encodeIdentity(SESSION),
            });
        } finally {
            await fixture.service.close(fixture.test.context);
            fixture.test.close();
        }
    });

    it("keeps every public relationship collection within Murmur's complete read window", async () => {
        const count = MURMUR_RELATIONSHIP_LIMIT + 1;
        const client = new FakeMurmurClient({
            contacts: Array.from({ length: count }, () => ({
                identity: REMOTE,
                localProfile: carriedProfile(peerProfile()),
                profile: carriedProfile(peerProfile()),
                sessionId: SESSION,
                status: "active" as const,
            })),
            incoming: Array.from({ length: count }, (_, index) => ({
                id: `request-${index}`,
                identity: REMOTE,
                profile: carriedProfile(peerProfile()),
                sessionId: SESSION,
            })),
            outgoing: Array.from({ length: count }, (_, index) => ({
                createdAt: index,
                identity: REMOTE,
                sessionId: SESSION,
            })),
        });
        const fixture = await createFixture("murmur-service-relationship-limit", client);
        try {
            const snapshot = await fixture.service.snapshot(fixture.test.context);
            expect(Value.Check(murmurSnapshotSchema, snapshot)).toBe(true);
            expect(snapshot.contacts).toHaveLength(MURMUR_RELATIONSHIP_LIMIT);
            expect(snapshot.incomingRequests).toHaveLength(MURMUR_RELATIONSHIP_LIMIT);
            expect(snapshot.outgoingRequests).toHaveLength(MURMUR_RELATIONSHIP_LIMIT);
        } finally {
            await fixture.service.close(fixture.test.context);
            fixture.test.close();
        }
    });

    it("shows a profile this build cannot read as no profile at all", async () => {
        const unreadable = { nickname: "not a sharing profile" } as MurmurContactProfile;
        const client = new FakeMurmurClient({
            contacts: [
                {
                    identity: REMOTE,
                    localProfile: unreadable,
                    profile: unreadable,
                    sessionId: OTHER_SESSION,
                    status: "active",
                },
            ],
            incoming: [
                { id: "unreadable", identity: REMOTE, profile: unreadable, sessionId: SESSION },
            ],
        });
        const fixture = await createFixture("murmur-service-unreadable-profile", client);
        try {
            const profile = await createLocalProfile(fixture);
            await fixture.service.bindProfile(fixture.test.context, profile.id);

            const snapshot = await fixture.service.snapshot(fixture.test.context);
            expect(Value.Check(murmurSnapshotSchema, snapshot)).toBe(true);
            expect(snapshot.contacts[0]?.profile).toBeNull();
            expect(snapshot.incomingRequests[0]?.profile).toBeNull();
            await expect(
                fixture.service.acceptContact(fixture.test.context, "unreadable"),
            ).rejects.toThrow("The contact request does not contain a valid profile.");
        } finally {
            await fixture.service.close(fixture.test.context);
            fixture.test.close();
        }
    });

    it("issues an invitation only once a local person is bound", async () => {
        const fixture = await createFixture("murmur-service-invitation");
        try {
            await expect(fixture.service.createInvitation(fixture.test.context)).rejects.toThrow(
                "Choose a local profile before using sharing.",
            );

            const profile = await createLocalProfile(fixture);
            await fixture.service.bindProfile(fixture.test.context, profile.id);
            const before = Date.now();
            const invitation = await fixture.service.createInvitation(fixture.test.context);
            const after = Date.now();

            expect(Value.Check(murmurInvitationSchema, invitation)).toBe(true);
            expect(invitation.invitation).toBe(encodeIdentity(INVITATION));
            // The clock is the module's own, so the expiry is checked against the wall clock the
            // call ran on rather than against a number a test handed in.
            expect(invitation.expiresAt).toBeGreaterThanOrEqual(
                before + DISCOVERY_INVITATION_TTL_MILLISECONDS,
            );
            expect(invitation.expiresAt).toBeLessThanOrEqual(
                after + DISCOVERY_INVITATION_TTL_MILLISECONDS,
            );
            expect(invitation.invitation).toHaveLength(43);
        } finally {
            await fixture.service.close(fixture.test.context);
            fixture.test.close();
        }
    });

    it("uses Murmur's public profile publication and identity-wide revocation primitives", async () => {
        const fixture = await createFixture("murmur-service-public-contact-primitives");
        const ctx = fixture.test.context;
        try {
            const profile = await createLocalProfile(fixture);
            await fixture.service.bindProfile(ctx, profile.id);
            await fixture.service.publishProfile(ctx);
            const signal = new AbortController().signal;
            await fixture.service.revokeInvitations(ctx, signal);

            expect(fixture.client.publishedProfiles).toEqual([{ profile, version: 1 }]);
            expect(fixture.client.revocationCalls).toBe(1);
            expect(fixture.client.revocationSignals[0]).not.toBe(signal);
            expect(fixture.client.revocationSignals[0]?.aborted).toBe(false);
        } finally {
            await fixture.service.close(ctx);
            fixture.test.close();
        }
    });

    it("abandons an invitation that is still being uploaded when sharing closes", async () => {
        const client = new FakeMurmurClient({ invitationWaitsForAbort: true });
        const fixture = await createFixture("murmur-service-invitation-abort", client);
        const ctx = fixture.test.context;
        try {
            const profile = await createLocalProfile(fixture);
            await fixture.service.bindProfile(ctx, profile.id);

            const invitation = fixture.service.createInvitation(ctx);
            const abandoned = expect(invitation).rejects.toThrow("The invitation was aborted.");
            await vi.waitFor(() => expect(client.invitationSignal).toBeDefined());

            await fixture.service.close(ctx);
            await abandoned;
            expect(client.invitationSignal?.aborted).toBe(true);
            expect(client.closed).toBe(true);
        } finally {
            fixture.test.close();
        }
    });

    it("carries every contact decision through to the client and into the snapshot", async () => {
        const remote = peerProfile();
        const client = new FakeMurmurClient({
            incoming: [
                {
                    id: "request-1",
                    identity: REMOTE,
                    profile: carriedProfile(remote),
                    sessionId: SESSION,
                },
                {
                    id: "request-2",
                    identity: identityBytes(9),
                    profile: carriedProfile(peerProfile({ id: "asecondprofile0000000001" })),
                    sessionId: OTHER_SESSION,
                },
            ],
        });
        const fixture = await createFixture("murmur-service-contacts", client);
        const ctx = fixture.test.context;
        try {
            const profile = await createLocalProfile(fixture);
            await fixture.service.bindProfile(ctx, profile.id);
            await fixture.service.acceptContact(ctx, "request-1");
            expect(client.sentProfiles.at(-1)).toEqual({ profile, version: 1 });
            expect((await fixture.service.snapshot(ctx)).contacts).toEqual([
                { identity: encodeIdentity(REMOTE), profile: remote, status: "active" },
            ]);

            await fixture.service.rejectContact(ctx, "request-2");
            expect((await fixture.service.snapshot(ctx)).incomingRequests).toEqual([]);

            await fixture.service.removeContact(ctx, encodeIdentity(REMOTE));
            expect((await fixture.service.snapshot(ctx)).contacts).toEqual([]);

            const outgoing = await fixture.service.requestContact(
                ctx,
                encodeIdentity(INVITATION),
                encodeIdentity(REMOTE),
            );
            expect(outgoing).toEqual({
                id: encodeIdentity(SESSION),
                identity: encodeIdentity(REMOTE),
                sessionId: encodeIdentity(SESSION),
            });

            const snapshot = await fixture.service.snapshot(ctx);
            expect(Value.Check(murmurSnapshotSchema, snapshot)).toBe(true);
            expect(snapshot.outgoingRequests).toContainEqual(outgoing);
            // MurmurModule owns the durable public version and event projection.
        } finally {
            await fixture.service.close(ctx);
            fixture.test.close();
        }
    });

    it("refuses a request nobody sent", async () => {
        const fixture = await createFixture("murmur-service-missing-request");
        try {
            await expect(
                fixture.service.rejectContact(fixture.test.context, "request-1"),
            ).rejects.toThrowError(new Error("Contact request not found."));
        } finally {
            await fixture.service.close(fixture.test.context);
            fixture.test.close();
        }
    });

    it("refuses a person this installation does not own", async () => {
        const fixture = await createFixture("murmur-service-foreign-profile");
        try {
            await expect(
                fixture.service.bindProfile(fixture.test.context, "amissingprofile000000001"),
            ).rejects.toThrow("Sharing requires a profile owned by this installation.");
            await expect(readMurmurBinding(fixture.test.context)).resolves.toBeUndefined();
        } finally {
            await fixture.service.close(fixture.test.context);
            fixture.test.close();
        }
    });

    it("refuses an identity that disagrees with the stored binding", async () => {
        const fixture = await createFixture("murmur-service-identity-mismatch");
        const ctx = fixture.test.context;
        try {
            const profile = await createLocalProfile(fixture);
            await fixture.service.bindProfile(ctx, profile.id);
            await fixture.service.close(ctx);

            const impostor = new MurmurService({
                client: new FakeMurmurClient({ identity: REMOTE }),
                lifetime: fixture.test.rootContext,
                profile: fixture.profiles,
                publish: () => undefined,
            });
            try {
                await expect(impostor.initializeBinding(ctx)).rejects.toThrow(
                    "The stored Murmur identity does not match this sharing profile.",
                );
                await expect(impostor.bindProfile(ctx, profile.id)).rejects.toThrow(
                    "The stored Murmur identity does not match this sharing profile.",
                );
            } finally {
                await impostor.close(ctx);
            }
        } finally {
            await fixture.service.close(ctx);
            fixture.test.close();
        }
    });

    it("reaches the relay, then reports the connection it lost", async () => {
        const fixture = await createFixture("murmur-service-connection");
        const ctx = fixture.test.context;
        try {
            await expect(fixture.service.snapshot(ctx)).resolves.toMatchObject({
                connection: "connecting",
            });

            fixture.service.start(ctx);
            await vi.waitFor(async () => {
                expect(await fixture.service.snapshot(ctx)).toMatchObject({
                    connection: "connected",
                });
            });

            // The snapshot already in flight is what shows the connection ending, because sharing
            // refuses to start anything new once closing has begun.
            const release = fixture.client.holdContacts();
            const pending = fixture.service.snapshot(ctx);
            const closing = fixture.service.close(ctx);
            expect(fixture.client.closed).toBe(false);

            release();
            await expect(pending).resolves.toMatchObject({ connection: "disconnected" });
            await closing;
            expect(fixture.client.closed).toBe(true);
            await expect(fixture.service.snapshot(ctx)).rejects.toThrow("Sharing is closing.");
        } finally {
            await fixture.service.close(ctx);
            fixture.test.close();
        }
    });

    it("keeps trying after the relay connection fails", async () => {
        vi.useFakeTimers();
        const client = new FakeMurmurClient({ syncErrors: [new Error("invalid relay response")] });
        const fixture = await createFixture("murmur-service-retry", client);
        const ctx = fixture.test.context;
        try {
            fixture.service.start(ctx);
            await vi.waitFor(() => expect(client.syncCalls).toBe(1));
            await expect(fixture.service.snapshot(ctx)).resolves.toMatchObject({
                connection: "disconnected",
            });

            await vi.advanceTimersByTimeAsync(1_000);
            await vi.waitFor(() => expect(client.syncCalls).toBe(2));
            await vi.waitFor(async () => {
                expect(await fixture.service.snapshot(ctx)).toMatchObject({
                    connection: "connected",
                });
            });
        } finally {
            await fixture.service.close(ctx);
            fixture.test.close();
            vi.useRealTimers();
        }
    });
});
