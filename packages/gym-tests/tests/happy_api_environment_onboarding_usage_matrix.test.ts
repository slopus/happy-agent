import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;

describe("Happy Agent onboarding and usage matrix", () => {
    const gyms = new Set<AgentGym>();
    const servers = new Set<Server>();

    afterEach(async () => {
        await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
        gyms.clear();
        await Promise.all([...servers].map(closeServer));
        servers.clear();
    });

    it(
        "environment-001 reports the project and provider onboarding steps on a fresh install",
        async () => {
            const gym = await start(gyms);
            const onboarding = await gym.client.getOnboarding();

            expect(onboarding.completed).toBe(false);
            expect(onboarding.steps).toEqual({
                profile: { done: false },
                project: { done: true },
                providers: { done: true, signedIn: ["gym"] },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-002 marks the profile step complete only after a non-null name",
        async () => {
            const gym = await start(gyms);
            const before = await gym.client.getOnboarding();
            const profile = await gym.client.getProfile();

            await gym.client.updateProfile(
                { email: "steps@example.test" },
                { ifMatch: profile.profile.version },
            );
            expect((await gym.client.getOnboarding()).steps.profile.done).toBe(false);

            const named = await gym.client.getProfile();
            await gym.client.updateProfile(
                { name: "Onboarding User" },
                { ifMatch: named.profile.version },
            );
            const after = await gym.client.getOnboarding();
            expect(before.completed).toBe(false);
            expect(after.steps.profile.done).toBe(true);
            expect(after.steps.project).toEqual(before.steps.project);
            expect(after.steps.providers).toEqual(before.steps.providers);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-003 leaves onboarding incomplete when only the project exists",
        async () => {
            const gym = await start(gyms);
            const onboarding = await gym.client.getOnboarding();

            expect(onboarding.completed).toBe(false);
            expect(onboarding.steps.project.done).toBe(true);
            expect(onboarding.steps.profile.done).toBe(false);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-004 allows explicit completion before optional profile setup",
        async () => {
            const gym = await start(gyms);

            await expect(gym.client.completeOnboarding()).resolves.toEqual({ completed: true });
            await expect(gym.client.getOnboarding()).resolves.toMatchObject({
                completed: true,
                steps: { profile: { done: false }, project: { done: true } },
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-005 treats repeated onboarding completion as an idempotent no-op",
        async () => {
            const gym = await start(gyms);
            await waitForRootProjectReady(gym);
            const before = await gym.events();

            const first = await gym.client.completeOnboarding();
            const afterFirst = await gym.events();
            const second = await gym.client.completeOnboarding();
            const afterSecond = await gym.events();

            expect(first).toEqual({ completed: true });
            expect(second).toEqual(first);
            expect(afterSecond).toEqual(afterFirst);
            expect(afterFirst.length).toBeGreaterThanOrEqual(before.length);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-006 keeps completion durable across restart",
        async () => {
            const gym = await start(gyms);
            await gym.client.completeOnboarding();
            const completed = await gym.client.getOnboarding();

            await gym.restart();

            await expect(gym.client.getOnboarding()).resolves.toEqual(completed);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-007 preserves onboarding steps when the profile is later edited",
        async () => {
            const gym = await start(gyms);
            const initial = await gym.client.getProfile();
            const named = await gym.client.updateProfile(
                { name: "Stable Onboarding" },
                { ifMatch: initial.profile.version },
            );
            await gym.client.completeOnboarding();
            const beforeClear = await gym.client.getOnboarding();

            const cleared = await gym.client.updateProfile(
                { name: null },
                { ifMatch: named.profile.version },
            );
            const afterClear = await gym.client.getOnboarding();

            expect(cleared.profile.name).toBeNull();
            expect(beforeClear.completed).toBe(true);
            expect(afterClear.completed).toBe(true);
            expect(afterClear.steps.profile.done).toBe(false);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-008 returns empty rolling usage before any inference",
        async () => {
            const gym = await start(gyms);

            await expect(gym.client.getUsage()).resolves.toMatchObject({
                day: {},
                hour: {},
                month: {},
                week: {},
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-009 records every token field in the daemon rolling usage",
        async () => {
            const gym = await startWithUsage(gyms, {
                cacheRead: 13,
                cacheWrite: 17,
                input: 19,
                output: 23,
                totalTokens: 72,
            });
            await gym.send("record one usage");
            const usage = await gym.client.getUsage();

            expect(usage.hour.gym?.["gym/model"]).toMatchObject({
                cacheRead: 13,
                cacheWrite: 17,
                input: 19,
                output: 23,
            });
            expect(usage.day.gym?.["gym/model"]).toEqual(usage.hour.gym?.["gym/model"]);
            expect(usage.week.gym?.["gym/model"]).toEqual(usage.hour.gym?.["gym/model"]);
            expect(usage.month.gym?.["gym/model"]).toEqual(usage.hour.gym?.["gym/model"]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-010 sums multiple runs and separates provider model keys",
        async () => {
            const gym = await startWithUsage(gyms, [
                { cacheRead: 1, cacheWrite: 2, input: 3, output: 5, totalTokens: 11 },
                { cacheRead: 7, cacheWrite: 11, input: 13, output: 17, totalTokens: 48 },
            ]);
            await gym.send("first usage");
            await gym.send("second usage", { modelId: "gym/model-2" });
            const usage = await gym.client.getUsage();

            expect(usage.hour.gym?.["gym/model"]).toMatchObject({
                cacheRead: 1,
                cacheWrite: 2,
                input: 3,
                output: 5,
            });
            expect(usage.hour.gym?.["gym/model-2"]).toMatchObject({
                cacheRead: 7,
                cacheWrite: 11,
                input: 13,
                output: 17,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-011 retains rolling usage after daemon restart",
        async () => {
            const gym = await startWithUsage(gyms, {
                cacheRead: 29,
                cacheWrite: 31,
                input: 37,
                output: 41,
                totalTokens: 138,
            });
            await gym.send("durable usage");
            const before = await gym.client.getUsage();

            await gym.restart();

            await expect(gym.client.getUsage()).resolves.toMatchObject({
                day: before.day,
                hour: before.hour,
                month: before.month,
                week: before.week,
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-012 keeps the public usage endpoint usable after an inference failure",
        async () => {
            const gym = await createAgentGym({
                inference: [
                    {
                        error: {
                            kind: "unknown",
                            message: "synthetic provider failure",
                        },
                    },
                ],
                timeoutMs: 15_000,
            });
            gyms.add(gym);
            await expect(gym.send("failed usage turn")).resolves.toMatchObject({
                agentId: gym.defaultSessionId,
            });

            const usage = await gym.client.getUsage();
            expect(usage).toHaveProperty("hour");
            expect(usage.hour).toEqual({});
            await expect(gym.client.getGreeting()).resolves.toMatchObject({
                text: "Welcome to Happy Agent!",
            });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "environment-013 returns every provider, every model, and every account quota value",
        async () => {
            const server = createServer((request, response) => {
                response.setHeader("content-type", "application/json");
                if (request.url === "/api/oauth/usage") {
                    response.end(
                        JSON.stringify({
                            subscription_type: "max",
                            five_hour: {
                                utilization: 31,
                                resets_at: "2030-01-01T05:00:00.000Z",
                            },
                            seven_day: {
                                utilization: 47,
                                resets_at: "2030-01-08T00:00:00.000Z",
                            },
                            extra_usage: {
                                is_enabled: true,
                                monthly_limit: 100,
                                used_credits: 42,
                                utilization: 42,
                            },
                            limits: [],
                        }),
                    );
                    return;
                }
                if (request.url === "/api/oauth/profile") {
                    response.end(JSON.stringify({ account: { has_claude_max: true } }));
                    return;
                }
                response.statusCode = 404;
                response.end(JSON.stringify({ error: "not found" }));
            });
            servers.add(server);
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address() as AddressInfo;
            const gym = await createAgentGym({
                config: [
                    "[providers]",
                    "default_enable = false",
                    "",
                    "[providers.claude]",
                    "enabled = true",
                    'oauth_token = "gym-oauth-token"',
                    'include_models = ["anthropic/opus-5"]',
                ].join("\n"),
                environment: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(address.port)}` },
                timeoutMs: 15_000,
            });
            gyms.add(gym);

            const usage = await gym.waitUntil(async () => {
                const candidate = await gym.client.getUsage();
                return candidate.providers?.find(
                    (provider) => provider.providerId === "claude" && provider.usage !== null,
                ) === undefined
                    ? undefined
                    : candidate;
            }, "Claude account usage to reach the public usage endpoint");
            const providers = usage.providers ?? [];

            expect(providers.map((provider) => provider.providerId)).toEqual([
                "bedrock",
                "claude",
                "codex",
                "grok",
                "gym",
            ]);
            const claude = providers.find((provider) => provider.providerId === "claude");
            expect(claude?.models).toEqual([
                { id: "anthropic/opus-5", enabled: true },
                { id: "anthropic/sonnet-5", enabled: false },
                { id: "anthropic/fable-5", enabled: false },
                { id: "anthropic/opus-4-8", enabled: false },
            ]);
            expect(providers.find((provider) => provider.providerId === "codex")?.models).toEqual([
                { id: "openai/gpt-5.6-sol", enabled: false },
                { id: "openai/gpt-5.6-terra", enabled: false },
                { id: "openai/gpt-5.6-luna", enabled: false },
            ]);
            expect(providers.find((provider) => provider.providerId === "gym")?.models).toEqual([
                { id: "gym/model", enabled: true },
                { id: "gym/model-2", enabled: true },
            ]);
            expect(claude).toMatchObject({
                type: "claude",
                enabled: true,
                checkedAt: expect.any(Number),
                error: null,
                usage: {
                    providerId: "claude",
                    vendor: "claude",
                    capturedAt: expect.any(Number),
                    planName: "Max",
                    exhausted: false,
                    windows: {
                        fiveHour: {
                            usedPercent: 31,
                            startsAt: Date.parse("2030-01-01T00:00:00.000Z"),
                            resetsAt: Date.parse("2030-01-01T05:00:00.000Z"),
                            durationMs: 18_000_000,
                        },
                        weekly: {
                            usedPercent: 47,
                            startsAt: Date.parse("2030-01-01T00:00:00.000Z"),
                            resetsAt: Date.parse("2030-01-08T00:00:00.000Z"),
                            durationMs: 604_800_000,
                        },
                        monthly: null,
                    },
                    credits: {
                        available: true,
                        remainingCents: null,
                        unlimited: false,
                        usedPercent: 42,
                    },
                },
            });
            expect(usage).toMatchObject({ day: {}, hour: {}, month: {}, week: {} });
        },
        TEST_TIMEOUT_MS,
    );
});

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
}

async function start(gyms: Set<AgentGym>): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    gyms.add(gym);
    return gym;
}

async function startWithUsage(
    gyms: Set<AgentGym>,
    usage:
        | {
              readonly cacheRead: number;
              readonly cacheWrite: number;
              readonly input: number;
              readonly output: number;
              readonly totalTokens: number;
          }
        | readonly {
              readonly cacheRead: number;
              readonly cacheWrite: number;
              readonly input: number;
              readonly output: number;
              readonly totalTokens: number;
          }[],
): Promise<AgentGym> {
    const turns = Array.isArray(usage) ? usage : [usage];
    let turn = 0;
    const gym = await createAgentGym({
        inference: (request) => {
            if (request.sessionId.startsWith("naming:")) {
                return { content: [{ text: "<title>Usage test</title>", type: "text" }] };
            }
            const tokens = turns[turn];
            turn += 1;
            return tokens === undefined
                ? { error: { message: `No usage fixture for turn ${String(turn - 1)}.` } }
                : {
                      content: [{ text: "usage response", type: "text" }],
                      usage: tokens,
                  };
        },
        timeoutMs: 15_000,
    });
    gyms.add(gym);
    return gym;
}

async function waitForRootProjectReady(gym: AgentGym): Promise<void> {
    await gym.waitUntil(async () => {
        const projects = await gym.client.listProjects();
        return projects.projects.some((project) => project.initialization.status === "ready")
            ? true
            : undefined;
    }, "the root project to finish initializing");
    await gym.waitUntil(async () => {
        const events = await gym.events();
        return events.some((event) => event.type === "project.updated") ? true : undefined;
    }, "the root project event");
}
