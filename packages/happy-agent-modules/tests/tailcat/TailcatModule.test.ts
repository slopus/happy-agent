import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentModuleScope, AnyAgentTool } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotsModule } from "../../sources/bots/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import type { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { TailcatModule } from "../../sources/tailcat/index.js";

const roots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("TailcatModule", () => {
    it("shows its tools only to active admin bots and rechecks authorization on execution", async () => {
        const fixture = await createFixture();
        try {
            await expect(fixture.toolNames("admin-agent")).resolves.toEqual([
                "set_tailcat_enabled",
                "get_tailcat_status",
            ]);
            await expect(fixture.toolNames("ordinary-agent")).resolves.toEqual([]);
            await expect(fixture.toolNames("archived-admin-agent")).resolves.toEqual([]);
            await expect(fixture.toolNames("human-agent")).resolves.toEqual([]);

            await expect(
                fixture.tailcat.setEnabled(fixture.ctx, "ordinary-agent", true),
            ).rejects.toThrow("Only an active admin bot can manage Tailcat internet exposure.");
            await expect(fixture.tailcat.getStatus(fixture.ctx, "human-agent")).rejects.toThrow(
                "Only an active admin bot can inspect Tailcat internet exposure.",
            );
        } finally {
            await fixture.close();
        }
    });

    it("opens and closes the live tunnel, persists the toggle, and reports its address", async () => {
        const fixture = await createFixture();
        try {
            await fixture.tailcat.attachTransport(fixture.ctx, { host: "127.0.0.1", port: 9 });
            const setTool = await fixture.tool("admin-agent", "set_tailcat_enabled");
            const getTool = await fixture.tool("admin-agent", "get_tailcat_status");

            const opened = await setTool.execute(
                fixture.ctx,
                { enabled: true },
                toolCall("tailcat-enable"),
            );
            expect(opened).toEqual({
                address: "tcStableTailcatAddress123",
                enabled: true,
                port: 24_784,
                state: "open",
            });
            await expect(
                getTool.execute(fixture.ctx, {}, toolCall("tailcat-read")),
            ).resolves.toEqual(opened);
            expect(fixture.updates).toEqual([true]);
            expect((await stat(fixture.paths.keyPath)).mode & 0o777).toBe(0o600);
            await expect(readFile(fixture.paths.addressPath, "utf8")).resolves.toBe(
                "tcStableTailcatAddress123\n",
            );

            const closed = await setTool.execute(
                fixture.ctx,
                { enabled: false },
                toolCall("tailcat-disable"),
            );
            expect(closed).toEqual({ enabled: false, state: "disabled" });
            expect(fixture.updates).toEqual([true, false]);
            await expect(readFile(fixture.paths.addressPath, "utf8")).rejects.toMatchObject({
                code: "ENOENT",
            });
            await expect(readFile(fixture.paths.keyPath, "utf8")).resolves.toBe(
                "stable-private-key\n",
            );
            expect(fixture.invoke).toHaveBeenCalledTimes(2);
        } finally {
            await fixture.close();
        }
    });
});

async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), "happy-tailcat-module-"));
    roots.push(root);
    const home = join(root, "tailcat");
    const paths = {
        addressPath: join(home, "address"),
        home,
        keyPath: join(home, "default.private.json"),
        portPath: join(home, "port"),
    };
    const executable = join(root, "fake-tailcat");
    await writeFile(
        executable,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "genkey") {
    const key = args.find((argument) => argument.startsWith("--key="))?.slice(6);
    if (key === undefined) process.exit(2);
    writeFileSync(key, "stable-private-key\\n", { mode: 0o600 });
    process.exit(0);
}
writeFileSync(process.env.TAILCAT_ADDR_FILE, "tcStableTailcatAddress123\\n", { mode: 0o600 });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`,
    );
    await chmod(executable, 0o755);
    vi.stubEnv("HAPPY_AGENT_TAILCAT_PATH", executable);

    let enabled = false;
    const updates: boolean[] = [];
    const config = {
        configuration: {
            paths: {
                tailcatAddressPath: paths.addressPath,
                tailcatHome: paths.home,
                tailcatKeyPath: paths.keyPath,
                tailcatPortPath: paths.portPath,
            },
        },
        tailcatPort: 24_784,
        get tailcatEnabled() {
            return enabled;
        },
        updateRuntimeTailcatEnabled: vi.fn(async (_ctx: Context, value: boolean) => {
            updates.push(value);
            enabled = value;
        }),
    } as unknown as ConfigModule;
    const bots = {
        forAgent: vi.fn(async (_ctx: Context, agentId: string) => {
            if (agentId === "admin-agent") return { isAdmin: true, status: "active" };
            if (agentId === "ordinary-agent") return { isAdmin: false, status: "active" };
            if (agentId === "archived-admin-agent") {
                return { isAdmin: true, status: "archived" };
            }
            return undefined;
        }),
    } as unknown as BotsModule;
    const invoke = vi.fn(async () => ({ callId: "tailcat-call", status: "created" as const }));
    const durableFunctions = {
        invoke,
        register: vi.fn(),
    } as unknown as DurableFunctionsModule;
    const tailcat = new TailcatModule(config, bots, durableFunctions);
    const ctx = createRootContext().named("tailcat-test");
    const hooks = tailcat.beforeStart?.(ctx);
    if (hooks === undefined) throw new Error("Tailcat did not install its hooks.");

    const toolsFor = async (agentId: string): Promise<readonly AnyAgentTool[]> => {
        const scope = { agent: { id: agentId } } as unknown as AgentModuleScope;
        return (await hooks.tools?.(ctx, scope)) ?? [];
    };
    return {
        close: async () => await tailcat.close(ctx),
        ctx,
        invoke,
        paths,
        tailcat,
        tool: async (agentId: string, name: string): Promise<AnyAgentTool> => {
            const tool = (await toolsFor(agentId)).find((candidate) => candidate.name === name);
            if (tool === undefined) throw new Error(`The ${name} tool is missing.`);
            return tool;
        },
        toolNames: async (agentId: string): Promise<readonly string[]> =>
            (await toolsFor(agentId)).map((tool) => tool.name),
        updates,
    };
}

function toolCall(id: string): never {
    return {
        id,
        kv: {
            getOrCreate: async (_ctx: Context, _key: string, create: () => unknown) =>
                await create(),
        },
        commit: async (_ctx: Context, result: unknown) => result,
    } as never;
}
