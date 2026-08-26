import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
const TEST_TIMEOUT_MS = 30_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

async function start(): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    running.add(gym);
    return gym;
}

describe("Happy Cloud API", () => {
    it(
        "publishes one joined authorization, projects it into bootstrap, and expires it on restart",
        async () => {
            const gym = await start();
            const initial = await gym.client.getCloud();
            expect(initial.cloud).toMatchObject({
                authorization: null,
                environment: null,
                error: null,
                status: "disconnected",
                user: null,
            });
            const initialSocial = await gym.client.getCloudSocial();
            expect(initialSocial.cloudSocial).toMatchObject({
                blocked: [],
                connection: null,
                friends: [],
                incomingRequests: [],
                outgoingRequests: [],
                status: "unenrolled",
            });
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const request = {
                environment: "production" as const,
                mutationId: "cloud-start-gym",
                redirectUri: "happy-auth://callback",
            };

            const started = await gym.client.startCloudAuthorization(request);
            expect(started.cloud).toMatchObject({
                authorization: {
                    expiresAt: expect.any(Number),
                    url: expect.stringContaining("workos"),
                },
                environment: "production",
                error: null,
                status: "authorizing",
                user: null,
            });
            expect(started.cloud.version).not.toBe(initial.cloud.version);
            await expect(gym.client.startCloudAuthorization(request)).resolves.toEqual(started);

            const updates = await gym.client.getEvents({ after: baseline });
            const cloudUpdates = updates.events.filter((event) => event.type === "cloud.updated");
            expect(cloudUpdates).toHaveLength(1);
            expect(cloudUpdates[0]).toMatchObject({
                payload: { cloud: started.cloud, mutationId: "cloud-start-gym" },
                type: "cloud.updated",
            });
            await expect(gym.client.getDesktopBootstrap()).resolves.toMatchObject({
                cloud: started.cloud,
                cloudSocial: initialSocial.cloudSocial,
            });

            await gym.restart();
            const expired = await gym.client.getCloud();
            expect(expired.cloud).toMatchObject({
                authorization: null,
                environment: null,
                error: { code: "authorization_expired" },
                status: "disconnected",
                user: null,
            });
            expect(expired.cloud.version > started.cloud.version).toBe(true);
            await expect(gym.client.getDesktopBootstrap()).resolves.toMatchObject({
                cloud: expired.cloud,
                cloudSocial: expect.objectContaining({ status: "unenrolled" }),
            });
            expect(
                (await gym.client.getEvents()).events.filter(
                    (event) => event.type === "cloud.updated",
                ),
            ).toEqual([
                expect.objectContaining({
                    payload: { cloud: expired.cloud },
                    type: "cloud.updated",
                }),
            ]);

            const disconnectBaseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const clean = await gym.client.disconnectCloud({ mutationId: "cloud-disconnect-gym" });
            expect(clean.cloud).toMatchObject({ error: null, status: "disconnected" });
            expect(
                (await gym.client.getEvents({ after: disconnectBaseline })).events.filter(
                    (event) => event.type === "cloud.updated",
                ),
            ).toEqual([
                expect.objectContaining({
                    payload: { cloud: clean.cloud, mutationId: "cloud-disconnect-gym" },
                    type: "cloud.updated",
                }),
            ]);
            await gym.restart();
            await expect(gym.client.getCloud()).resolves.toEqual(clean);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "returns stable disconnected failures without events and keeps the client usable",
        async () => {
            const gym = await start();
            const initialProfile = await gym.client.getProfile();
            await gym.client.updateProfile(
                { name: "Ada" },
                { ifMatch: initialProfile.profile.version },
            );
            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;

            await expect(
                gym.client.completeCloudAuthorization({
                    callbackUrl: "happy-auth://callback?code=none&state=none",
                }),
            ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
            await expect(gym.client.mintCloudAccessToken()).rejects.toMatchObject({
                code: "cloud_not_authenticated",
                status: 409,
            });
            await expect(gym.client.getCloudProfile()).rejects.toMatchObject({
                code: "cloud_not_authenticated",
                status: 409,
            });
            await expect(gym.client.enrollCloudProfile({ username: "ada" })).rejects.toMatchObject({
                code: "cloud_not_authenticated",
                status: 409,
            });
            await expect(gym.client.sendCloudFriendRequest("grace")).rejects.toMatchObject({
                body: {
                    cloudSocial: expect.objectContaining({ status: "unenrolled" }),
                    code: "cloud_not_authenticated",
                },
                code: "cloud_not_authenticated",
                status: 409,
            });
            await expect(
                gym.client.enrollCloudProfile({ username: "UPPERCASE" }),
            ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
            await expect(
                gym.client.startCloudAuthorization({
                    environment: "production",
                    redirectUri: "http://example.com/callback",
                }),
            ).rejects.toMatchObject({ code: "invalid_request", status: 400 });

            expect(
                (await gym.client.getEvents({ after: baseline })).events.filter(
                    (event) =>
                        event.type === "cloud.updated" ||
                        event.type === "cloud.profile.updated" ||
                        event.type === "cloud.social.updated",
                ),
            ).toEqual([]);
            await expect(gym.client.getCloud()).resolves.toMatchObject({
                cloud: { error: null, status: "disconnected" },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "accepts an actually empty optional mutation body",
        async () => {
            const gym = await start();

            const response = await gym.raw.request("DELETE", "/v0/cloud/auth", undefined);

            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({
                cloud: { authorization: null, error: null, status: "disconnected" },
            });
        },
        TEST_TIMEOUT_MS,
    );
});
