import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { createJustBashToolHarness } from "../testing/createAgentTestHarness.js";
import { createTestRootContext } from "../testing/createTestRootContext.js";
import { McpClientManager } from "./McpClientManager.js";

describe("McpClientManager", () => {
    const ctx = createTestRootContext();
    it.each(["read_only", "workspace_write"] as const)(
        "does not start trusted servers or expose their tools in %s mode",
        async (permissionMode) => {
            const root = await mkdtemp(join(tmpdir(), "rig-mcp-restricted-"));
            const cwd = join(root, "workspace");
            const homeDirectory = join(root, "home");
            const configHome = join(root, "rig-home");
            const marker = join(root, "server-started.txt");
            const manager = new McpClientManager({
                env: { RIG_CONFIGURATION_DIRECTORY: configHome } as NodeJS.ProcessEnv,
                homeDirectory,
            });
            try {
                await mkdir(configHome, { recursive: true });
                await mkdir(homeDirectory, { recursive: true });
                await mkdir(cwd, { recursive: true });
                await writeFile(
                    join(configHome, "happy.toml"),
                    `[mcp_servers.trusted]\ncommand = "${process.execPath}"\nargs = ["server.mjs"]\n`,
                    "utf8",
                );
                await writeFile(
                    join(homeDirectory, "server.mjs"),
                    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "started");\n`,
                    "utf8",
                );

                const loaded = await manager.load(cwd, permissionMode);

                await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
                expect(loaded.tools).toEqual([]);
                expect(loaded.servers).toEqual([
                    {
                        errorMessage:
                            "MCP servers are available in Auto or Full access because they can act outside Rig's sandbox.",
                        name: "trusted",
                        status: "blocked",
                        toolCount: 0,
                    },
                ]);
            } finally {
                await manager.close();
                await rm(root, { force: true, recursive: true });
            }
        },
    );

    it("asks once in Auto and remembers trust across manager restarts", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-mcp-trust-"));
        const cwd = join(root, "workspace");
        const homeDirectory = join(root, "home");
        const configHome = join(root, "config");
        const fixture = join(
            dirname(fileURLToPath(import.meta.url)),
            "testing",
            "stdioMcpServer.mjs",
        );
        await mkdir(configHome, { recursive: true });
        await mkdir(homeDirectory, { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeFile(
            join(configHome, "happy.toml"),
            `[mcp_servers.trusted]\ncommand = "${process.execPath}"\nargs = ["${fixture}"]\n`,
            "utf8",
        );
        let prompts = 0;
        const first = new McpClientManager({
            env: { RIG_CONFIGURATION_DIRECTORY: configHome } as NodeJS.ProcessEnv,
            homeDirectory,
        });
        try {
            const headless = await first.load(cwd, "auto");
            expect(headless.tools).toEqual([]);
            expect(headless.servers).toEqual([
                expect.objectContaining({
                    errorMessage: "This MCP server needs one-time trust approval before it starts.",
                    name: "trusted",
                    status: "blocked",
                }),
            ]);
            const loaded = await first.load(cwd, "auto", {
                requestTrust: async () => {
                    prompts += 1;
                    return true;
                },
            });
            expect(loaded.tools.map((tool) => tool.name)).toContain("mcp__trusted__echo_value");
            expect(prompts).toBe(1);
        } finally {
            await first.close();
        }

        const second = new McpClientManager({
            env: { RIG_CONFIGURATION_DIRECTORY: configHome } as NodeJS.ProcessEnv,
            homeDirectory,
        });
        try {
            const loaded = await second.load(cwd, "auto", {
                requestTrust: async () => {
                    prompts += 1;
                    return true;
                },
            });
            expect(loaded.tools.map((tool) => tool.name)).toContain("mcp__trusted__echo_value");
            expect(prompts).toBe(1);
            await writeFile(
                join(configHome, "happy.toml"),
                `[mcp_servers.trusted]\ncommand = "${process.execPath}"\nargs = ["${fixture}"]\nenabled_tools = ["echo_value"]\n`,
                "utf8",
            );
            await second.load(cwd, "auto", {
                requestTrust: async () => {
                    prompts += 1;
                    return true;
                },
            });
            expect(prompts).toBe(2);
        } finally {
            await second.close();
            await rm(root, { force: true, recursive: true });
        }
    });

    it("retries MCP loading after a trust request is cancelled", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-mcp-cancelled-trust-"));
        const cwd = join(root, "workspace");
        const homeDirectory = join(root, "home");
        const configHome = join(root, "rig-home");
        const fixture = join(
            dirname(fileURLToPath(import.meta.url)),
            "testing",
            "stdioMcpServer.mjs",
        );
        const manager = new McpClientManager({
            env: { RIG_CONFIGURATION_DIRECTORY: configHome } as NodeJS.ProcessEnv,
            homeDirectory,
        });
        await mkdir(configHome, { recursive: true });
        await mkdir(homeDirectory, { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeFile(
            join(configHome, "happy.toml"),
            `[mcp_servers.trusted]\ncommand = "${process.execPath}"\nargs = ["${fixture}"]\n`,
            "utf8",
        );
        let prompts = 0;
        try {
            await expect(
                manager.load(cwd, "auto", {
                    requestTrust: async () => {
                        prompts += 1;
                        throw new Error("The user input request was cancelled.");
                    },
                }),
            ).rejects.toThrow("The user input request was cancelled.");

            const loaded = await manager.load(cwd, "auto", {
                requestTrust: async () => {
                    prompts += 1;
                    return true;
                },
            });

            expect(prompts).toBe(2);
            expect(loaded.tools.map((tool) => tool.name)).toContain("mcp__trusted__echo_value");
        } finally {
            await manager.close();
            await rm(root, { force: true, recursive: true });
        }
    });

    it("starts trusted stdio servers from the user home instead of an untrusted workspace", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-mcp-cwd-"));
        const cwd = join(root, "workspace");
        const homeDirectory = join(root, "home");
        const configHome = join(root, "rig-home");
        const homeMarker = join(root, "home-server-started.txt");
        const workspaceMarker = join(root, "workspace-shadow-started.txt");
        const manager = new McpClientManager({
            env: { RIG_CONFIGURATION_DIRECTORY: configHome } as NodeJS.ProcessEnv,
            homeDirectory,
        });
        try {
            const fixture = join(
                dirname(fileURLToPath(import.meta.url)),
                "testing",
                "stdioMcpServer.mjs",
            );
            await mkdir(configHome, { recursive: true });
            await mkdir(homeDirectory, { recursive: true });
            await mkdir(cwd, { recursive: true });
            await writeFile(
                join(configHome, "happy.toml"),
                `[mcp_servers.trusted]\ncommand = "${process.execPath}"\nargs = ["server.mjs"]\n`,
                "utf8",
            );
            await writeFile(
                join(homeDirectory, "server.mjs"),
                `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(homeMarker)}, "home");\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`,
                "utf8",
            );
            await writeFile(
                join(cwd, "server.mjs"),
                `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(workspaceMarker)}, "workspace");\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`,
                "utf8",
            );

            const loaded = await manager.load(cwd, "full_access", {
                requestTrust: async () => true,
            });

            await expect(readFile(homeMarker, "utf8")).resolves.toBe("home");
            await expect(readFile(workspaceMarker)).rejects.toMatchObject({ code: "ENOENT" });
            expect(loaded.servers).toEqual([
                expect.objectContaining({ name: "trusted", status: "connected" }),
            ]);
            expect(loaded.tools.map((tool) => tool.name)).toContain("mcp__trusted__echo_value");
        } finally {
            await manager.close();
            await rm(root, { force: true, recursive: true });
        }
    });

    it("connects a permanently trusted project server without allowing it to shadow user config", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-mcp-client-"));
        const configHome = join(cwd, "config-home");
        const homeDirectory = join(cwd, "home");
        const manager = new McpClientManager({
            env: {
                RIG_CONFIGURATION_DIRECTORY: configHome,
                RIG_HOME: configHome,
            } as NodeJS.ProcessEnv,
            homeDirectory,
        });
        try {
            const fixture = join(
                dirname(fileURLToPath(import.meta.url)),
                "testing",
                "stdioMcpServer.mjs",
            );
            const projectMarker = join(cwd, "project-server-started.txt");
            const projectServer = join(cwd, "project-server.mjs");
            await mkdir(configHome, { recursive: true });
            await mkdir(homeDirectory, { recursive: true });
            await writeFile(
                join(configHome, "happy.toml"),
                `[mcp_servers."Global Docs"]\ncommand = "${process.execPath}"\nargs = ["${fixture}"]\n`,
                "utf8",
            );
            await writeFile(
                join(configHome, "runtime.toml"),
                `[mcp_servers."Runtime Docs"]\ncommand = "${process.execPath}"\nargs = ["${fixture}"]\n`,
                "utf8",
            );
            await writeFile(
                join(cwd, "rig.toml"),
                `[mcp_servers."Project Helper"]\ncommand = "${process.execPath}"\nargs = ["${projectServer}"]\n\n[mcp_servers."Global Docs"]\ncommand = "${process.execPath}"\nargs = ["${projectServer}"]\nenabled = false\n`,
                "utf8",
            );
            await writeFile(
                projectServer,
                `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(projectMarker)}, "started\\n");\nawait import(${JSON.stringify(pathToFileURL(fixture).href)});\n`,
                "utf8",
            );

            const trustedNames: string[] = [];
            const loaded = await manager.load(cwd, "auto", {
                requestTrust: async (request) => {
                    trustedNames.push(request.name);
                    return true;
                },
            });

            await expect(readFile(projectMarker, "utf8")).resolves.toBe("started\n");
            expect(trustedNames).toEqual(["Global Docs", "Project Helper", "Runtime Docs"]);
            expect(loaded.servers).toEqual([
                {
                    name: "Global Docs",
                    promptSupport: true,
                    resourceSupport: true,
                    status: "connected",
                    toolCount: 2,
                },
                {
                    errorMessage:
                        "A trusted user-level server with this name takes precedence over the project configuration.",
                    name: "Global Docs (project configuration)",
                    status: "blocked",
                    toolCount: 0,
                },
                {
                    name: "Project Helper",
                    promptSupport: true,
                    resourceSupport: true,
                    status: "connected",
                    toolCount: 2,
                },
                {
                    name: "Runtime Docs",
                    promptSupport: true,
                    resourceSupport: true,
                    status: "connected",
                    toolCount: 2,
                },
            ]);
            const toolNames = loaded.tools.map((tool) => tool.name);
            expect(toolNames).toContain("mcp__Global_Docs__echo_value");
            expect(toolNames).toContain("mcp__Runtime_Docs__echo_value");
            expect(toolNames).toContain("mcp__Project_Helper__echo_value");
        } finally {
            await manager.close();
            await rm(cwd, { force: true, recursive: true });
        }
    });

    it("discovers and calls tools over a stdio MCP connection", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-mcp-client-"));
        const configHome = join(cwd, "empty-rig-home");
        const homeDirectory = join(cwd, "empty-home");
        const manager = new McpClientManager({
            env: { RIG_CONFIGURATION_DIRECTORY: configHome } as NodeJS.ProcessEnv,
            homeDirectory,
        });
        try {
            const fixture = join(
                dirname(fileURLToPath(import.meta.url)),
                "testing",
                "stdioMcpServer.mjs",
            );
            await mkdir(configHome, { recursive: true });
            await mkdir(homeDirectory, { recursive: true });
            await writeFile(
                join(configHome, "happy.toml"),
                `[mcp_servers."test server"]\ncommand = "${process.execPath}"\nargs = ["${fixture}"]\n`,
                "utf8",
            );

            const loaded = await manager.load(cwd, "full_access", {
                requestTrust: async () => true,
            });

            expect(loaded.servers).toEqual([
                {
                    name: "test server",
                    promptSupport: true,
                    resourceSupport: true,
                    status: "connected",
                    toolCount: 2,
                },
            ]);
            expect(loaded.tools.map((tool) => tool.name)).toEqual([
                "mcp__test_server__echo_value",
                "mcp__test_server__ask_environment",
                "list_mcp_tools",
                "call_mcp_tool",
                "list_mcp_resources",
                "list_mcp_resource_templates",
                "read_mcp_resource",
                "list_mcp_prompts",
                "get_mcp_prompt",
            ]);
            const tool = loaded.tools.find(
                (candidate) => candidate.name === "mcp__test_server__echo_value",
            );
            expect(tool).toBeDefined();
            if (tool === undefined) throw new Error("Echo MCP tool was not discovered.");
            expect(Value.Check(tool.arguments, { value: "hello" })).toBe(true);
            const harness = createJustBashToolHarness();
            const result = await tool?.execute({ value: "hello" } as never, harness.context, {
                ctx,
            });
            expect(tool?.toLLM(result as never)).toEqual([{ type: "text", text: "Echo: hello" }]);
            expect(tool?.locks).toEqual(["mcp:test server"]);

            harness.context.userInput = {
                request: async () => ({
                    status: "answered" as const,
                    answers: { environment: ["staging"] },
                }),
            };
            const elicitingTool = loaded.tools.find(
                (candidate) => candidate.name === "mcp__test_server__ask_environment",
            );
            const elicitationResult = await elicitingTool?.execute({} as never, harness.context, {
                ctx,
            });
            expect(elicitingTool?.toLLM(elicitationResult as never)).toEqual([
                { type: "text", text: "Selected: staging" },
            ]);

            const readResource = loaded.tools.find(
                (candidate) => candidate.name === "read_mcp_resource",
            );
            const resourceResult = await readResource?.execute(
                { server: "test server", uri: "rig://guide" } as never,
                harness.context,
                { ctx },
            );
            expect(readResource?.toLLM(resourceResult as never)).toEqual([
                { type: "text", text: "Use pnpm." },
            ]);

            const getPrompt = loaded.tools.find((candidate) => candidate.name === "get_mcp_prompt");
            const promptResult = await getPrompt?.execute(
                {
                    server: "test server",
                    name: "review_change",
                    arguments: { focus: "permissions" },
                } as never,
                harness.context,
                { ctx },
            );
            expect(getPrompt?.toLLM(promptResult as never)).toEqual([
                { type: "text", text: expect.stringContaining("Review permissions.") },
            ]);
        } finally {
            await manager.close();
            await rm(cwd, { force: true, recursive: true });
        }
    });

    it("keeps superseded connections alive for sessions using their tools", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-mcp-reload-"));
        const cwd = join(root, "workspace");
        const homeDirectory = join(root, "home");
        const configHome = join(root, "rig-home");
        const configPath = join(configHome, "happy.toml");
        const fixture = join(
            dirname(fileURLToPath(import.meta.url)),
            "testing",
            "stdioMcpServer.mjs",
        );
        const manager = new McpClientManager({
            env: { RIG_CONFIGURATION_DIRECTORY: configHome } as NodeJS.ProcessEnv,
            homeDirectory,
        });
        await mkdir(dirname(configPath), { recursive: true });
        await mkdir(homeDirectory, { recursive: true });
        await mkdir(cwd, { recursive: true });
        await writeFile(
            configPath,
            `[mcp_servers.shared]\ncommand = "${process.execPath}"\nargs = ["${fixture}"]\n`,
            "utf8",
        );

        try {
            const first = await manager.load(cwd, "full_access", {
                requestTrust: async () => true,
            });
            const originalTool = first.tools.find(
                (tool) => tool.name === "mcp__shared__echo_value",
            );
            if (originalTool === undefined) throw new Error("Expected the original MCP tool.");

            await writeFile(
                configPath,
                `[mcp_servers.shared]\ncommand = "${process.execPath}"\nargs = ["${fixture}"]\nenabled_tools = ["echo_value"]\n`,
                "utf8",
            );
            await manager.load(cwd, "full_access", { requestTrust: async () => true });

            const harness = createJustBashToolHarness();
            const result = await originalTool.execute(
                { value: "still active" } as never,
                harness.context,
                { ctx },
            );
            expect(originalTool.toLLM(result as never)).toEqual([
                { type: "text", text: "Echo: still active" },
            ]);

            expect(first.release).toBeTypeOf("function");
            await first.release?.();
            await expect(
                originalTool.execute({ value: "released" } as never, harness.context, { ctx }),
            ).rejects.toThrow();
        } finally {
            await manager.close();
            await rm(root, { force: true, recursive: true });
        }
    });

    it("keeps an unavailable optional server visible without blocking other tools", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-mcp-client-"));
        const configHome = join(cwd, "empty-rig-home");
        const homeDirectory = join(cwd, "empty-home");
        const manager = new McpClientManager({
            env: { RIG_CONFIGURATION_DIRECTORY: configHome } as NodeJS.ProcessEnv,
            homeDirectory,
        });
        try {
            await mkdir(configHome, { recursive: true });
            await mkdir(homeDirectory, { recursive: true });
            await writeFile(
                join(configHome, "happy.toml"),
                '[mcp_servers.missing]\ncommand = "rig-command-that-does-not-exist"\n',
                "utf8",
            );

            const loaded = await manager.load(cwd, "full_access", {
                requestTrust: async () => true,
            });

            expect(loaded.tools).toEqual([]);
            expect(loaded.servers).toEqual([
                expect.objectContaining({
                    name: "missing",
                    status: "failed",
                    toolCount: 0,
                }),
            ]);
            expect(loaded.servers[0]?.errorMessage).toContain("could not connect");
        } finally {
            await manager.close();
            await rm(cwd, { force: true, recursive: true });
        }
    });

    it("enforces tool allowlists through live list and call tools", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-mcp-client-"));
        const configHome = join(cwd, "empty-rig-home");
        const homeDirectory = join(cwd, "empty-home");
        const manager = new McpClientManager({
            env: { RIG_CONFIGURATION_DIRECTORY: configHome } as NodeJS.ProcessEnv,
            homeDirectory,
        });
        try {
            const fixture = join(
                dirname(fileURLToPath(import.meta.url)),
                "testing",
                "stdioMcpServer.mjs",
            );
            await mkdir(configHome, { recursive: true });
            await mkdir(homeDirectory, { recursive: true });
            await writeFile(
                join(configHome, "happy.toml"),
                `[mcp_servers.restricted]\ncommand = "${process.execPath}"\nargs = ["${fixture}"]\nenabled_tools = ["echo_value"]\n`,
                "utf8",
            );
            const loaded = await manager.load(cwd, "full_access", {
                requestTrust: async () => true,
            });
            const harness = createJustBashToolHarness();
            const listTools = loaded.tools.find((tool) => tool.name === "list_mcp_tools");
            const listResult = await listTools?.execute(
                { server: "restricted" } as never,
                harness.context,
                { ctx },
            );
            expect(listTools?.toLLM(listResult as never)[0]).toEqual({
                type: "text",
                text: expect.not.stringContaining("ask_environment"),
            });

            const callTool = loaded.tools.find((tool) => tool.name === "call_mcp_tool");
            await expect(
                callTool?.execute(
                    { server: "restricted", name: "ask_environment" } as never,
                    harness.context,
                    { ctx },
                ),
            ).rejects.toThrow("disabled by the server policy");
        } finally {
            await manager.close();
            await rm(cwd, { force: true, recursive: true });
        }
    });
});
