import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";
import { McpModule } from "../../sources/mcp/index.js";
import { PresenceModule } from "../../sources/presence/index.js";
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
    it("discovers and calls a Happy-owned stdio server", async () => {
        const { module } = await configuredModule({ docs: stdio("docs") });
        try {
            const hooks = await resolveModuleHooks(ctx, module);
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
        await write(root, "Happy/Config/happy.toml", providerMcp("ignored", "ignored"));
        await write(root, "Happy/Config/mcp.toml", providerMcp("owned", "owned"));
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
        const module = new McpModule(config, new UserInputModule(presence), workspaceEvents.module);
        const agents = new McpAgents({
            "agent-a": firstWorkspace,
            "agent-b": secondWorkspace,
        });
        try {
            const hooks = await resolveModuleHooks(ctx, module, agents.ref);
            await hooks.agentCreated?.(ctx, systemScope(agents), lifecycleAgent("agent-a"));
            await hooks.agentRestored?.(ctx, systemScope(agents), lifecycleAgent("agent-b"));

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
                "Happy/Config/mcp.toml",
                `${providerMcp("global", "global")}\n${providerMcp("shared", "global-shared")}`,
            );
            await reload.execute(ctx, { global: true }, undefined as never);
            expect(
                (await module.listServerPage(ctx, "agent-b")).servers.map(({ name }) => name),
            ).toEqual(["global", "shared"]);
            await expect(echo(module, "agent-b", "shared", "override")).resolves.toBe(
                "global-shared:override",
            );

            await write(root, "Happy/Config/mcp.toml", providerMcp("global", "global"));
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
            await expect(processId(module, "agent-b", "shared")).resolves.toMatch(/^\d+$/u);
            await workspaceEvents.archive(secondWorkspace);
            await expect(processId(module, "agent-b", "shared")).rejects.toThrow(
                'MCP server "shared" is not connected.',
            );

            await workspaceEvents.create(secondWorkspace);
            await hooks.agentCreated?.(ctx, systemScope(agents), lifecycleAgent("agent-b"));
            await expect(processId(module, "agent-b", "shared")).resolves.toMatch(/^\d+$/u);
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
        const module = new McpModule(
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
            await expect(
                hooks.agentRestored?.(ctx, systemScope(agents), lifecycleAgent("broken")),
            ).resolves.toBeUndefined();

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
            const tools = await hooks.tools!(ctx, scope("broken"));
            expect(tools.map((tool) => tool.name)).toContain("mcp__repaired__echo");
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
        const module = new McpModule(config, new UserInputModule(presence), workspaceEvents.module);
        const agents = new McpAgents({ agent: workspace });
        const gate = gatedStdio(root, "reload-race", "replacement");
        try {
            const hooks = await resolveModuleHooks(ctx, module, agents.ref);
            await hooks.agentCreated?.(ctx, systemScope(agents), lifecycleAgent("agent"));
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

    it("waits for an in-flight reconcile before closing every connection", async () => {
        const { module, root } = await configuredModule({ initial: stdio("initial") });
        const gate = gatedStdio(root, "close-race", "replacement");
        await resolveModuleHooks(ctx, module);
        await write(root, "Happy/Config/mcp.toml", serverToml("replacement", gate.server));

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

async function configuredModule(servers: Record<string, ReturnType<typeof stdio>>) {
    const root = await temporaryRoot();
    await write(
        root,
        "Happy/Config/mcp.toml",
        Object.entries(servers)
            .map(([name, server]) => serverToml(name, server))
            .join("\n"),
    );
    const config = await ConfigModule.load(join(root, ".happy"));
    const presence = new PresenceModule(config);
    return {
        config,
        root,
        module: new McpModule(config, new UserInputModule(presence), new WorkspaceEvents().module),
    };
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
