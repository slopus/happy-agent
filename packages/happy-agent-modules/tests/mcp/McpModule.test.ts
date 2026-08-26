import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRootContext } from "@steve.kite/stdlib";
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
            await reload.execute(ctx, {}, undefined as never);
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
    return { config, module: new McpModule(config, new UserInputModule(presence)) };
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

function scope() {
    return { agent: { id: "agent-a", permissionMode: "auto" } } as never;
}
