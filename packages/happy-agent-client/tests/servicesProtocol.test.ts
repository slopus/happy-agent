import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    HappyAgentClient,
    WORKSPACE_SERVICE_AUTHORIZATION_HEADER,
    workspaceServiceAccessTokenResponseSchema,
    workspaceServiceChangesSchema,
    workspaceServiceCleanupSchema,
    workspaceServiceInputRequestSchema,
    workspaceServiceInputResponseSchema,
    workspaceServiceListQuerySchema,
    workspaceServiceListResponseSchema,
    workspaceServicePathSchema,
    workspaceServiceSchema,
    workspaceServiceUpdatedPayloadSchema,
    type HappyAgentEvent,
    type WorkspaceService,
} from "../sources/index.js";

const version = "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e";
const nextVersion = "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f";
const service: WorkspaceService = {
    id: "service1",
    workspaceId: "workspace1",
    agentId: "agent1",
    processId: "process1",
    name: "Web preview",
    command: "pnpm dev",
    cwd: ".",
    port: 4187,
    tty: false,
    protocol: "http",
    access: "workspace",
    status: "running",
    endpointStatus: "reachable",
    exitCode: null,
    error: null,
    sandbox: {
        inputs: ["src", "package.json", "node_modules"],
        scratch: ["dist"],
        outbound: [],
        limits: { memoryMiB: 1024, processes: 64 },
    },
    createdAt: 1,
    updatedAt: 2,
    startedAt: 2,
    endedAt: null,
    version,
};

describe("workspace services protocol", () => {
    it("models private services without allowing public access or metadata credential leaks", () => {
        expect(Value.Check(workspaceServiceSchema, service)).toBe(true);
        expect(Value.Check(workspaceServiceSchema, { ...service, futureMetadata: true })).toBe(
            true,
        );
        for (const status of ["starting", "stopping", "completed", "killed", "failed"]) {
            expect(
                Value.Check(workspaceServiceSchema, {
                    ...service,
                    status,
                    processId: null,
                    startedAt: null,
                }),
            ).toBe(true);
        }
        for (const invalid of [
            { access: "public" },
            { protocol: "udp" },
            { port: 80 },
            { port: 65536 },
            { command: "echo\u0000bad" },
            { accessToken: "must-not-leak" },
            { output: "not-metadata" },
            { chars: "not-metadata" },
        ]) {
            expect(Value.Check(workspaceServiceSchema, { ...service, ...invalid })).toBe(false);
        }
        expect(
            Value.Check(workspaceServiceAccessTokenResponseSchema, {
                accessToken: "credential",
                expiresAt: 300000,
            }),
        ).toBe(true);
        expect(WORKSPACE_SERVICE_AUTHORIZATION_HEADER).toBe("X-Happy-Service-Authorization");
    });

    it.each([
        "",
        ".",
        "..",
        "/etc/passwd",
        "../secret",
        "a/../b",
        "a/.",
        "C:/x",
        "a\\b",
        "a\u0000b",
    ])("rejects unsafe input path %j", (path) =>
        expect(Value.Check(workspaceServicePathSchema, path)).toBe(false),
    );

    it("bounds output, reader identities, list pages, and effective sandbox resources", () => {
        expect(Value.Check(workspaceServiceInputRequestSchema, { readerId: "view1" })).toBe(true);
        expect(
            Value.Check(workspaceServiceInputRequestSchema, {
                readerId: "view1",
                chars: "yes\n",
                waitMs: 250,
                maxOutputBytes: 65536,
            }),
        ).toBe(true);
        for (const request of [
            {},
            { readerId: "" },
            { readerId: "x".repeat(129) },
            { readerId: "view1", waitMs: 20001 },
            { readerId: "view1", maxOutputBytes: 262145 },
            { readerId: "view1", chars: "x".repeat(65537) },
        ])
            expect(Value.Check(workspaceServiceInputRequestSchema, request)).toBe(false);
        expect(
            Value.Check(workspaceServiceInputResponseSchema, {
                service,
                output: "server ready\n",
                truncated: false,
                wallTimeSeconds: 0.25,
            }),
        ).toBe(true);
        expect(
            Value.Check(workspaceServiceListQuerySchema, { includeStopped: true, limit: 100 }),
        ).toBe(true);
        expect(Value.Check(workspaceServiceListQuerySchema, { limit: 101 })).toBe(false);
        expect(
            Value.Check(workspaceServiceListResponseSchema, {
                services: [service],
                nextPageCursor: null,
                cursor: version,
            }),
        ).toBe(true);
        expect(
            Value.Check(workspaceServiceSchema, {
                ...service,
                sandbox: { ...service.sandbox, limits: { memoryMiB: 2048, processes: 64 } },
            }),
        ).toBe(false);
    });

    it("represents cleanup blockage and versioned updates without carrying process I/O", () => {
        expect(
            Value.Check(workspaceServiceCleanupSchema, {
                phase: "blocked",
                serviceIds: [service.id],
                error: { code: "stop_unconfirmed", message: "Waiting for service termination." },
            }),
        ).toBe(true);
        const changes = { status: "stopping", updatedAt: 3 };
        expect(Value.Check(workspaceServiceChangesSchema, changes)).toBe(true);
        expect(Value.Check(workspaceServiceChangesSchema, { ...changes, output: "private" })).toBe(
            false,
        );
        expect(
            Value.Check(workspaceServiceChangesSchema, { ...changes, accessToken: "private" }),
        ).toBe(false);
        expect(Value.Check(workspaceServiceChangesSchema, { status: "killed" })).toBe(false);
        expect(
            Value.Check(workspaceServiceUpdatedPayloadSchema, {
                serviceId: service.id,
                workspaceId: service.workspaceId,
                previousVersion: version,
                version: nextVersion,
                changes,
            }),
        ).toBe(true);
    });
    it("keeps all operations workspace-scoped across a remote connection", async () => {
        const calls: { url: URL; init: RequestInit | undefined }[] = [];
        const controller = new AbortController();
        const client = new HappyAgentClient({
            endpoint: "http://daemon/prefix?transport=key",
            token: "daemon-credential",
            fetch: async (input, init) => {
                const url = new URL(input.toString());
                calls.push({ url, init });
                if (url.pathname.endsWith("/access-token"))
                    return Response.json({ accessToken: "service-credential", expiresAt: 300000 });
                if (url.pathname.endsWith("/input"))
                    return Response.json({
                        service,
                        output: "ready",
                        truncated: false,
                        wallTimeSeconds: 0,
                    });
                if (url.pathname.endsWith("/services"))
                    return Response.json({
                        services: [service],
                        nextPageCursor: null,
                        cursor: version,
                    });
                return Response.json(
                    { service },
                    { status: init?.method === "DELETE" ? 202 : 200 },
                );
            },
        }).connection("remote");
        const workspaceId = "workspace/#?";
        const serviceId = "service/#?";
        await client.listWorkspaceServices(workspaceId, {
            includeStopped: true,
            limit: 2,
            pageCursor: "p/2",
        });
        await client.getWorkspaceService(workspaceId, serviceId);
        await client.inputWorkspaceService(
            workspaceId,
            serviceId,
            { readerId: "agent-view", chars: "yes\n", waitMs: 250 },
            { signal: controller.signal },
        );
        await client.stopWorkspaceService(workspaceId, serviceId, { mutationId: "stop1" });
        await client.issueWorkspaceServiceAccessToken(workspaceId, serviceId);
        const base = "/prefix/v0/connections/remote/api/v0/workspaces/workspace%2F%23%3F/services";
        expect(calls.map(({ url }) => url.pathname)).toEqual([
            base,
            `${base}/service%2F%23%3F`,
            `${base}/service%2F%23%3F/input`,
            `${base}/service%2F%23%3F`,
            `${base}/service%2F%23%3F/access-token`,
        ]);
        expect(calls.map(({ init }) => init?.method)).toEqual([
            "GET",
            "GET",
            "POST",
            "DELETE",
            "POST",
        ]);
        expect(calls[0]!.url.searchParams.get("includeStopped")).toBe("true");
        expect(calls[0]!.url.searchParams.get("pageCursor")).toBe("p/2");
        expect(calls[2]!.init?.signal).toBe(controller.signal);
        expect(JSON.parse(calls[2]!.init?.body as string)).toEqual({
            readerId: "agent-view",
            chars: "yes\n",
            waitMs: 250,
        });
        expect(JSON.parse(calls[3]!.init?.body as string)).toEqual({ mutationId: "stop1" });
        const tunnel = new URL(client.workspaceServiceProxyUrl(workspaceId, serviceId));
        expect(tunnel.pathname).toBe(`${base}/service%2F%23%3F/proxy`);
        expect(tunnel.searchParams.get("transport")).toBe("key");
        expect(tunnel.toString()).not.toContain("credential");
        for (const { url, init } of calls) {
            expect(url.searchParams.get("transport")).toBe("key");
            expect(new Headers(init?.headers).get("authorization")).toBe(
                "Bearer daemon-credential",
            );
            expect(new Headers(init?.headers).has(WORKSPACE_SERVICE_AUTHORIZATION_HEADER)).toBe(
                false,
            );
        }
    });

    it("does not replay ambiguous stdin writes or turn unsupported discovery into an empty list", async () => {
        let calls = 0;
        const client = new HappyAgentClient({
            endpoint: "http://daemon",
            token: "t",
            fetch: async () => {
                calls += 1;
                throw new Error("Connection lost after sending input.");
            },
        });
        await expect(
            client.inputWorkspaceService("w", "s", { readerId: "r", chars: "yes\n" }),
        ).rejects.toThrow("Connection lost");
        expect(calls).toBe(1);
        const unavailable = new HappyAgentClient({
            endpoint: "http://old-daemon",
            token: "t",
            fetch: async () =>
                Response.json(
                    { error: "Service support is unavailable.", code: "unsupported" },
                    { status: 501 },
                ),
        });
        await expect(unavailable.listWorkspaceServices("w")).rejects.toMatchObject({
            status: 501,
            code: "unsupported",
        });
    });

    it("delivers service lifecycle through the ordinary resumable event feed", async () => {
        const event: HappyAgentEvent = {
            cursor: nextVersion,
            occurredAt: 3,
            type: "service.updated",
            payload: {
                serviceId: service.id,
                workspaceId: service.workspaceId,
                previousVersion: version,
                version: nextVersion,
                changes: { status: "stopping", updatedAt: 3 },
            },
        };
        const client = new HappyAgentClient({
            endpoint: "http://daemon",
            token: "t",
            fetch: async () =>
                new Response(
                    `event: hello\ndata: ${JSON.stringify({ cursor: version, gap: false, resumed: true, connectedAt: 1 })}\n\n` +
                        `id: ${nextVersion}\nevent: service.updated\ndata: ${JSON.stringify(event)}\n\n`,
                    { headers: { "content-type": "text/event-stream" } },
                ),
        });
        const controller = new AbortController();
        const updates = client.updates({ after: version, signal: controller.signal });
        try {
            await expect(updates.next()).resolves.toMatchObject({ value: { kind: "connected" } });
            await expect(updates.next()).resolves.toMatchObject({
                value: { kind: "event", event },
            });
        } finally {
            controller.abort();
            await updates.return(undefined);
        }
    });
});
