import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import { McpModule } from "../../sources/mcp/index.js";
import { PresenceModule } from "../../sources/presence/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { UserInputModule } from "../../sources/userInput/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const fixture = fileURLToPath(new URL("./fixtures/stdioServer.mjs", import.meta.url));
const roots: string[] = [];
const ctx = createRootContext().named("mcp-production-test");

afterEach(async () => {
    await Promise.all(
        roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
    );
});

describe("McpModule production discovery", () => {
    it.runIf(process.platform === "linux")(
        "names the resolved Linux user catalog in configuration tools",
        async () => {
            const root = await temporaryRoot();
            const config = await ConfigModule.load(join(root, ".happy"), {
                environment: { HOME: root },
            });
            const module = mcpModule(
                config,
                new UserInputModule(new PresenceModule(config)),
                new WorkspaceEvents().module,
            );
            try {
                const tools = await (await resolveModuleHooks(ctx, module)).tools!(ctx, scope());
                const configure = tools.find((tool) => tool.name === "configure_mcp_server")!;
                const reload = tools.find((tool) => tool.name === "reload_mcp_servers")!;
                const expected = "~/happy/config/mcp.toml";
                for (const text of [
                    configure.description,
                    configure.parameters?.properties.scope.description,
                    configure.describeAutoPermissionAction?.(
                        { action: "remove", name: "docs" } as never,
                        ctx,
                    ),
                    reload.description,
                    reload.parameters?.properties.global.description,
                    reload.describeAutoPermissionAction?.({ global: true } as never, ctx),
                ]) {
                    expect(text).toContain(expected);
                    expect(text).not.toContain("~/Happy/Config");
                }
            } finally {
                await module.close();
            }
        },
    );

    it("discovers and calls a Happy-owned stdio server", async () => {
        const { module } = await configuredModule({ docs: stdio("docs") });
        try {
            const hooks = await resolveModuleHooks(ctx, module);
            await ready(module, "agent-a", ["docs"]);
            const tools = await hooks.tools!(ctx, scope());
            expect(tools.map((tool) => tool.name)).toContain("mcp__docs__echo");
            expect(tools.map((tool) => tool.name)).toContain("reload_mcp_servers");
            expect(tools.map((tool) => tool.name)).toContain("configure_mcp_server");
            expect(
                tools
                    .filter((tool) =>
                        ["configure_mcp_server", "reload_mcp_servers"].includes(tool.name),
                    )
                    .every(
                        (tool) =>
                            (tool.parameters as { readonly type?: unknown }).type === "object",
                    ),
            ).toBe(true);

            await expect(
                module.callTool(ctx, "agent-a", {
                    server: "docs",
                    name: "echo",
                    arguments: { text: "working" },
                }),
            ).resolves.toMatchObject({
                content: [{ type: "text", text: "docs:working" }],
            });
            await expect(module.listResources(ctx, "agent-a", "docs")).resolves.toMatchObject([
                { uri: "fixture://docs" },
            ]);
            await expect(
                module.getPrompt(ctx, "agent-a", { server: "docs", name: "hello" }),
            ).resolves.toMatchObject({
                messages: [{ role: "user", content: { type: "text", text: "hello from docs" } }],
            });
        } finally {
            await module.close();
        }
    });

    it("never makes a turn or an agent's restoration wait for a server to start", async () => {
        const root = await temporaryRoot();
        const userGate = gatedStdio(root, "user-start", "user");
        const folderGate = gatedStdio(root, "folder-start", "folder");
        const workspace = join(root, "workspace-slow");
        await write(root, "workspace-slow/mcp.toml", serverToml("folder", folderGate.server));
        const { module } = await configuredModule({ user: userGate.server }, root);
        const agents = new McpAgents({ agent: workspace });
        try {
            const hooks = await resolveModuleHooks(ctx, module, agents.ref);
            await waitForFile(userGate.marker);
            // Restoration only starts attaching the folder, while the user-wide server still hangs.
            expect(
                hooks.agentRestored?.(ctx, systemScope(agents), lifecycleAgent("agent")),
            ).toBeUndefined();
            await waitForFile(folderGate.marker);

            const started = Date.now();
            const names = (await hooks.tools!(ctx, scope("agent"))).map((tool) => tool.name);
            expect(Date.now() - started).toBeLessThan(1_000);
            expect(names).toContain("list_mcp_servers");
            expect(names.filter((name) => name.startsWith("mcp__"))).toEqual([]);
            await expect(module.listServerPage(ctx, "agent")).resolves.toMatchObject({
                servers: [
                    { name: "folder", status: "connecting", toolCount: 0 },
                    { name: "user", status: "connecting", toolCount: 0 },
                ],
            });
            await expect(echo(module, "agent", "user", "early")).rejects.toThrow(
                'MCP server "user" is still connecting.',
            );

            await writeFile(userGate.release, "release", "utf8");
            await writeFile(folderGate.release, "release", "utf8");
            await expect
                .poll(
                    async () =>
                        (await hooks.tools!(ctx, scope("agent")))
                            .map((tool) => tool.name)
                            .filter((name) => name.startsWith("mcp__")),
                    { timeout: 10_000 },
                )
                .toEqual(["mcp__folder__echo", "mcp__user__echo"]);
            await expect(echo(module, "agent", "folder", "later")).resolves.toBe("folder:later");
        } finally {
            await module.close();
        }
    });

    it("lists a server's tools once until it reports a change or is reloaded", async () => {
        const { module } = await configuredModule({ docs: stdio("docs") });
        try {
            const hooks = await resolveModuleHooks(ctx, module);
            await ready(module, "agent-a", ["docs"]);
            await Promise.all(
                ["agent-a", "agent-a", "agent-b", "agent-b"].map(
                    async (agentId) => await hooks.tools!(ctx, scope(agentId)),
                ),
            );
            for (let request = 0; request < 10; request += 1) {
                await hooks.tools!(ctx, scope(request % 2 === 0 ? "agent-a" : "agent-b"));
            }
            await module.listServerPage(ctx, "agent-a");
            await module.listTools(ctx, "agent-b", "docs");
            await expect(echo(module, "agent-a", "docs", "__tool_listings__")).resolves.toBe("1");

            await expect(echo(module, "agent-a", "docs", "__add_tool__")).resolves.toBe("added");
            await expect
                .poll(async () =>
                    (await hooks.tools!(ctx, scope("agent-b"))).map((tool) => tool.name),
                )
                .toContain("mcp__docs__added");
            await hooks.tools!(ctx, scope("agent-a"));
            await expect(echo(module, "agent-a", "docs", "__tool_listings__")).resolves.toBe("2");

            await module.reload(ctx);
            await hooks.tools!(ctx, scope("agent-a"));
            await hooks.tools!(ctx, scope("agent-b"));
            await expect(echo(module, "agent-a", "docs", "__tool_listings__")).resolves.toBe("3");
        } finally {
            await module.close();
        }
    });

    it("keeps healthy tools when one server tool exceeds the JSON depth bound", async () => {
        const { module } = await configuredModule({ mixed: stdio("mixed-tools") });
        try {
            const hooks = await resolveModuleHooks(ctx, module);
            await ready(module, "agent-a", ["mixed"]);
            const tools = await hooks.tools!(ctx, scope());

            expect(tools.map((tool) => tool.name)).toEqual(
                expect.arrayContaining(["mcp__mixed__echo", "mcp__mixed__nested"]),
            );
            expect(tools.map((tool) => tool.name)).not.toContain("mcp__mixed__too_deep");
            await expect(module.listServerPage(ctx, "agent-a")).resolves.toMatchObject({
                servers: [{ name: "mixed", status: "connected", toolCount: 2 }],
            });
            await expect(echo(module, "agent-a", "mixed", "still working")).resolves.toBe(
                "mixed-tools:still working",
            );
        } finally {
            await module.close();
        }
    });

    it("reloads edits online and isolates failed servers", async () => {
        const { config, module } = await configuredModule({ first: stdio("first") });
        try {
            const initialTools = await (await resolveModuleHooks(ctx, module)).tools!(ctx, scope());
            const configure = initialTools.find((tool) => tool.name === "configure_mcp_server");
            const reload = initialTools.find((tool) => tool.name === "reload_mcp_servers");
            if (configure === undefined || reload === undefined) {
                throw new Error("MCP configuration tools were not installed.");
            }
            await configure.execute(
                ctx,
                { action: "set", name: "second", server: stdio("second") },
                undefined as never,
            );
            await module.configureServer(ctx, "broken", {
                transport: "stdio",
                command: "/definitely/missing/happy-mcp-server",
            });
            await reload.execute(ctx, { global: true }, undefined as never);
            const page = await module.listServerPage(ctx, "agent-a");
            expect(page.servers).toMatchObject([
                { name: "broken", status: "failed", toolCount: 0 },
                { name: "first", status: "connected", toolCount: 1 },
                { name: "second", status: "connected", toolCount: 1 },
            ]);
            const hooks = await resolveModuleHooks(ctx, module);
            const names = (await hooks.tools!(ctx, scope())).map((tool) => tool.name);
            expect(names).toContain("mcp__first__echo");
            expect(names).toContain("mcp__second__echo");
            expect(Object.keys(config.mcpServers)).toEqual(["first", "second", "broken"]);
        } finally {
            await module.close();
        }
    });

    it("ignores MCP entries in happy.toml and reads only mcp.toml", async () => {
        const root = await temporaryRoot();
        await write(
            root,
            join(process.platform === "darwin" ? "Happy/Config" : "happy/config", "happy.toml"),
            providerMcp("ignored", "ignored"),
        );
        await write(
            root,
            join(process.platform === "darwin" ? "Happy/Config" : "happy/config", "mcp.toml"),
            providerMcp("owned", "owned"),
        );
        const config = await ConfigModule.load(join(root, ".happy"));
        expect(Object.keys(config.configuration.values.mcpServers)).toEqual(["owned"]);
        expect(Object.keys(await config.readMcpServers())).toEqual(["owned"]);
    });

    it("shares matching workspace servers, reconciles reloads, and releases lifecycle demand", async () => {
        const root = await temporaryRoot();
        const firstWorkspace = join(root, "workspace-a");
        const secondWorkspace = join(root, "workspace-b");
        await write(root, "workspace-a/mcp.toml", providerMcp("shared", "shared"));
        await write(
            root,
            "workspace-b/mcp.toml",
            `${providerMcp("shared", "shared")}enabled_tools = ["echo"]\n`,
        );
        const config = await ConfigModule.load(join(root, ".happy"));
        const presence = new PresenceModule(config);
        const workspaceEvents = new WorkspaceEvents();
        const module = mcpModule(config, new UserInputModule(presence), workspaceEvents.module);
        const agents = new McpAgents({
            "agent-a": firstWorkspace,
            "agent-b": secondWorkspace,
        });
        try {
            const hooks = await resolveModuleHooks(ctx, module, agents.ref);
            await hooks.agentCreated?.(ctx, systemScope(agents), lifecycleAgent("agent-a"));
            await hooks.agentRestored?.(ctx, systemScope(agents), lifecycleAgent("agent-b"));
            await ready(module, "agent-a", ["shared"]);
            await ready(module, "agent-b", ["shared"]);

            expect(await processId(module, "agent-a", "shared")).toBe(
                await processId(module, "agent-b", "shared"),
            );

            const beforeReload = await processId(module, "agent-a", "shared");
            const tools = await hooks.tools!(ctx, scope("agent-a"));
            const reload = tools.find((tool) => tool.name === "reload_mcp_servers");
            if (reload === undefined) throw new Error("The MCP reload tool was not installed.");
            await reload.execute(ctx, {}, undefined as never);
            expect(await processId(module, "agent-a", "shared")).toBe(beforeReload);

            await write(
                root,
                "workspace-a/mcp.toml",
                `${providerMcp("shared", "shared")}\n${providerMcp("local", "local")}`,
            );
            await reload.execute(ctx, {}, undefined as never);
            expect(
                (await module.listServerPage(ctx, "agent-a")).servers.map(({ name }) => name),
            ).toEqual(["local", "shared"]);
            expect(
                (await module.listServerPage(ctx, "agent-b")).servers.map(({ name }) => name),
            ).toEqual(["shared"]);

            await write(
                root,
                join(process.platform === "darwin" ? "Happy/Config" : "happy/config", "mcp.toml"),
                `${providerMcp("global", "global")}\n${providerMcp("shared", "global-shared")}`,
            );
            await reload.execute(ctx, { global: true }, undefined as never);
            expect(
                (await module.listServerPage(ctx, "agent-b")).servers.map(({ name }) => name),
            ).toEqual(["global", "shared"]);
            await expect(echo(module, "agent-b", "shared", "override")).resolves.toBe(
                "global-shared:override",
            );

            await write(
                root,
                join(process.platform === "darwin" ? "Happy/Config" : "happy/config", "mcp.toml"),
                providerMcp("global", "global"),
            );
            await reload.execute(ctx, { global: true }, undefined as never);
            await expect(echo(module, "agent-b", "shared", "workspace")).resolves.toBe(
                "shared:workspace",
            );
            const sharedAfterGlobalReconcile = await processId(module, "agent-b", "shared");

            await hooks.agentArchived?.(ctx, systemScope(agents), lifecycleAgent("agent-a"));
            await expect(processId(module, "agent-b", "shared")).resolves.toBe(
                sharedAfterGlobalReconcile,
            );
            await hooks.agentArchived?.(ctx, systemScope(agents), lifecycleAgent("agent-b"));
            await expect(processId(module, "agent-b", "shared")).rejects.toThrow(
                'MCP server "shared" is not connected.',
            );

            await hooks.agentCreated?.(ctx, systemScope(agents), lifecycleAgent("agent-b"));
            await ready(module, "agent-b", ["global", "shared"]);
            await expect(processId(module, "agent-b", "shared")).resolves.toMatch(/^\d+$/u);
            await workspaceEvents.archive(secondWorkspace);
            await expect(processId(module, "agent-b", "shared")).rejects.toThrow(
                'MCP server "shared" is not connected.',
            );

            await workspaceEvents.create(secondWorkspace);
            await hooks.agentCreated?.(ctx, systemScope(agents), lifecycleAgent("agent-b"));
            await ready(module, "agent-b", ["global", "shared"]);
            await expect(processId(module, "agent-b", "shared")).resolves.toMatch(/^\d+$/u);
        } finally {
            await module.close();
        }
    });

    it("configures servers in the calling agent's folder catalog only", async () => {
        const root = await temporaryRoot();
        const botFolder = join(root, "Happy/Bots/scout");
        const otherFolder = join(root, "Happy/Bots/other");
        const userWide = join(
            process.platform === "darwin" ? "Happy/Config" : "happy/config",
            "mcp.toml",
        );
        await write(root, userWide, providerMcp("global", "global"));
        await mkdir(botFolder, { recursive: true });
        await mkdir(otherFolder, { recursive: true });
        const config = await ConfigModule.load(join(root, ".happy"));
        const presence = new PresenceModule(config);
        const module = mcpModule(
            config,
            new UserInputModule(presence),
            new WorkspaceEvents().module,
        );
        const agents = new McpAgents({
            "agent-a": botFolder,
            "agent-b": botFolder,
            "agent-c": otherFolder,
        });
        try {
            const hooks = await resolveModuleHooks(ctx, module, agents.ref);
            for (const id of ["agent-a", "agent-b", "agent-c"]) {
                await hooks.agentCreated?.(ctx, systemScope(agents), lifecycleAgent(id));
            }
            await expect.poll(() => module.workspaceMcpConfigLocation("agent-a")).toBeDefined();
            await ready(module, "agent-a", ["global"]);
            const configure = (await hooks.tools!(ctx, scope("agent-a"))).find(
                (tool) => tool.name === "configure_mcp_server",
            );
            if (configure === undefined)
                throw new Error("The MCP configure tool was not installed.");
            const folderSet = {
                action: "set",
                name: "folder_tools",
                scope: "folder",
                server: stdio("folder"),
            } as const;
            expect(configure.describeAutoPermissionAction?.(folderSet as never, ctx)).toContain(
                join(botFolder, "mcp.toml"),
            );

            await configure.execute(ctx, folderSet, undefined as never);
            await expect(readFile(join(botFolder, "mcp.toml"), "utf8")).resolves.toContain(
                "[mcp_servers.folder_tools]",
            );
            await expect(readFile(join(root, userWide), "utf8")).resolves.not.toContain(
                "folder_tools",
            );
            // Every agent in the folder shares it at once; another folder never sees it.
            await expect(echo(module, "agent-b", "folder_tools", "shared")).resolves.toBe(
                "folder:shared",
            );
            expect(
                (await module.listServerPage(ctx, "agent-c")).servers.map(({ name }) => name),
            ).toEqual(["global"]);

            // A folder server the user-wide catalog would shadow is refused rather than ignored.
            await expect(
                configure.execute(
                    ctx,
                    { ...folderSet, name: "global", server: stdio("shadowed") },
                    undefined as never,
                ),
            ).rejects.toThrow('already has a server named "global"');
            await expect(readFile(join(botFolder, "mcp.toml"), "utf8")).resolves.not.toContain(
                "global",
            );

            await configure.execute(
                ctx,
                { action: "remove", name: "folder_tools", scope: "folder" },
                undefined as never,
            );
            expect(
                (await module.listServerPage(ctx, "agent-b")).servers.map(({ name }) => name),
            ).toEqual(["global"]);
        } finally {
            await module.close();
        }
    });

    it("isolates malformed workspace catalogs and retries them after repair", async () => {
        const root = await temporaryRoot();
        const healthyWorkspace = join(root, "workspace-healthy");
        const brokenWorkspace = join(root, "workspace-broken");
        await write(root, "workspace-healthy/mcp.toml", providerMcp("healthy", "healthy"));
        await write(root, "workspace-broken/mcp.toml", "[settings]\ninvalid = true\n");
        const config = await ConfigModule.load(join(root, ".happy"));
        const presence = new PresenceModule(config);
        const module = mcpModule(
            config,
            new UserInputModule(presence),
            new WorkspaceEvents().module,
        );
        const agents = new McpAgents({
            healthy: healthyWorkspace,
            broken: brokenWorkspace,
        });
        try {
            const hooks = await resolveModuleHooks(ctx, module, agents.ref);
            await hooks.agentCreated?.(ctx, systemScope(agents), lifecycleAgent("healthy"));
            expect(() =>
                hooks.agentRestored?.(ctx, systemScope(agents), lifecycleAgent("broken")),
            ).not.toThrow();
            await ready(module, "healthy", ["healthy"]);

            await expect(echo(module, "healthy", "healthy", "before")).resolves.toBe(
                "healthy:before",
            );
            await write(root, "workspace-healthy/mcp.toml", "[settings]\ninvalid = true\n");
            await expect(module.configureServer(ctx, "global", stdio("global"))).resolves.toBe(
                undefined,
            );
            await expect(echo(module, "broken", "global", "available")).resolves.toBe(
                "global:available",
            );
            await expect(echo(module, "healthy", "healthy", "after")).resolves.toBe(
                "healthy:after",
            );

            await write(root, "workspace-broken/mcp.toml", providerMcp("repaired", "repaired"));
            // A turn starts the never-loaded catalog again; its tools reach a later turn.
            await expect
                .poll(
                    async () => (await hooks.tools!(ctx, scope("broken"))).map((tool) => tool.name),
                    { timeout: 10_000 },
                )
                .toContain("mcp__repaired__echo");
            await expect(echo(module, "broken", "repaired", "working")).resolves.toBe(
                "repaired:working",
            );
        } finally {
            await module.close();
        }
    });

    it("does not let a queued workspace reload resurrect an archived catalog", async () => {
        const root = await temporaryRoot();
        const workspace = join(root, "workspace-race");
        await write(root, "workspace-race/mcp.toml", providerMcp("server", "initial"));
        const config = await ConfigModule.load(join(root, ".happy"));
        const presence = new PresenceModule(config);
        const workspaceEvents = new WorkspaceEvents();
        const module = mcpModule(config, new UserInputModule(presence), workspaceEvents.module);
        const agents = new McpAgents({ agent: workspace });
        const gate = gatedStdio(root, "reload-race", "replacement");
        try {
            const hooks = await resolveModuleHooks(ctx, module, agents.ref);
            await hooks.agentCreated?.(ctx, systemScope(agents), lifecycleAgent("agent"));
            await ready(module, "agent", ["server"]);
            await write(root, "workspace-race/mcp.toml", serverToml("server", gate.server));

            const blockingReload = module.reloadWorkspace(ctx, "agent");
            await waitForFile(gate.marker);
            const archive = workspaceEvents.archive(workspace);
            const staleReload = module.reloadWorkspace(ctx, "agent").then(
                () => undefined,
                (error: unknown) => error,
            );
            await writeFile(gate.release, "release", "utf8");
            await Promise.all([blockingReload, archive]);

            expect(await staleReload).toBeInstanceOf(Error);
            await expect(processId(module, "agent", "server")).rejects.toThrow(
                'MCP server "server" is not connected.',
            );
        } finally {
            await module.close();
        }
    });

    it("retries a server that timed out at startup without a manual reload", async () => {
        const root = await temporaryRoot();
        const gate = gatedStdio(root, "slow-start", "slow");
        const { module } = await configuredModule(
            { slow: { ...gate.server, startupTimeoutMs: 300 } },
            root,
        );
        try {
            const hooks = await resolveModuleHooks(ctx, module);
            const before = (await hooks.tools!(ctx, scope())).map((tool) => tool.name);
            expect(before).not.toContain("mcp__slow__echo");
            await expect
                .poll(async () => (await module.listServerPage(ctx, "agent-a")).servers)
                .toMatchObject([{ name: "slow", status: "failed", toolCount: 0 }]);

            await writeFile(gate.release, "release", "utf8");

            await expect
                .poll(async () => (await module.listServerPage(ctx, "agent-a")).servers, {
                    timeout: 10_000,
                })
                .toMatchObject([{ name: "slow", status: "connected", toolCount: 1 }]);
            const after = (await hooks.tools!(ctx, scope())).map((tool) => tool.name);
            expect(after).toContain("mcp__slow__echo");
            await expect(echo(module, "agent-a", "slow", "back")).resolves.toBe("slow:back");
        } finally {
            await module.close();
        }
    });

    it("restarts a server whose process stopped", async () => {
        const { module } = await configuredModule({ docs: stdio("docs") });
        try {
            await resolveModuleHooks(ctx, module);
            await ready(module, "agent-a", ["docs"]);
            const first = await processId(module, "agent-a", "docs");

            process.kill(Number(first), "SIGKILL");

            await expect
                .poll(
                    async () => await processId(module, "agent-a", "docs").catch(() => undefined),
                    { timeout: 10_000 },
                )
                .toMatch(/^\d+$/u);
            expect(await processId(module, "agent-a", "docs")).not.toBe(first);
        } finally {
            await module.close();
        }
    });

    it("waits for an in-flight reconcile before closing every connection", async () => {
        const { module, root } = await configuredModule({ initial: stdio("initial") });
        const gate = gatedStdio(root, "close-race", "replacement");
        await resolveModuleHooks(ctx, module);
        await write(
            root,
            join(process.platform === "darwin" ? "Happy/Config" : "happy/config", "mcp.toml"),
            serverToml("replacement", gate.server),
        );

        const reload = module.reload(ctx);
        await waitForFile(gate.marker);
        const close = module.close();
        await writeFile(gate.release, "release", "utf8");
        await Promise.all([reload, close]);

        await expect(module.listServerPage(ctx, "agent-a")).resolves.toMatchObject({ servers: [] });
        await expect(processId(module, "agent-a", "replacement")).rejects.toThrow(
            'MCP server "replacement" is not connected.',
        );
    });
});

/**
 * Wait until an agent sees exactly these servers, none of them still connecting. Starting the
 * module, creating an agent, and a turn only start servers; nothing waits for them.
 */
async function ready(module: McpModule, agentId: string, names: readonly string[]) {
    await expect
        .poll(
            async () =>
                (await module.listServerPage(ctx, agentId)).servers.map(
                    (server) =>
                        `${server.name}:${server.status === "connecting" ? "connecting" : "settled"}`,
                ),
            { timeout: 10_000 },
        )
        .toEqual(names.map((name) => `${name}:settled`));
}

async function configuredModule(servers: Record<string, ReturnType<typeof stdio>>, root?: string) {
    root ??= await temporaryRoot();
    await write(
        root,
        join(process.platform === "darwin" ? "Happy/Config" : "happy/config", "mcp.toml"),
        Object.entries(servers)
            .map(([name, server]) => serverToml(name, server))
            .join("\n"),
    );
    const config = await ConfigModule.load(join(root, ".happy"));
    const presence = new PresenceModule(config);
    return {
        config,
        root,
        module: mcpModule(config, new UserInputModule(presence), new WorkspaceEvents().module),
    };
}

/** The module as the runtime builds it, on a configuration with no runners. */
function mcpModule(
    config: ConfigModule,
    userInput: UserInputModule,
    workspaces: ConstructorParameters<typeof McpModule>[2],
): McpModule {
    const runners = new RunnersModule(config);
    return new McpModule(
        config,
        userInput,
        workspaces,
        runners,
        new ComputeModule(config, new SecretsModule(), runners),
    );
}

function stdio(label: string) {
    return {
        transport: "stdio" as const,
        command: process.execPath,
        args: [fixture, label],
        startupTimeoutMs: 10_000,
        toolTimeoutMs: 10_000,
    };
}

function gatedStdio(root: string, name: string, label: string) {
    const marker = join(root, `${name}.started`);
    const release = join(root, `${name}.release`);
    return {
        marker,
        release,
        server: {
            ...stdio(label),
            args: [fixture, label, marker, release],
        },
    };
}

function providerMcp(name: string, label: string): string {
    return serverToml(name, stdio(label));
}

function serverToml(name: string, server: ReturnType<typeof stdio>): string {
    return [
        `[mcp_servers.${JSON.stringify(name)}]`,
        `command = ${JSON.stringify(server.command)}`,
        `args = ${JSON.stringify(server.args)}`,
        `startup_timeout_sec = ${String(server.startupTimeoutMs / 1_000)}`,
        `tool_timeout_sec = ${String(server.toolTimeoutMs / 1_000)}`,
        "",
    ].join("\n");
}

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-mcp-test-"));
    roots.push(root);
    return root;
}

async function write(root: string, relative: string, contents: string): Promise<void> {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
}

async function waitForFile(path: string): Promise<void> {
    await expect
        .poll(async () => {
            try {
                await access(path);
                return true;
            } catch {
                return false;
            }
        })
        .toBe(true);
}

function scope(agentId = "agent-a") {
    return { agent: { id: agentId, permissionMode: "auto" } } as never;
}

function lifecycleAgent(id: string) {
    return { id, metadata: undefined };
}

function systemScope(agents: McpAgents) {
    return { agents: agents.ref, sharedKV: {} } as never;
}

async function processId(module: McpModule, agentId: string, server: string): Promise<string> {
    return await echo(module, agentId, server, "__process_id__");
}

async function echo(
    module: McpModule,
    agentId: string,
    server: string,
    text: string,
): Promise<string> {
    const result = await module.callTool(ctx, agentId, {
        server,
        name: "echo",
        arguments: { text },
    });
    const first = result.content?.[0];
    if (first?.type !== "text") throw new Error("The MCP fixture did not return a process ID.");
    return first.text;
}

class McpAgents {
    readonly #directories: Readonly<Record<string, string>>;

    constructor(directories: Readonly<Record<string, string>>) {
        this.#directories = directories;
    }

    readonly ref = {
        config: async (_ctx: unknown, agentId: string) => {
            const workingDirectory = this.#directories[agentId];
            return workingDirectory === undefined
                ? undefined
                : {
                      environment: {
                          osVersion: "test",
                          platform: process.platform,
                          shell: "",
                          workingDirectory,
                      },
                  };
        },
    } as never;
}

class WorkspaceEvents {
    #listener: ((ctx: Context, event: never) => Promise<void> | void) | undefined;

    readonly module = {
        onEvent: (listener: (ctx: Context, event: never) => Promise<void> | void) => {
            this.#listener = listener;
            return () => undefined;
        },
    } as never;

    async archive(path: string): Promise<void> {
        await this.#listener?.(ctx, {
            type: "workspace_updated",
            change: "begin_archive",
            workspace: { path },
        } as never);
    }

    async create(path: string): Promise<void> {
        await this.#listener?.(ctx, {
            type: "workspace_created",
            workspace: { path },
        } as never);
    }
}
