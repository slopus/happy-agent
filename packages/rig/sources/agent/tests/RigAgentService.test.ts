import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import { AgentSystemLocal, type Agent } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigProviders } from "../../config/types.js";
import type { GymInferenceRequest } from "../../executor/gym-types.js";
import type { ModelCatalog, ProtocolSession } from "../../protocol/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { SqliteAgentPersistence } from "../persistence/SqliteAgentPersistence.js";
import { assertAgentSubmissionOptionsSupported, RigAgentService } from "../RigAgentService.js";
import type { RigAgentProtocolSession } from "../RigProtocolFeature.js";

const temporaryDirectories: string[] = [];
const ctx = createTestRootContext().named("rig-agent-service-test");
const codexModelId = "openai/gpt-5.6-sol";
const claudeModelId = "anthropic/sonnet-5";
const promptModelCatalog: ModelCatalog = {
    defaultModelId: codexModelId,
    defaultProviderId: "gym",
    models: [],
    providers: [
        {
            models: [
                {
                    defaultThinkingLevel: "medium",
                    id: codexModelId,
                    name: "Codex",
                    thinkingLevels: ["medium"],
                },
                {
                    defaultThinkingLevel: "medium",
                    id: claudeModelId,
                    name: "Claude",
                    thinkingLevels: ["medium"],
                },
            ],
            providerId: "gym",
            providerType: "gym",
        },
    ],
};

afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("RigAgentService", () => {
    it("gives an agent created through the service a system prompt", async () => {
        const world = await openPromptWorld();
        try {
            const agent = await createPromptAgent(world);
            await dispatchPrompt(world, agent, codexModelId, 1);

            expect(world.requests).toHaveLength(1);
            expect(world.requests[0]?.context.systemPrompt).toContain(
                "You are Rig, built by Happy",
            );
        } finally {
            await world.close();
        }
    });

    it("selects different prompts for agents using different models", async () => {
        const world = await openPromptWorld();
        try {
            const codexAgent = await createPromptAgent(world);
            const claudeAgent = await createPromptAgent(world);
            await dispatchPrompt(world, codexAgent, codexModelId, 1);
            await dispatchPrompt(world, claudeAgent, claudeModelId, 2);

            expect(world.requests.map((request) => request.modelId)).toEqual([
                codexModelId,
                claudeModelId,
            ]);
            expect(world.requests[0]?.context.systemPrompt).not.toBe(
                world.requests[1]?.context.systemPrompt,
            );
        } finally {
            await world.close();
        }
    });

    it("uses the switched model's prompt on the next inference", async () => {
        const world = await openPromptWorld();
        try {
            const agent = await createPromptAgent(world);
            await dispatchPrompt(world, agent, codexModelId, 1);
            await dispatchPrompt(world, agent, claudeModelId, 2);

            expect(world.requests.map((request) => request.modelId)).toEqual([
                codexModelId,
                claudeModelId,
            ]);
            expect(world.requests[1]?.context.systemPrompt).not.toBe(
                world.requests[0]?.context.systemPrompt,
            );
        } finally {
            await world.close();
        }
    });

    it("opens Agent Base on its dedicated database and can reopen after a clean close", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-agent-service-test-"));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, "agent", "sessions.sqlite");
        const providers: ConfigProviders = {
            codex: {
                apiKey: "unused-until-inference",
                enabled: true,
                type: "codex",
            },
        };
        const modelCatalog: ModelCatalog = {
            defaultModelId: "gpt-test",
            defaultProviderId: "codex",
            models: [],
            providers: [
                {
                    models: [
                        {
                            defaultThinkingLevel: "medium",
                            id: "gpt-test",
                            name: "GPT Test",
                            thinkingLevels: ["low", "medium", "high"],
                        },
                    ],
                    providerId: "codex",
                    providerType: "codex",
                },
            ],
        };

        const firstStore = await PersistentSessionStore.open(ctx, {
            createRuntime: () => {
                throw new Error("Legacy runtime is unavailable in this test.");
            },
            databasePath,
            modelCatalog,
        });
        const first = await RigAgentService.open(ctx, {
            database: firstStore.database,
            env: {},
            modelCatalog,
            providers,
        });
        await expect(access(databasePath)).resolves.toBeUndefined();
        await first.close(ctx);
        await expect(
            firstStore.create(ctx, { cwd: "/tmp/rig-agent-service-shared-db" }),
        ).resolves.toBeDefined();
        await firstStore.close(ctx);

        const reopenedStore = await PersistentSessionStore.open(ctx, {
            createRuntime: () => {
                throw new Error("Legacy runtime is unavailable in this test.");
            },
            databasePath,
            modelCatalog,
        });
        const reopened = await RigAgentService.open(ctx, {
            database: reopenedStore.database,
            env: {},
            modelCatalog,
            providers,
        });
        await reopened.close(ctx);
        await reopenedStore.close(ctx);
    });

    it("rejects a stale expected run instead of downgrading the steer to a new run", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-agent-service-test-"));
        temporaryDirectories.push(directory);
        const modelCatalog: ModelCatalog = {
            defaultModelId: "gpt-test",
            defaultProviderId: "codex",
            models: [],
            providers: [
                {
                    models: [
                        {
                            defaultThinkingLevel: "medium",
                            id: "gpt-test",
                            name: "GPT Test",
                            thinkingLevels: ["low", "medium", "high"],
                        },
                    ],
                    providerId: "codex",
                    providerType: "codex",
                },
            ],
        };
        const providers: ConfigProviders = {
            codex: { apiKey: "unused-until-inference", enabled: true, type: "codex" },
        };
        const store = await PersistentSessionStore.open(ctx, {
            createRuntime: () => {
                throw new Error("Legacy runtime is unavailable in this test.");
            },
            databasePath: join(directory, "sessions.sqlite"),
            modelCatalog,
        });
        const service = await RigAgentService.open(ctx, {
            database: store.database,
            env: {},
            modelCatalog,
            providers,
        });
        try {
            const session = {
                id: "stale-session",
                snapshot: () => ({}) as ProtocolSession,
            } as unknown as RigAgentProtocolSession;
            await expect(
                service.steer(ctx, session, {
                    expectedRunId: "stale-run",
                    text: "must not become a run",
                }),
            ).rejects.toThrow("no longer active");
            await expect(
                service.submit(ctx, session, {
                    content: [
                        {
                            data: "raw",
                            mediaType: "audio/wav",
                            type: "audio",
                        } as never,
                    ],
                    text: "unsupported",
                }),
            ).rejects.toThrow("only text and image blocks are supported");
            await expect(
                service.submit(ctx, session, {
                    content: [
                        {
                            data: "raw",
                            detail: "high",
                            mediaType: "image/png",
                            type: "image",
                        },
                    ],
                    text: "image",
                }),
            ).rejects.toThrow("Image detail is not supported by Agent Base 0.0.6");
        } finally {
            await service.close(ctx);
            await store.close(ctx);
        }
    });

    it("rejects unsupported Agent Base submission options before creating a receipt", async () => {
        const directory = await mkdtemp(join(process.cwd(), ".rig-agent-service-test-"));
        temporaryDirectories.push(directory);
        const modelCatalog: ModelCatalog = {
            defaultModelId: "gpt-test",
            defaultProviderId: "codex",
            models: [],
            providers: [
                {
                    models: [
                        {
                            defaultThinkingLevel: "medium",
                            id: "gpt-test",
                            name: "GPT Test",
                            thinkingLevels: ["low", "medium", "high"],
                        },
                    ],
                    providerId: "codex",
                    providerType: "codex",
                },
            ],
        };
        const store = await PersistentSessionStore.open(ctx, {
            createRuntime: () => {
                throw new Error("Legacy runtime is unavailable in this test.");
            },
            databasePath: join(directory, "sessions.sqlite"),
            modelCatalog,
        });
        const service = await RigAgentService.open(ctx, {
            database: store.database,
            env: {},
            modelCatalog,
            providers: {
                codex: { apiKey: "unused-until-inference", enabled: true, type: "codex" },
            },
        });
        const session = {
            id: "unsupported-options-session",
            snapshot: () => ({}) as ProtocolSession,
        } as unknown as RigAgentProtocolSession;
        try {
            const requests = [
                { option: "systemPrompt", request: { systemPrompt: "custom", text: "message" } },
                { option: "debug", request: { debug: true, text: "message" } },
                { option: "interactive", request: { interactive: true, text: "message" } },
                {
                    option: "serviceTier: null",
                    request: {
                        clientSubmissionId: "clear-service-tier",
                        serviceTier: null,
                        text: "message",
                    },
                },
            ] as const;
            for (const candidate of requests) {
                await expect(service.submit(ctx, session, candidate.request)).rejects.toThrow(
                    candidate.option === "serviceTier: null"
                        ? "cannot clear a prior fast mode"
                        : `'${candidate.option}'`,
                );
            }
            await expect(
                service.steer(ctx, session, {
                    clientSubmissionId: "clear-service-tier-steer",
                    serviceTier: null,
                    text: "message",
                }),
            ).rejects.toThrow("cannot clear a prior fast mode");
            expect(() =>
                assertAgentSubmissionOptionsSupported({ serviceTier: "fast", text: "message" }),
            ).not.toThrow();
            const persistence = new SqliteAgentPersistence(store.database, session.id);
            await expect(persistence.load(ctx)).resolves.toEqual([]);
            await expect(persistence.readValues(ctx, "")).resolves.toEqual([]);
        } finally {
            await service.close(ctx);
            await store.close(ctx);
        }
    });
});

type PromptWorld = Awaited<ReturnType<typeof openPromptWorld>>;

async function createPromptAgent(world: PromptWorld): Promise<Agent> {
    const agent = await world.system.create(ctx, {}, { id: createId() });
    await agent.waitForIdle();
    return agent;
}

async function dispatchPrompt(
    world: PromptWorld,
    agent: Agent,
    model: string,
    expectedRequests: number,
): Promise<void> {
    await world.system.send(
        ctx,
        agent.id,
        { content: [{ text: "Use the selected prompt.", type: "text" }], role: "user" },
        {
            await: true,
            id: createId(),
            model,
            provider: "gym",
        },
    );
    await agent.waitForIdle();
    await vi.waitFor(() => {
        expect(world.requests).toHaveLength(expectedRequests);
    });
}

async function openPromptWorld() {
    const directory = await mkdtemp(join(process.cwd(), ".rig-agent-service-test-"));
    temporaryDirectories.push(directory);
    const requests: GymInferenceRequest[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as GymInferenceRequest);
        return new Response(
            JSON.stringify({
                content: [{ text: "Done.", type: "text" }],
            }),
            {
                headers: { "content-type": "application/json" },
                status: 200,
            },
        );
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = await PersistentSessionStore.open(ctx, {
        createRuntime: () => {
            throw new Error("Legacy runtime is unavailable in this test.");
        },
        databasePath: join(directory, "sessions.sqlite"),
        modelCatalog: promptModelCatalog,
    });
    const createSystem = vi.spyOn(AgentSystemLocal, "create");
    const service = await RigAgentService.open(ctx, {
        database: store.database,
        env: { RIG_GYM_INFERENCE_URL: "https://gym.test/inference" },
        modelCatalog: promptModelCatalog,
        providers: {},
    });
    const created = createSystem.mock.results.at(-1)?.value;
    createSystem.mockRestore();
    const system = await created;
    if (!(system instanceof AgentSystemLocal)) {
        throw new Error("RigAgentService did not create an AgentSystemLocal.");
    }
    return {
        close: async () => {
            await service.close(ctx);
            await store.close(ctx);
        },
        requests,
        service,
        store,
        system,
    };
}
