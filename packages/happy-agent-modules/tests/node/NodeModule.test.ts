import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { ensureAgentDatabaseConnection, type AgentModuleScope } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { BotsModule } from "../../sources/bots/index.js";
import { ConfigModule, parseHappyAgentConfigToml } from "../../sources/config/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { NodeModule } from "../../sources/node/index.js";
import { ApiModule } from "../../sources/api/index.js";
import { withTeamUser, type TeamUser } from "../../sources/team/index.js";
import { normalizeNodeAvatar } from "../../sources/node/impl/normalizeNodeAvatar.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "node-config-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const directory = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "happy.toml"),
        '[node]\nname = "Studio"\n[p2p]\nname = "Peer"\n',
    );
    const config = await ConfigModule.load(join(root, ".happy"));
    let active = true;
    const bots = {
        forAgent: async (_ctx: Context, id: string) =>
            id === "admin" ? { isAdmin: true, status: active ? "active" : "archived" } : undefined,
    } as unknown as BotsModule;
    const durable = { register: vi.fn(), invoke: vi.fn() };
    const fs = { stat: vi.fn(async () => ({ isFile: true, size: 10 })), readFileBuffer: vi.fn() };
    const permissions = { mode: "full_access" };
    const compute = {
        resolve: vi.fn(async () => ({ fs })),
        permissionsForContext: () => permissions,
        shouldReviewPath: vi.fn(async () => false),
    };
    const node = new NodeModule(
        config,
        bots,
        compute as unknown as ComputeModule,
        durable as unknown as DurableFunctionsModule,
    );
    const db = moduleDatabase(node.migrations, "node-test");
    ensureAgentDatabaseConnection(db.database);
    cleanups.push(async () => db.close());
    await db.ready;
    const hooks = await node.beforeStart(db.context);
    const events: unknown[] = [];
    node.onUpdated(() => {
        events.push("updated");
    });
    return {
        root,
        config,
        node,
        db,
        hooks,
        durable,
        fs,
        compute,
        permissions,
        events,
        revoke: () => {
            active = false;
        },
    };
}

describe("installation display configuration", () => {
    it("rejects an entire mixed HTTP patch from a team member and permits the owner", async () => {
        const f = await fixture();
        let isOwner = false;
        const subscriptions = new Proxy({}, { get: () => () => () => undefined }) as never;
        const providerScan = { setOverrides: vi.fn() };
        const team = {
            enabled: true,
            onProfileUpdated: () => () => undefined,
            authenticate: async (ctx: Context) => withTeamUser(ctx, { isOwner } as TeamUser),
        };
        const api = new ApiModule(
            subscriptions,
            f.config,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            providerScan as never,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            subscriptions,
            team as never,
            subscriptions,
            f.node,
        );
        cleanups.push(() => api.close());
        await api.beforeStart(f.db.context, {} as never);
        await api.markReady();
        const patch = async (body: unknown) => {
            const request = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
            Object.assign(request, {
                method: "PATCH",
                url: "/v0/config",
                headers: { authorization: "Bearer team-token", "content-type": "application/json" },
            });
            let status = 200;
            let result = "";
            const response = {
                setHeader() {},
                writeHead(value: number) {
                    status = value;
                },
                end(value?: string) {
                    result = value ?? "";
                },
            } as unknown as ServerResponse;
            await api.handleRequest(f.db.context, request, response);
            return { status, body: JSON.parse(result) };
        };
        expect(
            await patch({ node: { name: "Forbidden" }, providers: { codex: { enabled: false } } }),
        ).toMatchObject({ status: 403, body: { code: "forbidden" } });
        expect(providerScan.setOverrides).not.toHaveBeenCalled();
        expect((await f.node.get(f.db.context)).name).toBe("Studio");
        expect(f.events).toEqual([]);
        expect(await patch({ node: {} })).toMatchObject({ status: 200 });
        isOwner = true;
        expect(await patch({ node: { name: "Owner's Mac" } })).toMatchObject({
            status: 200,
            body: { config: { node: { name: "Owner's Mac", avatar: null } } },
        });
        expect(f.events).toHaveLength(1);
    });

    it("commits before publishing, composes with caller rollback, and serializes names", async () => {
        const f = await fixture();
        expect(await f.node.get(f.db.context)).toEqual({ name: "Studio", avatar: null });
        await expect(
            f.db.context.inTx(async (ctx) => {
                await f.node.setName(ctx, "Uncommitted");
                expect((await f.node.get(ctx)).name).toBe("Uncommitted");
                expect(f.events).toEqual([]);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect((await f.node.get(f.db.context)).name).toBe("Studio");
        expect(f.events).toEqual([]);
        await Promise.all([
            f.node.setName(f.db.context, "First"),
            f.node.setName(f.db.context, "Last 🖥️"),
        ]);
        expect((await f.node.get(f.db.context)).name).toBe("Last 🖥️");
        expect(f.events).toHaveLength(2);
        await f.node.setName(f.db.context, "Last 🖥️");
        expect(f.events).toHaveLength(2);
        await f.durable.register.mock.calls[0]![0].executor(f.db.context);
        expect(await readFile(f.config.configuration.paths.runtimeConfigPath, "utf8")).toContain(
            'name = "Last 🖥️"',
        );
        expect(
            (await ConfigModule.load(join(f.root, ".happy"))).configuration.values.node.name,
        ).toBe("Last 🖥️");
        expect(f.config.configuration.values.p2p.name).toBe("Peer");
    });

    it("stores image and placeholder atomically, keeps the name, and ignores invalid images and no-ops", async () => {
        const f = await fixture();
        const bytes = await sharp({
            create: { width: 16, height: 12, channels: 4, background: "red" },
        })
            .png()
            .toBuffer();
        f.fs.readFileBuffer.mockResolvedValue(bytes);
        await f.node.setAvatarFromPath(f.db.context, "admin", "/image.png");
        const asset = await f.node.avatar(f.db.context);
        expect(asset).toMatchObject({
            etag: expect.stringMatching(/^"[a-f0-9]{64}"$/),
            thumbhash: expect.any(String),
        });
        expect(await f.node.get(f.db.context)).toEqual({
            name: "Studio",
            avatar: { thumbhash: asset!.thumbhash },
        });
        expect(f.fs.readFileBuffer).toHaveBeenCalledWith(f.permissions, "/image.png", {
            maxBytes: 8 * 1024 * 1024,
        });
        await f.node.setAvatarFromPath(f.db.context, "admin", "/image.png");
        expect(f.events).toHaveLength(1);
        await expect(
            f.db.context.inTx(async (ctx) => {
                await f.node.setAvatarFromPath(ctx, "admin", null);
                expect(await f.node.avatar(ctx)).toBeNull();
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await f.node.avatar(f.db.context)).toEqual(asset);
        f.fs.readFileBuffer.mockResolvedValue(Buffer.from("not an image"));
        await expect(f.node.setAvatarFromPath(f.db.context, "admin", "/bad.png")).rejects.toThrow(
            "readable PNG",
        );
        f.fs.stat.mockResolvedValue({ isFile: true, size: 8 * 1024 * 1024 + 1 });
        await expect(f.node.setAvatarFromPath(f.db.context, "admin", "/huge.png")).rejects.toThrow(
            "8 MiB",
        );
        expect(await f.node.avatar(f.db.context)).toEqual(asset);
        expect(f.events).toHaveLength(1);
        await f.node.setAvatarFromPath(f.db.context, "admin", null);
        await f.node.setAvatarFromPath(f.db.context, "admin", null);
        expect(f.events).toHaveLength(2);
        expect(await f.node.avatar(f.db.context)).toBeNull();
    });

    it("uses real tool policies and rechecks active admin authority at execution", async () => {
        const f = await fixture();
        const scope = { agent: { id: "admin" } } as AgentModuleScope;
        const tools = await f.hooks.tools!(f.db.context, scope);
        expect(tools.map((tool) => tool.name)).toEqual(["set_node_name", "set_node_avatar"]);
        expect(
            await f.hooks.tools!(f.db.context, { agent: { id: "ordinary" } } as AgentModuleScope),
        ).toEqual([]);
        const avatar = tools[1]!;
        for (const tool of tools) {
            expect(tool.requiresAutoOrFullAccess).toBe(true);
            expect(tool.shouldReviewInAutoMode?.({}, f.db.context)).toBe(true);
        }
        expect(tools[0]!.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(await avatar.shouldRunInFullAccessInAutoMode!({ path: null }, f.db.context)).toBe(
            false,
        );
        expect(
            await avatar.shouldRunInFullAccessInAutoMode!(
                { path: "/workspace/image.png" },
                f.db.context,
            ),
        ).toBe(false);
        f.compute.shouldReviewPath.mockResolvedValue(true);
        expect(
            await avatar.shouldRunInFullAccessInAutoMode!(
                { path: "/outside/image.png" },
                f.db.context,
            ),
        ).toBe(true);
        expect(
            avatar.describeAutoPermissionAction!({ path: "/outside/image.png" }, f.db.context),
        ).toContain("outside-workspace");
        f.revoke();
        expect(await f.hooks.tools!(f.db.context, scope)).toEqual([]);
        await expect(avatar.execute(f.db.context, { path: null }, {} as never)).rejects.toThrow(
            "active admin",
        );
        await expect(
            tools[0]!.execute(f.db.context, { name: "Forbidden" }, {} as never),
        ).rejects.toThrow("active admin");
        expect(f.events).toEqual([]);
    });

    it("ignores project display identity and validates machine configuration", async () => {
        const f = await fixture();
        await writeFile(join(f.root, "happy.toml"), '[node]\nname = "Repository"\n');
        const cwd = process.cwd();
        try {
            process.chdir(f.root);
            expect(
                (await ConfigModule.load(join(f.root, ".happy"))).configuration.values.node.name,
            ).toBe("Studio");
        } finally {
            process.chdir(cwd);
        }
        expect(() => parseHappyAgentConfigToml('[node]\nname=""')).toThrow();
        expect(() => parseHappyAgentConfigToml('[node]\navatar="no"')).toThrow();
    });

    it.each(["png", "jpeg", "webp"] as const)(
        "normalizes %s images and deterministically hashes the retained bytes",
        async (format) => {
            const bytes = await sharp({
                create: { width: 300, height: 200, channels: 3, background: "blue" },
            })
                .toFormat(format)
                .toBuffer();
            const asset = await normalizeNodeAvatar(bytes);
            expect(await normalizeNodeAvatar(bytes)).toEqual(asset);
            expect(await sharp(Buffer.from(asset.data, "base64")).metadata()).toMatchObject({
                format: "webp",
                width: 256,
            });
        },
    );

    it("rejects unsupported formats, too many pixels, and oversized input", async () => {
        await expect(
            normalizeNodeAvatar(
                Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'),
            ),
        ).rejects.toThrow("readable PNG");
        await expect(normalizeNodeAvatar(Buffer.alloc(8 * 1024 * 1024 + 1))).rejects.toThrow(
            "8 MiB",
        );
        const huge = await sharp({
            create: { width: 6400, height: 6400, channels: 3, background: "white" },
        })
            .png()
            .toBuffer();
        await expect(normalizeNodeAvatar(huge)).rejects.toThrow("40 million");
    });
});
