import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentSQLiteDatabase, AgentStorage, withAgentDatabase } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ServiceRecords,
    type ServiceRecord,
} from "../../../sources/services/persistence/ServiceRecords.js";

const workspaceId = "aaworkspace";
let fixture: Awaited<ReturnType<typeof createFixture>>;
beforeEach(async () => {
    fixture = await createFixture();
});
afterEach(async () => {
    await fixture?.close();
});

describe("durable workspace service records", () => {
    it("atomically admits at most 32 concurrent services and hides other workspaces", async () => {
        const results = await Promise.allSettled(
            Array.from({ length: 40 }, (_, index) =>
                fixture.records.create(fixture.ctx, input(index)),
            ),
        );
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(32);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(8);
        const page = await fixture.records.queryPage(fixture.ctx, workspaceId, {
            includeStopped: false,
            limit: 100,
        });
        expect(page.records).toHaveLength(32);
        expect(page.records.map((record) => record.sequence)).toEqual(
            Array.from({ length: 32 }, (_, i) => 31 - i),
        );
        await expect(
            fixture.records.query(fixture.ctx, "otherworkspace", page.records[0]!.service.id),
        ).resolves.toBeUndefined();
    });

    it("rolls back metadata, index, capacity, and admission with the caller's transaction", async () => {
        await expect(
            fixture.storage.transaction(fixture.ctx, async (txCtx) => {
                await fixture.records.create(txCtx, input(1));
                await fixture.records.closeAdmission(txCtx, workspaceId);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(
            (
                await fixture.records.queryPage(fixture.ctx, workspaceId, {
                    includeStopped: true,
                    limit: 100,
                })
            ).records,
        ).toEqual([]);
        const record = await fixture.records.create(fixture.ctx, input(1));
        expect(record.sequence).toBe(0);
    });

    it("retains capacity until teardown is confirmed and never revives a finished execution", async () => {
        const first = await fixture.records.create(fixture.ctx, input(1));
        const ended = {
            ...first.service,
            status: "killed" as const,
            endpointStatus: "unavailable" as const,
            endedAt: first.service.createdAt + 1,
            updatedAt: first.service.createdAt + 1,
            version: version(900),
        };
        await expect(
            fixture.records.replace(fixture.ctx, ended, first.service.version),
        ).rejects.toThrow("confirmed sandbox cleanup");
        expect(
            (
                await fixture.records.queryPage(fixture.ctx, workspaceId, {
                    includeStopped: false,
                    limit: 100,
                })
            ).records,
        ).toHaveLength(1);
        await fixture.records.replace(fixture.ctx, ended, first.service.version, true);
        expect(
            (
                await fixture.records.queryPage(fixture.ctx, workspaceId, {
                    includeStopped: false,
                    limit: 100,
                })
            ).records,
        ).toHaveLength(0);
        expect(
            (await fixture.records.query(fixture.ctx, workspaceId, first.service.id))?.service
                .status,
        ).toBe("killed");
        await expect(
            fixture.records.replace(
                fixture.ctx,
                { ...ended, status: "running", version: version(901) },
                ended.version,
            ),
        ).rejects.toThrow("cannot be changed or restarted");
    });

    it("rejects process rebinding, sandbox changes, and stale versions", async () => {
        const initial = await fixture.records.create(fixture.ctx, input(1));
        const running = {
            ...initial.service,
            status: "running" as const,
            processId: "aaprocess",
            startedAt: 1100,
            updatedAt: 1100,
            version: version(910),
        };
        await fixture.records.replace(fixture.ctx, running, initial.service.version);
        for (const change of [
            { processId: "anotherprocess" },
            { startedAt: 1101 },
            { sandbox: { ...running.sandbox, scratch: ["different"] } },
        ]) {
            await expect(
                fixture.records.replace(
                    fixture.ctx,
                    { ...running, ...change, version: version(911), updatedAt: 1200 },
                    running.version,
                ),
            ).rejects.toThrow();
        }
        await expect(
            fixture.records.replace(
                fixture.ctx,
                { ...running, version: version(912) },
                initial.service.version,
            ),
        ).rejects.toThrow("version changed");
        expect(
            (await fixture.records.query(fixture.ctx, workspaceId, running.id))?.service,
        ).toEqual(running);
    });

    it("rejects malformed identities and private fields before writing metadata", async () => {
        await expect(fixture.records.query(fixture.ctx, workspaceId, "")).rejects.toThrow(
            "identity is invalid",
        );
        const value = input(1);
        await expect(
            fixture.records.create(fixture.ctx, {
                ...value,
                service: { ...value.service, bridgeToken: "not-a-real-credential" },
            } as never),
        ).rejects.toThrow("initial service record is invalid");
        await expect(
            fixture.records.create(fixture.ctx, {
                ...value,
                service: { ...value.service, id: "service.with.scope" },
            }),
        ).rejects.toThrow("initial service record is invalid");
        expect(
            (
                await fixture.records.queryPage(fixture.ctx, workspaceId, {
                    includeStopped: true,
                    limit: 100,
                })
            ).records,
        ).toEqual([]);
    });

    it("durably closes admission while retaining discoverable work to stop", async () => {
        const first = await fixture.records.create(fixture.ctx, input(1));
        await expect(fixture.records.closeAdmission(fixture.ctx, workspaceId)).resolves.toEqual([
            first.service.id,
        ]);
        const restored = new ServiceRecords(fixture.storage.kv.scoped("services"));
        await expect(restored.create(fixture.ctx, input(2))).rejects.toThrow(
            "closed to new services",
        );
        expect(
            (
                await restored.queryPage(fixture.ctx, workspaceId, {
                    includeStopped: false,
                    limit: 100,
                })
            ).records,
        ).toHaveLength(1);
    });

    it("paginates across bounded index pages without listing a historical prefix", async () => {
        for (let index = 0; index < 270; index += 1) {
            const record = await fixture.records.create(fixture.ctx, input(index));
            await fixture.records.replace(
                fixture.ctx,
                {
                    ...record.service,
                    status: "completed",
                    endpointStatus: "unavailable",
                    exitCode: 0,
                    endedAt: record.service.createdAt + 1,
                    updatedAt: record.service.createdAt + 1,
                    version: version(index + 1000),
                },
                record.service.version,
                true,
            );
        }
        const reads = vi.spyOn(fixture.records.kv, "read");
        const lists = vi.spyOn(fixture.records.kv, "list");
        const first = await fixture.records.queryPage(fixture.ctx, workspaceId, {
            includeStopped: true,
            limit: 100,
        });
        expect(first.records).toHaveLength(100);
        expect(reads).toHaveBeenCalledTimes(103); // header, two bounded index pages, 100 records
        const second = await fixture.records.queryPage(fixture.ctx, workspaceId, {
            includeStopped: true,
            limit: 100,
            before: first.nextBefore!,
        });
        const third = await fixture.records.queryPage(fixture.ctx, workspaceId, {
            includeStopped: true,
            limit: 100,
            before: second.nextBefore!,
        });
        expect(
            [...first.records, ...second.records, ...third.records].map(
                (record) => record.sequence,
            ),
        ).toEqual(Array.from({ length: 270 }, (_, index) => 269 - index));
        expect(third.nextBefore).toBeNull();
        expect(lists).not.toHaveBeenCalled();
        expect(first.records[0]!.service.createdAt).toBeGreaterThan(
            first.records[1]!.service.createdAt,
        );
    }, 30_000);
});

function input(index: number): Omit<ServiceRecord, "sequence"> {
    const id = `s${index.toString().padStart(23, "0")}`;
    return {
        execution: { id, directory: `/private/service-controls/${id}` },
        service: {
            id,
            workspaceId,
            agentId: "aaowner",
            processId: null,
            name: "Preview",
            command: "serve",
            cwd: ".",
            port: 4187,
            tty: false,
            protocol: "http",
            access: "workspace",
            status: "starting",
            endpointStatus: "waiting",
            exitCode: null,
            error: null,
            sandbox: {
                inputs: ["public"],
                scratch: [],
                outbound: [],
                limits: { memoryMiB: 128, processes: 32 },
            },
            version: version(index),
            createdAt: 1000,
            updatedAt: 1000,
            startedAt: null,
            endedAt: null,
        },
    };
}
function version(index: number): string {
    return `00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}
async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), "happy-service-records-"));
    const connection = await openAgentSQLiteDatabase(join(directory, "records.db"));
    const ctx = withAgentDatabase(
        createRootContext().named("service-record-tests"),
        connection.database,
    );
    const storage = new AgentStorage({
        database: connection.database,
        acquireLock: async () => ({ release: async () => {} }),
    });
    const close = async () => {
        await connection.close();
        await rm(directory, { recursive: true, force: true });
    };
    try {
        await storage.migrate(ctx, []);
        return {
            connection,
            close,
            ctx,
            storage,
            records: new ServiceRecords(storage.kv.scoped("services")),
        };
    } catch (error) {
        await close();
        throw error;
    }
}
