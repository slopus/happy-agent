import { cuid2Schema, type AgentKV } from "@slopus/happy-agent-base";
import { workspaceServiceSchema, type WorkspaceService } from "@slopus/happy-agent-client";
import { computeServiceExecutionSchema } from "@slopus/happy-agent-compute";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

const exact = { additionalProperties: false } as const;
const sequenceSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const storedServiceSchema = Type.Object(
    {
        ...workspaceServiceSchema.properties,
        id: cuid2Schema,
        workspaceId: cuid2Schema,
        agentId: cuid2Schema,
        processId: Type.Union([Type.Null(), cuid2Schema]),
        error: Type.Union([
            Type.Null(),
            Type.Object(
                {
                    code: Type.String({ minLength: 1, maxLength: 128 }),
                    message: Type.String({ minLength: 1, maxLength: 4096 }),
                },
                exact,
            ),
        ]),
        version: Type.String({
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        }),
        createdAt: sequenceSchema,
        updatedAt: sequenceSchema,
        startedAt: Type.Union([Type.Null(), sequenceSchema]),
        endedAt: Type.Union([Type.Null(), sequenceSchema]),
    },
    exact,
);
const recordSchema = Type.Object(
    {
        service: storedServiceSchema,
        execution: computeServiceExecutionSchema,
        sequence: sequenceSchema,
    },
    exact,
);
const newRecordSchema = Type.Omit(recordSchema, ["sequence"]);
const headerSchema = Type.Object(
    {
        nextSequence: sequenceSchema,
        lastCreatedAt: sequenceSchema,
        activeIds: Type.Array(cuid2Schema, { maxItems: 32, uniqueItems: true }),
        closed: Type.Boolean(),
    },
    exact,
);
const indexPageSchema = Type.Array(cuid2Schema, { maxItems: 256, uniqueItems: true });
const querySchema = Type.Object(
    {
        includeStopped: Type.Boolean(),
        limit: Type.Integer({ minimum: 1, maximum: 288 }),
        before: Type.Optional(sequenceSchema),
    },
    exact,
);
export type ServiceRecord = Static<typeof recordSchema>;
export type ServiceRecordQuery = Static<typeof querySchema>;

/** Complete semantic operations over the feature's supplied shared AgentKV. */
export class ServiceRecords {
    constructor(readonly kv: AgentKV) {}

    /** One immutable owner placement makes aborts bounded, including unstarted durable work. */
    async ownerWorkspace(ctx: Context, agentId: string): Promise<string | undefined> {
        assertIdentity(agentId);
        return await readChecked(ctx, this.kv, `owner.${agentId}!`, cuid2Schema);
    }

    async query(
        ctx: Context,
        workspaceId: string,
        serviceId: string,
    ): Promise<ServiceRecord | undefined> {
        assertIdentity(workspaceId);
        assertIdentity(serviceId);
        const record = await readChecked(ctx, this.kv, recordKey(serviceId), recordSchema);
        return record?.service.workspaceId === workspaceId ? record : undefined;
    }

    async create(ctx: Context, input: Static<typeof newRecordSchema>): Promise<ServiceRecord> {
        if (!Value.Check(newRecordSchema, input) || input.service.status !== "starting") {
            throw new Error("The initial service record is invalid.");
        }
        return this.kv.transaction(ctx, async (_, txCtx) => {
            const service = structuredClone(input.service);
            const ownerWorkspace = await this.ownerWorkspace(txCtx, service.agentId);
            if (ownerWorkspace !== undefined && ownerWorkspace !== service.workspaceId) {
                throw new Error("A service owner cannot be moved to another workspace.");
            }
            const header = await this.#header(txCtx, service.workspaceId);
            if (header.closed) throw new Error("This workspace is closed to new services.");
            if (header.activeIds.length >= 32)
                throw new Error("This workspace already has 32 active services.");
            if (await readChecked(txCtx, this.kv, recordKey(service.id), recordSchema)) {
                throw new Error("The service identity is already in use.");
            }
            if (header.nextSequence === Number.MAX_SAFE_INTEGER)
                throw new Error("The service catalog is full.");
            // Keep append order identical to createdAt/id order, even after a clock adjustment.
            service.createdAt = Math.max(service.createdAt, header.lastCreatedAt + 1);
            service.updatedAt = service.createdAt;
            const record: ServiceRecord = {
                ...structuredClone(input),
                service,
                sequence: header.nextSequence,
            };
            if (!Value.Check(recordSchema, record))
                throw new Error("The service record is invalid.");
            const key = pageKey(service.workspaceId, Math.floor(record.sequence / 256));
            const page = (await readChecked(txCtx, this.kv, key, indexPageSchema)) ?? [];
            if (page.length !== record.sequence % 256)
                throw new Error("The service history index is inconsistent.");
            page.push(service.id);
            header.activeIds.push(service.id);
            header.nextSequence += 1;
            header.lastCreatedAt = service.createdAt;
            await this.kv.write(txCtx, recordKey(service.id), record);
            await this.kv.write(txCtx, `owner.${service.agentId}!`, service.workspaceId);
            await this.kv.write(txCtx, key, page);
            await this.kv.write(txCtx, headerKey(service.workspaceId), header);
            return structuredClone(record);
        });
    }

    async queryPage(
        ctx: Context,
        workspaceId: string,
        query: ServiceRecordQuery,
    ): Promise<{
        records: ServiceRecord[];
        nextBefore: number | null;
    }> {
        assertIdentity(workspaceId);
        if (!Value.Check(querySchema, query)) throw new Error("The service page query is invalid.");
        return this.kv.transaction(ctx, async (_, txCtx) => {
            const header = await this.#header(txCtx, workspaceId);
            let before = Math.min(query.before ?? header.nextSequence, header.nextSequence);
            if (!query.includeStopped) {
                const active = await Promise.all(
                    header.activeIds.map((id) => this.#required(txCtx, workspaceId, id)),
                );
                const matching = active
                    .filter((record) => record.sequence < before)
                    .sort((a, b) => b.sequence - a.sequence);
                const records = matching.slice(0, query.limit);
                return {
                    records,
                    nextBefore: matching.length > records.length ? records.at(-1)!.sequence : null,
                };
            }
            const records: ServiceRecord[] = [];
            while (before > 0 && records.length < query.limit) {
                const pageNumber = Math.floor((before - 1) / 256);
                const page = await readChecked(
                    txCtx,
                    this.kv,
                    pageKey(workspaceId, pageNumber),
                    indexPageSchema,
                );
                if (page === undefined) throw new Error("The service history page is missing.");
                while (before > pageNumber * 256 && records.length < query.limit) {
                    before -= 1;
                    const id = page[before % 256];
                    if (id === undefined) throw new Error("The service history entry is missing.");
                    const record = await this.#required(txCtx, workspaceId, id);
                    if (record.sequence !== before)
                        throw new Error("The service history order is inconsistent.");
                    records.push(record);
                }
            }
            return { records, nextBefore: before > 0 ? before : null };
        });
    }

    /** Only the runtime owner may supply confirmedTeardown after its native completion barrier. */
    async replace(
        ctx: Context,
        service: WorkspaceService,
        previousVersion: string,
        confirmedTeardown = false,
    ): Promise<void> {
        if (!Value.Check(storedServiceSchema, service))
            throw new Error("The service update is invalid.");
        await this.kv.transaction(ctx, async (_, txCtx) => {
            const record = await this.#required(txCtx, service.workspaceId, service.id);
            const before = record.service;
            if (before.version !== previousVersion) throw new Error("The service version changed.");
            if (terminal(before.status))
                throw new Error("A finished service cannot be changed or restarted.");
            if (
                (before.processId !== null && service.processId !== before.processId) ||
                (before.startedAt !== null && service.startedAt !== before.startedAt)
            ) {
                throw new Error("A service cannot be rebound to another process or startup.");
            }
            const immutable = [
                "agentId",
                "command",
                "cwd",
                "name",
                "port",
                "tty",
                "protocol",
                "access",
                "sandbox",
                "createdAt",
            ] as const;
            if (
                immutable.some(
                    (key) => JSON.stringify(before[key]) !== JSON.stringify(service[key]),
                )
            ) {
                throw new Error("A service execution's identity and sandbox cannot change.");
            }
            if (service.version === before.version || service.updatedAt < before.updatedAt) {
                throw new Error("The service update must advance its version and timestamp.");
            }
            if (
                (before.status === "stopping" &&
                    !terminal(service.status) &&
                    service.status !== "stopping") ||
                (before.status === "running" && service.status === "starting")
            ) {
                throw new Error("A service cannot return to an earlier lifecycle state.");
            }
            if (terminal(service.status)) {
                if (
                    !confirmedTeardown ||
                    service.endedAt === null ||
                    service.endpointStatus !== "unavailable"
                ) {
                    throw new Error("Service termination requires confirmed sandbox cleanup.");
                }
                const header = await this.#header(txCtx, service.workspaceId);
                header.activeIds = header.activeIds.filter((id) => id !== service.id);
                await this.kv.write(txCtx, headerKey(service.workspaceId), header);
            }
            await this.kv.write(txCtx, recordKey(service.id), {
                ...record,
                service: structuredClone(service),
            });
        });
    }

    async closeAdmission(ctx: Context, workspaceId: string): Promise<readonly string[]> {
        assertIdentity(workspaceId);
        return this.kv.transaction(ctx, async (_, txCtx) => {
            const header = await this.#header(txCtx, workspaceId);
            header.closed = true;
            await this.kv.write(txCtx, headerKey(workspaceId), header);
            return [...header.activeIds];
        });
    }

    /** Restore admits new identities without reviving or rebinding any previous execution. */
    async reopenAdmission(ctx: Context, workspaceId: string): Promise<void> {
        assertIdentity(workspaceId);
        await this.kv.transaction(ctx, async (_, txCtx) => {
            const header = await this.#header(txCtx, workspaceId);
            if (!header.closed) return;
            header.closed = false;
            await this.kv.write(txCtx, headerKey(workspaceId), header);
        });
    }

    async #header(ctx: Context, workspaceId: string): Promise<Static<typeof headerSchema>> {
        return (
            (await readChecked(ctx, this.kv, headerKey(workspaceId), headerSchema)) ?? {
                nextSequence: 0,
                lastCreatedAt: 0,
                activeIds: [],
                closed: false,
            }
        );
    }

    async #required(ctx: Context, workspaceId: string, serviceId: string): Promise<ServiceRecord> {
        const record = await this.query(ctx, workspaceId, serviceId);
        if (record === undefined) throw new Error("The service record was not found.");
        return record;
    }
}

async function readChecked<Schema extends TSchema>(
    ctx: Context,
    kv: AgentKV,
    key: string,
    schema: Schema,
): Promise<Static<Schema> | undefined> {
    const value = await kv.read(ctx, key);
    if (value === undefined) return undefined;
    if (!Value.Check(schema, value)) throw new Error("Stored service state is invalid.");
    return structuredClone(value);
}
function assertIdentity(value: string): void {
    if (!Value.Check(cuid2Schema, value))
        throw new Error("The service or workspace identity is invalid.");
}
function terminal(status: WorkspaceService["status"]): boolean {
    return status === "completed" || status === "killed" || status === "failed";
}
// Sentinels keep AgentKV's prefix-based point reads from collecting neighboring keys.
function recordKey(id: string): string {
    return `record.${id}!`;
}
function headerKey(id: string): string {
    return `workspace.${id}.header!`;
}
function pageKey(id: string, page: number): string {
    return `workspace.${id}.page.${page.toString().padStart(16, "0")}!`;
}
