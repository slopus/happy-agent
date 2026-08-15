import { request as requestHttp } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { defineTestModel as defineModel } from "../../testing/defineTestModel.js";

import {
    PluginAppError,
    PluginIconError,
    PluginManager,
    PluginMcpRegistry,
    PluginNotFoundError,
} from "../../plugins/index.js";
import type { PluginContext } from "../../agent/context/PluginContext.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";
import { DaemonLog } from "../DaemonLog.js";

const servers: Awaited<ReturnType<typeof createProtocolHttpServer>>[] = [];
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);
const TEST_MODEL = defineModel({
    defaultThinkingLevel: "off",
    id: "test/model",
    name: "Test model",
    thinkingLevels: ["off"],
});
const TEST_SCRATCH_DIRECTORY = fileURLToPath(
    new URL("../../../../../.context/rig-tests/", import.meta.url),
);

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    server.closeAllConnections();
                }),
        ),
    );
});

describe("plugin HTTP protocol", () => {
    it("serves explicit plugin states and bounded current logs", async () => {
        const plugins = context();
        const server = await createProtocolHttpServer(createTestRootContext(), {
            plugins,
            token: "secret",
        });
        servers.push(server);
        const port = await listen(server);
        await expect(requestJson(port, "/plugins")).resolves.toMatchObject({
            plugins: [{ name: "Clock", status: "stopped" }],
        });
        await expect(requestJson(port, "/plugins/Clock/log")).resolves.toMatchObject({
            log: { name: "Clock", text: "[stdout] tick\n" },
        });
    });

    it("serves authenticated generation-bound icons through a real manager and filesystem", async () => {
        await mkdir(TEST_SCRATCH_DIRECTORY, { recursive: true });
        const root = await mkdtemp(join(TEST_SCRATCH_DIRECTORY, "plugin-http-"));
        try {
            const directory = join(root, "plugins");
            const plugin = join(directory, "clock");
            await mkdir(join(plugin, "skills", "clock"), { recursive: true });
            await Promise.all([
                writeFile(
                    join(plugin, "happy.plugin.json"),
                    `${JSON.stringify({
                        author: "Happy",
                        category: "utilities",
                        description: "A clock.",
                        icon: "icon.png",
                        name: "Clock",
                        skills: "skills",
                    })}\n`,
                ),
                writeFile(join(plugin, "icon.png"), PNG),
                writeFile(
                    join(plugin, "skills", "clock", "SKILL.md"),
                    "---\nname: clock\ndescription: Reads time\n---\n# Clock\n",
                ),
            ]);
            const ctx = createTestRootContext();
            const store = await InMemorySessionStore.open(ctx, {
                modelCatalog: {
                    defaultModelId: TEST_MODEL.id,
                    defaultProviderId: "test",
                    models: [TEST_MODEL],
                    providers: [{ models: [TEST_MODEL], providerId: "test" }],
                },
            });
            try {
                const manager = new PluginManager({
                    daemonLog: new DaemonLog({ path: join(root, "daemon.log"), write: () => {} }),
                    directory,
                    mcpRegistry: new PluginMcpRegistry(),
                    store,
                });
                try {
                    const server = await createProtocolHttpServer(createTestRootContext(), {
                        plugins: manager,
                        token: "secret",
                    });
                    servers.push(server);
                    const port = await listen(server);
                    const listed = (await requestJson(port, "/plugins")) as {
                        plugins: { icon: { generation: string } }[];
                    };
                    const generation = listed.plugins[0]!.icon.generation;
                    const path = `/plugins/clock/generations/${generation}/icon`;
                    expect((await request(port, { path, token: "wrong" })).status).toBe(401);
                    await expect(request(port, { path })).resolves.toMatchObject({
                        body: PNG.toString("utf8"),
                        status: 200,
                    });
                    expect(
                        (
                            await request(port, {
                                path: `/plugins/missing/generations/${generation}/icon`,
                            })
                        ).status,
                    ).toBe(404);

                    await writeFile(join(plugin, "icon.png"), Buffer.from("not a png"));
                    const unavailable = await request(port, { path });
                    expect(unavailable.status).toBe(422);
                    expect(JSON.parse(unavailable.body)).toEqual({
                        error: {
                            code: "icon_unavailable",
                            message: "The plugin icon is unavailable.",
                        },
                    });
                } finally {
                    await manager.close(ctx);
                }
            } finally {
                await store.close(ctx);
            }
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it("authenticates and validates source-folder installation and uninstallation", async () => {
        const plugins = context();
        const server = await createProtocolHttpServer(createTestRootContext(), {
            plugins,
            token: "secret",
        });
        servers.push(server);
        const port = await listen(server);

        expect(
            (
                await request(port, {
                    body: JSON.stringify({
                        requestId: "local-install-1",
                        source: {
                            sourceDirectory: "/plugins/source",
                            type: "local-directory",
                        },
                    }),
                    method: "POST",
                    path: "/plugins",
                    token: "wrong",
                })
            ).status,
        ).toBe(401);
        await expect(
            requestJson(port, "/plugins", {
                requestId: "local-install-1",
                source: {
                    sourceDirectory: "/plugins/source",
                    type: "local-directory",
                },
            }),
        ).resolves.toEqual({
            plugin: {
                classification: "fresh-install",
                description: "A clock.",
                directory: "/managed/clock",
                folder: "clock",
                name: "Clock",
                version: "0.0.0",
            },
        });
        expect(plugins.install).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                requestId: "local-install-1",
                signal: expect.any(AbortSignal),
                sourceDirectory: "/plugins/source",
            }),
        );

        const relative = await request(port, {
            body: JSON.stringify({
                requestId: "local-install-2",
                source: { sourceDirectory: "plugins/source", type: "local-directory" },
            }),
            method: "POST",
            path: "/plugins",
        });
        expect(relative.status).toBe(400);
        expect(JSON.parse(relative.body)).toEqual({
            error: {
                code: "invalid_request",
                message:
                    "Plugin sourceDirectory must be an absolute path on the machine running Rig.",
            },
        });
        const malformed = await request(port, {
            body: JSON.stringify({
                requestId: "local-install-3",
                source: { sourceDirectory: "/plugins/source", type: "local-directory" },
                unexpected: true,
            }),
            method: "POST",
            path: "/plugins",
        });
        expect(malformed.status).toBe(400);
        expect(JSON.parse(malformed.body)).toEqual({
            error: {
                code: "invalid_request",
                message: "Plugin installation settings are invalid.",
            },
        });
        const invalidJson = await request(port, {
            body: "{",
            method: "POST",
            path: "/plugins",
        });
        expect(invalidJson.status).toBe(400);
        expect(JSON.parse(invalidJson.body)).toEqual({
            error: {
                code: "invalid_request",
                message: "Plugin installation settings must be valid JSON.",
            },
        });

        await expect(requestJson(port, "/plugins/Clock", undefined, "DELETE")).resolves.toEqual({
            plugin: {
                dataDirectory: "/data/clock",
                folder: "clock",
                name: "Clock",
            },
        });
        expect(plugins.uninstall).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ name: "Clock", signal: expect.any(AbortSignal) }),
        );
    });

    it("returns stable management failures without replacing them with generic server errors", async () => {
        const plugins = context();
        vi.mocked(plugins.install).mockRejectedValueOnce(
            new Error("The plugin main entry point is missing."),
        );
        vi.mocked(plugins.uninstall).mockRejectedValueOnce(
            new PluginNotFoundError("No plugin named Missing is installed."),
        );
        const server = await createProtocolHttpServer(createTestRootContext(), {
            plugins,
            token: "secret",
        });
        servers.push(server);
        const port = await listen(server);

        const install = await request(port, {
            body: JSON.stringify({
                requestId: "broken-install",
                source: {
                    sourceDirectory: "/plugins/broken",
                    type: "local-directory",
                },
            }),
            method: "POST",
            path: "/plugins",
        });
        expect(install.status).toBe(422);
        expect(JSON.parse(install.body)).toEqual({
            error: { code: "install_failed", message: "The plugin main entry point is missing." },
        });

        const uninstall = await request(port, {
            method: "DELETE",
            path: "/plugins/Missing",
        });
        expect(uninstall.status).toBe(404);
        expect(JSON.parse(uninstall.body)).toEqual({
            error: {
                code: "plugin_not_found",
                message: "No plugin named Missing is installed.",
            },
        });
    });

    it("authenticates discovery and installs the exact discovered package source", async () => {
        const plugins = context();
        const source = {
            catalogId: "a".repeat(64),
            plugin: {
                description: "A clock.",
                displayName: "Clock",
                name: "clock",
                path: "plugins/clock",
                version: "1.2.0",
            },
            ref: "release/1.2.0",
            repository: "happy-dev/plugins",
            revision: "b".repeat(40),
            type: "github" as const,
        };
        vi.mocked(plugins.discoverRepository).mockResolvedValueOnce({
            catalogId: source.catalogId,
            plugins: [
                {
                    availability: "update-available",
                    description: "A clock.",
                    displayName: "Clock",
                    installed: { folder: "clock", name: "Clock", version: "1.0.0" },
                    name: "clock",
                    source,
                    version: "1.2.0",
                },
            ],
            ref: source.ref,
            repository: source.repository,
            revision: source.revision,
        });
        vi.mocked(plugins.installFromGitHub).mockResolvedValueOnce({
            classification: "upgrade",
            description: "A clock.",
            directory: "/managed/clock",
            folder: "clock",
            name: "Clock",
            version: "1.2.0",
        });
        const server = await createProtocolHttpServer(createTestRootContext(), {
            plugins,
            token: "secret",
        });
        servers.push(server);
        const port = await listen(server);

        expect(
            (
                await request(port, {
                    body: JSON.stringify({ repository: "happy-dev/plugins" }),
                    method: "POST",
                    path: "/plugin-catalogs/github",
                    token: "wrong",
                })
            ).status,
        ).toBe(401);
        await expect(
            requestJson(port, "/plugin-catalogs/github", {
                ref: "release/1.2.0",
                repository: "happy-dev/plugins",
            }),
        ).resolves.toMatchObject({
            plugins: [{ availability: "update-available", source }],
            revision: source.revision,
        });
        await expect(
            requestJson(port, "/plugins", { requestId: "install-clock-1", source }),
        ).resolves.toMatchObject({
            plugin: { classification: "upgrade", version: "1.2.0" },
        });
        expect(plugins.installFromGitHub).toHaveBeenCalledWith(
            expect.anything(),
            source,
            expect.objectContaining({
                requestId: "install-clock-1",
                signal: expect.any(AbortSignal),
            }),
        );
    });

    it("authenticates MCP App resources, tools, and namespaced storage and closes stale errors", async () => {
        const plugins = context();
        const server = await createProtocolHttpServer(createTestRootContext(), {
            plugins,
            token: "secret",
        });
        servers.push(server);
        const port = await listen(server);
        const base = "/plugin-apps/usage%3Aoverview/generations/current";

        expect(
            (
                await request(port, {
                    body: JSON.stringify({ uri: "ui://usage/overview/index.html" }),
                    method: "POST",
                    path: `${base}/resources/read`,
                    token: "wrong",
                })
            ).status,
        ).toBe(401);
        await expect(
            requestJson(port, `${base}/resources/read`, {
                uri: "ui://usage/overview/index.html",
            }),
        ).resolves.toEqual({
            contents: [
                {
                    mimeType: "text/html;profile=mcp-app",
                    text: "<h1>Usage</h1>",
                    uri: "ui://usage/overview/index.html",
                },
            ],
        });
        await expect(
            requestJson(port, `${base}/tools/call`, {
                arguments: { scope: "weekly" },
                name: "read",
                server: "Usage",
            }),
        ).resolves.toMatchObject({ result: { content: [{ text: "read weekly" }] } });
        await expect(
            requestJson(port, `${base}/extensions/io.slopus.happy/storage/set`, {
                key: "layout",
                value: { compact: true },
            }),
        ).resolves.toEqual({});
        expect(
            (
                await request(port, {
                    body: JSON.stringify({ uri: "ui://usage/overview/index.html" }),
                    method: "POST",
                    path: "/plugin-apps/usage%3Aoverview/generations/old/resources/read",
                })
            ).status,
        ).toBe(409);

        const iconBase = `/plugins/clock/generations/${"a".repeat(64)}/icon`;
        expect((await request(port, { path: iconBase, token: "wrong" })).status).toBe(401);
        await expect(request(port, { path: iconBase })).resolves.toMatchObject({
            body: "catalog-icon",
            status: 200,
        });
        expect(
            (
                await request(port, {
                    path: `/plugins/clock/generations/${"b".repeat(64)}/icon`,
                })
            ).status,
        ).toBe(409);
    });
});

function context(): Pick<
    PluginContext,
    | "callAppTool"
    | "discoverRepository"
    | "install"
    | "installFromGitHub"
    | "list"
    | "readAppResource"
    | "readIcon"
    | "readLog"
    | "storageDelete"
    | "storageGet"
    | "storageList"
    | "storageSet"
    | "uninstall"
> {
    return {
        async callAppTool(_ctx, _id, generation, _server, tool, input) {
            if (generation === "old")
                throw new PluginAppError("stale_generation", "stale generation");
            return {
                content: [
                    {
                        text: `${tool} ${(input as { scope?: string }).scope ?? ""}`.trim(),
                        type: "text",
                    },
                ],
            };
        },
        discoverRepository: vi.fn(async () => {
            throw new Error("Unexpected plugin catalog discovery.");
        }),
        install: vi.fn(async () => ({
            classification: "fresh-install" as const,
            description: "A clock.",
            directory: "/managed/clock",
            folder: "clock",
            name: "Clock",
            version: "0.0.0",
        })),
        installFromGitHub: vi.fn(async () => {
            throw new Error("Unexpected GitHub plugin installation.");
        }),
        async list() {
            return {
                failures: [],
                plugins: [
                    {
                        apps: [],
                        author: "Happy",
                        category: "utilities",
                        dataDirectory: "/data/clock",
                        description: "A clock.",
                        directory: "/plugins/clock",
                        folder: "clock",
                        icon: {
                            generation: "a".repeat(64),
                            mediaType: "image/png",
                            size: 12,
                        },
                        logAvailable: true,
                        name: "Clock",
                        status: "stopped",
                        version: "0.0.0",
                    },
                ],
                version: "01900000-0000-7000-8000-000000000001",
            };
        },
        readAppResource(_id, generation, uri) {
            if (generation === "old")
                throw new PluginAppError("stale_generation", "stale generation");
            return { mimeType: "text/html;profile=mcp-app", text: "<h1>Usage</h1>", uri };
        },
        async readIcon(_ctx, _pluginId, generation) {
            if (generation !== "a".repeat(64)) {
                throw new PluginIconError("stale_generation", "stale generation");
            }
            const body = Buffer.from("catalog-icon");
            return {
                body,
                generation,
                mediaType: "image/png",
                size: body.byteLength,
            };
        },
        async readLog(_ctx, name) {
            return {
                folder: "clock",
                name,
                source: "current_run",
                status: "stopped",
                text: "[stdout] tick\n",
                truncated: false,
                updatedAt: 42,
            };
        },
        async storageDelete() {},
        async storageGet() {
            return undefined;
        },
        async storageList() {
            return [];
        },
        async storageSet() {},
        uninstall: vi.fn(async () => ({
            dataDirectory: "/data/clock",
            folder: "clock",
            name: "Clock",
        })),
    };
}

async function listen(
    server: Awaited<ReturnType<typeof createProtocolHttpServer>>,
): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    return address.port;
}

function requestJson(
    port: number,
    path: string,
    body?: unknown,
    method?: string,
): Promise<unknown> {
    return request(port, {
        ...(body === undefined ? {} : { body: JSON.stringify(body), method: method ?? "POST" }),
        ...(method === undefined ? {} : { method }),
        path,
    }).then((response) => JSON.parse(response.body) as unknown);
}

function request(
    port: number,
    options: { body?: string; method?: string; path: string; token?: string },
): Promise<{ body: string; status: number }> {
    return new Promise((resolve, reject) => {
        const request = requestHttp(
            {
                headers: {
                    authorization: `Bearer ${options.token ?? "secret"}`,
                    ...(options.body === undefined
                        ? {}
                        : {
                              "content-length": String(Buffer.byteLength(options.body)),
                              "content-type": "application/json",
                          }),
                },
                host: "127.0.0.1",
                method: options.method ?? "GET",
                path: options.path,
                port,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        status: response.statusCode ?? 500,
                    }),
                );
            },
        );
        request.once("error", reject);
        request.end(options.body);
    });
}
