import {
    clientFrameEvent,
    createAgentGym,
    GymHttpClient,
    type AgentGym,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;
const INSTRUCTIONS_LIMIT = 256 * 1024;
const SECURITY_LIMIT = 32 * 1024;
const PROFILE_PHOTO_LIMIT = 8 * 1024 * 1024;
const PNG_1X1 = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);

interface ApiFailure {
    readonly body: Record<string, unknown> | null;
    readonly code: string | null;
    readonly status: number;
}

describe("Happy Agent API contract closure matrix", () => {
    const gyms = new Set<AgentGym>();

    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it(
        "contract-001 serves the greeting through the public client",
        async () => {
            const gym = await start(gyms);

            await expect(gym.client.getGreeting()).resolves.toEqual({
                text: "Welcome to Happy Agent!",
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-002 reports a ready authenticated health resource",
        async () => {
            const gym = await start(gyms);
            const health = await gym.client.getHealth();

            expect(health).toMatchObject({
                healthy: true,
                ready: true,
                status: "ready",
                version: {
                    daemon: "gym",
                    protocol: expect.any(Number),
                },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-003 returns a complete config without private installation values",
        async () => {
            const gym = await start(gyms);
            const response = await gym.client.getConfig();
            const serialized = JSON.stringify(response);

            expect(response.config).toMatchObject({
                defaults: {
                    effort: expect.any(String),
                    modelId: expect.any(String),
                    permissionMode: expect.any(String),
                    providerId: expect.any(String),
                },
                models: expect.any(Object),
                providers: expect.any(Object),
                settings: expect.any(Object),
                workspace: expect.any(Object),
            });
            expect(serialized).not.toContain(gym.token);
            expect(serialized).not.toContain(gym.happyHome);
            expect(serialized).not.toContain(gym.workspacePath);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-004 completes onboarding idempotently and persists the completion state",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getOnboarding();
            expect(initial).toMatchObject({
                completed: expect.any(Boolean),
                steps: {
                    profile: { done: expect.any(Boolean) },
                    project: { done: true },
                    providers: {
                        done: expect.any(Boolean),
                        signedIn: expect.any(Array),
                    },
                },
            });

            await expect(gym.client.completeOnboarding()).resolves.toEqual({ completed: true });
            await expect(gym.client.completeOnboarding()).resolves.toEqual({ completed: true });
            await expect(gym.client.getOnboarding()).resolves.toMatchObject({
                completed: true,
            });
            await gym.restart();
            await expect(gym.client.getOnboarding()).resolves.toMatchObject({
                completed: true,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-005 exposes a nullable profile with an opaque resource version",
        async () => {
            const gym = await start(gyms);
            const response = await gym.client.getProfile();

            expect(response.profile).toMatchObject({
                email: null,
                name: null,
                photo: null,
                updatedAt: expect.any(Number),
                version: expect.any(String),
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-006 round-trips global instructions through the public client",
        async () => {
            const gym = await start(gyms);
            const instructions = "Keep this contract readable.\n雪だるま · café\n";

            await expect(gym.client.putInstructions(instructions)).resolves.toEqual({
                instructions,
            });
            await expect(gym.client.getInstructions()).resolves.toEqual({ instructions });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-007 round-trips the global security policy through the public client",
        async () => {
            const gym = await start(gyms);
            const policy = "Only use the workspace.\n安全第一 · café\n";

            await expect(gym.client.putSecurityPolicy(policy)).resolves.toEqual({ policy });
            await expect(gym.client.getSecurityPolicy()).resolves.toEqual({ policy });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-008 pulls ordered events with a bounded page and inclusive until cursor",
        async () => {
            const gym = await start(gyms);
            const page = await gym.client.getEvents({ limit: 3 });

            expect(page.events.length).toBeGreaterThan(0);
            expect(page.events.length).toBeLessThanOrEqual(3);
            expect(page.cursor).toEqual(expect.any(String));
            expect(page.latestCursor).toEqual(expect.any(String));
            for (const event of page.events) {
                expect(event).toMatchObject({
                    cursor: expect.any(String),
                    occurredAt: expect.any(Number),
                    payload: expect.anything(),
                    type: expect.any(String),
                });
            }

            const first = page.events[0];
            if (first === undefined)
                throw new Error("The event page unexpectedly had no first event.");
            const bounded = await gym.client.getEvents({
                limit: 1,
                until: first.cursor,
            });
            expect(bounded.events).toHaveLength(1);
            expect(bounded.events[0]?.cursor).toBe(first.cursor);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-009 streams a hello followed by the ordered config event",
        async () => {
            const gym = await start(gyms);
            const stream = gym.stream();
            try {
                await stream.opened();
                const hello = stream.frames.find((frame) => frame.event === "hello");
                expect(hello?.data).toMatchObject({
                    cursor: expect.any(String),
                    gap: false,
                    resumed: false,
                });

                await gym.client.putInstructions("streamed contract event");
                const frame = await stream.waitFor(
                    (candidate) => candidate.event === "config.updated",
                    "config.updated",
                );
                expect(frame.id).toEqual(expect.any(String));
                expect(clientFrameEvent(frame)).toMatchObject({
                    type: "config.updated",
                });
            } finally {
                stream.close();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-010 provides a desktop bootstrap snapshot with its closing cursor",
        async () => {
            const gym = await start(gyms);
            const project = await firstProject(gym);
            const bootstrap = await gym.client.getDesktopBootstrap();

            expect(bootstrap).toMatchObject({
                config: { defaults: expect.any(Object) },
                profile: { version: expect.any(String) },
                onboarding: { steps: expect.any(Object) },
                projects: expect.any(Array),
                workspaces: expect.any(Array),
                cursor: expect.any(String),
            });
            expect(bootstrap.projects.some((candidate) => candidate.id === project.id)).toBe(true);
            expect(bootstrap.workspaces.some((candidate) => candidate.id === project.id)).toBe(
                true,
            );
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-011 returns all four daemon usage windows with object breakdowns",
        async () => {
            const gym = await start(gyms);
            const usage = await gym.client.getUsage();

            expect(usage).toMatchObject({
                hour: expect.any(Object),
                day: expect.any(Object),
                week: expect.any(Object),
                month: expect.any(Object),
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-012 chains profile versions while preserving omitted fields",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getProfile();
            const first = await gym.client.updateProfile(
                { email: "contract@example.test", name: "Contract User" },
                { ifMatch: initial.profile.version },
            );
            const second = await gym.client.updateProfile(
                { name: "Renamed Contract User" },
                { ifMatch: first.profile.version },
            );

            expect(second.profile).toMatchObject({
                email: "contract@example.test",
                name: "Renamed Contract User",
                photo: null,
            });
            expect(second.profile.version).not.toBe(first.profile.version);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-013 returns the authoritative profile for a stale If-Match writer",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getProfile();
            const current = await gym.client.updateProfile(
                { name: "Current Writer" },
                { ifMatch: initial.profile.version },
            );
            const failure = await captureFailure(() =>
                gym.client.updateProfile(
                    { name: "Stale Writer" },
                    { ifMatch: initial.profile.version },
                ),
            );

            expect(failure).toMatchObject({ code: "conflict", status: 409 });
            expect(failure.body).toMatchObject({
                code: "conflict",
                currentVersion: current.profile.version,
                profile: current.profile,
            });
            await expect(gym.client.getProfile()).resolves.toEqual(current);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-014 reports a missing profile photo through the typed error",
        async () => {
            const gym = await start(gyms);
            const failure = await captureFailure(() => gym.client.getProfilePhoto());

            expect(failure).toMatchObject({ code: "not_found", status: 404 });
            expect(failure.body).toMatchObject({
                code: "not_found",
                error: expect.any(String),
            });
            await expect(gym.client.getProfile()).resolves.toMatchObject({
                profile: { photo: null },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-015 serves canonical photo bytes and honors a matching ETag",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            await gym.client.setProfilePhoto(
                { contentType: "image/png", data: PNG_1X1 },
                { ifMatch: before.profile.version },
            );
            const photo = await gym.client.getProfilePhoto();

            expect(photo).toMatchObject({
                contentType: "image/webp",
                data: expect.any(ArrayBuffer),
                etag: expect.any(String),
            });
            expect(photo?.data.byteLength).toBeGreaterThan(0);
            await expect(
                gym.client.getProfilePhoto({ ifNoneMatch: photo?.etag ?? undefined }),
            ).resolves.toBeNull();
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-016 rejects an unsupported profile photo media type without mutating the profile",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            const invalidImage = {
                contentType: "text/plain",
                data: new Uint8Array([1, 2, 3]),
            } as never;
            const failure = await captureFailure(() =>
                gym.client.setProfilePhoto(invalidImage, {
                    ifMatch: before.profile.version,
                }),
            );

            expect(failure).toMatchObject({ code: "invalid_request", status: 400 });
            await expect(gym.client.getProfile()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-017 rejects a profile photo over the byte limit before decoding it",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            const oversized = new Uint8Array(PROFILE_PHOTO_LIMIT + 1);
            const failure = await captureFailure(() =>
                gym.client.setProfilePhoto(
                    { contentType: "image/png", data: oversized },
                    { ifMatch: before.profile.version },
                ),
            );

            expect(failure).toMatchObject({ code: "too_large", status: 413 });
            await expect(gym.client.getProfile()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-018 accepts an instructions document exactly at its size limit",
        async () => {
            const gym = await start(gyms);
            const instructions = "i".repeat(INSTRUCTIONS_LIMIT);

            await expect(gym.client.putInstructions(instructions)).resolves.toEqual({
                instructions,
            });
            await expect(gym.client.getInstructions()).resolves.toEqual({ instructions });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-019 rejects oversized instructions while preserving the previous document",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.putInstructions("preserve these instructions");
            const failure = await captureFailure(() =>
                gym.client.putInstructions("x".repeat(INSTRUCTIONS_LIMIT + 1)),
            );

            expect(failure).toMatchObject({ code: "invalid_request", status: 400 });
            await expect(gym.client.getInstructions()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-020 accepts a security policy exactly at its size limit",
        async () => {
            const gym = await start(gyms);
            const policy = "s".repeat(SECURITY_LIMIT);

            await expect(gym.client.putSecurityPolicy(policy)).resolves.toEqual({ policy });
            await expect(gym.client.getSecurityPolicy()).resolves.toEqual({ policy });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-021 rejects a malformed security body without changing the policy",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.put("/v0/config/security", {
                extra: true,
                policy: "must not write",
            });
            expectRawFailure(response, 400, "invalid_request");

            await expect(gym.client.getSecurityPolicy()).resolves.toEqual({ policy: "" });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-022 rejects a malformed project body before touching the catalog",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.listProjects();
            const beforeProjectIds = before.projects.map((project) => project.id);
            const response = await gym.raw.post("/v0/projects", { path: 123 });

            expectRawFailure(response, 400, "invalid_request");
            const after = await gym.client.listProjects();
            expect(after.projects.map((project) => project.id)).toEqual(beforeProjectIds);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-023 rejects a profile mutation without the required If-Match header",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.patch("/v0/profile", {
                name: "must not apply",
            });

            expectRawFailure(response, 400, "invalid_request");
            await expect(gym.client.getProfile()).resolves.toMatchObject({
                profile: { name: null },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-024 rejects a malformed If-Match value through the public client",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getProfile();
            const failure = await captureFailure(() =>
                gym.client.updateProfile(
                    { name: "must not apply" },
                    { ifMatch: "not-a-resource-version" },
                ),
            );

            expect(failure).toMatchObject({ code: "invalid_request", status: 400 });
            await expect(gym.client.getProfile()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-025 rejects a stale photo deletion with the current profile resource",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getProfile();
            const withPhoto = await gym.client.setProfilePhoto(
                { contentType: "image/png", data: PNG_1X1 },
                { ifMatch: initial.profile.version },
            );
            const failure = await captureFailure(() =>
                gym.client.deleteProfilePhoto({ ifMatch: initial.profile.version }),
            );

            expect(failure).toMatchObject({ code: "conflict", status: 409 });
            expect(failure.body).toMatchObject({
                currentVersion: withPhoto.profile.version,
                profile: withPhoto.profile,
            });
            await expect(gym.client.getProfile()).resolves.toEqual(withPhoto);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-026 reports runtime config changes as a stable conflict",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getConfig();
            const failure = await captureFailure(() =>
                gym.client.patchConfig({
                    settings: {
                        completionChime: !before.config.settings.completionChime,
                    },
                }),
            );

            expect(failure).toMatchObject({ code: "conflict", status: 409 });
            await expect(gym.client.getConfig()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-027 rejects an out-of-range event page limit through the public client",
        async () => {
            const gym = await start(gyms);
            const failure = await captureFailure(() => gym.client.getEvents({ limit: 0 }));

            expect(failure).toMatchObject({ code: "invalid_request", status: 400 });
            expect(failure.body).toMatchObject({
                code: "invalid_request",
                error: expect.any(String),
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-028 rejects a malformed event cursor through the public client",
        async () => {
            const gym = await start(gyms);
            const failure = await captureFailure(() =>
                gym.client.getEvents({ after: "not-a-uuid-v7" }),
            );

            expect(failure).toMatchObject({ code: "invalid_request", status: 400 });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-029 returns a stable not-found error for a missing project",
        async () => {
            const gym = await start(gyms);
            const failure = await captureFailure(() =>
                gym.client.getProject("missingcontractproject"),
            );

            expect(failure).toMatchObject({ code: "not_found", status: 404 });
            expect(failure.body).toMatchObject({
                code: "not_found",
                error: expect.any(String),
            });
            await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-030 treats POST on the greeting route as an absent method",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.post("/");

            expectRawFailure(response, 404, "not_found");
            await expect(gym.client.getGreeting()).resolves.toEqual({
                text: "Welcome to Happy Agent!",
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-031 treats PATCH on the health route as an absent method",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.patch("/v0/health", {});

            expectRawFailure(response, 404, "not_found");
            await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-032 rejects a wrong bearer token without echoing it",
        async () => {
            const gym = await start(gyms);
            const wrongToken = "contract-wrong-token";
            const client = new GymHttpClient({
                socketPath: gym.socketPath,
                token: wrongToken,
            });
            const response = await client.get("/v0/health");

            expectRawFailure(response, 401, "unauthorized");
            expect(response.text).not.toContain(wrongToken);
            expect(response.text).not.toContain(gym.token);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-033 rejects an empty bearer token before serving health",
        async () => {
            const gym = await start(gyms);
            const client = new GymHttpClient({
                socketPath: gym.socketPath,
                token: "",
            });
            const response = await client.get("/v0/health");

            expectRawFailure(response, 401, "unauthorized");
            expect(response.text).not.toContain(gym.token);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-034 keeps unauthorized errors JSON, cache-free, and bounded",
        async () => {
            const gym = await start(gyms);
            const client = new GymHttpClient({
                socketPath: gym.socketPath,
                token: "contract-header-token",
            });
            const response = await client.get("/v0/health");

            expectRawFailure(response, 401, "unauthorized");
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["content-type"]).toContain("application/json");
            expect(response.headers["content-length"]).toEqual(expect.any(String));
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-035 returns a cache-free JSON error for an unknown route",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.get("/v0/contract-route-does-not-exist");
            const body = expectRawFailure(response, 404, "not_found");

            expect(Object.keys(body).sort()).toEqual(["code", "error"]);
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(response.headers["content-type"]).toContain("application/json");
            expect(response.text).not.toContain(gym.token);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-036 rejects a private project path without disclosing it",
        async () => {
            const gym = await start(gyms);
            const privatePath = `${gym.happyHome}/contract-private-folder`;
            const response = await gym.raw.post("/v0/projects", { path: privatePath });

            expectRawFailure(response, 400, "invalid_request");
            expect(response.text).not.toContain(privatePath);
            expect(response.text).not.toContain(gym.happyHome);
            expect(response.text).not.toContain(gym.token);
            await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-037 does not reflect a credential placed in an unknown-route query",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.get(
                `/v0/contract-route-does-not-exist?authorization=${encodeURIComponent(gym.token)}`,
            );

            expectRawFailure(response, 404, "not_found");
            expect(response.text).not.toContain(gym.token);
            await expect(gym.client.getGreeting()).resolves.toMatchObject({
                text: "Welcome to Happy Agent!",
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-038 rejects a bodyless instructions request as malformed",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.request("PUT", "/v0/config/instructions");

            expectRawFailure(response, 400, "invalid_request");
            await expect(gym.client.getInstructions()).resolves.toEqual({
                instructions: "",
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-039 rejects extra instruction fields without writing them",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.put("/v0/config/instructions", {
                extra: "not part of the contract",
                instructions: "must not write",
            });

            expectRawFailure(response, 400, "invalid_request");
            await expect(gym.client.getInstructions()).resolves.toEqual({
                instructions: "",
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-040 removes the legacy sessions collection route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/sessions");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-041 removes the legacy session resource route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/sessions/legacy");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-042 removes the legacy models route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/models");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-043 removes the legacy catalog route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/catalog");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-044 removes the legacy timeline route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/timeline");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-045 removes the legacy live-events route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/events/live");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-046 removes the legacy event-trim route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/events/trim");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-047 removes the legacy provider-usage route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/provider-usage");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-048 removes the legacy plural profiles route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/profiles");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-049 exposes the stable public sharing snapshot",
        async () => {
            const gym = await start(gyms);
            await expect(gym.client.getSharing()).resolves.toMatchObject({
                sharing: { status: "unenrolled" },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-050 removes the legacy secrets route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/secrets");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-051 removes the legacy file-paths route",
        async () => {
            const gym = await start(gyms);
            await expectRemoved(gym, "/v0/file-paths");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-052 removes project-nested workspaces from the public surface",
        async () => {
            const gym = await start(gyms);
            const project = await firstProject(gym);
            await expectRemoved(gym, `/v0/projects/${project.id}/workspaces`);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-053 removes project-nested terminals from the public surface",
        async () => {
            const gym = await start(gyms);
            const project = await firstProject(gym);
            await expectRemoved(gym, `/v0/projects/${project.id}/terminals`);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-054 removes project-nested files from the public surface",
        async () => {
            const gym = await start(gyms);
            const project = await firstProject(gym);
            await expectRemoved(gym, `/v0/projects/${project.id}/files`);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "contract-055 removes project-nested Git from the public surface",
        async () => {
            const gym = await start(gyms);
            const project = await firstProject(gym);
            await expectRemoved(gym, `/v0/projects/${project.id}/git`);
        },
        TEST_TIMEOUT_MS,
    );
});

async function start(gyms: Set<AgentGym>): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    gyms.add(gym);
    return gym;
}

async function firstProject(gym: AgentGym) {
    const project = (await gym.client.listProjects()).projects[0];
    if (project === undefined) {
        throw new Error("The gym did not expose its root project.");
    }
    return project;
}

function asErrorBody(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

function expectRawFailure(
    response: { readonly body: unknown; readonly status: number },
    status: number,
    code: string,
): Record<string, unknown> {
    expect(response.status).toBe(status);
    const body = asErrorBody(response.body);
    expect(body).toMatchObject({
        code,
        error: expect.any(String),
    });
    return body;
}

async function captureFailure(operation: () => Promise<unknown>): Promise<ApiFailure> {
    try {
        await operation();
    } catch (error: unknown) {
        if (typeof error !== "object" || error === null) throw error;
        const candidate = error as {
            readonly body?: unknown;
            readonly code?: unknown;
            readonly status?: unknown;
        };
        if (typeof candidate.status !== "number") throw error;
        return {
            body:
                typeof candidate.body === "object" &&
                candidate.body !== null &&
                !Array.isArray(candidate.body)
                    ? (candidate.body as Record<string, unknown>)
                    : null,
            code: typeof candidate.code === "string" ? candidate.code : null,
            status: candidate.status,
        };
    }
    throw new Error("The API action unexpectedly succeeded.");
}

async function expectRemoved(gym: AgentGym, path: string): Promise<void> {
    const response = await gym.raw.get(path);
    const body = expectRawFailure(response, 404, "not_found");
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain(gym.token);
    expect(serialized).not.toContain(gym.happyHome);
    await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
}
