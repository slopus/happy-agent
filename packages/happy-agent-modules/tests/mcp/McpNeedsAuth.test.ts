import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import { McpModule } from "../../sources/mcp/index.js";
import { PresenceModule } from "../../sources/presence/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { UserInputModule } from "../../sources/userInput/index.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { startOAuthMcpServer } from "./fixtures/oauthMcpServer.js";

const ctx = createRootContext().named("mcp-needs-auth-test");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("an HTTP MCP server that needs a login", () => {
    it("is marked as needing a login, is never retried or logged into, and is checked again on reload", async () => {
        const fixture = await startOAuthMcpServer();
        cleanups.push(async () => await fixture.close());
        const module = await moduleWith(`[mcp_servers.docs]\nurl = "${fixture.url}"\n`);
        await resolveModuleHooks(ctx, module);

        await expect
            .poll(async () => (await module.listServerPage(ctx, "agent-a")).servers)
            .toMatchObject([{ name: "docs", status: "needs_auth", toolCount: 0 }]);
        const [server] = (await module.listServerPage(ctx, "agent-a")).servers;
        expect(server?.errorMessage).toContain("The person can ask you to log in to it.");
        await expect(
            module.callTool(ctx, "agent-a", { server: "docs", name: "echo" }),
        ).rejects.toThrow('MCP server "docs" needs a login.');

        // A failed server is retried after one second; a server that needs a login is not.
        const asked = fixture.mcpRequests().length;
        await delay(1_500);
        expect(fixture.mcpRequests()).toHaveLength(asked);

        await module.reload(ctx);
        expect(fixture.mcpRequests().length).toBeGreaterThan(asked);
        await expect(module.listServerPage(ctx, "agent-a")).resolves.toMatchObject({
            servers: [{ name: "docs", status: "needs_auth" }],
        });
        // Nothing discovered the authorization server or registered a client.
        expect(fixture.authRequests()).toEqual([]);
    });

    it("fails, rather than needing a login, when its own configured credential is refused", async () => {
        const fixture = await startOAuthMcpServer();
        cleanups.push(async () => await fixture.close());
        const module = await moduleWith(
            `[mcp_servers.docs]\nurl = "${fixture.url}"\nhttp_headers = { Authorization = "Bearer wrong" }\n`,
        );
        await resolveModuleHooks(ctx, module);

        await expect
            .poll(async () => (await module.listServerPage(ctx, "agent-a")).servers)
            .toMatchObject([{ name: "docs", status: "failed" }]);
        expect(fixture.authRequests()).toEqual([]);
    });
});

async function moduleWith(mcpToml: string): Promise<McpModule> {
    const root = await mkdtemp(join(tmpdir(), "happy-mcp-needs-auth-"));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    const path = join(
        root,
        process.platform === "darwin" ? "Happy/Config" : "happy/config",
        "mcp.toml",
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, mcpToml, "utf8");
    const config = await ConfigModule.load(join(root, ".happy"));
    const runners = new RunnersModule(config);
    const module = new McpModule(
        config,
        new UserInputModule(new PresenceModule(config)),
        { onEvent: () => () => undefined } as never,
        runners,
        new ComputeModule(config, new SecretsModule(), runners),
    );
    cleanups.push(async () => await module.close());
    return module;
}
