import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createHappyPluginTestHost,
    createHappyMcpToolName,
    defineMcpTool,
    HAPPY_PLUGIN_MAX_STORAGE_KEYS,
    type HappyPluginTestHost,
    Type,
} from "../sources/index.js";

const hosts: HappyPluginTestHost[] = [];

afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    vi.restoreAllMocks();
});

describe("Happy plugin test host", () => {
    it("supports typed system-prompt hooks and non-blocking tracing subscriptions", async () => {
        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        const hook = await host.client.hooks.onSystemPrompt(({ systemPrompt, userPrompt }) => ({
            systemPrompt: `${systemPrompt}\nPlugin saw: ${userPrompt}`,
        }));
        const traced: string[] = [];
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tracing = await host.client.tracing.subscribe(async (event) => {
            traced.push(event.type);
            await gate;
        });

        await expect(
            host.hooks.applySystemPrompt({
                systemPrompt: "Base",
                userPrompt: "Ship.",
            }),
        ).resolves.toEqual({ systemPrompt: "Base\nPlugin saw: Ship." });
        host.tracing.emit({
            model: "openai/gpt-test",
            provider: "codex",
            sessionId: "session-1",
            timestamp: 1,
            type: "turn_started",
        });
        host.tracing.emit({
            durationMs: 2,
            model: "openai/gpt-test",
            provider: "codex",
            sessionId: "session-1",
            stopReason: "stop",
            success: true,
            timestamp: 3,
            type: "turn_finished",
        });
        await expect.poll(() => traced).toEqual(["turn_started"]);
        release();
        await expect.poll(() => traced).toEqual(["turn_started", "turn_finished"]);

        const hookRegistrationId = hook.registrationId;
        const tracingRegistrationId = tracing.registrationId;
        await hook.close();
        await tracing.close();
        expect(host.requests).toContainEqual({
            method: "DELETE",
            path: `/hooks/system-prompt/${hookRegistrationId}`,
        });
        expect(host.requests).toContainEqual({
            method: "DELETE",
            path: `/tracing/subscriptions/${tracingRegistrationId}`,
        });
    });

    it("retires a required prompt stream while dynamically restoring tracing", async () => {
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        const hook = await host.client.hooks.onSystemPrompt(({ systemPrompt }) => ({
            systemPrompt: `${systemPrompt}\nrecovered`,
        }));
        const traced: string[] = [];
        const tracing = await host.client.tracing.subscribe((event) => {
            traced.push(event.type);
        });
        const firstHookRegistration = hook.registrationId;
        const firstTracingRegistration = tracing.registrationId;

        host.hooks.disconnect();
        host.tracing.disconnect();

        await expect.poll(() => tracing.registrationId !== firstTracingRegistration).toBe(true);
        expect(hook.registrationId).toBe(firstHookRegistration);
        expect(hook.status).toBe("closed");
        expect(tracing.status).toBe("connected");
        await expect(
            host.hooks.applySystemPrompt({
                systemPrompt: "Base",
                userPrompt: "Continue.",
            }),
        ).rejects.toThrow("No system-prompt hook is attached");
        host.tracing.emit({
            model: "openai/gpt-test",
            provider: "codex",
            sessionId: "session-1",
            timestamp: 1,
            type: "turn_started",
        });
        await expect.poll(() => traced).toEqual(["turn_started"]);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("will reconnect"));

        await hook.close();
        await tracing.close();
        warning.mockRestore();
    });

    it("rejects late hooks while allowing dynamic tracing after readiness", async () => {
        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);

        await host.client.ready("Ready.");
        await expect(host.client.hooks.onSystemPrompt(() => ({}))).rejects.toThrow(
            "must be declared before the plugin reports ready",
        );
        const tracing = await host.client.tracing.subscribe(() => {});
        expect(tracing.status).toBe("connected");
        await tracing.close();
    });

    it("exposes the exact stable tool identity used by ordinary agents", () => {
        expect(createHappyMcpToolName("Project Tools", "Catalog", "list projects")).toBe(
            "mcp__Project_Tools___Catalog__list_projects",
        );
    });

    it("seeds the plugin catalog for SDK tests", async () => {
        const host = await createHappyPluginTestHost(
            {
                plugins: [
                    {
                        folder: "catalog",
                        isSelf: true,
                        name: "Catalog",
                        state: "running",
                        version: "2.0.0",
                    },
                    {
                        folder: "broken",
                        isSelf: false,
                        name: "Broken",
                        state: "failed",
                        version: "0.0.0",
                    },
                ],
            },
            { temporaryDirectory: process.cwd() },
        );
        hosts.push(host);

        await expect(host.client.plugins.list()).resolves.toEqual([
            {
                folder: "catalog",
                isSelf: true,
                name: "Catalog",
                state: "running",
                version: "2.0.0",
            },
            {
                folder: "broken",
                isSelf: false,
                name: "Broken",
                state: "failed",
                version: "0.0.0",
            },
        ]);
        expect(host.requests).toContainEqual({ method: "GET", path: "/plugins" });
    });

    it("seeds Rig data, observes SDK requests, lists MCP tools, and calls one", async () => {
        const observed: string[] = [];
        const host = await createHappyPluginTestHost(
            {
                projects: [
                    { id: "project-1", name: "Rig", path: "/workspace/rig" },
                    { id: "project-2", name: "Plugins", path: "/workspace/plugins" },
                ],
                sessions: [
                    {
                        agentId: "agent-1",
                        archived: false,
                        cwd: "/workspace/rig",
                        id: "session-1",
                        projectId: "project-1",
                        status: "idle",
                    },
                ],
                workspaces: [
                    {
                        id: "workspace-1",
                        name: "Plugin work",
                        path: "/workspace/rig/plugin-work",
                        projectId: "project-1",
                        status: "ready",
                        version: 0,
                    },
                ],
            },
            {
                onRequest: (request) => observed.push(`${request.method} ${request.path}`),
                temporaryDirectory: process.cwd(),
            },
        );
        hosts.push(host);

        const server = await host.client.mcp.startServer({
            name: "Project tools",
            tools: [
                defineMcpTool({
                    description: "List the projects visible to this plugin.",
                    inputSchema: Type.Object({}, { additionalProperties: false }),
                    name: "list_projects",
                    async execute() {
                        const projects = await host.client.projects.list();
                        return {
                            content: [{ text: JSON.stringify(projects), type: "text" }],
                        };
                    },
                }),
            ],
        });

        await host.mcp.waitForTools();
        expect(host.mcp.listTools()).toMatchObject([
            { server: "Project tools", tool: "list_projects" },
        ]);
        await expect(host.mcp.callTool("Project tools", "list_projects")).resolves.toMatchObject({
            content: [{ text: expect.stringContaining('"name":"Rig"'), type: "text" }],
        });
        expect(
            host.requests.filter(
                (request) => request.method === "POST" && request.path.includes("/calls/"),
            ),
        ).toHaveLength(1);
        await expect(
            host.client.workspaces.list({ projectId: "project-1" }),
        ).resolves.toMatchObject([{ id: "workspace-1", name: "Plugin work" }]);
        expect(observed).toContain("GET /projects");
        expect(observed).toContain("GET /workspaces?projectId=project-1");
        expect(host.requests.some((request) => request.path === "/mcp/servers")).toBe(true);

        const registrationId = server.registrationId;
        await server.close();
        await expect.poll(() => host.mcp.listTools()).toEqual([]);
        expect(host.requests).toContainEqual({
            method: "DELETE",
            path: `/mcp/servers/${registrationId}`,
        });
    });

    it("creates writable plugin state and removes its temporary root on close", async () => {
        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        const statePath = join(host.environment.HAPPY_PLUGIN_DIRECTORY, "state.txt");

        await writeFile(statePath, "persisted locally\n");
        await expect(readFile(statePath, "utf8")).resolves.toBe("persisted locally\n");

        await host.close();
        await expect(access(host.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("exercises network request handlers and tunnel observers", async () => {
        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        const tunnels: string[] = [];
        const requestSubscription = await host.client.network.onRequest((request) => ({
            body: Buffer.from(`${request.method} ${request.url}`),
            headers: { "content-type": "text/plain" },
            status: 202,
            type: "response",
        }));
        const tunnelSubscription = await host.client.network.onTunnel((tunnel) => {
            tunnels.push(
                `${tunnel.hostname}:${String(tunnel.port)} ${String(tunnel.bytesFromClient)}/${String(tunnel.bytesFromServer)}`,
            );
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        await host.client.ready("Serving network requests.");
        await expect(
            host.client.network.onRequest(() => ({ type: "pass_through" })),
        ).rejects.toThrow(
            "Network listener registration must be declared before the plugin reports ready.",
        );

        await expect(
            host.network.request({
                body: Buffer.alloc(0),
                headers: {},
                hostname: "api.example.com",
                method: "GET",
                url: "http://api.example.com/items",
            }),
        ).resolves.toMatchObject({
            body: Buffer.from("GET http://api.example.com/items"),
            status: 202,
            type: "response",
        });
        host.network.tunnel({ type: "invalid" } as never);
        host.network.tunnel({
            bytesFromClient: 12,
            bytesFromServer: 34,
            hostname: "api.example.com",
            port: 443,
            type: "tunnel",
        });
        await expect.poll(() => tunnels).toEqual(["api.example.com:443 12/34"]);
        expect(consoleError).toHaveBeenCalledWith(
            expect.stringContaining("Happy dropped an invalid network event"),
        );
        consoleError.mockRestore();

        await Promise.all([requestSubscription.close(), tunnelSubscription.close()]);
    });

    it("mirrors workspace command and file APIs for plugin authoring", async () => {
        const workspace = await mkdtemp(join(process.cwd(), ".workspace-"));
        try {
            const host = await createHappyPluginTestHost(
                {
                    workspaces: [
                        {
                            id: "workspace-1",
                            name: "Authoring workspace",
                            path: workspace,
                            projectId: "project-1",
                            status: "ready",
                            version: 0,
                        },
                    ],
                },
                { temporaryDirectory: process.cwd() },
            );
            hosts.push(host);

            await expect(
                host.client.workspaces.files.write({
                    content: "from the fake host\n",
                    path: "nested/file.txt",
                    workspaceId: "workspace-1",
                }),
            ).resolves.toEqual({ bytesWritten: 19 });
            await expect(
                host.client.workspaces.files.read({
                    path: "nested/file.txt",
                    workspaceId: "workspace-1",
                }),
            ).resolves.toEqual({ bytes: 19, content: "from the fake host\n" });
            await expect(
                host.client.workspaces.files.read({
                    path: "missing.txt",
                    workspaceId: "workspace-1",
                }),
            ).rejects.toMatchObject({
                message: "The requested workspace file does not exist.",
                status: 404,
            });
            await expect(
                host.client.workspaces.exec({
                    command: "printf 'ready'",
                    workspaceId: "workspace-1",
                }),
            ).resolves.toMatchObject({
                exitCode: 0,
                stdout: "ready",
                timedOut: false,
            });
        } finally {
            await rm(workspace, { force: true, recursive: true });
        }
    });

    it("returns an initializing workspace reservation before the host completes it", async () => {
        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        const workspace = await host.client.workspaces.create({
            id: "g1l4nup1ppbrfvae0pllq6ul",
            name: "Initializing workspace",
            projectId: "project-1",
        });

        expect(workspace.status).toBe("initializing");
        const root = host.rootDirectory;
        await host.close();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("publishes an asynchronous workspace-ready event for a new reservation", async () => {
        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        let resolveReady: (id: string) => void = () => {};
        const ready = new Promise<string>((resolve) => {
            resolveReady = resolve;
        });
        const subscription = await host.client.workspaces.subscribe((event) => {
            if (event.type === "workspace_updated" && event.workspace.status === "ready") {
                resolveReady(event.workspace.id);
            }
        });

        const workspace = await host.client.workspaces.create({
            id: "g1l4nup1ppbrfvae0pllq6ul",
            name: "Observable workspace",
            projectId: "project-1",
        });

        expect(workspace.status).toBe("initializing");
        await expect(ready).resolves.toBe(workspace.id);
        await subscription.close();
    });

    it("mirrors production request-error status codes", async () => {
        const host = await createHappyPluginTestHost(
            {
                workspaces: [
                    {
                        id: "workspace-1",
                        name: "Authoring workspace",
                        path: process.cwd(),
                        projectId: "project-1",
                        status: "ready",
                        version: 0,
                    },
                ],
            },
            { temporaryDirectory: process.cwd() },
        );
        hosts.push(host);

        await expect(
            rawHostRequestStatus(host, "/sessions", JSON.stringify({ cwd: 42 })),
        ).resolves.toBe(400);
        await expect(
            rawHostRequestStatus(
                host,
                "/projects/project-1/workspaces/workspace-1",
                JSON.stringify({}),
                "PATCH",
            ),
        ).resolves.toBe(400);
        await expect(rawHostRequestStatus(host, "/mcp/servers", JSON.stringify({}))).resolves.toBe(
            400,
        );
        await expect(rawHostRequestStatus(host, "/sessions", "{")).resolves.toBe(400);
        await expect(
            rawHostRequestStatus(
                host,
                "/sessions",
                JSON.stringify({ cwd: "x".repeat(1024 * 1024) }),
                "POST",
                64 * 1024,
            ),
        ).resolves.toBe(413);
    });

    it("limits each plugin to eight concurrent workspace commands", async () => {
        const workspace = await mkdtemp(join(process.cwd(), ".workspace-cap-"));
        const commands: Promise<unknown>[] = [];
        try {
            const host = await createHappyPluginTestHost(
                {
                    workspaces: [
                        {
                            id: "workspace-1",
                            name: "Authoring workspace",
                            path: workspace,
                            projectId: "project-1",
                            status: "ready",
                            version: 0,
                        },
                    ],
                },
                { temporaryDirectory: process.cwd() },
            );
            hosts.push(host);

            for (let index = 0; index < 8; index += 1) {
                commands.push(
                    host.client.workspaces.exec({
                        command: `touch started-${String(index)}; while [ ! -e release ]; do sleep 0.01; done`,
                        workspaceId: "workspace-1",
                    }),
                );
            }
            await expect
                .poll(async () =>
                    (await readdir(workspace)).filter((name) => name.startsWith("started-")),
                )
                .toHaveLength(8);

            await expect(
                host.client.workspaces.exec({
                    command: "printf 'too many'",
                    workspaceId: "workspace-1",
                }),
            ).rejects.toMatchObject({
                message: "A plugin can run at most 8 workspace commands at once.",
                status: 400,
            });
        } finally {
            await writeFile(join(workspace, "release"), "");
            await Promise.allSettled(commands);
            await rm(workspace, { force: true, recursive: true });
        }
    });

    it("mirrors provider usage plus app tool and storage access", async () => {
        const host = await createHappyPluginTestHost(
            {
                providerUsage: [
                    {
                        checkedAt: 42,
                        error: null,
                        providerId: "provider-work",
                        usage: {
                            capturedAt: 40,
                            credits: null,
                            exhausted: false,
                            planName: "Team",
                            providerId: "provider-work",
                            vendor: "codex",
                            windows: { fiveHour: null, monthly: null, weekly: null },
                        },
                    },
                ],
            },
            { temporaryDirectory: process.cwd() },
        );
        hosts.push(host);

        await expect(host.client.providers.usage()).resolves.toMatchObject([
            { providerId: "provider-work", usage: { planName: "Team" } },
        ]);
        await host.client.mcp.startServer({
            name: "App backend",
            tools: [
                defineMcpTool({
                    description: "Uppercase a string for the app.",
                    execute: ({ value }) => ({
                        content: [{ text: value.toUpperCase(), type: "text" }],
                    }),
                    inputSchema: Type.Object({ value: Type.String() }),
                    name: "uppercase",
                    visibility: ["app"],
                }),
            ],
        });
        await host.mcp.waitForTools();
        expect(host.mcp.listTools()).toEqual([]);
        await expect(
            host.mcp.callTool("App backend", "uppercase", { value: "blocked" }),
        ).rejects.toThrow("model-visible");
        await expect(
            host.apps.callTool("App backend", "uppercase", { value: "ready" }),
        ).resolves.toMatchObject({ content: [{ text: "READY", type: "text" }] });
        await host.apps.storage.set("view", { mode: "compact" });
        await expect(host.apps.storage.get("view")).resolves.toEqual({ mode: "compact" });
        await expect(host.apps.storage.list()).resolves.toEqual(["view"]);
        await expect(host.apps.storage.set("Bad Key", null)).rejects.toThrow("lowercase");
        await expect(host.apps.storage.set("bigint", 1n)).rejects.toThrow("JSON serializable");
        await expect(host.apps.storage.set("large", "x".repeat(70 * 1024))).rejects.toThrow(
            "cannot exceed 65536",
        );
        for (let index = 1; index < HAPPY_PLUGIN_MAX_STORAGE_KEYS; index += 1) {
            await host.apps.storage.set(`key-${String(index).padStart(4, "0")}`, null);
        }
        await expect(host.apps.storage.set("overflow", null)).rejects.toThrow("too many");
        await host.apps.storage.delete("view");
        await expect(host.apps.storage.get("view")).resolves.toBeUndefined();
    });

    it("validates data and resolves plugin failures as MCP error results", async () => {
        await expect(
            createHappyPluginTestHost({
                projects: [{ id: "", name: "Broken", path: "/workspace" }],
            }),
        ).rejects.toThrow();

        const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
        hosts.push(host);
        await host.client.mcp.startServer({
            name: "Validation",
            tools: [
                defineMcpTool({
                    description: "Requires one string.",
                    inputSchema: Type.Object({ value: Type.String() }),
                    name: "echo",
                    execute: ({ value }) => ({
                        content: [{ text: value, type: "text" }],
                    }),
                }),
                defineMcpTool({
                    description: "Returns a representative plugin failure.",
                    inputSchema: Type.Object({}),
                    name: "fail",
                    execute() {
                        throw new Error("Expected plugin failure.");
                    },
                }),
            ],
        });
        await host.mcp.waitForTools();

        await expect(host.mcp.callTool("Validation", "echo", { value: 42 })).resolves.toMatchObject(
            {
                content: [{ text: expect.stringContaining("expected schema"), type: "text" }],
                isError: true,
            },
        );
        await expect(host.mcp.callTool("Validation", "fail")).resolves.toEqual({
            content: [{ text: "Expected plugin failure.", type: "text" }],
            isError: true,
        });
        expect(
            host.requests.filter(
                (request) => request.method === "POST" && request.path.includes("/calls/"),
            ),
        ).toHaveLength(2);
    });

    it.each(["close", "end", "error"] as const)(
        "retires its catalog after an unexpected stream %s without registering late",
        async (mode) => {
            const host = await createHappyPluginTestHost({}, { temporaryDirectory: process.cwd() });
            hosts.push(host);
            const server = await host.client.mcp.startServer({
                name: `Recovery ${mode}`,
                tools: [
                    defineMcpTool({
                        description: "Proves the recovered stream accepts calls.",
                        inputSchema: Type.Object({}),
                        name: "ping",
                        execute: () => ({
                            content: [{ text: "pong", type: "text" }],
                        }),
                    }),
                ],
            });
            const firstRegistration = server.registrationId;

            host.mcp.disconnectServers(mode);
            await expect.poll(() => server.status, { timeout: 2_000 }).toBe("closed");
            expect(server.failure).toEqual(expect.any(String));
            expect(host.mcp.listTools()).toEqual([]);
            expect(server.registrationId).toBe(firstRegistration);
            expect(host.requests).not.toContainEqual({
                method: "DELETE",
                path: `/mcp/servers/${firstRegistration}`,
            });

            const registrationCount = host.requests.filter(
                (request) => request.method === "POST" && request.path === "/mcp/servers",
            ).length;
            await server.close();
            expect(server.status).toBe("closed");
            expect(
                host.requests.filter(
                    (request) => request.method === "POST" && request.path === "/mcp/servers",
                ),
            ).toHaveLength(registrationCount);
            expect(host.requests).not.toContainEqual({
                method: "DELETE",
                path: `/mcp/servers/${firstRegistration}`,
            });
        },
    );
});

function rawHostRequestStatus(
    host: HappyPluginTestHost,
    path: string,
    body: string,
    method = "POST",
    chunkBytes?: number,
): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const request = requestHttp(
            {
                headers: {
                    authorization: `Bearer ${host.environment.HAPPY_PLUGIN_TOKEN}`,
                    "content-length": Buffer.byteLength(body),
                    "content-type": "application/json",
                },
                method,
                path,
                socketPath: host.environment.HAPPY_PLUGIN_SOCKET_PATH,
            },
            (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 500));
            },
        );
        request.once("error", reject);
        if (chunkBytes === undefined) {
            request.end(body);
            return;
        }
        const buffer = Buffer.from(body);
        let offset = 0;
        const writeNext = (): void => {
            if (offset >= buffer.length) {
                request.end();
                return;
            }
            const nextOffset = Math.min(buffer.length, offset + chunkBytes);
            const canContinue = request.write(buffer.subarray(offset, nextOffset));
            offset = nextOffset;
            if (canContinue) {
                setImmediate(writeNext);
            } else {
                request.once("drain", writeNext);
            }
        };
        writeNext();
    });
}
