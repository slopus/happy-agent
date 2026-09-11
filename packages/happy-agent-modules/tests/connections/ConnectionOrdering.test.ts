import { agentDatabaseRun, ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import {
    connectionsUpdatedPayloadSchema,
    type ConnectionsUpdatedPayload,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotsModule } from "../../sources/bots/index.js";
import type { CloudModule } from "../../sources/cloud/index.js";
import type { ConfigModule, RemoteConnectionEntry } from "../../sources/config/index.js";
import { ConnectionsModule } from "../../sources/connections/index.js";
import {
    connectionsMigrations,
    queryConnectionSnapshot,
} from "../../sources/connections/persistence/connectionSnapshot.js";
import type { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import type { TailcatModule } from "../../sources/tailcat/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const databases: ModuleDatabase[] = [];
afterEach(() => {
    for (const database of databases.splice(0)) database.close();
});

const entry = (name: string): RemoteConnectionEntry => ({
    name,
    address: "tcPrivate",
    token: "r".repeat(43),
});
async function fixture() {
    const configured: Record<string, RemoteConnectionEntry> = {
        zebra: entry("Zebra"),
        alpha: entry("Alpha"),
        middle: entry("Middle"),
    };
    const config = {
        get connections() {
            return structuredClone(configured);
        },
    } as ConfigModule;
    const module = new ConnectionsModule(
        config,
        {} as BotsModule,
        {} as CloudModule,
        {} as TailcatModule,
        { register: vi.fn() } as unknown as DurableFunctionsModule,
    );
    const database = moduleDatabase(module.migrations, "connection-ordering");
    ensureAgentDatabaseConnection(database.database);
    databases.push(database);
    await database.ready;
    return { module, configured, database, ctx: database.context };
}

describe("durable connection ordering", () => {
    it("appends new connections after reordered survivors and preserves metadata-only edits", async () => {
        const f = await fixture();
        const initial = await f.module.getSnapshot(f.ctx);
        expect(initial.connections.map((connection) => connection.id)).toEqual([
            "alpha",
            "middle",
            "zebra",
        ]);
        const moved = await f.module.reorder(f.ctx, "alpha", "zebra", initial.version);
        f.configured.aardvark = entry("Aardvark");
        f.configured.aaa = entry("First new ID");
        f.configured.middle = entry("Renamed");
        const appended = await f.module.getSnapshot(f.ctx);
        expect(appended.connections.map((connection) => connection.id)).toEqual([
            "middle",
            "zebra",
            "alpha",
            "aaa",
            "aardvark",
        ]);
        for (const original of moved.connections)
            expect(
                appended.connections.find((connection) => connection.id === original.id)?.orderKey,
            ).toBe(original.orderKey);
        f.configured.middle = { enabled: false };
        await f.module.getSnapshot(f.ctx);
        f.configured.middle = entry("Returned");
        const returned = await f.module.getSnapshot(f.ctx);
        expect(returned.connections.at(-1)?.id).toBe("middle");
        expect(returned.connections.at(-1)?.orderKey).not.toBe(moved.connections[0]!.orderKey);
    });

    it("composes multiple moves in one transaction and rolls back keys, versions, and notifications", async () => {
        const f = await fixture();
        const initial = await f.module.getSnapshot(f.ctx);
        const events: { snapshot: ConnectionsUpdatedPayload; mutationId: string | undefined }[] =
            [];
        f.module.onUpdated((_ctx, snapshot, mutationId) => events.push({ snapshot, mutationId }));
        await expect(
            f.ctx.inTx(async (txCtx) => {
                const moved = await f.module.reorder(
                    txCtx,
                    "zebra",
                    null,
                    initial.version,
                    "rollback",
                );
                expect(await f.module.list(txCtx)).toEqual(moved.connections);
                const second = await f.module.reorder(txCtx, "middle", "zebra", moved.version);
                expect(await queryConnectionSnapshot(txCtx)).toEqual(second);
                expect(events).toEqual([]);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await f.module.getSnapshot(f.ctx)).toEqual(initial);
        expect(events).toEqual([]);
        const committed = await f.ctx.inTx(async (txCtx) => {
            const moved = await f.module.reorder(
                txCtx,
                "zebra",
                null,
                initial.version,
                "committed",
            );
            expect(events).toEqual([]);
            return moved;
        });
        expect(events).toEqual([{ snapshot: committed, mutationId: "committed" }]);
        expect(await queryConnectionSnapshot(f.ctx)).toEqual(committed);
    });

    it("serializes concurrent guarded moves, preserving the winning snapshot", async () => {
        const f = await fixture();
        const initial = await f.module.getSnapshot(f.ctx);
        const events: ConnectionsUpdatedPayload[] = [];
        f.module.onUpdated((_ctx, snapshot) => events.push(snapshot));
        const results = await Promise.allSettled([
            f.module.reorder(f.ctx, "zebra", null, initial.version),
            f.module.reorder(f.ctx, "alpha", "middle", initial.version),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const current = await f.module.getSnapshot(f.ctx);
        expect(results.find((result) => result.status === "rejected")).toMatchObject({
            reason: { status: 409, code: "conflict", current },
        });
        expect(events).toEqual([current]);
    });

    it("keeps no-op positions unchanged and leaves state intact after invalid moves", async () => {
        const f = await fixture();
        const initial = await f.module.getSnapshot(f.ctx);
        const events: ConnectionsUpdatedPayload[] = [];
        f.module.onUpdated((_ctx, snapshot) => events.push(snapshot));
        expect(await f.module.reorder(f.ctx, "alpha", null, initial.version)).toEqual(initial);
        expect(await f.module.reorder(f.ctx, "middle", "alpha", initial.version)).toEqual(initial);
        for (const [id, afterId, status] of [
            ["missing", null, 404],
            ["alpha", "missing", 404],
            ["alpha", "alpha", 400],
        ] as const) {
            await expect(
                f.module.reorder(f.ctx, id, afterId, initial.version),
            ).rejects.toMatchObject({ status });
        }
        expect(events).toEqual([]);
        expect(await queryConnectionSnapshot(f.ctx)).toEqual(initial);
    });

    it("does not return an uncommitted reconciliation version in a reorder conflict", async () => {
        const f = await fixture();
        const initial = await f.module.getSnapshot(f.ctx);
        f.configured.new = entry("Pending config edit");
        await expect(
            f.module.reorder(f.ctx, "alpha", null, "01900000-0000-7000-8000-000000000001"),
        ).rejects.toMatchObject({ current: initial });
        expect(await queryConnectionSnapshot(f.ctx)).toEqual(initial);
        const reconciled = await f.module.getSnapshot(f.ctx);
        expect(reconciled.connections.at(-1)?.id).toBe("new");
        expect(await f.module.reorder(f.ctx, "alpha", null, reconciled.version)).toEqual(
            reconciled,
        );
    });

    it("backfills existing snapshots in ID order before validating required keys", async () => {
        const database = moduleDatabase(connectionsMigrations.slice(0, 1), "connection-migration");
        ensureAgentDatabaseConnection(database.database);
        databases.push(database);
        await database.ready;
        const previous = {
            version: "01900000-0000-7000-8000-000000000001",
            connections: [
                { id: "zebra", name: "Zebra", authentication: "bearer" },
                {
                    id: "alpha",
                    name: "Alpha",
                    authentication: "workos",
                    organizationId: "org_test",
                },
            ],
        };
        await agentDatabaseRun(
            database.database,
            sql`INSERT INTO happy_agent_connections_snapshot (singleton_id, snapshot_json) VALUES (1, ${JSON.stringify(previous)})`,
        );
        await database.context.inTx(async (txCtx) => {
            await connectionsMigrations[1]![1](txCtx, txCtx.db);
        });
        const migrated = (await queryConnectionSnapshot(database.context))!;
        expect(Value.Check(connectionsUpdatedPayloadSchema, migrated)).toBe(true);
        expect(migrated.version > previous.version).toBe(true);
        expect(migrated.connections).toEqual([
            { ...previous.connections[1], orderKey: "00000000000000000001" },
            { ...previous.connections[0], orderKey: "00000000000000000002" },
        ]);
    });
});
