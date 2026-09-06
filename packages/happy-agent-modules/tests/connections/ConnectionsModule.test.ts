import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ConfigModule,
    parseHappyAgentConfigToml,
    type RemoteConnectionEntry,
} from "../../sources/config/index.js";
import { ConnectionsModule } from "../../sources/connections/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { CloudModule } from "../../sources/cloud/index.js";
import type { TailcatModule } from "../../sources/tailcat/index.js";
import type { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { ensureAgentDatabaseConnection, type AgentModuleScope } from "@slopus/happy-agent-base";
import {
    connectionsUpdatedPayloadSchema,
    type ConnectionsUpdatedPayload,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import { queryConnectionSnapshot } from "../../sources/connections/persistence/connectionSnapshot.js";
import { RemoteProxyConnection } from "../../sources/connections/impl/RemoteProxyConnection.js";

const roots: string[] = [];
const databases: ModuleDatabase[] = [];
const ctx = createRootContext();
const token = "r".repeat(43);
afterEach(async () => {
    vi.restoreAllMocks();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "remote-config-"));
    roots.push(root);
    await mkdir(join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config"), {
        recursive: true,
    });
    await writeFile(
        join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config", "happy.toml"),
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
    const closeTransport = vi.fn(async () => undefined);
    const tailcat = { openRemote: vi.fn(() => ({ close: closeTransport })) };
    const module = new ConnectionsModule(
        config,
        bots,
        {} as CloudModule,
        tailcat as unknown as TailcatModule,
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
        tailcat,
        closeTransport,
        revoke: () => {
            active = false;
        },
    };
}

describe("configured remote roster", () => {
    it.each(["set", "reconcile"] as const)(
        "preserves the pool and carrier when %s changes only the display name",
        async (mode) => {
            const f = await fixture();
            const database = moduleDatabase(f.module.migrations, "connection-rename");
            ensureAgentDatabaseConnection(database.database);
            databases.push(database);
            await database.ready;
            const health = vi.spyOn(RemoteProxyConnection.prototype, "health").mockResolvedValue({
                reachable: true,
                authenticated: true,
                ready: true,
            });
            const reconcile = f.durable.register.mock.calls[0]![0].executor;
            const initial = await f.module.getSnapshot(database.context);
            const events: ConnectionsUpdatedPayload[] = [];
            f.module.onUpdated((_ctx, snapshot) => events.push(snapshot));
            try {
                await f.module.checkHealth(ctx, "admin", "mac");
                const renamed = { name: "Renamed Mac", address: "tcCaseSensitive", token };
                if (mode === "set") await f.module.set(ctx, "admin", "mac", renamed);
                else await f.config.updateRuntimeConnection(ctx, "mac", renamed);
                await reconcile(database.context);

                expect(f.closeTransport).not.toHaveBeenCalled();
                await f.module.checkHealth(ctx, "admin", "mac");
                expect(f.tailcat.openRemote).toHaveBeenCalledTimes(1);
                expect(health.mock.contexts[1]).toBe(health.mock.contexts[0]);
                const snapshot = await f.module.getSnapshot(database.context);
                expect(snapshot.connections).toEqual([
                    { id: "mac", name: "Renamed Mac", authentication: "bearer" },
                ]);
                expect(snapshot.version > initial.version).toBe(true);
                expect(events).toEqual([snapshot]);
                expect((await ConfigModule.load(f.home)).connections.mac).toEqual(renamed);
                await reconcile(database.context);
                expect(events).toEqual([snapshot]);
                expect(f.closeTransport).not.toHaveBeenCalled();
            } finally {
                await f.module.close(ctx);
            }
            expect(f.closeTransport).toHaveBeenCalledTimes(1);
        },
    );

    describe.each(["set", "reconcile"] as const)("%s transport replacement", (mode) => {
        it.each<{ change: string; entry: RemoteConnectionEntry }>([
            { change: "address", entry: { name: "Build Mac", address: "tcOther", token } },
            {
                change: "port",
                entry: { name: "Build Mac", address: "tcCaseSensitive", port: 24780, token },
            },
            {
                change: "token",
                entry: { name: "Build Mac", address: "tcCaseSensitive", token: "s".repeat(43) },
            },
            {
                change: "authentication mode",
                entry: {
                    name: "Build Mac",
                    address: "tcCaseSensitive",
                    workos_organization_id: "org_test",
                },
            },
            { change: "removal", entry: { enabled: false } },
        ])("closes the old pool and carrier on $change", async ({ entry }) => {
            const f = await fixture();
            vi.spyOn(RemoteProxyConnection.prototype, "health").mockResolvedValue({
                reachable: true,
                authenticated: true,
                ready: true,
            });
            vi.spyOn(f.module, "getSnapshot").mockResolvedValue({
                connections: [],
                version: "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f",
            });
            const reconcile = f.durable.register.mock.calls[0]![0].executor;
            try {
                await f.module.checkHealth(ctx, "admin", "mac");
                if (mode === "set") await f.module.set(ctx, "admin", "mac", entry);
                else await f.config.updateRuntimeConnection(ctx, "mac", entry);
                await reconcile(ctx);
                expect(f.closeTransport).toHaveBeenCalledTimes(1);
                if (entry.enabled === false) {
                    await expect(f.module.checkHealth(ctx, "admin", "mac")).rejects.toMatchObject({
                        status: 404,
                    });
                } else {
                    await f.module.checkHealth(ctx, "admin", "mac");
                    expect(f.tailcat.openRemote).toHaveBeenCalledTimes(2);
                    expect(f.tailcat.openRemote).toHaveBeenLastCalledWith(entry.address);
                }
            } finally {
                await f.module.close(ctx);
            }
        });
    });

    it("commits the complete snapshot before notifying and rolls both back with the caller", async () => {
        const f = await fixture();
        const database = moduleDatabase(f.module.migrations, "connection-snapshot");
        ensureAgentDatabaseConnection(database.database);
        databases.push(database);
        await database.ready;
        const events: ConnectionsUpdatedPayload[] = [];
        f.module.onUpdated((_ctx, snapshot) => events.push(snapshot));
        const initial = await f.module.getSnapshot(database.context);
        expect(Value.Check(connectionsUpdatedPayloadSchema, initial)).toBe(true);
        events.length = 0;
        await f.config.updateRuntimeConnection(ctx, "mac", {
            name: "Renamed",
            address: "tcPrivate",
            token,
        });
        await expect(
            database.context.inTx(async (txCtx) => {
                const changed = await f.module.getSnapshot(txCtx);
                expect(changed.version > initial.version).toBe(true);
                expect(await f.module.getSnapshot(txCtx)).toEqual(changed);
                expect(events).toEqual([]);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await queryConnectionSnapshot(database.context)).toEqual(initial);
        expect(events).toEqual([]);
        const changed = await database.context.inTx(
            async (txCtx) => await f.module.getSnapshot(txCtx),
        );
        expect(events).toEqual([changed]);
        expect(await queryConnectionSnapshot(database.context)).toEqual(changed);
        events.length = 0;
        vi.spyOn(Date, "now").mockReturnValue(0);
        await f.config.updateRuntimeConnection(ctx, "mac", { enabled: false });
        const simultaneous = await Promise.all(
            Array.from({ length: 8 }, () => f.module.getSnapshot(database.context)),
        );
        expect(
            simultaneous.every((snapshot) => snapshot.version === simultaneous[0]!.version),
        ).toBe(true);
        expect(simultaneous[0]!.version > changed.version).toBe(true);
        expect(events).toEqual([simultaneous[0]]);
        expect(events[0]!.connections).toEqual([]);
    });

    it("retains the version across restart and private changes but reconciles offline public edits", async () => {
        const f = await fixture();
        const database = moduleDatabase(f.module.migrations, "connection-restart");
        ensureAgentDatabaseConnection(database.database);
        databases.push(database);
        await database.ready;
        const initial = await f.module.getSnapshot(database.context);
        await f.config.updateRuntimeConnection(ctx, "mac", {
            name: "Build Mac",
            address: "tcRotated",
            token: "s".repeat(43),
        });
        const restarted = new ConnectionsModule(
            await ConfigModule.load(f.home),
            {} as BotsModule,
            {} as CloudModule,
            {} as TailcatModule,
            f.durable as unknown as DurableFunctionsModule,
        );
        const events: ConnectionsUpdatedPayload[] = [];
        const unsubscribe = restarted.onUpdated((_ctx, snapshot) => events.push(snapshot));
        await restarted.beforeStart(database.context).afterStart!(database.context, {} as never);
        expect(await restarted.getSnapshot(database.context)).toEqual(initial);
        expect(events).toEqual([]);
        unsubscribe();
        await f.config.updateRuntimeConnection(ctx, "mac", {
            name: "Team",
            address: "tcTeam",
            workos_organization_id: "org_test",
        });
        const edited = new ConnectionsModule(
            await ConfigModule.load(f.home),
            {} as BotsModule,
            {} as CloudModule,
            {} as TailcatModule,
            f.durable as unknown as DurableFunctionsModule,
        );
        edited.onUpdated((_ctx, snapshot) => events.push(snapshot));
        await edited.beforeStart(database.context).afterStart!(database.context, {} as never);
        const current = await edited.getSnapshot(database.context);
        expect(current.version > initial.version).toBe(true);
        expect(current.connections).toEqual([
            { id: "mac", name: "Team", authentication: "workos", organizationId: "org_test" },
        ]);
        expect(events).toEqual([current]);
        expect(JSON.stringify(current)).not.toContain("tcTeam");
    });

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
