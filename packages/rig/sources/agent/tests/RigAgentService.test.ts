import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConfigProviders } from "../../config/types.js";
import type { ModelCatalog } from "../../protocol/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { RigAgentService } from "../RigAgentService.js";

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
});
