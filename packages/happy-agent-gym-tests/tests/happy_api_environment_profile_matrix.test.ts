import { createAgentGym, clientFrameEvent, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;
const PNG_1X1 = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);
const WEBP_1X1 = Uint8Array.from(
    Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA=", "base64"),
);

interface ApiErrorLike {
    readonly body: Record<string, unknown> | null;
    readonly code: string | null;
    readonly status: number;
}

describe("Happy Agent profile and media matrix", () => {
    const gyms = new Set<AgentGym>();

    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it(
        "profile-001 starts with nullable identity fields and a usable version",
        async () => {
            const gym = await start(gyms);
            const response = await gym.client.getProfile();

            expect(response.profile).toMatchObject({
                email: null,
                name: null,
                photo: null,
            });
            expect(response.profile.version).toEqual(expect.any(String));
            expect(response.profile.version.length).toBeGreaterThan(0);
            expect(response.profile.updatedAt).toEqual(expect.any(Number));
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-002 applies a partial update without overwriting omitted fields",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getProfile();
            const first = await gym.client.updateProfile(
                { email: "partial@example.test", name: "Partial User" },
                { ifMatch: initial.profile.version },
            );
            const second = await gym.client.updateProfile(
                { name: "Renamed Partial User" },
                { ifMatch: first.profile.version },
            );

            expect(second.profile).toMatchObject({
                email: "partial@example.test",
                name: "Renamed Partial User",
                photo: null,
            });
            expect(second.profile.version).not.toBe(first.profile.version);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-003 clears individual fields with null and chains versions",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getProfile();
            const populated = await gym.client.updateProfile(
                { email: "clear@example.test", name: "Clear Me" },
                { ifMatch: initial.profile.version },
            );
            const cleared = await gym.client.updateProfile(
                { email: null },
                { ifMatch: populated.profile.version },
            );

            expect(cleared.profile.email).toBeNull();
            expect(cleared.profile.name).toBe("Clear Me");
            expect(cleared.profile.version).not.toBe(populated.profile.version);
            await expect(gym.client.getProfile()).resolves.toEqual(cleared);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-004 rejects an empty If-Match value without changing the profile",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            const failure = await captureError(() =>
                gym.client.updateProfile({ name: "must not apply" }, { ifMatch: "" }),
            );

            expect(failure).toMatchObject({ status: 400, code: "invalid_request" });
            expect(await gym.client.getProfile()).toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-005 returns the authoritative profile on a stale version conflict",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getProfile();
            const current = await gym.client.updateProfile(
                { name: "Authoritative" },
                { ifMatch: initial.profile.version },
            );
            const failure = await captureError(() =>
                gym.client.updateProfile(
                    { name: "stale writer" },
                    { ifMatch: initial.profile.version },
                ),
            );

            expect(failure).toMatchObject({ status: 409, code: "conflict" });
            expect(failure.body).toMatchObject({
                currentVersion: current.profile.version,
                profile: current.profile,
            });
            await expect(gym.client.getProfile()).resolves.toEqual(current);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-006 serializes concurrent writers and leaves one winner",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getProfile();
            const results = await Promise.all(
                ["writer-a", "writer-b"].map(async (name) =>
                    captureResult(() =>
                        gym.client.updateProfile({ name }, { ifMatch: initial.profile.version }),
                    ),
                ),
            );
            const successes = results.filter(
                (result): result is { readonly profile: typeof initial.profile } =>
                    result !== undefined && "profile" in result,
            );
            const failures = results.filter(
                (result): result is ApiErrorLike => result !== undefined && "status" in result,
            );

            expect(successes).toHaveLength(1);
            expect(failures).toHaveLength(1);
            expect(failures[0]).toMatchObject({ status: 409, code: "conflict" });
            await expect(gym.client.getProfile()).resolves.toEqual({
                profile: successes[0]?.profile,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-007 emits one ordered profile.updated event with the mutation echo",
        async () => {
            const gym = await start(gyms);
            const stream = gym.stream();
            await stream.opened();
            try {
                const initial = await gym.client.getProfile();
                const mutationId = "profile-matrix-event";
                const updated = await gym.client.updateProfile(
                    { email: "event@example.test", mutationId, name: "Event User" },
                    { ifMatch: initial.profile.version },
                );
                const frame = await stream.waitFor(
                    (candidate) => clientFrameEvent(candidate)?.type === "profile.updated",
                    "profile.updated",
                );
                const event = clientFrameEvent(frame);

                expect(event).toMatchObject({
                    type: "profile.updated",
                    payload: {
                        mutationId,
                        previousVersion: initial.profile.version,
                        profile: updated.profile,
                        version: updated.profile.version,
                    },
                });
                expect(frame.id).toEqual(expect.any(String));
            } finally {
                stream.close();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-008 reports an absent photo with a stable not-found error",
        async () => {
            const gym = await start(gyms);
            const failure = await captureError(() => gym.client.getProfilePhoto());

            expect(failure).toMatchObject({ status: 404, code: "not_found" });
            await expect(gym.client.getProfile()).resolves.toMatchObject({
                profile: { photo: null },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-009 normalizes PNG bytes and publishes a ThumbHash-backed photo",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            const updated = await gym.client.setProfilePhoto(
                { contentType: "image/png", data: PNG_1X1 },
                { ifMatch: before.profile.version },
            );
            const photo = await gym.client.getProfilePhoto();

            expect(updated.profile.photo?.thumbhash).toEqual(expect.any(String));
            expect(updated.profile.photo?.thumbhash.length).toBeGreaterThan(0);
            expect(photo).toMatchObject({
                contentType: "image/webp",
                data: expect.any(ArrayBuffer),
            });
            expect(photo?.data.byteLength).toBeGreaterThan(0);
            expect(photo?.etag).toMatch(/^".+"$/);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-010 accepts a WebP-labelled upload and always serves canonical WebP",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            const updated = await gym.client.setProfilePhoto(
                { contentType: "image/webp", data: WEBP_1X1 },
                { ifMatch: before.profile.version },
            );
            const photo = await gym.client.getProfilePhoto();

            expect(updated.profile.version).not.toBe(before.profile.version);
            expect(updated.profile.photo).not.toBeNull();
            expect(photo?.contentType).toBe("image/webp");
            expect(photo?.data.byteLength).toBeGreaterThan(0);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-011 rejects a stale photo replacement and preserves the current bytes",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getProfile();
            const first = await gym.client.setProfilePhoto(
                { contentType: "image/png", data: PNG_1X1 },
                { ifMatch: initial.profile.version },
            );
            const currentPhoto = await gym.client.getProfilePhoto();
            const failure = await captureError(() =>
                gym.client.setProfilePhoto(
                    { contentType: "image/png", data: PNG_1X1 },
                    { ifMatch: initial.profile.version },
                ),
            );

            expect(failure).toMatchObject({ status: 409, code: "conflict" });
            expect(failure.body).toMatchObject({
                currentVersion: first.profile.version,
                profile: first.profile,
            });
            const after = await gym.client.getProfilePhoto();
            expect(after?.etag).toBe(currentPhoto?.etag);
            expect(new Uint8Array(after?.data ?? new ArrayBuffer(0))).toEqual(
                new Uint8Array(currentPhoto?.data ?? new ArrayBuffer(0)),
            );
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-012 returns 304 semantics through a matching photo ETag",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            await gym.client.setProfilePhoto(
                { contentType: "image/png", data: PNG_1X1 },
                { ifMatch: before.profile.version },
            );
            const photo = await gym.client.getProfilePhoto();
            expect(photo?.etag).toEqual(expect.any(String));

            await expect(
                gym.client.getProfilePhoto({ ifNoneMatch: photo?.etag ?? undefined }),
            ).resolves.toBeNull();
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-013 deletes a photo with its current version and leaves no asset",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            const withPhoto = await gym.client.setProfilePhoto(
                { contentType: "image/png", data: PNG_1X1 },
                { ifMatch: before.profile.version },
            );
            const withoutPhoto = await gym.client.deleteProfilePhoto({
                ifMatch: withPhoto.profile.version,
            });

            expect(withoutPhoto.profile.photo).toBeNull();
            expect(withoutPhoto.profile.version).not.toBe(withPhoto.profile.version);
            await expect(gym.client.getProfilePhoto()).rejects.toMatchObject({
                status: 404,
                code: "not_found",
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "profile-014 persists identity and media metadata across daemon restart",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            const updated = await gym.client.updateProfile(
                { email: "restart@example.test", name: "Restart Profile" },
                { ifMatch: before.profile.version },
            );
            const withPhoto = await gym.client.setProfilePhoto(
                { contentType: "image/png", data: PNG_1X1 },
                { ifMatch: updated.profile.version },
            );
            const photoBefore = await gym.client.getProfilePhoto();

            await gym.restart();

            await expect(gym.client.getProfile()).resolves.toEqual(withPhoto);
            await expect(gym.client.getProfilePhoto()).resolves.toMatchObject({
                contentType: "image/webp",
                etag: photoBefore?.etag,
            });
        },
        TEST_TIMEOUT_MS,
    );
});

async function start(gyms: Set<AgentGym>): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    gyms.add(gym);
    return gym;
}

async function captureError(operation: () => Promise<unknown>): Promise<ApiErrorLike> {
    const error = await operation().catch((value: unknown) => value);
    expect(error).toMatchObject({
        body: expect.anything(),
        code: expect.any(String),
        status: expect.any(Number),
    });
    return error as ApiErrorLike;
}

async function captureResult<Result>(
    operation: () => Promise<Result>,
): Promise<Result | ApiErrorLike | undefined> {
    try {
        return await operation();
    } catch (error: unknown) {
        return error as ApiErrorLike;
    }
}
