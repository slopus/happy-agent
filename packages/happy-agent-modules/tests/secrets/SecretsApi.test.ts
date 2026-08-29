import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { secretApiIdSchema, SecretApiConflictError } from "../../sources/secrets/SecretApi.js";
import { secretsApiMigrations } from "../../sources/secrets/SecretApiDatabase.js";
import { secretsMigrations } from "../../sources/secrets/SecretDatabase.js";
import { SecretsModule } from "../../sources/secrets/SecretsModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("SecretsModule public catalog", () => {
    it("accepts lowercase secret names with underscores and dashes", () => {
        expect(Value.Check(secretApiIdSchema, "openai_prod-key")).toBe(true);
        expect(Value.Check(secretApiIdSchema, "ab")).toBe(true);
        expect(Value.Check(secretApiIdSchema, "a")).toBe(false);
        expect(Value.Check(secretApiIdSchema, "OpenAI")).toBe(false);
        expect(Value.Check(secretApiIdSchema, "openai.prod")).toBe(false);
        expect(Value.Check(secretApiIdSchema, "openai key")).toBe(false);
        expect(Value.Check(secretApiIdSchema, `a${"b".repeat(32)}`)).toBe(false);
    });

    it("publishes expanded legacy names when the new migration follows the original API migration", async () => {
        const baseMigration = secretsMigrations[0];
        const apiMigration = secretsApiMigrations[0];
        const namesMigration = secretsApiMigrations[1];
        if (
            baseMigration === undefined ||
            apiMigration === undefined ||
            namesMigration === undefined
        ) {
            throw new Error("Expected all secrets migrations.");
        }
        const database = moduleDatabase([baseMigration, apiMigration], "secrets-api-migration");
        await database.ready;
        try {
            const module = new SecretsModule();
            await module.register(database.context, "global", {
                id: "legacysecret",
                description: "Public legacy credentials",
                environment: { PUBLIC_TOKEN: "public-legacy-value" },
            });
            await module.register(database.context, "global", {
                id: "legacy-secret",
                description: "Dashed legacy credentials",
                environment: { DASHED_TOKEN: "dashed-legacy-value" },
            });
            await module.register(database.context, "global", {
                id: "legacy_secret",
                description: "Underscored legacy credentials",
                environment: { UNDERSCORED_TOKEN: "underscored-legacy-value" },
            });
            await module.register(database.context, "global", {
                id: "legacy.secret",
                description: "Unsupported legacy credentials",
                environment: { UNSUPPORTED_TOKEN: "unsupported-legacy-value" },
            });
            await namesMigration[1](database.context, database.database);

            await expect(module.listCatalog(database.context)).resolves.toMatchObject({
                secrets: [
                    { id: "legacy-secret", environmentVariables: ["DASHED_TOKEN"] },
                    { id: "legacy_secret", environmentVariables: ["UNDERSCORED_TOKEN"] },
                    { id: "legacysecret", environmentVariables: ["PUBLIC_TOKEN"] },
                ],
            });
            await expect(
                module.catalogSecret(database.context, "legacysecret"),
            ).resolves.toMatchObject({ managed: false });
            await expect(
                module.createCatalogSecret(database.context, {
                    id: "legacysecret",
                    description: "Duplicate",
                    environment: { TOKEN: "replacement" },
                }),
            ).rejects.toBeInstanceOf(SecretApiConflictError);
            expect(JSON.stringify(await module.listCatalog(database.context))).not.toContain(
                "legacy-value",
            );
            await expect(module.catalogSecret(database.context, "legacy.secret")).rejects.toThrow(
                "invalid",
            );
        } finally {
            database.close();
        }
    });

    it("resolves the union of typed grants while keeping selection explicit", async () => {
        const module = new SecretsModule();
        const database = moduleDatabase(module.migrations, "secrets-api-inheritance");
        await database.ready;
        try {
            for (const [id, name, value] of [
                ["projectsecret", "PROJECT_TOKEN", "project-value"],
                ["workspacesecret", "WORKSPACE_TOKEN", "workspace-value"],
                ["agentsecret", "AGENT_TOKEN", "agent-value"],
            ] as const) {
                await module.createCatalogSecret(database.context, {
                    id,
                    description: `${id} credentials`,
                    environment: { [name]: value },
                });
            }
            await module.attachCatalogSecret(database.context, "projectsecret", {
                type: "project",
                id: "projectone",
            });
            await module.attachCatalogSecret(database.context, "workspacesecret", {
                type: "workspace",
                id: "workspaceone",
            });
            await module.attachCatalogSecret(database.context, "agentsecret", {
                type: "agent",
                id: "agentone",
            });

            const targets = [
                { type: "agent" as const, id: "agentone" },
                { type: "workspace" as const, id: "workspaceone" },
                { type: "project" as const, id: "projectone" },
            ];
            await expect(
                module.resolveForCommandTargets(database.context, targets, [
                    "projectsecret",
                    "agentsecret",
                ]),
            ).resolves.toEqual({
                environment: { PROJECT_TOKEN: "project-value", AGENT_TOKEN: "agent-value" },
                hiddenEnvironmentVariables: ["AGENT_TOKEN", "PROJECT_TOKEN", "WORKSPACE_TOKEN"],
            });
            await expect(
                module.resolveForCommandTargets(
                    database.context,
                    [
                        { type: "agent", id: "agenttwo" },
                        { type: "workspace", id: "workspacetwo" },
                        { type: "project", id: "projectone" },
                    ],
                    ["workspacesecret"],
                ),
            ).rejects.toThrow("not attached");
        } finally {
            database.close();
        }
    });

    it("versions value-only updates and keeps typed attachment mutations idempotent", async () => {
        const module = new SecretsModule();
        const database = moduleDatabase(module.migrations, "secrets-api-mutations");
        await database.ready;
        try {
            const events: unknown[] = [];
            module.onEvent((_ctx, event) => {
                events.push(event);
            });
            const created = await module.createCatalogSecret(database.context, {
                id: "catalogsecret",
                description: "Catalog credentials",
                environment: { TOKEN: "first" },
            });
            expect(JSON.stringify(created)).not.toContain("first");

            const firstAttachment = await module.attachCatalogSecret(database.context, created.id, {
                type: "agent",
                id: "agentone",
            });
            const repeatedAttachment = await module.attachCatalogSecret(
                database.context,
                created.id,
                { type: "agent", id: "agentone" },
            );
            expect(firstAttachment.created).toBe(true);
            expect(repeatedAttachment).toEqual({
                attachment: firstAttachment.attachment,
                created: false,
            });
            await expect(
                module.updateCatalogSecret(database.context, created.id, created.version, {
                    availableToAgents: false,
                }),
            ).rejects.toBeInstanceOf(SecretApiConflictError);
            await expect(
                module.updateCatalogSecret(database.context, created.id, created.version, {
                    environment: { TOKEN: null },
                }),
            ).rejects.toThrow("at least one variable");

            const updated = await module.updateCatalogSecret(
                database.context,
                created.id,
                created.version,
                { environment: { TOKEN: "second" } },
            );
            if (updated === undefined) throw new Error("Expected an updated secret");
            expect(updated.version).not.toBe(created.version);
            expect(updated.environmentVariables).toEqual(["TOKEN"]);
            expect(JSON.stringify(events)).not.toContain("first");
            expect(JSON.stringify(events)).not.toContain("second");

            await expect(
                module.updateCatalogSecret(database.context, created.id, created.version, {
                    description: "Stale",
                }),
            ).rejects.toBeInstanceOf(SecretApiConflictError);
            expect(
                await module.updateCatalogSecret(database.context, created.id, updated.version, {
                    environment: { TOKEN: "second" },
                }),
            ).toEqual(updated);

            const detached = await module.detachCatalogSecret(database.context, created.id, {
                type: "agent",
                id: "agentone",
            });
            expect(detached).toEqual(firstAttachment.attachment);
            await expect(
                module.detachCatalogSecret(database.context, created.id, {
                    type: "agent",
                    id: "agentone",
                }),
            ).resolves.toBeUndefined();
            await expect(
                module.updateCatalogSecret(database.context, created.id, updated.version, {
                    availableToAgents: false,
                }),
            ).resolves.toMatchObject({ availableToAgents: false });
        } finally {
            database.close();
        }
    });

    it("retires only managed secrets owned by the calling feature", async () => {
        const module = new SecretsModule();
        const database = moduleDatabase(module.migrations, "secrets-api-managed-retirement");
        await database.ready;
        try {
            const events: unknown[] = [];
            module.onEvent((_ctx, event) => {
                events.push(event);
            });
            const created = await module.createCatalogSecret(database.context, {
                id: "managedsecret",
                description: "Managed credentials",
                environment: { TOKEN: "managed-hidden-value" },
            });
            await expect(
                module.retireManagedCatalogSecret(database.context, "managed-feature", created.id),
            ).rejects.toBeInstanceOf(SecretApiConflictError);
            await agentDatabaseRun(
                database.context.db,
                sql`UPDATE happy_agent_secrets SET kind = ${"managed-feature"}
                    WHERE owner_agent_id = ${"global"} AND id = ${created.id}`,
            );
            await module.attachCatalogSecret(database.context, created.id, {
                type: "agent",
                id: "agentone",
            });

            await expect(
                module.retireManagedCatalogSecret(database.context, "another-feature", created.id),
            ).rejects.toBeInstanceOf(SecretApiConflictError);
            await expect(
                module.retireManagedCatalogSecret(database.context, "managed-feature", created.id),
            ).resolves.toBe(true);
            await expect(
                module.catalogSecret(database.context, created.id),
            ).resolves.toBeUndefined();
            await expect(
                module.resolveForCommandTargets(database.context, [
                    { type: "agent", id: "agentone" },
                ]),
            ).resolves.toEqual({ environment: {}, hiddenEnvironmentVariables: [] });
            expect(events.at(-1)).toMatchObject({
                type: "secret_api_removed",
                secretId: created.id,
                previousVersion: created.version,
            });
            expect(JSON.stringify(events)).not.toContain("managed-hidden-value");
        } finally {
            database.close();
        }
    });
});
