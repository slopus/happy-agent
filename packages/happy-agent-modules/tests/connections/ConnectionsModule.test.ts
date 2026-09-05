import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule, parseHappyAgentConfigToml } from "../../sources/config/index.js";
import { ConnectionsModule } from "../../sources/connections/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { CloudModule } from "../../sources/cloud/index.js";
import type { TailcatModule } from "../../sources/tailcat/index.js";
import type { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import type { AgentModuleScope } from "@slopus/happy-agent-base";

const roots: string[] = [];
const ctx = createRootContext();
const token = "r".repeat(43);
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "remote-config-"));
    roots.push(root);
    await mkdir(join(root, "Happy", "Config"), { recursive: true });
    await writeFile(
        join(root, "Happy", "Config", "happy.toml"),
        `[connections.mac]\nname = "Build Mac"\naddress = "tcCaseSensitive"\ntoken = "${token}"\n`,
    );
    const home = join(root, ".happy");
    const config = await ConfigModule.load(home);
    let active = true;
    const bots = {
        forAgent: async (_ctx: unknown, id: string) =>
            id === "admin" ? { isAdmin: true, status: active ? "active" : "archived" } : undefined,
    } as unknown as BotsModule;
    const durable = { register: vi.fn(), invoke: vi.fn() };
    const module = new ConnectionsModule(
        config,
        bots,
        {} as CloudModule,
        {} as TailcatModule,
        durable as unknown as DurableFunctionsModule,
    );
    const hooks = module.beforeStart(ctx);
    return {
        root,
        home,
        config,
        module,
        hooks,
        durable,
        revoke: () => {
            active = false;
        },
    };
}

describe("configured remote roster", () => {
    it("ignores repository attempts to change tokens or register a remote", async () => {
        const f = await fixture();
        await writeFile(
            join(f.root, "happy.toml"),
            `[api]\ntoken="${token}"\n[connections.evil]\nname="Repository remote"\naddress="tcEvil"\ntoken="${token}"\n`,
        );
        const previous = process.cwd();
        try {
            process.chdir(f.root);
            const config = await ConfigModule.load(f.home);
            expect(config.configuration.values.api).toBeUndefined();
            expect(config.connections.evil).toBeUndefined();
            expect(config.connections.mac).toBeDefined();
        } finally {
            process.chdir(previous);
        }
    });

    it("does not treat inherited object keys as configured endpoints", async () => {
        const f = await fixture();
        await expect(f.module.checkHealth(ctx, "admin", "constructor")).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
    });
    it("keeps credentials and addresses out of the public roster", async () => {
        const f = await fixture();
        expect(f.module.list()).toEqual([
            { id: "mac", name: "Build Mac", authentication: "bearer" },
        ]);
        expect(JSON.stringify(f.module.list())).not.toContain(token);
        expect(JSON.stringify(f.module.list())).not.toContain("tcCaseSensitive");
    });

    it("persists replacement credentials and removal tombstones across restart", async () => {
        const f = await fixture();
        await f.module.set(ctx, "admin", "mac", {
            name: "Engineering",
            address: "tcTeam",
            workos_organization_id: "org_test",
        });
        const updated = await ConfigModule.load(f.home);
        expect(updated.connections.mac).toEqual({
            name: "Engineering",
            address: "tcTeam",
            workos_organization_id: "org_test",
        });
        expect(updated.connections.mac).not.toHaveProperty("token");
        await f.module.set(ctx, "admin", "mac", { enabled: false });
        expect(f.module.list()).toEqual([]);
        expect((await ConfigModule.load(f.home)).connections.mac).toEqual({ enabled: false });
        expect(
            await readFile(f.config.configuration.paths.runtimeConfigPath, "utf8"),
        ).not.toContain(token);
        expect(f.durable.invoke).toHaveBeenCalledTimes(2);
    });

    it("exposes tools only to an active admin and rechecks stale tool authority", async () => {
        const f = await fixture();
        const tools = await f.hooks.tools!(ctx, { agent: { id: "admin" } } as AgentModuleScope);
        expect(tools.map((tool) => tool.name)).toEqual([
            "list_remote_connections",
            "set_remote_connection",
            "remove_remote_connection",
            "check_remote_connection_health",
        ]);
        const healthTool = tools.find((tool) => tool.name === "check_remote_connection_health")!;
        expect(healthTool.requiresAutoOrFullAccess).toBe(true);
        expect(healthTool.shouldReviewInAutoMode?.({ id: "mac" }, {} as never)).toBe(true);
        expect(healthTool.shouldRunInFullAccessInAutoMode?.({ id: "mac" }, {} as never)).toBe(true);
        expect(await f.hooks.tools!(ctx, { agent: { id: "human" } } as AgentModuleScope)).toEqual(
            [],
        );
        f.revoke();
        expect(await f.hooks.tools!(ctx, { agent: { id: "admin" } } as AgentModuleScope)).toEqual(
            [],
        );
        await expect(f.module.listForAdmin(ctx, "admin")).rejects.toThrow("active admin");
        await expect(f.module.set(ctx, "admin", "mac", { enabled: false })).rejects.toThrow(
            "active admin",
        );
        await expect(f.module.checkHealth(ctx, "admin", "mac")).rejects.toThrow("active admin");
        await expect(healthTool.execute(ctx, { id: "mac" }, {} as never)).rejects.toThrow(
            "active admin",
        );
        expect(f.module.list()).toHaveLength(1);
    });

    it.each([
        '[connections."../escape"]\nenabled = false',
        '[connections.a]\nname="A"\naddress="tcA"',
        `[connections.a]\nname="A"\naddress="tcA"\ntoken="${token}"\nworkos_organization_id="org_a"`,
        `[connections.a]\nname="A"\naddress="tcA"\ntoken="${token}"\nport=0`,
        '[api]\ntoken="short"',
    ])("rejects invalid deployment configuration", (source) => {
        expect(() => parseHappyAgentConfigToml(source)).toThrow();
    });
});
