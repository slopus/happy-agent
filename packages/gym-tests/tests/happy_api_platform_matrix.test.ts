import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
    clientFrameEvent,
    createAgentGym,
    GymHttpClient,
    type AgentGym,
    type AgentGymOptions,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;
const INSTRUCTIONS_LIMIT = 256 * 1024;
const SECURITY_LIMIT = 32 * 1024;

type ApiFailure = {
    readonly body: Record<string, unknown> | null;
    readonly code: string | null;
    readonly status: number;
};

describe("Happy Agent platform API matrix", () => {
    const gyms = new Set<AgentGym>();

    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
    });

    it(
        "platform-001 returns the exact public greeting through the typed client",
        async () => {
            const gym = await start(gyms);

            await expect(gym.client.getGreeting()).resolves.toEqual({
                text: "Welcome to Happy Agent!",
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-002 sends JSON and no-store headers on the greeting",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.get("/");

            expect(response.status).toBe(200);
            expect(response.headers["content-type"]).toContain("application/json");
            expect(response.headers["cache-control"]).toBe("no-store");
            expect(Number(response.headers["content-length"])).toBeGreaterThan(0);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-003 reports a complete ready health resource",
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
            expect(health.version.protocol).toBeGreaterThan(0);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-004 preserves a caller-selected daemon version in health",
        async () => {
            const gym = await start(gyms, { version: "platform-matrix-version" });

            await expect(gym.client.getHealth()).resolves.toMatchObject({
                version: {
                    daemon: "platform-matrix-version",
                    protocol: expect.any(Number),
                },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-005 creates a bearer token with the documented private shape",
        async () => {
            const gym = await start(gyms);

            expect(gym.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(gym.token).not.toContain("/");
            expect(gym.token).not.toContain("+");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-006 rejects missing or wrong credentials without disclosing them",
        async () => {
            const gym = await start(gyms);
            const missing = new GymHttpClient({
                socketPath: gym.socketPath,
                token: "",
            });
            const wrongToken = "wrong-platform-token";
            const wrong = new GymHttpClient({
                socketPath: gym.socketPath,
                token: wrongToken,
            });

            const missingResponse = await missing.get("/v0/health");
            const wrongResponse = await wrong.get("/v0/health");

            expect(missingResponse).toMatchObject({
                body: { code: "unauthorized" },
                status: 401,
            });
            expect(wrongResponse).toMatchObject({
                body: { code: "unauthorized" },
                status: 401,
            });
            expect(missingResponse.text).not.toContain(gym.token);
            expect(wrongResponse.text).not.toContain(wrongToken);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-007 returns a stable not-found error for an unknown route",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.get(`/v0/platform-missing?secret=${gym.token}`);

            expect(response).toMatchObject({
                body: { code: "not_found", error: expect.any(String) },
                status: 404,
            });
            expect(response.text).not.toContain(gym.token);
            expect(response.headers["cache-control"]).toBe("no-store");
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-008 exposes the complete sanitized configuration envelope",
        async () => {
            const gym = await start(gyms);
            const response = await gym.client.getConfig();

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
            expect(Object.keys(response.config.network).sort()).toEqual([
                "allowLocalBinding",
                "allowedDomains",
                "allowedLoopbackPorts",
                "allowedPorts",
                "deniedDomains",
            ]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-009 keeps model definitions and provider references internally consistent",
        async () => {
            const gym = await start(gyms);
            const config = (await gym.client.getConfig()).config;

            expect(Object.keys(config.models).length).toBeGreaterThan(0);
            for (const [modelId, model] of Object.entries(config.models)) {
                expect(modelId).toMatch(/.+/);
                expect(model).toMatchObject({
                    defaultEffort: expect.any(String),
                    efforts: expect.any(Array),
                    name: expect.any(String),
                    serviceTiers: expect.any(Array),
                });
                expect(
                    model.contextWindow === null || typeof model.contextWindow === "number",
                ).toBe(true);
            }
            for (const provider of Object.values(config.providers)) {
                expect(provider.models).toEqual(expect.any(Array));
                for (const model of provider.models) {
                    expect(config.models[model.id]).toBeDefined();
                }
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-010 removes the bearer token and private homes from config JSON",
        async () => {
            const gym = await start(gyms);
            const serialized = JSON.stringify(await gym.client.getConfig());

            expect(serialized).not.toContain(gym.token);
            expect(serialized).not.toContain(gym.happyHome);
            expect(serialized).not.toContain(gym.workspacePath);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-011 reflects read-only permission mode in effective defaults",
        async () => {
            const gym = await start(gyms, { permissionMode: "read_only" });

            await expect(gym.client.getConfig()).resolves.toMatchObject({
                config: { defaults: { permissionMode: "read_only" } },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-012 reflects workspace-write permission mode in effective defaults",
        async () => {
            const gym = await start(gyms, { permissionMode: "workspace_write" });

            await expect(gym.client.getConfig()).resolves.toMatchObject({
                config: { defaults: { permissionMode: "workspace_write" } },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-013 reflects auto permission mode in effective defaults",
        async () => {
            const gym = await start(gyms, { permissionMode: "auto" });

            await expect(gym.client.getConfig()).resolves.toMatchObject({
                config: { defaults: { permissionMode: "auto" } },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-014 rejects runtime configuration changes without changing the snapshot",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getConfig();
            const failure = await captureFailure(() =>
                gym.client.patchConfig({
                    settings: { completionChime: !before.config.settings.completionChime },
                }),
            );

            expect(failure).toMatchObject({ code: "conflict", status: 409 });
            await expect(gym.client.getConfig()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-015 rejects an empty runtime configuration request cleanly",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getConfig();
            const failure = await captureFailure(() => gym.client.patchConfig({}));

            expect(failure).toMatchObject({ code: "conflict", status: 409 });
            await expect(gym.client.getConfig()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-016 starts with an empty global instructions document",
        async () => {
            const gym = await start(gyms);

            await expect(gym.client.getInstructions()).resolves.toEqual({ instructions: "" });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-017 round-trips Unicode and multiline instructions",
        async () => {
            const gym = await start(gyms);
            const instructions = "Line one\n雪だるま · café\n最后一行\n";

            await expect(gym.client.putInstructions(instructions)).resolves.toEqual({
                instructions,
            });
            await expect(gym.client.getInstructions()).resolves.toEqual({ instructions });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-018 accepts an instructions document exactly at its size limit",
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
        "platform-019 rejects oversized instructions and preserves the prior document",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.putInstructions("preserve this");
            const failure = await captureFailure(() =>
                gym.client.putInstructions("x".repeat(INSTRUCTIONS_LIMIT + 1)),
            );

            expect(failure).toMatchObject({ code: "invalid_request", status: 400 });
            await expect(gym.client.getInstructions()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-020 rejects an empty instructions request with invalid_request",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.request("PUT", "/v0/config/instructions");

            expect(response).toMatchObject({
                body: { code: "invalid_request", error: expect.any(String) },
                status: 400,
            });
            await expect(gym.client.getInstructions()).resolves.toEqual({ instructions: "" });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-021 starts with an empty global security policy",
        async () => {
            const gym = await start(gyms);

            await expect(gym.client.getSecurityPolicy()).resolves.toEqual({ policy: "" });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-022 round-trips Unicode and multiline security policy text",
        async () => {
            const gym = await start(gyms);
            const policy = "Allow local reads.\n安全第一 · café\n";

            await expect(gym.client.putSecurityPolicy(policy)).resolves.toEqual({ policy });
            await expect(gym.client.getSecurityPolicy()).resolves.toEqual({ policy });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-023 accepts a security policy exactly at its size limit",
        async () => {
            const gym = await start(gyms);
            const policy = "s".repeat(SECURITY_LIMIT);

            await expect(gym.client.putSecurityPolicy(policy)).resolves.toEqual({ policy });
            await expect(gym.client.getSecurityPolicy()).resolves.toEqual({ policy });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-024 rejects an oversized security policy and preserves the prior text",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.putSecurityPolicy("preserve this policy");
            const failure = await captureFailure(() =>
                gym.client.putSecurityPolicy("x".repeat(SECURITY_LIMIT + 1)),
            );

            expect(failure).toMatchObject({ code: "invalid_request", status: 400 });
            await expect(gym.client.getSecurityPolicy()).resolves.toEqual(before);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-025 rejects extra security body fields without changing the policy",
        async () => {
            const gym = await start(gyms);
            const response = await gym.raw.request("PUT", "/v0/config/security", {
                extra: true,
                policy: "must not write",
            });

            expect(response).toMatchObject({
                body: { code: "invalid_request", error: expect.any(String) },
                status: 400,
            });
            await expect(gym.client.getSecurityPolicy()).resolves.toEqual({ policy: "" });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-026 writes both global documents with owner-only permissions",
        async () => {
            const gym = await start(gyms);
            await gym.client.putInstructions("private instructions");
            await gym.client.putSecurityPolicy("private policy");

            expect(
                permissions((await stat(join(gym.publicHomePath, "Config", "AGENTS.md"))).mode),
            ).toBe(0o600);
            expect(
                permissions((await stat(join(gym.publicHomePath, "Config", "SECURITY.md"))).mode),
            ).toBe(0o600);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-027 persists both global documents across daemon restart",
        async () => {
            const gym = await start(gyms);
            const instructions = await gym.client.putInstructions("restart instructions");
            const policy = await gym.client.putSecurityPolicy("restart policy");
            const socketPath = gym.socketPath;
            const token = gym.token;

            await gym.restart();

            expect(gym.socketPath).toBe(socketPath);
            expect(gym.token).toBe(token);
            await expect(gym.client.getInstructions()).resolves.toEqual(instructions);
            await expect(gym.client.getSecurityPolicy()).resolves.toEqual(policy);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-028 identifies stable and replacement daemons in each honest hello",
        async () => {
            const gym = await start(gyms);
            const stream = gym.stream();
            let daemonId = "";
            let daemonStartedAt = 0;
            try {
                await stream.opened();
                const hello = stream.frames.find((frame) => frame.event === "hello");

                expect(hello?.data).toMatchObject({
                    gap: false,
                    resumed: false,
                    cursor: expect.any(String),
                    daemonId: expect.any(String),
                    daemonStartedAt: expect.any(Number),
                    draining: false,
                });
                const helloData = hello?.data as
                    | { readonly daemonId?: unknown; readonly daemonStartedAt?: unknown }
                    | undefined;
                if (
                    typeof helloData?.daemonId !== "string" ||
                    typeof helloData.daemonStartedAt !== "number"
                ) {
                    throw new Error("The event stream hello did not identify the daemon.");
                }
                daemonId = helloData.daemonId;
                daemonStartedAt = helloData.daemonStartedAt;
            } finally {
                stream.close();
            }

            const reconnect = gym.stream();
            try {
                await reconnect.opened();
                const hello = reconnect.frames.find((frame) => frame.event === "hello");
                expect(hello?.data).toMatchObject({ daemonId, daemonStartedAt });
            } finally {
                reconnect.close();
            }

            await gym.restart();
            const replacement = gym.stream();
            try {
                await replacement.opened();
                const hello = replacement.frames.find((frame) => frame.event === "hello");
                expect(hello?.data).toMatchObject({
                    daemonId: expect.any(String),
                    daemonStartedAt: expect.any(Number),
                    draining: false,
                });
                const helloData = hello?.data as { readonly daemonId?: unknown } | undefined;
                expect(helloData?.daemonId).not.toBe(daemonId);
            } finally {
                replacement.close();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-029 publishes one config update event after each document write",
        async () => {
            const gym = await start(gyms);
            const stream = gym.stream();
            try {
                await stream.opened();
                await gym.client.putInstructions("event instructions");
                const first = await stream.waitFor(
                    (frame) => frame.event === "config.updated",
                    "the instructions config event",
                );
                await gym.client.putSecurityPolicy("event policy");
                const second = await stream.waitFor(
                    (frame) => frame.event === "config.updated" && frame.id !== first.id,
                    "the security config event",
                );

                expect(first.id).toEqual(expect.any(String));
                expect(second.id).toEqual(expect.any(String));
                expect(first.id).not.toBe(second.id);
                expect(clientFrameEvent(first)).toMatchObject({ type: "config.updated" });
                expect(clientFrameEvent(second)).toMatchObject({ type: "config.updated" });
            } finally {
                stream.close();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-030 resumes an event stream from Last-Event-ID without replaying the cursor",
        async () => {
            const gym = await start(gyms);
            const firstStream = gym.stream();
            try {
                await firstStream.opened();
                await gym.client.putInstructions("resume instructions");
                const firstEvent = await firstStream.waitFor(
                    (frame) => frame.event === "config.updated",
                    "the resumable config event",
                );
                const cursor = firstEvent.id;
                expect(cursor).toEqual(expect.any(String));
                if (typeof cursor !== "string") {
                    throw new Error("The config event did not carry a cursor.");
                }
                firstStream.close();

                const reconnect = gym.stream("/v0/events/stream", {
                    lastEventId: cursor,
                });
                try {
                    await reconnect.opened();
                    const hello = reconnect.frames.find((frame) => frame.event === "hello");
                    expect(hello?.data).toMatchObject({
                        gap: false,
                        resumed: true,
                    });

                    await gym.client.putSecurityPolicy("after reconnect");
                    const nextEvent = await reconnect.waitFor(
                        (frame) => frame.event === "config.updated",
                        "the post-reconnect config event",
                    );
                    expect(nextEvent.id).not.toBe(cursor);
                } finally {
                    reconnect.close();
                }
            } finally {
                firstStream.close();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-031 starts and stops the inspector through the public API",
        async () => {
            const gym = await start(gyms);

            const started = await gym.client.startInspector();
            try {
                expect(started.inspectorUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+$/);
            } finally {
                await expect(gym.client.stopInspector()).resolves.toEqual({ stopped: true });
            }
            await expect(gym.client.stopInspector()).resolves.toEqual({ stopped: false });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "platform-032 shuts down and restarts with the same authenticated installation",
        async () => {
            const gym = await start(gyms);
            const tokenBefore = gym.token;
            const shutdown = await gym.client.shutdown();

            expect(shutdown).toMatchObject({
                pid: expect.any(Number),
                shuttingDown: true,
            });
            await gym.restart();

            expect(gym.token).toBe(tokenBefore);
            await expect(gym.client.getGreeting()).resolves.toEqual({
                text: "Welcome to Happy Agent!",
            });
            await expect(gym.client.getHealth()).resolves.toMatchObject({
                ready: true,
                status: "ready",
            });
        },
        TEST_TIMEOUT_MS,
    );
});

async function start(gyms: Set<AgentGym>, options: AgentGymOptions = {}): Promise<AgentGym> {
    const gym = await createAgentGym(options);
    gyms.add(gym);
    return gym;
}

async function captureFailure(action: () => Promise<unknown>): Promise<ApiFailure> {
    try {
        await action();
    } catch (error: unknown) {
        if (typeof error === "object" && error !== null) {
            const candidate = error as {
                readonly body?: unknown;
                readonly code?: unknown;
                readonly status?: unknown;
            };
            if (typeof candidate.status === "number") {
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
        }
        throw error;
    }
    throw new Error("The API action unexpectedly succeeded.");
}

function permissions(mode: number): number {
    return mode & 0o777;
}
