import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
    clientFrameEvent,
    createAgentGym,
    GymHttpClient,
    type AgentGym,
} from "@slopus/happy-agent-gym";
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

function permissions(mode: number): number {
    return mode & 0o777;
}

describe("Happy Agent platform API", () => {
    it("serves the public greeting and ready health", async () => {
        const gym = await start();

        await expect(gym.client.getGreeting()).resolves.toEqual({
            text: "Welcome to Happy Agent!",
        });
        await expect(gym.client.getHealth()).resolves.toMatchObject({
            healthy: true,
            ready: true,
            status: "ready",
            version: {
                daemon: "gym",
                protocol: expect.any(Number),
            },
        });
    });

    it("rejects missing and wrong authorization and keeps unknown routes absent", async () => {
        const gym = await start();
        const missing = new GymHttpClient({ socketPath: gym.socketPath, token: "" });
        const wrong = new GymHttpClient({
            socketPath: gym.socketPath,
            token: "wrong-token".padEnd(43, "x"),
        });

        await expect(missing.get("/v0/health")).resolves.toMatchObject({
            body: { code: "unauthorized", error: expect.any(String) },
            status: 401,
        });
        await expect(wrong.get("/v0/health")).resolves.toMatchObject({
            body: { code: "unauthorized", error: expect.any(String) },
            status: 401,
        });
        await expect(gym.raw.get("/v0/not-a-real-route")).resolves.toMatchObject({
            body: { code: "not_found", error: expect.any(String) },
            status: 404,
        });
        await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
    });

    it("protects the agent home, token, and socket with private permissions", async () => {
        const gym = await start();

        expect(permissions((await stat(join(gym.happyHome, "agent"))).mode)).toBe(0o700);
        expect(permissions((await stat(join(gym.happyHome, "agent", "token"))).mode)).toBe(0o600);
        expect(permissions((await stat(gym.socketPath)).mode)).toBe(0o600);
    });

    it("returns sanitized configuration and rejects unsupported runtime changes", async () => {
        const gym = await start();
        const before = await gym.client.getConfig();
        const serialized = JSON.stringify(before);

        expect(before.config.models).toHaveProperty("gym/model");
        expect(serialized).not.toContain(gym.token);
        expect(serialized).not.toContain(gym.happyHome);

        await expect(
            gym.client.patchConfig({
                settings: { completionChime: !before.config.settings.completionChime },
            }),
        ).rejects.toMatchObject({
            code: "conflict",
            status: 409,
        });
        await expect(gym.client.getConfig()).resolves.toEqual(before);
    });

    it(
        "persists instructions and security policy, emits config updates, and enforces limits",
        async () => {
            const gym = await start();
            const stream = gym.stream();
            try {
                await stream.opened();
                await expect(
                    gym.client.putInstructions("Global gym instructions\n"),
                ).resolves.toEqual({
                    instructions: "Global gym instructions\n",
                });
                const instructionsFrame = await stream.waitFor(
                    (frame) => frame.event === "config.updated",
                    "the instructions config update",
                );
                const instructionsEvent = clientFrameEvent(instructionsFrame);
                expect(instructionsEvent?.type).toBe("config.updated");

                await expect(
                    gym.client.putSecurityPolicy("Gym security policy\n"),
                ).resolves.toEqual({
                    policy: "Gym security policy\n",
                });
                const securityEvent = clientFrameEvent(
                    await stream.waitFor(
                        (frame) =>
                            frame.event === "config.updated" && frame.id !== instructionsFrame.id,
                        "the security config update",
                    ),
                );
                expect(securityEvent?.type).toBe("config.updated");
            } finally {
                stream.close();
            }

            expect(
                permissions((await stat(join(gym.publicHomePath, "Config", "AGENTS.md"))).mode),
            ).toBe(0o600);
            expect(
                permissions((await stat(join(gym.publicHomePath, "Config", "SECURITY.md"))).mode),
            ).toBe(0o600);

            await expect(
                gym.client.putInstructions("x".repeat(256 * 1024 + 1)),
            ).rejects.toMatchObject({
                code: "invalid_request",
                status: 400,
            });
            await expect(
                gym.client.putSecurityPolicy("x".repeat(32 * 1024 + 1)),
            ).rejects.toMatchObject({
                code: "invalid_request",
                status: 400,
            });

            await gym.restart();
            await expect(gym.client.getInstructions()).resolves.toEqual({
                instructions: "Global gym instructions\n",
            });
            await expect(gym.client.getSecurityPolicy()).resolves.toEqual({
                policy: "Gym security policy\n",
            });
        },
        TEST_TIMEOUT_MS,
    );

    it("starts and stops the inspector through the public lifecycle", async () => {
        const gym = await start();

        const started = await gym.client.startInspector();
        expect(started.inspectorUrl).toMatch(/^ws:\/\//);
        await expect(gym.client.stopInspector()).resolves.toEqual({ stopped: true });
        await expect(gym.client.stopInspector()).resolves.toEqual({ stopped: false });
    });

    it(
        "shuts down gracefully and preserves the bearer token across restart",
        async () => {
            const gym = await start();
            const tokenPath = join(gym.happyHome, "agent", "token");
            const tokenBefore = (await readFile(tokenPath, "utf8")).trim();

            await expect(gym.client.shutdown()).resolves.toMatchObject({
                pid: expect.any(Number),
                shuttingDown: true,
            });
            await gym.restart();

            expect((await readFile(tokenPath, "utf8")).trim()).toBe(tokenBefore);
            expect(gym.token).toBe(tokenBefore);
            await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "stays ready and reports named work while graceful shutdown waits for an agent operation",
        async () => {
            let operationStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                operationStarted = resolve;
            });
            let finishOperation!: () => void;
            const operationFinished = new Promise<void>((resolve) => {
                finishOperation = resolve;
            });
            const gym = await createAgentGym({
                inference: async (request) => {
                    if (request.tools.length === 0) {
                        return {
                            content: [{ text: "<title>Graceful shutdown</title>", type: "text" }],
                        };
                    }
                    operationStarted();
                    await operationFinished;
                    return { content: [{ text: "Operation finished.", type: "text" }] };
                },
                timeoutMs: 15_000,
            });
            running.add(gym);

            try {
                await gym.send("Hold this operation while shutdown starts.", { wait: false });
                await started;
                await expect(gym.client.shutdown()).resolves.toMatchObject({
                    shuttingDown: true,
                });

                const health = await gym.waitUntil(async () => {
                    const current = await gym.client.getHealth();
                    return current.shuttingDown === true &&
                        current.waitingFor?.includes("agent-system") === true
                        ? current
                        : undefined;
                }, "graceful shutdown health");
                expect(health).toMatchObject({
                    healthy: true,
                    ready: true,
                    shuttingDown: true,
                    status: "ready",
                });
                expect(health.waitingFor).toContain("agent-system");
                await expect(gym.client.getGreeting()).resolves.toEqual({
                    text: "Welcome to Happy Agent!",
                });
            } finally {
                finishOperation();
            }

            await expect(gym.daemon.closed).resolves.toBeUndefined();
            expect(
                gym.inference.requests.filter((request) => request.tools.length > 0),
            ).toHaveLength(1);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "drains at the inference edge, stays read-only, and stops only when asked",
        async () => {
            let inferenceStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                inferenceStarted = resolve;
            });
            let finishInference!: () => void;
            const inferenceFinished = new Promise<void>((resolve) => {
                finishInference = resolve;
            });
            let projectId = "";
            const gym = await createAgentGym({
                inference: async (request) => {
                    if (request.tools.length === 0) {
                        return {
                            content: [{ text: "<title>Daemon draining</title>", type: "text" }],
                        };
                    }
                    inferenceStarted();
                    await inferenceFinished;
                    return {
                        content: [
                            {
                                arguments: {
                                    name: "Must remain uncreated while draining",
                                    projectRef: projectId,
                                },
                                callId: "drain_edge_workspace",
                                name: "create_workspace",
                                type: "tool_call",
                            },
                        ],
                    };
                },
                timeoutMs: 15_000,
            });
            running.add(gym);
            const project = (await gym.client.listProjects()).projects.find((candidate) =>
                candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
            );
            expect(project).toBeDefined();
            if (project === undefined)
                throw new Error("The gym did not register its root project.");
            projectId = project.id;

            try {
                await gym.send("Return a workspace tool call after the drain starts.", {
                    wait: false,
                });
                await started;

                await expect(gym.client.drain()).resolves.toMatchObject({
                    draining: true,
                    pid: expect.any(Number),
                });
                await expect(gym.client.drain()).resolves.toMatchObject({ draining: true });

                const draining = await gym.waitUntil(async () => {
                    const current = await gym.client.getHealth();
                    return current.drainWaitingFor?.some(
                        (item) =>
                            item.name === "agent-system" &&
                            item.agents?.some(
                                (agent) =>
                                    agent.id === gym.defaultSessionId &&
                                    agent.stage === "inference",
                            ) === true,
                    ) === true
                        ? current
                        : undefined;
                }, "the daemon to report its in-flight inference");
                expect(draining).toMatchObject({
                    draining: true,
                    healthy: true,
                    ready: true,
                    status: "ready",
                });
                await expect(gym.client.getGreeting()).resolves.toEqual({
                    text: "Welcome to Happy Agent!",
                });
                await expect(
                    gym.client.putInstructions("This mutation must be rejected.\n"),
                ).rejects.toMatchObject({
                    code: "draining",
                    status: 503,
                });
            } finally {
                finishInference();
            }

            const drained = await gym.waitUntil(async () => {
                const current = await gym.client.getHealth();
                return current.draining === true && current.drainWaitingFor?.length === 0
                    ? current
                    : undefined;
            }, "the daemon to finish draining");
            expect(drained).toMatchObject({
                draining: true,
                ready: true,
                status: "ready",
            });
            expect(
                (
                    await gym.client.listWorkspaces({
                        includeArchived: true,
                        projectId,
                    })
                ).workspaces.some(
                    (workspace) => workspace.name === "Must remain uncreated while draining",
                ),
            ).toBe(false);
            expect(
                gym.inference.requests.filter((request) => request.tools.length > 0),
            ).toHaveLength(1);

            await expect(gym.client.shutdown()).resolves.toMatchObject({ shuttingDown: true });
            await expect(gym.daemon.closed).resolves.toBeUndefined();
        },
        TEST_TIMEOUT_MS,
    );

    it("removes its isolated root when disposed", async () => {
        const gym = await start();
        const root = gym.happyHome;

        running.delete(gym);
        await gym.dispose();
        await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    });
});
