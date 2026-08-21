import { clientFrameEvent, createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;

// A small, valid PNG that Sharp can normalize through the public photo endpoint.
const PNG_1X1 = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);

interface PublicApiError {
    readonly body: Record<string, unknown> | null;
    readonly code: string | null;
    readonly status: number;
}

describe("Happy Agent environment API", () => {
    let gym: AgentGym | undefined;

    afterEach(async () => {
        await gym?.dispose();
        gym = undefined;
    });

    it(
        "updates the singleton profile with an exact event, rejects stale versions, and survives restart",
        async () => {
            gym = await createAgentGym({ timeoutMs: 15_000 });
            const initial = await gym.client.getProfile();
            expect(initial.profile).toMatchObject({
                email: null,
                name: null,
                photo: null,
            });
            expect(initial.profile.version.length).toBeGreaterThan(0);

            const stream = gym.stream();
            let updated: typeof initial | undefined;
            try {
                await stream.opened();
                const mutationId = "profile-update-environment";
                updated = await gym.client.updateProfile(
                    {
                        email: "steve@example.test",
                        mutationId,
                        name: "Steve Korshakov",
                    },
                    { ifMatch: initial.profile.version },
                );
                expect(updated.profile).toMatchObject({
                    email: "steve@example.test",
                    name: "Steve Korshakov",
                    photo: null,
                });
                expect(updated.profile.version).not.toBe(initial.profile.version);

                const frame = await stream.waitFor(
                    (candidate) => candidate.event === "profile.updated",
                    "the profile.updated event",
                );
                const event = clientFrameEvent(frame);
                expect(event?.type).toBe("profile.updated");
                if (event === undefined || event.type !== "profile.updated") {
                    throw new Error("The profile event was not a typed Happy Agent event.");
                }
                expect(event.payload).toMatchObject({
                    mutationId,
                    previousVersion: initial.profile.version,
                    profile: updated.profile,
                    version: updated.profile.version,
                });

                const profileEventsBeforeConflict = (await gym.events()).filter(
                    (candidate) => candidate.type === "profile.updated",
                );
                let caught: unknown;
                try {
                    await gym.client.updateProfile(
                        { name: "Stale update" },
                        { ifMatch: initial.profile.version },
                    );
                } catch (error: unknown) {
                    caught = error;
                }
                expectApiError(caught);
                const conflict = caught as PublicApiError;
                expect(conflict.status).toBe(409);
                expect(conflict.code).toBe("conflict");
                expect(conflict.body).toMatchObject({
                    currentVersion: updated.profile.version,
                    profile: updated.profile,
                });
                expect(
                    (await gym.events()).filter(
                        (candidate) => candidate.type === "profile.updated",
                    ),
                ).toEqual(profileEventsBeforeConflict);

                // A rejected mutation must not poison the same public client.
                await expect(gym.client.getProfile()).resolves.toEqual(updated);
            } finally {
                stream.close();
            }

            if (updated === undefined) throw new Error("The profile update did not complete.");
            await gym.restart();
            await expect(gym.client.getProfile()).resolves.toEqual(updated);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "normalizes profile photos, supports ETags, rejects stale deletes, and persists removal",
        async () => {
            gym = await createAgentGym({ timeoutMs: 15_000 });
            let caught: unknown;
            try {
                await gym.client.getProfilePhoto();
            } catch (error: unknown) {
                caught = error;
            }
            expectApiError(caught);
            expect((caught as PublicApiError).status).toBe(404);
            expect((caught as PublicApiError).code).toBe("not_found");

            const initial = await gym.client.getProfile();
            const withPhoto = await gym.client.setProfilePhoto(
                { contentType: "image/png", data: PNG_1X1 },
                { ifMatch: initial.profile.version },
            );
            expect(withPhoto.profile.photo?.thumbhash).toEqual(expect.any(String));
            expect(withPhoto.profile.photo?.thumbhash.length).toBeGreaterThan(0);
            expect(withPhoto.profile.version).not.toBe(initial.profile.version);

            const photo = await gym.client.getProfilePhoto();
            expect(photo).not.toBeNull();
            expect(photo?.contentType).toBe("image/webp");
            expect(photo?.data.byteLength).toBeGreaterThan(0);
            expect(photo?.etag).toMatch(/^".+"$/);
            const notModified = await gym.client.getProfilePhoto({
                ifNoneMatch: photo?.etag ?? undefined,
            });
            expect(notModified).toBeNull();

            let staleDelete: unknown;
            try {
                await gym.client.deleteProfilePhoto({ ifMatch: initial.profile.version });
            } catch (error: unknown) {
                staleDelete = error;
            }
            expectApiError(staleDelete);
            expect((staleDelete as PublicApiError).status).toBe(409);
            expect((staleDelete as PublicApiError).code).toBe("conflict");
            await expect(gym.client.getProfile()).resolves.toEqual(withPhoto);

            const withoutPhoto = await gym.client.deleteProfilePhoto({
                ifMatch: withPhoto.profile.version,
            });
            expect(withoutPhoto.profile.photo).toBeNull();
            await expect(gym.client.getProfilePhoto()).rejects.toMatchObject({
                code: "not_found",
                status: 404,
            });
            await expect(gym.client.getProfile()).resolves.toEqual(withoutPhoto);

            await gym.restart();
            await expect(gym.client.getProfile()).resolves.toEqual(withoutPhoto);
            await expect(gym.client.getProfilePhoto()).rejects.toMatchObject({
                code: "not_found",
                status: 404,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "reports onboarding steps, completes idempotently, and persists completion",
        async () => {
            gym = await createAgentGym({ timeoutMs: 15_000 });
            const before = await gym.client.getOnboarding();
            expect(before.completed).toBe(false);
            expect(before.steps.project.done).toBe(true);
            expect(before.steps.profile.done).toBe(false);
            expect(before.steps.providers.done).toBe(true);
            expect(before.steps.providers.signedIn).toContain("gym");

            const profile = await gym.client.getProfile();
            await gym.client.updateProfile(
                { name: "Gym User" },
                { ifMatch: profile.profile.version },
            );
            const afterProfile = await gym.client.getOnboarding();
            expect(afterProfile.steps.profile.done).toBe(true);

            await expect(gym.client.completeOnboarding()).resolves.toEqual({ completed: true });
            const eventsAfterCompletion = await gym.events();
            await expect(gym.client.completeOnboarding()).resolves.toEqual({ completed: true });
            expect(await gym.events()).toEqual(eventsAfterCompletion);
            await expect(gym.client.getOnboarding()).resolves.toMatchObject({
                completed: true,
                steps: afterProfile.steps,
            });

            await gym.restart();
            await expect(gym.client.getOnboarding()).resolves.toMatchObject({
                completed: true,
                steps: afterProfile.steps,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "starts with empty daemon usage, records public inference usage, and retains it on restart",
        async () => {
            gym = await createAgentGym({
                inference: (request) =>
                    request.sessionId.startsWith("naming:")
                        ? { content: [{ text: "<title>Usage test</title>", type: "text" }] }
                        : {
                              content: [{ text: "usage recorded", type: "text" }],
                              usage: {
                                  cacheRead: 2,
                                  cacheWrite: 1,
                                  input: 11,
                                  output: 7,
                                  totalTokens: 21,
                              },
                          },
                timeoutMs: 15_000,
            });
            await expect(gym.client.getUsage()).resolves.toMatchObject({
                day: {},
                hour: {},
                month: {},
                week: {},
            });

            await gym.send("record usage");
            const populated = await gym.client.getUsage();
            expect(populated.hour).toMatchObject({
                gym: {
                    "gym/model": {
                        cacheRead: 2,
                        cacheWrite: 1,
                        input: 11,
                        output: 7,
                    },
                },
            });
            expect(gym.inference.unscripted).toEqual([]);

            await gym.restart();
            const afterRestart = await gym.client.getUsage();
            expect(afterRestart.hour).toMatchObject(populated.hour);
        },
        TEST_TIMEOUT_MS,
    );
});

function expectApiError(value: unknown): asserts value is PublicApiError {
    expect(value).toBeDefined();
    expect(value).toMatchObject({
        code: expect.any(String),
        status: expect.any(Number),
    });
}
