import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 60_000;
const IDENTITY = "B".repeat(43);
const INVITATION = "A".repeat(43);

interface ApiFailure {
    readonly body: Record<string, unknown> | null;
    readonly code: string | null;
    readonly status: number;
}

describe("Happy Agent sharing API matrix", () => {
    const gyms = new Set<AgentGym>();

    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it(
        "sharing-001 exposes a stable unenrolled snapshot and ignores the removed config toggle",
        async () => {
            const gym = await start(gyms, {
                config: '[sharing]\nenabled = true\nrelay_url = "https://example.invalid/"\n',
            });
            const first = await gym.client.getSharing();
            const second = await gym.client.getSharing();

            expect(first).toEqual(second);
            expect(first.sharing.status).toBe("unenrolled");
            expect(Object.keys(first.sharing).sort()).toEqual(["status", "updatedAt", "version"]);
            const bootstrap = await gym.client.getDesktopBootstrap();
            expect(bootstrap.sharing).toEqual(first.sharing);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sharing-002 returns the authoritative snapshot for every unenrolled mutation failure",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getSharing();
            const rawInvitation = await gym.raw.request<Record<string, unknown>>(
                "POST",
                "/v0/sharing/invitations",
            );
            expect(rawInvitation).toMatchObject({
                body: {
                    code: "sharing_not_enrolled",
                    sharing: before.sharing,
                },
                status: 409,
            });
            const rawRequest = await gym.raw.post<Record<string, unknown>>("/v0/sharing/requests", {
                invitation: INVITATION,
            });
            expect(rawRequest).toMatchObject({
                body: {
                    code: "sharing_not_enrolled",
                    sharing: before.sharing,
                },
                status: 409,
            });
            const operations = [
                ["submit", () => gym.client.submitSharingRequest({ invitation: INVITATION })],
                ["accept", () => gym.client.acceptSharingRequest("incoming")],
                ["reject", () => gym.client.rejectSharingRequest("incoming")],
                ["remove", () => gym.client.removeSharingContact(IDENTITY)],
                ["reset", () => gym.client.resetSharing()],
            ] as const;

            for (const [name, operation] of operations) {
                const failure = await capture(operation);
                expect(failure, name).toMatchObject({
                    code: "sharing_not_enrolled",
                    status: 409,
                });
                expect(failure.body, name).toMatchObject({ sharing: before.sharing });
            }
            await expect(gym.client.getSharing()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sharing-003 enrolls once and publishes the exact compact mutation event",
        async () => {
            const gym = await start(gyms);
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const mutationId = "sharing-enroll-exact";
            const enrolled = await gym.client.enrollSharing({ mutationId });
            expect(enrolled.sharing).toMatchObject({
                connection: expect.stringMatching(/^(connecting|connected|disconnected)$/),
                contacts: [],
                identity: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
                incomingRequests: [],
                outgoingRequests: [],
                status: "enrolled",
            });
            if (enrolled.sharing.status !== "enrolled") throw new Error("Enrollment failed.");
            expect(Object.keys(enrolled.sharing).sort()).toEqual([
                "connection",
                "contacts",
                "identity",
                "incomingRequests",
                "outgoingRequests",
                "status",
                "updatedAt",
                "version",
            ]);

            const events = await gym.client.getEvents({ after: baseline, limit: 100 });
            const exact = events.events.filter(
                (event) =>
                    event.type === "sharing.updated" && event.payload.mutationId === mutationId,
            );
            expect(exact).toHaveLength(1);
            expect(exact[0]?.payload).toEqual({ mutationId, version: enrolled.sharing.version });

            const beforeNoop = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const noop = await gym.client.enrollSharing({ mutationId: "sharing-enroll-noop" });
            expect(noop.sharing.version >= enrolled.sharing.version).toBe(true);
            const afterNoop = await gym.client.getEvents({ after: beforeNoop, limit: 100 });
            expect(
                afterNoop.events.some(
                    (event) =>
                        event.type === "sharing.updated" &&
                        event.payload.mutationId === "sharing-enroll-noop",
                ),
            ).toBe(false);

            const bodyless = await gym.raw.request<Record<string, unknown>>(
                "POST",
                "/v0/sharing/enroll",
            );
            expect(bodyless.status).toBe(200);
            expect(bodyless.body).toMatchObject({ sharing: { status: "enrolled" } });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sharing-004 resets only after managed invitation revocation is confirmed",
        async () => {
            const gym = await start(gyms);
            const enrolled = await gym.client.enrollSharing();
            if (enrolled.sharing.status !== "enrolled") throw new Error("Enrollment failed.");
            await expect
                .poll(async () => {
                    const current = await gym.client.getSharing();
                    return current.sharing.status === "enrolled"
                        ? current.sharing.connection
                        : undefined;
                })
                .not.toBe("connecting");
            const before = await gym.client.getSharing();
            if (before.sharing.status !== "enrolled") throw new Error("Sharing unenrolled.");
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const mutationId = "sharing-reset-exact";
            const outcome = await gym.client.resetSharing({ mutationId }).then(
                (value) => ({ kind: "success" as const, value }),
                (error: unknown) => ({ error: error as ApiFailure, kind: "unavailable" as const }),
            );
            const resetEvents = await gym.client.getEvents({ after: baseline, limit: 100 });
            const mutationEvents = resetEvents.events.filter(
                (event) =>
                    event.type === "sharing.updated" && event.payload.mutationId === mutationId,
            );
            let expectedIdentity = before.sharing.identity;
            let expectedVersion = before.sharing.version;
            if (outcome.kind === "success") {
                if (outcome.value.sharing.status !== "enrolled") {
                    throw new Error("Reset unenrolled sharing.");
                }
                expect(outcome.value.sharing.identity).not.toBe(before.sharing.identity);
                expect(outcome.value.sharing.version > before.sharing.version).toBe(true);
                expect(outcome.value.sharing).toMatchObject({
                    contacts: [],
                    incomingRequests: [],
                    outgoingRequests: [],
                    status: "enrolled",
                });
                expect(mutationEvents).toEqual([
                    expect.objectContaining({
                        payload: { mutationId, version: outcome.value.sharing.version },
                        type: "sharing.updated",
                    }),
                ]);
                expectedIdentity = outcome.value.sharing.identity;
                expectedVersion = outcome.value.sharing.version;
            } else {
                expect(outcome.error).toMatchObject({
                    body: {
                        code: "sharing_unavailable",
                        sharing: before.sharing,
                    },
                    code: "sharing_unavailable",
                    status: 503,
                });
                expect(mutationEvents).toEqual([]);
                await expect(gym.client.getSharing()).resolves.toEqual(before);
            }

            expect(
                resetEvents.events.some(
                    (event) =>
                        event.type === "sharing.updated" &&
                        event.payload.mutationId === mutationId &&
                        event.payload.version !== expectedVersion,
                ),
            ).toBe(false);

            await gym.restart();
            const restarted = await gym.client.getSharing();
            expect(restarted.sharing).toMatchObject({
                identity: expectedIdentity,
                status: "enrolled",
            });
            expect(restarted.sharing.version > expectedVersion).toBe(true);
            const bootstrap = await gym.client.getDesktopBootstrap();
            expect(bootstrap.sharing).toEqual(restarted.sharing);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sharing-005 validates encoded targets and includes sharing in route errors",
        async () => {
            const gym = await start(gyms);
            const current = await gym.client.getSharing();
            const malformed = await gym.raw.post<Record<string, unknown>>(
                "/v0/sharing/requests/%E0%A4%A/accept",
                {},
            );
            expect(malformed.status).toBe(400);
            expect(malformed.body).toMatchObject({
                code: "invalid_request",
                sharing: current.sharing,
            });

            const invalidIdentity = await gym.raw.delete<Record<string, unknown>>(
                "/v0/sharing/contacts/short",
                {},
            );
            expect(invalidIdentity.status).toBe(400);
            expect(invalidIdentity.body).toMatchObject({
                code: "invalid_request",
                sharing: current.sharing,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "sharing-006 advances for a local profile edit without borrowing its mutation id",
        async () => {
            const gym = await start(gyms);
            const enrolled = await gym.client.enrollSharing();
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const profile = await gym.client.getProfile();
            const mutationId = "profile-edit-must-not-leak-to-sharing";

            await gym.client.updateProfile(
                { mutationId, name: "Sharing Profile" },
                { ifMatch: profile.profile.version },
            );

            await expect
                .poll(async () => {
                    const events = await gym.client.getEvents({ after: baseline, limit: 100 });
                    return events.events.filter((event) => event.type === "sharing.updated");
                })
                .not.toEqual([]);
            const events = await gym.client.getEvents({ after: baseline, limit: 100 });
            const sharingEvents = events.events.filter((event) => event.type === "sharing.updated");
            expect(sharingEvents.some((event) => event.payload.mutationId === mutationId)).toBe(
                false,
            );

            const current = await gym.client.getSharing();
            expect(current.sharing.version > enrolled.sharing.version).toBe(true);
            expect(
                sharingEvents.some((event) => event.payload.version === current.sharing.version),
            ).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );
});

async function start(gyms: Set<AgentGym>, options: Parameters<typeof createAgentGym>[0] = {}) {
    const gym = await createAgentGym({ timeoutMs: 20_000, ...options });
    gyms.add(gym);
    return gym;
}

async function capture(operation: () => Promise<unknown>): Promise<ApiFailure> {
    try {
        await operation();
    } catch (error: unknown) {
        return error as ApiFailure;
    }
    throw new Error("The sharing operation unexpectedly succeeded.");
}
