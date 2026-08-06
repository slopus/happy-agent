import { request as requestHttp } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createId } from "@paralleldrive/cuid2";
import {
    createHappyPluginClient,
    defineMcpTool,
    HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES,
    HAPPY_PLUGIN_MAX_LIST_ITEMS,
    HAPPY_PLUGIN_MAX_MEDIA_BYTES,
    Type,
} from "happy-plugins";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createGeneratedMediaStore } from "../../generated-media/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createPluginApiServer } from "../createPluginApiServer.js";
import { MAX_INSTALLED_PLUGINS } from "../discoverPlugins.js";
import { PluginHookRegistry } from "../PluginHookRegistry.js";
import { PluginMcpRegistry } from "../PluginMcpRegistry.js";
import { PluginNetworkRegistry } from "../PluginNetworkRegistry.js";
import { PluginStartupState } from "../PluginStartupState.js";

const execFile = promisify(execFileCallback);
const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

describe("plugin API server", () => {
    it("requires its plugin token and serves SDK requests over its Unix socket", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const server = createPluginApiServer({
            listPlugins: async () => [],
            pluginFolder: "test-plugin",
            pluginName: "Test Plugin",
            startup: new PluginStartupState(),
            store,
            token: "private-plugin-token",
        });
        cleanup.push(
            () =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    server.closeAllConnections();
                }),
        );
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, () => {
                server.off("error", reject);
                resolve();
            });
        });

        await expect(
            createHappyPluginClient({
                socketPath,
                token: "private-plugin-token",
            }).projects.list(),
        ).resolves.toEqual([]);
        await expect(unauthorizedStatus(socketPath)).resolves.toBe(401);
    });

    it("forwards a stable workspace ID so repeated plugin creation returns one reservation", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        await writeFile(join(directory, "README.md"), "Plugin test project\n");
        await execFile("git", ["-C", directory, "init", "--initial-branch=main"]);
        await execFile("git", ["-C", directory, "config", "user.email", "rig@example.test"]);
        await execFile("git", ["-C", directory, "config", "user.name", "Rig Test"]);
        await execFile("git", ["-C", directory, "add", "README.md"]);
        await execFile("git", ["-C", directory, "commit", "-m", "Initial"]);
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const project = await store.registerProject({ path: directory });
        const server = createPluginApiServer({
            listPlugins: async () => [],
            pluginFolder: "test-plugin",
            pluginName: "Test Plugin",
            startup: new PluginStartupState(),
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);
        const client = createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        });
        const id = createId();
        const events: string[] = [];
        const subscription = await client.workspaces.subscribe((event) => {
            events.push(`${event.type}:${event.workspace.status}`);
        });

        const first = await client.workspaces.create({
            id,
            name: "Retry safely",
            projectId: project.id,
        });
        const retry = await client.workspaces.create({
            id,
            name: "Retry safely",
            projectId: project.id,
        });

        expect(retry).toEqual(first);
        expect(store.listWorkspaces(project.id)).toEqual([expect.objectContaining({ id })]);
        await expect(
            client.workspaces.create({
                baseRef: "different-base",
                id,
                name: "Retry safely",
                projectId: project.id,
            }),
        ).rejects.toMatchObject({ status: 409 });
        await expect.poll(() => events).toContain("workspace_created:initializing");
        await subscription.close();
    });

    it("returns conflict responses when hook stream registrations are stale or duplicate", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const hooks = new PluginHookRegistry().createConnection({
            folder: "test-plugin",
            name: "Test Plugin",
        });
        const startup = new PluginStartupState();
        const server = createPluginApiServer({
            hooks,
            listPlugins: async () => [],
            pluginFolder: "test-plugin",
            pluginName: "Test Plugin",
            startup,
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        for (const path of [
            "/hooks/system-prompt/stale/events",
            "/tracing/subscriptions/stale/events",
        ]) {
            const response = await authorizedResponse(socketPath, path);
            expect(response.status).toBe(409);
            expect(response.contentType).toContain("application/json");
            expect(response.body).toContain("not active");
        }
        await expect(
            authorizedResponse(socketPath, "/hooks/system-prompt", "POST"),
        ).resolves.toMatchObject({ status: 201 });
        await expect(
            authorizedResponse(socketPath, "/hooks/system-prompt", "POST"),
        ).resolves.toMatchObject({
            body: expect.stringContaining("already registered"),
            status: 409,
        });
    });

    it("keeps hooks in the startup window while tracing remains dynamic", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const hooks = new PluginHookRegistry().createConnection({
            folder: "test-plugin",
            name: "Test Plugin",
        });
        const startup = new PluginStartupState();
        const server = createPluginApiServer({
            hooks,
            listPlugins: async () => [],
            pluginFolder: "test-plugin",
            pluginName: "Test Plugin",
            startup,
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);
        const client = createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        });

        const hook = await client.hooks.onSystemPrompt(() => ({}));
        await client.ready("Ready.");
        const tracing = await client.tracing.subscribe(() => {});
        expect(tracing.status).toBe("connected");

        await hook.close();
        await expect(client.hooks.onSystemPrompt(() => ({}))).rejects.toThrow(
            "must be declared before the plugin reports ready",
        );
        await tracing.close();
    });

    it("rejects hook and tracing registrations for a failed generation", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const hooks = new PluginHookRegistry().createConnection({
            folder: "test-plugin",
            name: "Test Plugin",
        });
        const hookRegistrationId = hooks.registerSystemPrompt();
        const tracingRegistrationId = hooks.registerTracing();
        const startup = new PluginStartupState();
        startup.fail("The plugin did not report ready within 10 seconds.");
        const server = createPluginApiServer({
            hooks,
            listPlugins: async () => [],
            pluginFolder: "test-plugin",
            pluginName: "Test Plugin",
            startup,
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        for (const path of ["/hooks/system-prompt", "/tracing/subscriptions"]) {
            const response = await authorizedResponse(socketPath, path, "POST");
            expect(response.status).toBe(400);
            expect(response.body).toContain("arrived after this plugin generation failed to start");
        }
        await expect(
            requestStatus(
                socketPath,
                "private-plugin-token",
                `/hooks/system-prompt/${hookRegistrationId}/events`,
            ),
        ).resolves.toBe(400);
        await expect(
            requestStatus(
                socketPath,
                "private-plugin-token",
                `/tracing/subscriptions/${tracingRegistrationId}/events`,
            ),
        ).resolves.toBe(400);
    });

    it("creates, lists, updates, and removes slot entries with plugin authorship", async () => {
        const fixture = await createPluginApiFixture();

        await expect(
            fixture.client.slots.create({
                content: { markdown: "Wrong place", type: "text" },
                description: "Invalid shortcut",
                purpose: "Exercise the slot matrix",
                scope: "session",
                sessionId: "missing-session",
                slot: "sidebar",
            }),
        ).rejects.toMatchObject({
            message: "The sidebar slot allows only the everywhere scope.",
            status: 400,
        });

        const created = await fixture.client.slots.create({
            content: { markdown: "Build is green", type: "text" },
            description: "Build status",
            purpose: "Keep the current build visible",
            scope: "everywhere",
            slot: "status-line",
        });
        expect(created).toMatchObject({
            author: { folder: "test-plugin", name: "Test Plugin", type: "plugin" },
            content: { markdown: "Build is green", type: "text" },
            scope: "everywhere",
            slot: "status-line",
        });

        await expect(fixture.client.slots.list({ slot: "status-line" })).resolves.toEqual([
            created,
        ]);
        const updated = await fixture.client.slots.update(created.id, {
            content: {
                action: { message: "show logs", type: "send-current-chat" },
                label: "Open logs",
                type: "button",
            },
            slot: "sidebar",
        });
        expect(updated).toMatchObject({
            author: { folder: "test-plugin", name: "Test Plugin", type: "plugin" },
            slot: "sidebar",
        });
        await expect(fixture.client.slots.remove(created.id)).resolves.toEqual(updated);
        await expect(fixture.client.slots.list()).resolves.toEqual([]);
    });

    it("publishes bounded bytes or plugin-owned files through generated media", async () => {
        const fixture = await createPluginApiFixture();
        await writeFile(join(fixture.pluginDataDirectory, "report.txt"), "path media");
        await writeFile(join(fixture.directory, "outside.txt"), "outside");
        await writeFile(
            join(fixture.pluginDataDirectory, "too-large.bin"),
            Buffer.alloc(HAPPY_PLUGIN_MAX_MEDIA_BYTES + 1),
        );

        const bytesPublished = await fixture.client.media.publish({
            bytes: Buffer.from("byte media"),
            name: "summary.txt",
        });
        expect(bytesPublished).toMatchObject({
            bytes: 10,
            location: expect.stringMatching(/^generated\/summary-[a-f0-9]{8}\.txt$/u),
            name: expect.stringMatching(/^summary-[a-f0-9]{8}\.txt$/u),
        });
        await expect(
            readFile(join(fixture.generatedDirectory, bytesPublished.name), "utf8"),
        ).resolves.toBe("byte media");

        const pathPublished = await fixture.client.media.publish({ path: "report.txt" });
        await expect(
            readFile(join(fixture.generatedDirectory, pathPublished.name), "utf8"),
        ).resolves.toBe("path media");
        await expect(
            fixture.client.media.publish({ path: "../outside.txt" }),
        ).rejects.toMatchObject({
            message: "Plugin media paths cannot leave the plugin data folder.",
            status: 400,
        });
        await expect(fixture.client.media.publish({ path: "too-large.bin" })).rejects.toMatchObject(
            { status: 413 },
        );
    });

    it("executes one-shot workspace commands with captured output and a bounded timeout", async () => {
        const fixture = await createWorkspaceApiFixture();

        await expect(
            fixture.client.workspaces.exec({
                command: "printf 'captured stdout'; printf 'captured stderr' >&2; pwd",
                workspaceId: fixture.workspaceId,
            }),
        ).resolves.toEqual({
            exitCode: 0,
            stderr: "captured stderr",
            stderrTruncated: false,
            stdout: `captured stdout${fixture.workspacePath}\n`,
            stdoutTruncated: false,
            timedOut: false,
        });

        await expect(
            fixture.client.workspaces.exec({
                command: "sleep 2",
                timeoutMs: 25,
                workspaceId: fixture.workspaceId,
            }),
        ).resolves.toMatchObject({
            exitCode: null,
            stderrTruncated: false,
            stdoutTruncated: false,
            timedOut: true,
        });
    });

    it("refuses workspace operations until the managed checkout is ready and present", async () => {
        const fixture = await createWorkspaceApiFixture({
            presence: "missing",
            status: "initializing",
        });
        const destination = join(fixture.workspacePath, "must-not-exist.txt");

        await expect(
            fixture.client.workspaces.exec({
                command: `touch ${JSON.stringify(destination)}`,
                workspaceId: fixture.workspaceId,
            }),
        ).rejects.toMatchObject({
            message: "The workspace is still initializing or its directory is unavailable.",
            status: 409,
        });
        await expect(
            fixture.client.workspaces.files.read({
                path: "must-not-exist.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).rejects.toMatchObject({ status: 409 });
        await expect(
            fixture.client.workspaces.files.write({
                content: "must not write",
                path: "must-not-exist.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).rejects.toMatchObject({ status: 409 });
        await expect(readFile(destination, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("reads and writes bounded workspace files while rejecting traversal and symlink escapes", async () => {
        const fixture = await createWorkspaceApiFixture();
        const outside = join(fixture.directory, "outside");
        await mkdir(outside);
        await symlink(outside, join(fixture.workspacePath, "escape"));

        await expect(
            fixture.client.workspaces.files.write({
                content: "plugin file\n",
                path: "nested/report.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).resolves.toEqual({ bytesWritten: 12 });
        await expect(
            fixture.client.workspaces.files.read({
                path: "nested/report.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).resolves.toEqual({ bytes: 12, content: "plugin file\n" });
        await expect(
            fixture.client.workspaces.files.write({
                content: "outside",
                path: "../outside.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            fixture.client.workspaces.files.write({
                content: "outside",
                path: "escape/outside.txt",
                workspaceId: fixture.workspaceId,
            }),
        ).rejects.toMatchObject({ status: 400 });
    });

    it("caps each command output stream and reports truncation independently", async () => {
        const fixture = await createWorkspaceApiFixture();
        const script = [
            `process.stdout.write("x".repeat(${String(HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES + 1)}))`,
            'process.stderr.write("kept stderr")',
        ].join(";");
        const result = await fixture.client.workspaces.exec({
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
            workspaceId: fixture.workspaceId,
        });

        expect(Buffer.byteLength(result.stdout)).toBe(HAPPY_PLUGIN_MAX_COMMAND_OUTPUT_BYTES);
        expect(result).toMatchObject({
            exitCode: 0,
            stderr: "kept stderr",
            stderrTruncated: false,
            stdoutTruncated: true,
            timedOut: false,
        });
    });

    it("returns sanitized workspace operation failures instead of raw host paths", async () => {
        const fixture = await createWorkspaceApiFixture();
        const missingFile = fixture.client.workspaces.files.read({
            path: "missing.txt",
            workspaceId: fixture.workspaceId,
        });
        await expect(missingFile).rejects.toMatchObject({
            message: "The requested workspace file does not exist.",
            status: 404,
        });
        await expect(missingFile).rejects.not.toThrow(fixture.workspacePath);

        await mkdir(join(fixture.workspacePath, "directory"));
        const directoryWrite = fixture.client.workspaces.files.write({
            content: "not a directory",
            path: "directory",
            workspaceId: fixture.workspaceId,
        });
        await expect(directoryWrite).rejects.toMatchObject({
            message: "The workspace file could not be written because its path is a directory.",
            status: 400,
        });
        await expect(directoryWrite).rejects.not.toThrow(fixture.workspacePath);

        await writeFile(join(fixture.workspacePath, "file-parent"), "file");
        const invalidParentWrite = fixture.client.workspaces.files.write({
            content: "not reachable",
            path: "file-parent/child.txt",
            workspaceId: fixture.workspaceId,
        });
        await expect(invalidParentWrite).rejects.toMatchObject({
            message: "The workspace file path is invalid because part of it is not a directory.",
            status: 400,
        });
        await expect(invalidParentWrite).rejects.not.toThrow(fixture.workspacePath);

        await rm(fixture.workspacePath, { force: true, recursive: true });
        const missingWorkspace = fixture.client.workspaces.exec({
            command: "printf unreachable",
            workspaceId: fixture.workspaceId,
        });
        await expect(missingWorkspace).rejects.toMatchObject({
            message: "The workspace directory is unavailable.",
            status: 404,
        });
        await expect(missingWorkspace).rejects.not.toThrow(fixture.workspacePath);
    });

    it("lists the manager snapshot with plugin states and the caller marked by folder", async () => {
        expect(MAX_INSTALLED_PLUGINS).toBeLessThanOrEqual(HAPPY_PLUGIN_MAX_LIST_ITEMS);
        const longDisplayName = "R".repeat(129);
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const server = createPluginApiServer({
            listPlugins: async () => [
                {
                    apps: [],
                    author: "Happy",
                    category: "productivity",
                    dataDirectory: "/plugin-data/reports",
                    description: "Writes reports.",
                    directory: "/plugins/reports",
                    folder: "reports",
                    icon: {
                        generation: "a".repeat(64),
                        mediaType: "image/png",
                        size: 128,
                    },
                    logAvailable: true,
                    name: longDisplayName,
                    status: "failed",
                    version: "0.0.0",
                },
                {
                    apps: [],
                    author: "Happy",
                    category: "automation",
                    dataDirectory: "/plugin-data/archive",
                    description: "Archives work.",
                    directory: "/plugins/archive",
                    folder: "archive",
                    icon: {
                        generation: "b".repeat(64),
                        mediaType: "image/png",
                        size: 128,
                    },
                    logAvailable: false,
                    name: "Archive",
                    status: "stopped",
                    version: "0.0.0",
                },
                ...Array.from({ length: MAX_INSTALLED_PLUGINS - 2 }, (_, index) => ({
                    apps: [],
                    author: "Happy",
                    category: "other" as const,
                    dataDirectory: `/plugin-data/filler-${String(index)}`,
                    description: "Fills the bounded catalog.",
                    directory: `/plugins/filler-${String(index)}`,
                    folder: `filler-${String(index)}`,
                    icon: {
                        generation: "c".repeat(64),
                        mediaType: "image/png" as const,
                        size: 128,
                    },
                    logAvailable: false,
                    name: `Filler ${String(index)}`,
                    status: "stopped" as const,
                    version: "0.0.0",
                })),
                {
                    apps: [],
                    author: "Happy",
                    category: "utilities",
                    dataDirectory: "/plugin-data/clock",
                    description: "Keeps time.",
                    directory: "/plugins/clock",
                    folder: "clock",
                    icon: {
                        generation: "d".repeat(64),
                        mediaType: "image/png",
                        size: 128,
                    },
                    logAvailable: true,
                    name: "Clock",
                    status: "running",
                    statusMessage: "Keeping time.",
                    version: "1.2.3",
                },
            ],
            pluginFolder: "clock",
            pluginName: "Clock",
            startup: new PluginStartupState(),
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        const plugins = await createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }).plugins.list();
        expect(plugins).toHaveLength(MAX_INSTALLED_PLUGINS);
        expect(plugins.slice(0, 2)).toEqual([
            {
                folder: "reports",
                isSelf: false,
                name: longDisplayName,
                state: "failed",
                version: "0.0.0",
            },
            {
                folder: "archive",
                isSelf: false,
                name: "Archive",
                state: "stopped",
                version: "0.0.0",
            },
        ]);
        expect(plugins.at(-1)).toEqual({
            folder: "clock",
            isSelf: true,
            name: "Clock",
            state: "running",
            status: "Keeping time.",
            version: "1.2.3",
        });
    });

    it("forwards SDK-registered MCP calls over the same authenticated socket", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const registry = new PluginMcpRegistry();
        cleanup.push(() => registry.close());
        const mcp = registry.createConnection({ folder: "projects", name: "Projects" });
        const startup = new PluginStartupState();
        const statuses: string[] = [];
        const server = createPluginApiServer({
            listPlugins: async () => [],
            mcp,
            onStatus: (status) => statuses.push(status),
            pluginFolder: "projects",
            pluginName: "Projects",
            startup,
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);
        const client = createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        });
        const contribution = await client.mcp.startServer({
            name: "Catalog",
            tools: [
                defineMcpTool({
                    description: "List projects through the plugin SDK.",
                    inputSchema: Type.Object({}),
                    name: "list_projects",
                    async execute() {
                        return {
                            content: [
                                {
                                    text: JSON.stringify(await client.projects.list()),
                                    type: "text",
                                },
                            ],
                        };
                    },
                }),
                defineMcpTool({
                    description: "Return more data than the plugin boundary permits.",
                    inputSchema: Type.Object({}),
                    name: "oversized_result",
                    execute() {
                        return {
                            content: [{ text: "x".repeat(1024 * 1024 + 1), type: "text" }],
                        };
                    },
                }),
            ],
        });
        await client.ready("Ready.");
        await expect(client.ready("Ready again.")).rejects.toThrow(
            "Plugin readiness was already reported for this plugin generation.",
        );
        await client.status.set("Serving project tools.");
        expect(statuses).toEqual(["Ready.", "Serving project tools."]);

        const tools = (await registry.load("/workspace", "auto")).tools;
        const tool = tools.find((candidate) => candidate.name.endsWith("__list_projects"))!;
        await expect(tool.execute({} as never, {} as never, {})).resolves.toEqual({
            content: [{ text: "[]", type: "text" }],
        });
        const oversized = tools.find((candidate) => candidate.name.endsWith("__oversized_result"))!;
        await expect(oversized.execute({} as never, {} as never, {})).resolves.toMatchObject({
            content: [{ text: expect.stringContaining("request is too large"), type: "text" }],
            isError: true,
        });
        await expect(
            client.mcp.startServer({
                name: "Late catalog",
                tools: [
                    defineMcpTool({
                        description: "Arrives after readiness.",
                        inputSchema: Type.Object({}),
                        name: "late",
                        execute: () => ({ content: [{ text: "late", type: "text" }] }),
                    }),
                ],
            }),
        ).rejects.toThrow("must be declared before the plugin reports ready");

        await contribution.close();
        await expect
            .poll(async () => (await registry.load("/workspace", "auto")).tools)
            .toEqual([]);
    });

    it("rejects an MCP stream that attaches after its plugin generation timed out", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const registry = new PluginMcpRegistry();
        cleanup.push(() => registry.close());
        const mcp = registry.createConnection({ folder: "slow", name: "Slow" });
        const registrationId = mcp.register({
            name: "Late",
            tools: [
                {
                    description: "Attaches after the startup deadline.",
                    inputSchema: {
                        additionalProperties: false,
                        properties: {},
                        type: "object",
                    },
                    name: "late",
                },
            ],
        });
        const startup = new PluginStartupState();
        startup.fail("The plugin did not report ready within 10 seconds.");
        const server = createPluginApiServer({
            listPlugins: async () => [],
            mcp,
            pluginFolder: "slow",
            pluginName: "Slow",
            startup,
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        await expect(
            requestStatus(
                socketPath,
                "private-plugin-token",
                `/mcp/servers/${registrationId}/events`,
            ),
        ).resolves.toBe(400);
        expect((await registry.load("/workspace", "auto")).tools).toEqual([]);
    });

    it("rejects a network listener stream that attaches after its generation timed out", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const registry = new PluginNetworkRegistry();
        cleanup.push(() => registry.close());
        const network = registry.createConnection({
            folder: "slow",
            interceptDomains: ["api.example.com"],
            name: "Slow",
        });
        const registrationId = network.register("request");
        const startup = new PluginStartupState();
        startup.fail("The plugin did not report ready within 10 seconds.");
        const server = createPluginApiServer({
            listPlugins: async () => [],
            network,
            pluginFolder: "slow",
            pluginName: "Slow",
            startup,
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        await listen(server, socketPath);

        await expect(
            requestStatus(
                socketPath,
                "private-plugin-token",
                `/network/requests/${registrationId}/events`,
            ),
        ).resolves.toBe(400);
        expect(registry.shouldIntercept("api.example.com")).toBe(false);
    });

    it("does not complete an in-flight MCP call after its real socket stream disconnects", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const registry = new PluginMcpRegistry();
        cleanup.push(() => registry.close());
        const startup = new PluginStartupState();
        const server = createPluginApiServer({
            listPlugins: async () => [],
            mcp: registry.createConnection({ folder: "projects", name: "Projects" }),
            pluginFolder: "projects",
            pluginName: "Projects",
            startup,
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        const requests: string[] = [];
        server.on("request", (request) => {
            requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
        });
        await listen(server, socketPath);
        const callStarted = deferred<void>();
        const callAborted = deferred<void>();

        const contribution = await createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }).mcp.startServer({
            name: "Catalog",
            tools: [
                defineMcpTool({
                    description: "List projects.",
                    inputSchema: Type.Object({}),
                    name: "list_projects",
                    execute: (_input, { signal }) =>
                        new Promise((_resolve, reject) => {
                            callStarted.resolve();
                            const abort = () => {
                                callAborted.resolve();
                                reject(new Error("The blocking call was aborted."));
                            };
                            if (signal.aborted) {
                                abort();
                                return;
                            }
                            signal.addEventListener("abort", abort, { once: true });
                        }),
                }),
            ],
        });
        await createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }).ready("Ready.");
        const retiredRegistrationId = contribution.registrationId;
        const tool = (await registry.load("/workspace", "auto")).tools[0]!;
        const call = Promise.resolve(tool.execute({} as never, {} as never, {}));
        const rejectedCall = expect(call).rejects.toThrow("connection closed");
        await callStarted.promise;

        server.closeAllConnections();
        await rejectedCall;
        await callAborted.promise;
        expect(contribution.registrationId).toBe(retiredRegistrationId);
        await expect.poll(() => contribution.status, { timeout: 2_000 }).toBe("closed");
        expect(
            requests.some((request) =>
                request.startsWith(`POST /mcp/servers/${retiredRegistrationId}/calls/`),
            ),
        ).toBe(false);
        expect(requests).not.toContain(`DELETE /mcp/servers/${retiredRegistrationId}`);

        await contribution.close();
    });

    it("unregisters an MCP registration before closing its active stream", async () => {
        const directory = await createTestSocketDirectory();
        cleanup.push(() => rm(directory, { force: true, recursive: true }));
        const socketPath = join(directory, "api.sock");
        const store = new InMemorySessionStore({
            modelCatalog: {
                defaultModelId: "",
                defaultProviderId: "",
                models: [],
                providers: [],
            },
        });
        cleanup.push(() => store.close());
        const registry = new PluginMcpRegistry();
        cleanup.push(() => registry.close());
        const startup = new PluginStartupState();
        const server = createPluginApiServer({
            listPlugins: async () => [],
            mcp: registry.createConnection({ folder: "projects", name: "Projects" }),
            pluginFolder: "projects",
            pluginName: "Projects",
            startup,
            store,
            token: "private-plugin-token",
        });
        cleanup.push(() => closeServer(server));
        const requests: string[] = [];
        server.on("request", (request) => {
            requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
        });
        await listen(server, socketPath);

        const contribution = await createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }).mcp.startServer({
            name: "Catalog",
            tools: [
                defineMcpTool({
                    description: "List projects.",
                    inputSchema: Type.Object({}),
                    name: "list_projects",
                    execute: () => ({ content: [{ text: "[]", type: "text" }] }),
                }),
            ],
        });
        const retiredRegistrationId = contribution.registrationId;

        await contribution.close();

        expect(contribution.status).toBe("closed");
        await expect
            .poll(async () => (await registry.load("/workspace", "auto")).tools)
            .toEqual([]);
        expect(requests).toContain(`DELETE /mcp/servers/${retiredRegistrationId}`);
    });
});

function listen(
    server: ReturnType<typeof createPluginApiServer>,
    socketPath: string,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function closeServer(server: ReturnType<typeof createPluginApiServer>): Promise<void> {
    if (!server.listening) {
        server.closeAllConnections();
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
    });
}

async function createWorkspaceApiFixture(
    state: { presence?: "missing" | "present"; status?: "initializing" | "ready" } = {},
) {
    const directory = await createTestSocketDirectory();
    cleanup.push(() => rm(directory, { force: true, recursive: true }));
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const socketPath = join(directory, "api.sock");
    const store = new InMemorySessionStore({
        modelCatalog: {
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [],
        },
    });
    cleanup.push(() => store.close());
    const workspaceId = "workspace-1";
    vi.spyOn(store, "listWorkspaces").mockReturnValue([
        {
            createdAt: 1,
            gitCommonDir: workspacePath,
            id: workspaceId,
            kind: "git_worktree",
            name: "Plugin work",
            orderKey: "a0",
            path: workspacePath,
            presence: state.presence ?? "present",
            projectId: "project-1",
            status: state.status ?? "ready",
            storageKey: workspaceId,
            updatedAt: 1,
            version: 0,
        },
    ]);
    const server = createPluginApiServer({
        listPlugins: async () => [],
        pluginFolder: "test-plugin",
        pluginName: "Test Plugin",
        startup: new PluginStartupState(),
        store,
        token: "private-plugin-token",
    });
    cleanup.push(() => closeServer(server));
    await listen(server, socketPath);
    return {
        client: createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }),
        directory,
        workspaceId,
        workspacePath,
    };
}

async function createPluginApiFixture() {
    const directory = await createTestSocketDirectory();
    cleanup.push(() => rm(directory, { force: true, recursive: true }));
    const pluginDataDirectory = join(directory, "plugin-data");
    const generatedDirectory = join(directory, "generated");
    await mkdir(pluginDataDirectory);
    const socketPath = join(directory, "api.sock");
    const store = new InMemorySessionStore({
        modelCatalog: {
            defaultModelId: "",
            defaultProviderId: "",
            models: [],
            providers: [],
        },
    });
    cleanup.push(() => store.close());
    const server = createPluginApiServer({
        generatedMedia: createGeneratedMediaStore({ hostDirectory: generatedDirectory }),
        listPlugins: async () => [],
        pluginDataDirectory,
        pluginFolder: "test-plugin",
        pluginName: "Test Plugin",
        startup: new PluginStartupState(),
        store,
        token: "private-plugin-token",
    });
    cleanup.push(() => closeServer(server));
    await listen(server, socketPath);
    return {
        client: createHappyPluginClient({
            socketPath,
            token: "private-plugin-token",
        }),
        directory,
        generatedDirectory,
        pluginDataDirectory,
    };
}

function unauthorizedStatus(socketPath: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const request = requestHttp(
            { method: "GET", path: "/projects", socketPath },
            (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 500));
            },
        );
        request.once("error", reject);
        request.end();
    });
}

function authorizedResponse(
    socketPath: string,
    path: string,
    method = "GET",
): Promise<{ body: string; contentType: string | undefined; status: number }> {
    return new Promise((resolve, reject) => {
        const request = requestHttp(
            {
                headers: { authorization: "Bearer private-plugin-token" },
                method,
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        contentType:
                            typeof response.headers["content-type"] === "string"
                                ? response.headers["content-type"]
                                : undefined,
                        status: response.statusCode ?? 500,
                    }),
                );
            },
        );
        request.once("error", reject);
        request.end();
    });
}

function requestStatus(socketPath: string, token: string, path: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const request = requestHttp(
            {
                headers: { authorization: `Bearer ${token}` },
                method: "GET",
                path,
                socketPath,
            },
            (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 500));
            },
        );
        request.once("error", reject);
        request.end();
    });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
}
