import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { agentDatabaseRun } from "@slopus/happy-agent-base";
import { HappyAgentApiError, HappyAgentClient } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { ApiModule } from "../../sources/api/ApiModule.js";
import { SecretsModule } from "../../sources/secrets/SecretsModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

describe("Secrets API routes", () => {
    it("keeps values write-only across CRUD, typed grants, conflicts, and events", async () => {
        const fixture = await secretsApiFixture();
        const cursor = fixture.api.cursor();
        const rawValue = "never-visible-api-value";

        const created = await fixture.client.createSecret({
            id: "secretone",
            description: "  Deployment credentials  ",
            environment: { DEPLOY_TOKEN: rawValue },
            mutationId: "create-secret",
        });
        expect(created.secret).toMatchObject({
            id: "secretone",
            description: "Deployment credentials",
            environmentVariables: ["DEPLOY_TOKEN"],
            managed: false,
            availableToAgents: true,
        });
        expect(JSON.stringify(created)).not.toContain(rawValue);

        await expect(
            fixture.client.createSecret({
                id: "secretone",
                description: "Duplicate",
                environment: { TOKEN: "also-hidden" },
            }),
        ).rejects.toMatchObject({ status: 409, code: "conflict" });

        await expect(fixture.client.getSecret("secretone")).resolves.toEqual(created);
        await expect(fixture.client.listSecrets()).resolves.toMatchObject({
            secrets: [created.secret],
            nextCursor: null,
        });

        const attached = await fixture.client.attachSecret(
            "secretone",
            { type: "agent", id: "agentone" },
            { mutationId: "attach-secret" },
        );
        expect(attached).toMatchObject({ created: true, httpStatus: 201 });
        await expect(
            fixture.client.attachSecret("secretone", { type: "agent", id: "agentone" }),
        ).resolves.toMatchObject({
            attachment: attached.attachment,
            created: false,
            httpStatus: 200,
        });
        await expect(
            fixture.client.listSecrets({ targetType: "agent", targetId: "agentone" }),
        ).resolves.toMatchObject({ secrets: [created.secret] });
        await expect(fixture.client.listSecretAttachments("secretone")).resolves.toMatchObject({
            attachments: [attached.attachment],
            nextCursor: null,
        });

        await expect(
            fixture.client.updateSecret(
                "secretone",
                { availableToAgents: false },
                { ifMatch: created.secret.version },
            ),
        ).rejects.toMatchObject({ status: 409, code: "conflict" });

        const updated = await fixture.client.updateSecret(
            "secretone",
            { environment: { DEPLOY_TOKEN: "rotated-hidden-value" }, mutationId: "rotate-secret" },
            { ifMatch: created.secret.version },
        );
        expect(updated.secret.version).not.toBe(created.secret.version);
        expect(updated.secret.environmentVariables).toEqual(["DEPLOY_TOKEN"]);
        expect(JSON.stringify(updated)).not.toContain("rotated-hidden-value");

        await expect(
            fixture.client.updateSecret(
                "secretone",
                { description: "Stale" },
                { ifMatch: created.secret.version },
            ),
        ).rejects.toSatisfy((error: unknown) => {
            if (!(error instanceof HappyAgentApiError)) return false;
            return (
                error.status === 409 &&
                error.code === "conflict" &&
                JSON.stringify(error.body).includes(updated.secret.version) &&
                !JSON.stringify(error.body).includes("rotated-hidden-value")
            );
        });

        const detached = await fixture.client.detachSecret(
            "secretone",
            { type: "agent", id: "agentone" },
            { mutationId: "detach-secret" },
        );
        expect(detached).toEqual({ detached: true, attachment: attached.attachment });
        await expect(
            fixture.client.detachSecret("secretone", { type: "agent", id: "agentone" }),
        ).resolves.toEqual({ detached: false, attachment: null });

        const disabled = await fixture.client.updateSecret(
            "secretone",
            { availableToAgents: false },
            { ifMatch: updated.secret.version },
        );
        expect(disabled.secret.availableToAgents).toBe(false);
        await expect(
            fixture.client.attachSecret("secretone", { type: "agent", id: "agentone" }),
        ).rejects.toMatchObject({ status: 409, code: "conflict" });

        await agentDatabaseRun(
            fixture.context.db,
            sql`UPDATE happy_agent_secrets SET kind = ${"test-managed"}
                WHERE owner_agent_id = ${"global"} AND id = ${"secretone"}`,
        );
        await expect(
            fixture.secrets.retireManagedCatalogSecret(
                fixture.context,
                "test-managed",
                "secretone",
            ),
        ).resolves.toBe(true);
        await expect(fixture.client.getSecret("secretone")).rejects.toMatchObject({ status: 404 });

        const events = await fixture.client.getEvents({ after: cursor });
        expect(events.events.map((event) => event.type)).toEqual([
            "secret.created",
            "secret.attached",
            "secret.updated",
            "secret.detached",
            "secret.updated",
            "secret.removed",
        ]);
        expect(
            events.events.map(
                (event) => (event.payload as Record<string, unknown>)["mutationId"] ?? null,
            ),
        ).toEqual(["create-secret", "attach-secret", "rotate-secret", "detach-secret", null, null]);
        expect(JSON.stringify(events)).not.toContain(rawValue);
        expect(JSON.stringify(events)).not.toContain("rotated-hidden-value");
        expect(events.events[2]?.payload).toMatchObject({
            secretId: "secretone",
            changes: { updatedAt: updated.secret.updatedAt },
        });
        expect(
            (events.events[2]?.payload as Record<string, unknown> | undefined)?.["changes"],
        ).not.toHaveProperty("environmentVariables");
        expect(events.events[5]?.payload).toEqual({
            secretId: "secretone",
            previousVersion: disabled.secret.version,
        });
    });
});

async function secretsApiFixture() {
    const directory = await mkdtemp(join(tmpdir(), "happy-secrets-api-"));
    const secrets = new SecretsModule();
    const database = moduleDatabase(secrets.migrations, "secrets-api-routes");
    await database.ready;
    const subscriptions = new Proxy(
        {},
        {
            get: () => () => () => undefined,
        },
    );
    const config = {
        configuration: {
            paths: { agentHome: directory, tokenPath: join(directory, "api-token") },
        },
    };
    const api = new ApiModule(
        subscriptions as never,
        config as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        subscriptions as never,
        secrets,
    );
    const agents = {
        config: async (_ctx: Context, agentId: string) =>
            agentId === "agentone" ? { metadata: {} } : undefined,
    };
    await api.beforeStart(database.context, agents as never);
    await api.markReady();
    const token = api.token();
    if (token === undefined) throw new Error("The API fixture did not create a token.");
    const client = new HappyAgentClient({
        endpoint: "http://happy-agent.test",
        fetch: apiFetch(api, database.context),
        token,
    });
    cleanups.push(async () => {
        await api.close();
        database.close();
        await rm(directory, { force: true, recursive: true });
    });
    return { api, client, context: database.context, secrets };
}

function apiFetch(api: ApiModule, context: Context): typeof fetch {
    return async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" ? init.body : undefined;
        const request = Readable.from(
            body === undefined ? [] : [Buffer.from(body)],
        ) as IncomingMessage;
        Object.assign(request, {
            headers: Object.fromEntries(headers.entries()),
            method: init?.method ?? "GET",
            url: `${url.pathname}${url.search}`,
        });
        let responseBody = "";
        let responseStatus = 200;
        const responseHeaders = new Headers();
        const response = {
            end(value?: string | Buffer) {
                responseBody = value?.toString() ?? "";
            },
            setHeader(name: string, value: number | string | readonly string[]) {
                responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
            },
            writeHead(status: number, values?: Record<string, number | string>) {
                responseStatus = status;
                for (const [name, value] of Object.entries(values ?? {})) {
                    responseHeaders.set(name, String(value));
                }
                return this;
            },
        } as unknown as ServerResponse;
        await api.handleRequest(context, request, response);
        return new Response(responseBody, { headers: responseHeaders, status: responseStatus });
    };
}
