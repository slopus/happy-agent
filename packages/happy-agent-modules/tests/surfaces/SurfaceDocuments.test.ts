import {
    agentDatabaseRows,
    agentDatabaseRun,
    ensureAgentDatabaseConnection,
    type AgentModuleScope,
    type AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SurfaceDocumentLiveFrame } from "@slopus/happy-agent-client";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { ArtifactsModule } from "../../sources/artifacts/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import type { RunnersModule } from "../../sources/runners/index.js";
import type { TasksModule } from "../../sources/tasks/index.js";
import type { TeamModule } from "../../sources/team/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { SurfacesModule } from "../../sources/surfaces/index.js";
import { DOCUMENT_FRAGMENT } from "../../sources/surfaces/documents/documentEditor.js";
import { SurfacesPersistence } from "../../sources/surfaces/persistence/SurfacesPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const close: (() => void)[] = [];
afterEach(() => {
    vi.useRealTimers();
    close
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
});

async function fixture() {
    const durable = new DurableFunctionsModule();
    const bots = {
        forAgent: async (_ctx: unknown, id: string) =>
            id === "admin" ? { isAdmin: true, status: "active" } : undefined,
    } as unknown as BotsModule;
    const team = {
        enabled: true,
        getUser: async (_ctx: unknown, id: string) =>
            ["alice", "bob"].includes(id) ? { id, authentication: "jwt" } : undefined,
    } as unknown as TeamModule;
    const make = (functions = durable) =>
        new SurfacesModule(
            functions,
            team,
            bots,
            { get: async () => undefined } as unknown as TasksModule,
            { get: async () => undefined } as unknown as ArtifactsModule,
            {
                resolve: async () => ({}),
                shouldReviewPath: async () => false,
            } as unknown as ComputeModule,
            {} as ConfigModule,
            { localExecution: true } as RunnersModule,
        );
    const surfaces = make();
    const db = moduleDatabase(
        [...durable.migrations, ...surfaces.migrations],
        "surface-documents-test",
    );
    ensureAgentDatabaseConnection(db.database);
    close.push(() => {
        durable.stop();
        db.close();
    });
    await db.ready;
    const hooks = surfaces.beforeStart(db.context, {} as AgentSystemRef);
    const frames: { streamId: string; frame: SurfaceDocumentLiveFrame }[] = [];
    surfaces.onDocumentFrame((streamId, frame) => frames.push({ streamId, frame }));
    const alice = { userId: "alice", agentId: null };
    return {
        surfaces,
        hooks,
        ctx: db.context,
        db,
        kv: new SurfacesPersistence(db.database).kv(),
        frames,
        alice,
        /** A second module over the same database: nothing cached, everything read back. */
        restarted: () => {
            const again = make(new DurableFunctionsModule());
            again.beforeStart(db.context, {} as AgentSystemRef);
            return again;
        },
        document: (text?: string, mutationId?: string) =>
            surfaces.create(
                db.context,
                {
                    type: "document",
                    name: "Notes",
                    ...(text === undefined ? {} : { text }),
                    ...(mutationId === undefined ? {} : { mutationId }),
                },
                "bob",
                undefined,
                alice,
            ),
    };
}

const load = (state: string | Uint8Array) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, typeof state === "string" ? Buffer.from(state, "base64") : state);
    return doc;
};
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const firstText = (doc: Y.Doc) => {
    const walk = (node: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined => {
        for (const child of node.toArray()) {
            if (child instanceof Y.XmlText) return child;
            const found = walk(child as Y.XmlElement);
            if (found !== undefined) return found;
        }
        return undefined;
    };
    return walk(doc.getXmlFragment(DOCUMENT_FRAGMENT))!;
};
/** A client's edit of the state it holds, as the update it would send. */
const edit = (doc: Y.Doc, change: (doc: Y.Doc) => void) => {
    const vector = Y.encodeStateVector(doc);
    change(doc);
    return base64(Y.encodeStateAsUpdate(doc, vector));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("collaborative document content", () => {
    it("starts with optional Markdown as change 1 and reports seq-derived versions", async () => {
        const t = await fixture();
        const notes = await t.document("# Notes\n", "create");
        const reading = await t.surfaces.document(t.ctx, notes.id);
        expect(reading.document).toMatchObject({
            text: "# Notes\n",
            seq: 1,
            authorUserId: "bob",
            lastEditorUserId: "alice",
        });
        expect(await t.surfaces.documentChanges(t.ctx, notes.id)).toEqual({
            updates: [
                {
                    seq: 1,
                    actor: t.alice,
                    source: "api",
                    mutationId: "create",
                    createdAt: reading.document.updatedAt,
                    size: expect.any(Number),
                },
            ],
            nextAfterSeq: null,
        });
        const empty = await t.document();
        const blank = (await t.surfaces.document(t.ctx, empty.id)).document;
        expect(blank).toMatchObject({ text: "", seq: 0, lastEditorUserId: null });
        expect(blank.updatedAt).toBe(blank.createdAt);
        expect(blank.version).not.toBe(reading.document.version);
        expect((await t.surfaces.documentState(t.ctx, empty.id, {})).seq).toBe(0);
        await expect(t.surfaces.document(t.ctx, empty.id, 1)).rejects.toMatchObject({
            code: "not_found",
        });
    });

    it("stores changes once per mutation, appends nothing for no-ops, and refuses invalid changes", async () => {
        const t = await fixture();
        const notes = await t.document("Hello\n");
        const client = load((await t.surfaces.documentState(t.ctx, notes.id, {})).update);
        const typed = edit(client, (doc) => firstText(doc).insert(5, " world"));
        expect(await t.surfaces.changeDocument(t.ctx, notes.id, typed, t.alice, "m1")).toEqual({
            seq: 2,
        });
        const other = edit(client, (doc) => firstText(doc).insert(0, ">> "));
        expect(await t.surfaces.changeDocument(t.ctx, notes.id, other, t.alice, "m1")).toEqual({
            seq: 2,
        });
        expect(await t.surfaces.changeDocument(t.ctx, notes.id, typed, t.alice, "m2")).toEqual({
            seq: 2,
        });
        expect((await t.surfaces.document(t.ctx, notes.id)).document.text).toBe("Hello world\n");
        expect((await t.surfaces.document(t.ctx, notes.id, 1)).document.text).toBe("Hello\n");
        await expect(t.surfaces.document(t.ctx, notes.id, 3)).rejects.toMatchObject({
            code: "not_found",
        });

        const ahead = new Y.Doc();
        Y.applyUpdate(
            ahead,
            Buffer.from((await t.surfaces.documentState(t.ctx, notes.id, {})).update, "base64"),
        );
        edit(ahead, (doc) => firstText(doc).insert(0, "unsent "));
        const dependent = edit(ahead, (doc) => firstText(doc).insert(0, "depends "));
        for (const update of [
            base64(new Uint8Array([1, 2, 3, 4, 5])),
            dependent,
            base64(new Uint8Array(1024 * 1024 + 1)),
        ])
            await expect(
                t.surfaces.changeDocument(t.ctx, notes.id, update, t.alice, `bad-${update.length}`),
            ).rejects.toMatchObject({
                code: "invalid_request",
            });
        expect(
            (await t.surfaces.documentChanges(t.ctx, notes.id)).updates.map((entry) => entry.seq),
        ).toEqual([1, 2]);

        const behind = load((await t.surfaces.documentState(t.ctx, notes.id, { seq: 1 })).update);
        const missing = await t.surfaces.documentState(t.ctx, notes.id, {
            stateVector: base64(Y.encodeStateVector(behind)),
        });
        Y.applyUpdate(behind, Buffer.from(missing.update, "base64"));
        expect(missing.seq).toBe(2);
        expect(Y.encodeStateVector(behind)).toEqual(
            new Uint8Array(Buffer.from(missing.stateVector, "base64")),
        );
        await expect(
            t.surfaces.documentState(t.ctx, notes.id, { seq: 1, stateVector: "" }),
        ).rejects.toMatchObject({
            code: "invalid_request",
        });
        for (const seq of [0, 3])
            await expect(t.surfaces.documentState(t.ctx, notes.id, { seq })).rejects.toMatchObject({
                code: "invalid_request",
            });
        await expect(
            t.surfaces.documentState(t.ctx, notes.id, { stateVector: "BQ==" }),
        ).rejects.toMatchObject({
            code: "invalid_request",
        });
    });

    it("commits with the caller's transaction and reaches subscribed streams only after commit", async () => {
        const t = await fixture();
        const notes = await t.document("Draft\n");
        expect(await t.surfaces.subscribeDocument(t.ctx, notes.id, "streama")).toEqual({ seq: 1 });
        const client = load((await t.surfaces.documentState(t.ctx, notes.id, {})).update);
        const typed = edit(client, (doc) => firstText(doc).insert(0, "New "));
        await expect(
            t.ctx.inTx(async (tx) => {
                expect(
                    await t.surfaces.changeDocument(tx, notes.id, typed, t.alice, "rolled"),
                ).toEqual({ seq: 2 });
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        await settle();
        expect(t.frames).toEqual([]);
        expect((await t.surfaces.document(t.ctx, notes.id)).document).toMatchObject({
            seq: 1,
            text: "Draft\n",
        });
        expect(await t.surfaces.changeDocument(t.ctx, notes.id, typed, t.alice, "kept")).toEqual({
            seq: 2,
        });
        await settle();
        expect(t.frames).toEqual([
            {
                streamId: "streama",
                frame: {
                    type: "document.update",
                    data: {
                        surfaceId: notes.id,
                        seq: 2,
                        update: typed,
                        mutationId: "kept",
                        actor: t.alice,
                        source: "api",
                    },
                },
            },
        ]);
        await t.surfaces.unsubscribeDocument(t.ctx, notes.id, "streama");
        await t.surfaces.changeDocument(
            t.ctx,
            notes.id,
            edit(client, (doc) => firstText(doc).insert(0, "x")),
            t.alice,
            "after",
        );
        await settle();
        expect(t.frames).toHaveLength(1);
    });

    it("converts a Markdown document an earlier daemon stored, once and atomically, keeping its revisions", async () => {
        const t = await fixture();
        const notes = await t.document("placeholder\n");
        const version = "01890a5d-ac96-774b-bcce-b302099a8057";
        const legacy = {
            surfaceId: notes.id,
            text: "# Old notes\n\nKept a_snake_name text.\n",
            authorUserId: "bob",
            lastEditorUserId: "alice",
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_001,
            version,
        };
        const db = new SurfacesPersistence(t.db.database);
        await t.ctx.inTx(async (tx) => {
            await t.kv.write(tx, `document.${notes.id}`, legacy);
            await t.kv.write(tx, `document-revision.${notes.id}.${version}`, {
                document: legacy,
                actor: t.alice,
                mutationId: "old-save",
                source: "api",
            });
            await t.kv.write(tx, `document-summary.${notes.id}.${version}`, {
                actor: t.alice,
                mutationId: "old-save",
                source: "api",
                version,
                updatedAt: legacy.updatedAt,
            });
            await db.deleteValue(tx, `document-log.${notes.id}`);
            await agentDatabaseRun(
                tx.db,
                sql`DELETE FROM happy_agent_surface_document_changes WHERE surface_id = ${notes.id}`,
            );
        });
        await expect(
            t.ctx.inTx(async (tx) => {
                expect((await t.surfaces.document(tx, notes.id)).document.seq).toBe(1);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await t.kv.read(t.ctx, `document-log.${notes.id}`)).toBeUndefined();
        const converted = (await t.restarted().document(t.ctx, notes.id)).document;
        expect(converted).toMatchObject({
            text: legacy.text,
            seq: 1,
            authorUserId: "bob",
            lastEditorUserId: null,
            createdAt: legacy.createdAt,
        });
        expect((await t.surfaces.documentChanges(t.ctx, notes.id)).updates).toMatchObject([
            {
                seq: 1,
                source: "conversion",
                actor: { userId: null, agentId: null },
                mutationId: null,
            },
        ]);
        expect((await t.surfaces.document(t.ctx, notes.id)).document.seq).toBe(1);
        expect((await t.surfaces.documentVersions(t.ctx, notes.id)).versions).toMatchObject([
            { version, mutationId: "old-save" },
        ]);
        expect((await t.surfaces.getDocumentVersion(t.ctx, notes.id, version)).document).toEqual(
            legacy,
        );
    });

    it("snapshots long logs and replays every version the same after a restart", async () => {
        const t = await fixture();
        const notes = await t.document("start\n");
        const client = load((await t.surfaces.documentState(t.ctx, notes.id, {})).update);
        for (let index = 0; index < 300; index += 1)
            await t.surfaces.changeDocument(
                t.ctx,
                notes.id,
                edit(client, (doc) => firstText(doc).insert(firstText(doc).length, ` ${index}`)),
                t.alice,
                `m${index}`,
            );
        const snapshots = await agentDatabaseRows<{ seq: number }>(
            t.db.database,
            sql`SELECT seq FROM happy_agent_surface_document_snapshots WHERE surface_id = ${notes.id}`,
        );
        expect(snapshots.map((row) => Number(row.seq))).toEqual([256]);
        const restarted = t.restarted();
        const current = (await t.surfaces.document(t.ctx, notes.id)).document.text;
        expect((await restarted.document(t.ctx, notes.id)).document.text).toBe(current);
        expect((await restarted.document(t.ctx, notes.id, 101)).document.text).toBe(
            `start${Array.from({ length: 100 }, (_, index) => ` ${index}`).join("")}\n`,
        );
        expect((await restarted.document(t.ctx, notes.id, 290)).document.text).toBe(
            `start${Array.from({ length: 289 }, (_, index) => ` ${index}`).join("")}\n`,
        );
        const page = await restarted.documentChanges(t.ctx, notes.id, 290, 200);
        expect(page.updates.map((entry) => entry.seq)).toEqual(
            Array.from({ length: 11 }, (_, index) => 291 + index),
        );
        expect(page.nextAfterSeq).toBeNull();
    });

    it("relays presence to other streams and ends it on unsubscribe, close, and silence", async () => {
        const t = await fixture();
        const notes = await t.document("Shared\n");
        await t.surfaces.subscribeDocument(t.ctx, notes.id, "streama");
        await t.surfaces.subscribeDocument(t.ctx, notes.id, "streamb");
        await t.surfaces.shareDocumentPresence(t.ctx, notes.id, "streamc", 7, "AA==");
        expect(t.frames).toEqual([]);
        await t.surfaces.shareDocumentPresence(t.ctx, notes.id, "streama", 7, "AQ==");
        const presence = t.frames.filter((entry) => entry.frame.type === "document.presence");
        expect(presence).toMatchObject([
            {
                streamId: "streamb",
                frame: {
                    data: { active: true, revision: 1, awarenessClientId: 7, update: "AQ==" },
                },
            },
        ]);
        const clientKey = (presence[0]!.frame.data as { clientKey: string }).clientKey;
        await t.surfaces.subscribeDocument(t.ctx, notes.id, "streamc");
        expect(t.frames.at(-1)).toMatchObject({
            streamId: "streamc",
            frame: { data: { clientKey, active: true, revision: 1 } },
        });
        t.frames.length = 0;
        await t.surfaces.unsubscribeDocument(t.ctx, notes.id, "streama");
        expect(t.frames.map((entry) => entry.streamId).sort()).toEqual(["streamb", "streamc"]);
        expect(t.frames[0]!.frame.data).toEqual({
            surfaceId: notes.id,
            clientKey,
            revision: 2,
            active: false,
            awarenessClientId: 7,
        });

        t.frames.length = 0;
        await t.surfaces.shareDocumentPresence(t.ctx, notes.id, "streamb", 8, "Ag==");
        t.surfaces.closeDocumentStream("streamb");
        expect(
            t.frames.map((entry) => [
                entry.streamId,
                (entry.frame.data as { active: boolean }).active,
            ]),
        ).toEqual([
            ["streamc", true],
            ["streamc", false],
        ]);

        await t.surfaces.subscribeDocument(t.ctx, notes.id, "streamd");
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await t.surfaces.shareDocumentPresence(t.ctx, notes.id, "streamc", 9, "Aw==");
        t.frames.length = 0;
        vi.advanceTimersByTime(30_000);
        expect(t.frames).toMatchObject([
            { streamId: "streamd", frame: { data: { active: false, awarenessClientId: 9 } } },
        ]);
    });

    it("limits documents per stream and streams per document", async () => {
        const t = await fixture();
        const documents = [];
        for (let index = 0; index < 33; index += 1) documents.push(await t.document());
        for (const document of documents.slice(0, 32))
            await t.surfaces.subscribeDocument(t.ctx, document.id, "busy");
        await expect(
            t.surfaces.subscribeDocument(t.ctx, documents[32]!.id, "busy"),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await t.surfaces.subscribeDocument(t.ctx, documents[0]!.id, "busy")).toEqual({
            seq: 0,
        });
        for (let index = 0; index < 63; index += 1)
            await t.surfaces.subscribeDocument(t.ctx, documents[0]!.id, `s${index}`);
        await expect(
            t.surfaces.subscribeDocument(t.ctx, documents[0]!.id, "late"),
        ).rejects.toMatchObject({ code: "conflict" });
        await expect(
            t.surfaces.subscribeDocument(t.ctx, "abcdefghijklmnopqrstuvwx", "late"),
        ).rejects.toMatchObject({
            code: "not_found",
        });
    });

    it("gives agents seq-based Markdown tools that merge, report omissions, and refuse unknown content", async () => {
        const t = await fixture();
        const scope = { agent: { id: "writer" }, kv: t.kv.scoped("writer") } as AgentModuleScope;
        await scope.kv.write(t.ctx, "owner", "alice");
        const tools = await t.hooks.tools!(t.ctx, scope);
        const tool = (name: string) => tools.find((entry) => entry.name === name)!;
        for (const name of ["read_document", "update_document", "list_document_versions"]) {
            expect(tool(name).defer, name).toBe(true);
            expect(tool(name).shouldReviewInAutoMode!({}, t.ctx), name).toBe(
                name === "update_document",
            );
            expect(tool(name).shouldRunInFullAccessInAutoMode, name).toBeUndefined();
        }
        expect(
            tool("update_document").describeAutoPermissionAction!({ tabId: "x" }, t.ctx),
        ).toContain("shared data write");
        const notes = await t.document("# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n");
        const read = (await tool("read_document").execute(
            t.ctx,
            { tabId: notes.id },
            {} as never,
        )) as {
            document: { seq: number; text: string };
            omitted?: string;
        };
        expect(read).toEqual({ document: expect.objectContaining({ seq: 1 }) });
        const client = load((await t.surfaces.documentState(t.ctx, notes.id, {})).update);
        await t.surfaces.changeDocument(
            t.ctx,
            notes.id,
            edit(client, (doc) => {
                const text = firstText(doc);
                text.format(0, 2, { underline: true });
            }),
            t.alice,
            "underline",
        );
        const written = (await tool("update_document").execute(
            t.ctx,
            {
                tabId: notes.id,
                seq: read.document.seq,
                text: read.document.text.replace("Second", "Revised second"),
            },
            {} as never,
        )) as { document: { seq: number; text: string }; changed: boolean; omitted?: string };
        expect(written).toMatchObject({
            changed: true,
            document: { seq: 3, text: "# Plan\n\nFirst paragraph.\n\nRevised second paragraph.\n" },
            omitted: expect.stringContaining("underline"),
        });
        expect(
            await tool("update_document").execute(
                t.ctx,
                { tabId: notes.id, seq: 3, text: written.document.text },
                {} as never,
            ),
        ).toMatchObject({ changed: false, document: { seq: 3 } });
        await expect(
            tool("update_document").execute(
                t.ctx,
                { tabId: notes.id, seq: 4, text: "x" },
                {} as never,
            ),
        ).rejects.toMatchObject({ code: "invalid_request" });
        expect(
            await tool("list_document_versions").execute(
                t.ctx,
                { tabId: notes.id, limit: 2 },
                {} as never,
            ),
        ).toMatchObject({
            updates: [{ seq: 1 }, { seq: 2 }],
            nextAfterSeq: 2,
        });
        expect((await t.surfaces.documentChanges(t.ctx, notes.id, 2)).updates).toMatchObject([
            {
                seq: 3,
                source: "tool",
                actor: { userId: "alice", agentId: "writer" },
                mutationId: null,
            },
        ]);

        const future = edit(
            load((await t.surfaces.documentState(t.ctx, notes.id, {})).update),
            (doc) => {
                const group = doc.getXmlFragment(DOCUMENT_FRAGMENT).get(0) as Y.XmlElement;
                const container = new Y.XmlElement("blockContainer");
                container.insert(0, [new Y.XmlElement("futureBlock")]);
                group.insert(group.length, [container]);
            },
        );
        await t.surfaces.changeDocument(t.ctx, notes.id, future, t.alice, "future");
        await expect(
            tool("update_document").execute(
                t.ctx,
                { tabId: notes.id, seq: 4, text: "Replaced" },
                {} as never,
            ),
        ).rejects.toMatchObject({
            code: "invalid_request",
            message: expect.stringContaining("cannot represent"),
        });
        expect((await t.surfaces.document(t.ctx, notes.id)).document.seq).toBe(4);
    });
});
