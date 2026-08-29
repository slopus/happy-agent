import { describe, expect, it } from "vitest";

import { SecretsModule } from "../../sources/secrets/SecretsModule.js";
import { SECRETS_MIGRATION_KEY, secretsMigrations } from "../../sources/secrets/SecretDatabase.js";
import { SECRETS_API_MIGRATION_KEY } from "../../sources/secrets/SecretApiDatabase.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const AGENT = "agent-a";

async function withDatabase<T>(
    name: string,
    callback: (
        database: ModuleDatabase & {
            readonly database: import("@slopus/happy-agent-base").AgentDatabase;
        },
    ) => Promise<T>,
): Promise<T> {
    const database = moduleDatabase(secretsMigrations, name);
    await database.ready;
    try {
        return await callback(database);
    } finally {
        database.close();
    }
}

describe("SecretsModule boundary contracts", () => {
    it("trims descriptions, allocates fresh IDs, sorts safe names, and keeps values out of metadata", async () => {
        await withDatabase("secrets-boundary-registration", async (database) => {
            const events: unknown[] = [];
            const module = new SecretsModule();
            module.onEventTransactional((_ctx, event) => {
                events.push(event);
            });

            const first = await module.register(database.context, AGENT, {
                description: "  API token  ",
                environment: {
                    ZED: "top-secret-z",
                    API_TOKEN: "top-secret-token",
                    ALPHA: "top-secret-a",
                },
            });
            const second = await module.register(database.context, AGENT, {
                description: "Second",
                environment: { SECOND: "top-secret-second" },
            });

            expect(first).toEqual({
                id: first.id,
                description: "API token",
                environmentVariables: ["ALPHA", "API_TOKEN", "ZED"],
                revision: "1",
            });
            expect(second.id).not.toBe(first.id);
            expect(JSON.stringify(first)).not.toContain("top-secret");
            expect(JSON.stringify(second)).not.toContain("top-secret");
            expect(events).toHaveLength(2);
            expect(JSON.stringify(events)).not.toContain("top-secret");
            expect(await module.reference(database.context, AGENT, first.id)).toEqual(first);
            const listed = await module.list(database.context, AGENT);
            expect([...listed.secrets].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
                [first, second].sort((a, b) => a.id.localeCompare(b.id)),
            );
            expect(secretsMigrations.map(([key]) => key)).toEqual([
                SECRETS_MIGRATION_KEY,
                SECRETS_API_MIGRATION_KEY,
            ]);
        });
    });

    it("overwrites explicit registrations, preserves attachments, and isolates agents", async () => {
        await withDatabase("secrets-boundary-overwrite", async (database) => {
            const module = new SecretsModule();
            await module.register(database.context, AGENT, {
                id: "shared",
                description: "First",
                environment: { TOKEN: "first" },
            });
            await module.attach(database.context, AGENT, "scope-a", "shared");

            const overwritten = await module.register(database.context, AGENT, {
                id: "shared",
                description: "  Second  ",
                environment: { OTHER: "second" },
                availableToModel: false,
            });
            expect(overwritten).toEqual({
                id: "shared",
                description: "Second",
                environmentVariables: ["OTHER"],
                revision: "2",
                availableToModel: false,
            });
            expect(
                await module.list(database.context, AGENT, { scopeRef: "scope-a" }),
            ).toMatchObject({
                secrets: [overwritten],
            });
            expect(await module.reference(database.context, "agent-b", "shared")).toBeUndefined();
            expect(await module.list(database.context, "agent-b")).toEqual({
                secrets: [],
                limit: 50,
            });
        });
    });

    it("increments revisions only when environment values change and emits no-op update events", async () => {
        await withDatabase("secrets-boundary-update", async (database) => {
            const events: Array<{ type: string; secret?: { revision: string } }> = [];
            const module = new SecretsModule();
            module.onEventTransactional((_ctx, event) => {
                events.push(event as (typeof events)[number]);
            });

            const original = await module.register(database.context, AGENT, {
                id: "mutable",
                description: "Original",
                environment: { TOKEN: "one", REMOVE_ME: "two" },
            });
            const descriptionOnly = await module.update(database.context, AGENT, "mutable", {
                description: "  Changed  ",
            });
            expect(descriptionOnly).toMatchObject({
                description: "Changed",
                revision: original.revision,
            });

            const noOp = await module.update(database.context, AGENT, "mutable", {
                description: "Changed",
            });
            expect(noOp).toEqual(descriptionOnly);
            expect(events.map(({ type }) => type)).toEqual(["secret_registered", "secret_updated"]);

            const environmentChanged = await module.update(database.context, AGENT, "mutable", {
                environment: { REMOVE_ME: null, ADDED: "three" },
                availableToModel: false,
            });
            expect(environmentChanged).toEqual({
                id: "mutable",
                description: "Changed",
                environmentVariables: ["ADDED", "TOKEN"],
                revision: "2",
                availableToModel: false,
            });
            expect(events.map(({ type }) => type)).toEqual([
                "secret_registered",
                "secret_updated",
                "secret_updated",
            ]);
        });
    });

    it("updates an existing environment variable regardless of case without creating a collision", async () => {
        await withDatabase("secrets-boundary-case-insensitive-update", async (database) => {
            const module = new SecretsModule();
            await module.register(database.context, AGENT, {
                id: "case-update",
                description: "Case update",
                environment: { TOKEN: "old" },
            });

            await expect(
                module.update(database.context, AGENT, "case-update", {
                    environment: { token: "new" },
                }),
            ).resolves.toEqual({
                id: "case-update",
                description: "Case update",
                environmentVariables: ["TOKEN"],
                revision: "2",
            });
            await expect(module.resolveForHost(database.context, AGENT, "scope")).resolves.toEqual(
                {},
            );
        });
    });

    it("treats explicit re-registration with reordered identical variables as a no-op", async () => {
        await withDatabase("secrets-boundary-registration-order", async (database) => {
            const events: string[] = [];
            const module = new SecretsModule();
            module.onEventTransactional((_ctx, event) => {
                events.push(event.type);
            });
            const first = await module.register(database.context, AGENT, {
                id: "same-values",
                description: "Same",
                environment: { FIRST: "one", SECOND: "two" },
            });
            const second = await module.register(database.context, AGENT, {
                id: "same-values",
                description: "Same",
                environment: { SECOND: "two", FIRST: "one" },
            });

            expect(second).toEqual(first);
            expect(events).toEqual(["secret_registered"]);
        });
    });

    it("removes attachments atomically and distinguishes missing mutations", async () => {
        await withDatabase("secrets-boundary-remove", async (database) => {
            const module = new SecretsModule();
            await module.register(database.context, AGENT, {
                id: "removable",
                description: "Remove me",
                environment: { TOKEN: "value" },
            });
            await module.attach(database.context, AGENT, "scope-a", "removable");
            expect(await module.remove(database.context, AGENT, "missing")).toBe(false);
            expect(await module.remove(database.context, AGENT, "removable")).toBe(true);
            expect(await module.reference(database.context, AGENT, "removable")).toBeUndefined();
            expect(await module.list(database.context, AGENT, { scopeRef: "scope-a" })).toEqual({
                secrets: [],
                limit: 50,
            });
            expect(await module.remove(database.context, AGENT, "removable")).toBe(false);
            await expect(
                module.attach(database.context, AGENT, "scope-a", "removable"),
            ).rejects.toThrow("reference does not exist");
        });
    });

    it("denies reserved managed IDs case-insensitively and rejects invalid public inputs", async () => {
        await withDatabase("secrets-boundary-validation", async (database) => {
            const module = new SecretsModule();
            for (const id of ["github", "GitHub", "GITHUB", "project-git", "Project-Git"]) {
                await expect(
                    module.register(database.context, AGENT, {
                        id,
                        description: "Credential",
                        environment: { TOKEN: "value" },
                    }),
                ).rejects.toThrow("reserved");
            }
            await expect(
                module.register(database.context, AGENT, {
                    id: "bad id",
                    description: "Credential",
                    environment: { TOKEN: "value" },
                }),
            ).rejects.toThrow("registration input is invalid");
            await expect(
                module.register(database.context, AGENT, {
                    id: "bad",
                    description: "   ",
                    environment: { TOKEN: "value" },
                }),
            ).rejects.toThrow("description");
            await expect(
                module.register(database.context, AGENT, {
                    id: "bad",
                    description: "Credential",
                    environment: { TOKEN: "one", token: "two" },
                }),
            ).rejects.toThrow("duplicate environment");
            await expect(module.update(database.context, AGENT, "missing", {})).rejects.toThrow(
                "update input is invalid",
            );
            await expect(module.list(database.context, AGENT, { limit: 0 })).rejects.toThrow(
                "list query input is invalid",
            );
        });
    });

    it("scopes every operation to the acting agent and applies no further policy", async () => {
        await withDatabase("secrets-boundary-authorization", async (database) => {
            const module = new SecretsModule();

            await module.register(database.context, AGENT, {
                id: "owned",
                description: "Owned",
                environment: { TOKEN: "value" },
            });
            await module.attach(database.context, AGENT, "scope-a", "owned");

            // The owning agent may do everything, with no policy hook in between.
            await expect(module.reference(database.context, AGENT, "owned")).resolves.toMatchObject(
                { id: "owned" },
            );
            await expect(module.list(database.context, AGENT)).resolves.toMatchObject({
                secrets: [expect.objectContaining({ id: "owned" })],
            });
            await expect(
                module.resolveForHost(database.context, AGENT, "scope-a"),
            ).resolves.toEqual({ TOKEN: "value" });

            // Another agent sees an empty catalog rather than an authorization error: the acting
            // agent ID is the whole of the policy.
            await expect(
                module.reference(database.context, "agent-other", "owned"),
            ).resolves.toBeUndefined();
            await expect(module.list(database.context, "agent-other")).resolves.toMatchObject({
                secrets: [],
            });
            await expect(
                module.attach(database.context, "agent-other", "scope-a", "owned"),
            ).rejects.toThrow("reference does not exist");
            await expect(
                module.resolveForHost(database.context, "agent-other", "scope-a"),
            ).resolves.toEqual({});
        });
    });

    it("takes no constructor options and mints valid identities on its own", async () => {
        expect(SecretsModule.length).toBe(0);

        await withDatabase("secrets-boundary-factories", async (database) => {
            const module = new SecretsModule();
            const events: Array<{ eventId: string; at: number }> = [];
            module.onEventTransactional((_ctx, event) => {
                events.push(event);
            });
            const before = Date.now();
            const reference = await module.register(database.context, AGENT, {
                description: "A secret",
                environment: { TOKEN: "value" },
            });

            // Minted IDs are usable identities: they round-trip through the public API.
            expect(reference.id).toMatch(/^[A-Za-z0-9_-]+$/);
            await expect(module.reference(database.context, AGENT, reference.id)).resolves.toEqual(
                reference,
            );
            expect(events).toHaveLength(1);
            expect(events[0]!.eventId).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(events[0]!.at).toBeGreaterThanOrEqual(before);
            expect(events[0]!.at).toBeLessThanOrEqual(Date.now());
        });
    });
});
