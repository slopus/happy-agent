import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
    AgentKV,
    withAgentConfig,
    withAgentPermissionMode,
    type AgentModuleScope,
    type AgentPermissionMode,
    type AgentToolCall,
} from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const root = createRootContext().named("managed-network-policy-live-test");

/**
 * The status the managed proxy answered a tunnel request with: `200` when it opened the tunnel,
 * `403` when the policy refused the destination, and `000` when no proxy was reached at all.
 * `--proxytunnel` makes plain HTTP use a tunnel too, so every destination is decided the same way.
 */
const tunnel = (url: string) =>
    `curl -sS --proxytunnel --max-time 20 -o /dev/null -w '%{http_connect}' ${url} 2>/dev/null; true`;

const POLICY = `[network]
allowed_domains = ["api.github.com", "*.githubusercontent.com"]
denied_domains = ["raw.githubusercontent.com"]
allowed_ports = [443]
`;

describe.skipIf(process.platform === "win32")("managed network policy for shell commands", () => {
    let directory: string;
    let globalConfigPath: string;
    let module: ComputeModule;
    let agentCtx: Context;
    let bash: (ctx: Context, command: string) => Promise<string>;

    beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), "managed-network-"));
        const home = join(directory, "private");
        globalConfigPath = (await ConfigModule.load(home)).configuration.paths.globalConfigPath;
        await mkdir(dirname(globalConfigPath), { recursive: true });
        await writeFile(globalConfigPath, POLICY, "utf8");
        const config = await ConfigModule.load(home);
        const cwd = join(directory, "workspace");
        await mkdir(cwd);
        module = new ComputeModule(config, new SecretsModule());
        agentCtx = withAgentConfig(root, { modules: { compute: { cwd } } });
        const kv = new AgentKV(new InMemoryPersistence(), "kv.network-agent.").scoped(
            "module",
            "compute",
        );
        const scope = {
            agent: { id: "network-agent", model: "anthropic/opus-5" },
            kv,
        } as AgentModuleScope;
        const tools = await (await resolveModuleHooks(agentCtx, module)).tools!(agentCtx, scope);
        const tool = tools.find((candidate) => candidate.name === "Bash");
        if (tool === undefined) throw new Error("The module offers no Bash tool.");
        const call = {
            id: "networkcall",
            kv: kv.scoped("call", "networkcall"),
            commit: async (_commitCtx: Context, result: unknown) => result,
        } as AgentToolCall;
        bash = async (ctx, command) => {
            const result = await tool.execute(ctx, { command }, call);
            if (result.exitCode !== 0) {
                throw new Error(`${command} exited ${String(result.exitCode)}: ${result.stderr}`);
            }
            return String(result.stdout).trim();
        };
    });

    afterAll(async () => {
        await module?.dispose(agentCtx);
        await rm(directory, { force: true, recursive: true });
    });

    const inMode = (mode: AgentPermissionMode) => withAgentPermissionMode(agentCtx, mode);

    it("runs Auto commands behind the managed proxy with the configured allowlist", async () => {
        const auto = inMode("auto");
        expect(await bash(auto, "env | grep -c '^HTTPS_PROXY=' || true")).toBe("1");
        expect(await bash(auto, tunnel("https://api.github.com"))).toBe("200");
        expect(await bash(auto, tunnel("https://objects.githubusercontent.com"))).toBe("200");
        expect(await bash(auto, tunnel("https://example.com"))).toBe("403");
        expect(await bash(auto, tunnel("https://raw.githubusercontent.com"))).toBe("403");
        expect(await bash(auto, tunnel("http://api.github.com"))).toBe("403");
    });

    it("applies the same policy in Workspace write and none in Read only", async () => {
        expect(await bash(inMode("workspace_write"), tunnel("https://api.github.com"))).toBe("200");
        expect(await bash(inMode("workspace_write"), tunnel("https://example.com"))).toBe("403");
        expect(await bash(inMode("read_only"), tunnel("https://api.github.com"))).toBe("000");
    });

    it("rereads the policy before every command", async () => {
        await writeFile(globalConfigPath, '[network]\nallowed_domains = ["example.com"]\n', "utf8");
        try {
            expect(await bash(inMode("auto"), tunnel("https://example.com"))).toBe("200");
            expect(await bash(inMode("auto"), tunnel("https://api.github.com"))).toBe("403");
        } finally {
            await writeFile(globalConfigPath, POLICY, "utf8");
        }
    });
});
