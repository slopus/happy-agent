import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConfigProviders } from "../../config/types.js";
import type { ModelCatalog, ProtocolSession } from "../../protocol/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { SqliteAgentPersistence } from "../persistence/SqliteAgentPersistence.js";
import { assertAgentSubmissionOptionsSupported, RigAgentService } from "../RigAgentService.js";
import type { RigAgentProtocolSession } from "../RigProtocolFeature.js";

const temporaryDirectories: string[] = [];
const ctx = createTestRootContext().named("rig-agent-service-test");

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("RigAgentService", () => {
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
