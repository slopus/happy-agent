import { describe, expect, it } from "vitest";

import { moduleDatabase } from "../support/moduleDatabase.js";
import { SecretsModule } from "../../sources/secrets/SecretsModule.js";
import { SECRETS_MIGRATION_KEY, secretsMigrations } from "../../sources/secrets/SecretDatabase.js";
import {
    SECRETS_API_MIGRATION_KEY,
    SECRETS_NAMES_MIGRATION_KEY,
} from "../../sources/secrets/SecretApiDatabase.js";

describe("SecretsModule", () => {
    it("owns a stable migration and persists safe metadata", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-test");
        await database.ready;
        try {
            expect(secretsMigrations.map(([key]) => key)).toEqual([
                SECRETS_MIGRATION_KEY,
                SECRETS_API_MIGRATION_KEY,
                SECRETS_NAMES_MIGRATION_KEY,
            ]);
            const module = new SecretsModule();
            const reference = await module.register(database.context, "agent-a", {
                id: "secret-1",
                description: "A token",
                environment: { TOKEN: "never returned to the model" },
            });

            expect(reference).toEqual({
                id: "secret-1",
                description: "A token",
                environmentVariables: ["TOKEN"],
                revision: "1",
            });
            expect(await module.reference(database.context, "agent-a", "secret-1")).toEqual(
                reference,
            );
            await expect(
                module.attach(database.context, "agent-a", "scope-1", "secret-1"),
            ).resolves.toEqual({
                scopeRef: "scope-1",
                secretId: "secret-1",
            });
            await expect(
                module.attach(database.context, "agent-a", "scope-1", "secret-1"),
            ).resolves.toEqual({
                scopeRef: "scope-1",
                secretId: "secret-1",
            });

            // A fresh module reads the same durable catalog: nothing lives only in memory.
            const restarted = new SecretsModule();
            expect(await restarted.reference(database.context, "agent-a", "secret-1")).toEqual(
                reference,
            );
        } finally {
            database.close();
        }
    });

    it("mints its own secret identity when a caller does not supply one", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-minted-id-test");
        await database.ready;
        try {
            const module = new SecretsModule();
            const first = await module.register(database.context, "agent-a", {
                description: "A token",
                environment: { TOKEN: "value" },
            });
            const second = await module.register(database.context, "agent-a", {
                description: "Another token",
                environment: { OTHER: "value" },
            });

            expect(first.id).not.toEqual(second.id);
            expect(first.id.length).toBeGreaterThan(0);
            expect(await module.reference(database.context, "agent-a", first.id)).toEqual(first);
        } finally {
            database.close();
        }
    });

    it("takes no construction arguments at all", () => {
        expect(SecretsModule.length).toBe(0);
        const module = new SecretsModule();
        expect(module.name).toBe("secrets");
        expect(module.migrations).toBe(secretsMigrations);
    });

    it("resolves host values from its own catalog", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-resolver-test");
        await database.ready;
        try {
            const module = new SecretsModule();
            await module.register(database.context, "agent-a", {
                id: "secret-1",
                description: "A token",
                environment: { TOKEN: "database value" },
            });
            await module.attach(database.context, "agent-a", "scope-1", "secret-1");

            expect(await module.resolveForHost(database.context, "agent-a", "scope-1")).toEqual({
                TOKEN: "database value",
            });
        } finally {
            database.close();
        }
    });

    it("scopes the catalog to the acting agent", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-agent-scope-test");
        await database.ready;
        try {
            const module = new SecretsModule();
            await module.register(database.context, "agent-a", {
                id: "secret-1",
                description: "A token",
                environment: { TOKEN: "value" },
            });

            // Another agent never sees it: the acting agent ID is the whole of the policy.
            expect(await module.reference(database.context, "agent-b", "secret-1")).toBeUndefined();
            await expect(module.list(database.context, "agent-b", {})).resolves.toMatchObject({
                secrets: [],
            });
            await expect(module.remove(database.context, "agent-b", "secret-1")).resolves.toBe(
                false,
            );
        } finally {
            database.close();
        }
    });

    it("lists scoped attachments in one context transaction", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-list-snapshot-test");
        await database.ready;
        const module = new SecretsModule();
        try {
            await module.register(database.context, "agent-a", {
                id: "secret-1",
                description: "A token",
                environment: { TOKEN: "host-only" },
            });
            await module.attach(database.context, "agent-a", "scope-1", "secret-1");

            await expect(
                module.list(database.context, "agent-a", { scopeRef: "scope-1" }),
            ).resolves.toMatchObject({
                secrets: [expect.objectContaining({ id: "secret-1" })],
            });
        } finally {
            database.close();
        }
    });

    it("enforces host-only references and reserves managed credential IDs", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-policy-test");
        await database.ready;
        try {
            const module = new SecretsModule();
            for (const id of ["github", "GitHub", "GITHUB", "gItHuB"]) {
                await expect(
                    module.register(database.context, "agent-a", {
                        id,
                        description: "Spoofed GitHub token",
                        environment: { GH_TOKEN: "token" },
                    }),
                ).rejects.toThrow("reserved for GitHub CLI credentials");
            }
            for (const id of ["project-git", "PROJECT-GIT", "Project-Git"]) {
                await expect(
                    module.register(database.context, "agent-a", {
                        id,
                        description: "Spoofed project Git token",
                        environment: { GIT_TOKEN: "token" },
                    }),
                ).rejects.toThrow("reserved for managed project Git access");
            }

            await module.register(database.context, "agent-a", {
                id: "managed",
                description: "Host credential",
                environment: { TOKEN: "host-only" },
                availableToModel: false,
            });
            await expect(
                module.reference(database.context, "agent-a", "managed"),
            ).resolves.toMatchObject({
                id: "managed",
                availableToModel: false,
            });
            await expect(
                module.attach(database.context, "agent-a", "scope-1", "managed"),
            ).rejects.toThrow("cannot be attached to agent commands");

            await expect(
                module.update(database.context, "agent-a", "managed", {
                    availableToModel: true,
                }),
            ).resolves.toMatchObject({ availableToModel: true });
            await expect(
                module.attach(database.context, "agent-a", "scope-1", "managed"),
            ).resolves.toEqual({
                scopeRef: "scope-1",
                secretId: "managed",
            });
            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1"),
            ).resolves.toEqual({
                environment: { TOKEN: "host-only" },
                hiddenEnvironmentVariables: ["TOKEN"],
            });
            await expect(
                module.update(database.context, "agent-a", "managed", {
                    availableToModel: false,
                }),
            ).resolves.toMatchObject({ availableToModel: false });
            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1"),
            ).rejects.toThrow("not available to agent commands");
            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1", ["managed"]),
            ).rejects.toThrow("not available to agent commands");
        } finally {
            database.close();
        }
    });

    it("rejects colliding selected environments and returns command hiding metadata", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-command-resolution-test");
        await database.ready;
        try {
            const module = new SecretsModule();
            await module.register(database.context, "agent-a", {
                id: "first",
                description: "First",
                environment: { TOKEN: "first" },
            });
            await module.register(database.context, "agent-a", {
                id: "second",
                description: "Second",
                environment: { token: "second", OTHER: "second" },
            });
            await module.attach(database.context, "agent-a", "scope-1", "second");
            await module.attach(database.context, "agent-a", "scope-1", "first");

            await expect(
                module.resolveForHost(database.context, "agent-a", "scope-1"),
            ).rejects.toThrow("both define token");
            await expect(
                module.resolveForHost(database.context, "agent-a", "scope-1", ["first"]),
            ).resolves.toEqual({ TOKEN: "first" });
            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1", ["first"]),
            ).resolves.toEqual({
                environment: { TOKEN: "first" },
                hiddenEnvironmentVariables: ["OTHER", "TOKEN"],
            });
        } finally {
            database.close();
        }
    });

    it("hides every attached variable from a command even when only some are selected", async () => {
        const database = moduleDatabase(secretsMigrations, "secrets-command-hiding-test");
        await database.ready;
        try {
            const module = new SecretsModule();
            await module.register(database.context, "agent-a", {
                id: "selected",
                description: "Selected",
                environment: { SELECTED_TOKEN: "value" },
            });
            await module.register(database.context, "agent-a", {
                id: "unselected",
                description: "Unselected",
                environment: { UNSELECTED_TOKEN: "value" },
            });
            await module.attach(database.context, "agent-a", "scope-1", "selected");
            await module.attach(database.context, "agent-a", "scope-1", "unselected");

            await expect(
                module.resolveForCommand(database.context, "agent-a", "scope-1", ["selected"]),
            ).resolves.toEqual({
                environment: { SELECTED_TOKEN: "value" },
                hiddenEnvironmentVariables: ["SELECTED_TOKEN", "UNSELECTED_TOKEN"],
            });
        } finally {
            database.close();
        }
    });
});
