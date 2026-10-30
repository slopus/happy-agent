import {
    ensureAgentDatabaseConnection,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArtifactsModule } from "../../sources/artifacts/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { MAX_PROMPT_DOCUMENTS } from "../../sources/surfaces/promptDocuments/PromptDocument.js";
import type { RunnersModule } from "../../sources/runners/index.js";
import { SurfacesModule } from "../../sources/surfaces/index.js";
import type { TasksModule } from "../../sources/tasks/index.js";
import type { TeamModule } from "../../sources/team/index.js";
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
        forAgent: async (_ctx: Context, agentId: string) => {
            if (agentId === "admin-agent") return { isAdmin: true, status: "active" };
            if (agentId === "ordinary-bot") return { isAdmin: false, status: "active" };
            if (agentId === "archived-admin") return { isAdmin: true, status: "archived" };
            return undefined;
        },
    } as unknown as BotsModule;
    const team = {
        enabled: true,
        getUser: async (_ctx: unknown, id: string) =>
            id === "alice" ? { id, authentication: "jwt" } : undefined,
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
            { enabled: false } as RunnersModule,
        );
    const surfaces = make();
    const db = moduleDatabase(
        [...durable.migrations, ...surfaces.migrations],
        "prompt-documents-test",
    );
    ensureAgentDatabaseConnection(db.database);
    close.push(() => {
        durable.stop();
        db.close();
    });
    await db.ready;
    const hooks = surfaces.beforeStart(db.context, {} as AgentSystemRef);
    const ctx = db.context;
    const scope = (agentId: string) => ({ agent: { id: agentId } }) as unknown as AgentModuleScope;
    const toolsFor = async (agentId: string): Promise<readonly AnyAgentTool[]> =>
        (await hooks.tools?.(ctx, scope(agentId))) ?? [];
    return {
        ctx,
        surfaces,
        /** Another module over the same database, as after a restart: nothing kept in memory. */
        restarted: () => {
            const again = make(new DurableFunctionsModule());
            again.beforeStart(db.context, {} as AgentSystemRef);
            return again;
        },
        instructions: async (agentId = "some-agent") =>
            (await hooks.instructions?.(ctx, scope(agentId))) ?? "",
        toolNames: async (agentId: string) =>
            (await toolsFor(agentId))
                .map((tool) => tool.name)
                .filter((name) => name.includes("prompt_document")),
        tool: async (name: string) => {
            const tool = (await toolsFor("admin-agent")).find((item) => item.name === name);
            if (tool === undefined) throw new Error(`The ${name} tool is missing.`);
            return tool;
        },
        document: (name: string) =>
            surfaces.create(ctx, { type: "document", name }, "alice", undefined, {
                userId: "alice",
                agentId: null,
            }),
        todoList: (name: string) =>
            surfaces.create(ctx, { type: "todo", name }, "alice", undefined, {
                userId: "alice",
                agentId: null,
            }),
    };
}

describe("important documents", () => {
    it("adds nothing to the instructions while no document is marked", async () => {
        const t = await fixture();
        await expect(t.instructions()).resolves.not.toContain("# Important documents");
        await expect(t.surfaces.promptDocuments(t.ctx)).resolves.toEqual([]);
    });

    it("lists marked documents in every agent's instructions, oldest mark first", async () => {
        const t = await fixture();
        const style = await t.document("Style guide");
        const release = await t.document("Release process");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(2_000);
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: release.id,
            description: "How to cut and announce a release. Read before releasing anything.",
        });
        vi.setSystemTime(1_000);
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: style.id,
            description: "Writing style for user-facing text.",
        });

        const instructions = await t.instructions("any-ordinary-agent");
        expect(instructions).toContain("# Important documents");
        expect(instructions).toContain(
            "read every document whose description matches it with read_document",
        );
        expect(instructions).toContain("Read a document again whenever later work touches it.");
        expect(instructions).toContain(
            [
                "<important_documents>",
                "  <document>",
                "    <name>Style guide</name>",
                "    <description>Writing style for user-facing text.</description>",
                `    <surface_id>${style.id}</surface_id>`,
                `    <link>happy://surfaces/${style.id}</link>`,
                "  </document>",
                "  <document>",
                "    <name>Release process</name>",
                "    <description>How to cut and announce a release. Read before releasing anything.</description>",
                `    <surface_id>${release.id}</surface_id>`,
                `    <link>happy://surfaces/${release.id}</link>`,
                "  </document>",
                "</important_documents>",
            ].join("\n"),
        );
    });

    it("breaks a tie in mark time by Surface ID", async () => {
        const t = await fixture();
        const first = await t.document("One");
        const second = await t.document("Two");
        const [low, high] = [first, second].sort((a, b) => (a.id < b.id ? -1 : 1));
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(5_000);
        for (const surface of [high!, low!]) {
            await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
                surfaceId: surface.id,
                description: "Same moment.",
            });
        }
        const documents = await t.surfaces.promptDocuments(t.ctx);
        expect(documents.map((document) => document.surfaceId)).toEqual([low!.id, high!.id]);
    });

    it("follows the Surface's live name unless the admin names the document", async () => {
        const t = await fixture();
        const notes = await t.document("Notes");
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Team conventions.",
        });
        await t.surfaces.update(t.ctx, notes.id, { name: "Team handbook" });
        await expect(t.instructions()).resolves.toContain("<name>Team handbook</name>");

        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Team conventions.",
            name: "Engineering conventions",
        });
        await expect(t.instructions()).resolves.toContain("<name>Engineering conventions</name>");

        // Marking again without a name returns to the Surface's own.
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Team conventions.",
        });
        await expect(t.instructions()).resolves.toContain("<name>Team handbook</name>");
    });

    it("rewords a marked document in place and treats an identical mark as no change", async () => {
        const t = await fixture();
        const first = await t.document("First");
        const second = await t.document("Second");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(1_000);
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: first.id,
            description: "Old words.",
        });
        vi.setSystemTime(2_000);
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: second.id,
            description: "Second.",
        });
        vi.setSystemTime(3_000);
        const reworded = await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: first.id,
            description: "New words.",
        });
        expect(reworded.changed).toBe(true);
        expect(
            reworded.documents.map((document) => [document.surfaceId, document.description]),
        ).toEqual([
            [first.id, "New words."],
            [second.id, "Second."],
        ]);
        expect(reworded.documents[0]).toMatchObject({
            markedAt: 1_000,
            updatedAt: 3_000,
            markedByAgentId: "admin-agent",
        });

        const repeated = await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: first.id,
            description: "New words.",
        });
        expect(repeated.changed).toBe(false);
        expect(repeated.documents[0]?.updatedAt).toBe(3_000);
    });

    it("unmarks a document, and unmarking it again changes nothing", async () => {
        const t = await fixture();
        const notes = await t.document("Notes");
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Notes.",
        });
        await expect(
            t.surfaces.unmarkPromptDocument(t.ctx, "admin-agent", notes.id),
        ).resolves.toEqual({
            surfaceId: notes.id,
            changed: true,
            documents: [],
        });
        await expect(t.instructions()).resolves.not.toContain("# Important documents");
        await expect(
            t.surfaces.unmarkPromptDocument(t.ctx, "admin-agent", notes.id),
        ).resolves.toMatchObject({ changed: false });
    });

    it("keeps the list across a restart", async () => {
        const t = await fixture();
        const notes = await t.document("Notes");
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Notes.",
        });
        await expect(t.restarted().promptDocuments(t.ctx)).resolves.toMatchObject([
            { surfaceId: notes.id, displayName: "Notes", description: "Notes." },
        ]);
    });

    it("marks only existing document Surfaces", async () => {
        const t = await fixture();
        const todos = await t.todoList("Chores");
        await expect(
            t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
                surfaceId: todos.id,
                description: "Not a document.",
            }),
        ).rejects.toThrow("Only a document Surface can be an important document.");
        await expect(
            t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
                surfaceId: "a".repeat(24),
                description: "Missing.",
            }),
        ).rejects.toThrow("The Surface was not found.");
        await expect(
            t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
                surfaceId: (await t.document("Notes")).id,
                description: "   ",
            }),
        ).rejects.toThrow("The important document is invalid.");
        await expect(t.surfaces.promptDocuments(t.ctx)).resolves.toEqual([]);
    });

    it(`refuses more than ${String(MAX_PROMPT_DOCUMENTS)} documents but still rewords one`, async () => {
        const t = await fixture();
        const marked: string[] = [];
        for (let index = 0; index < MAX_PROMPT_DOCUMENTS; index += 1) {
            const document = await t.document(`Document ${String(index)}`);
            await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
                surfaceId: document.id,
                description: "Guidance.",
            });
            marked.push(document.id);
        }
        const extra = await t.document("One too many");
        await expect(
            t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
                surfaceId: extra.id,
                description: "Guidance.",
            }),
        ).rejects.toThrow("Unmark one first.");
        await expect(
            t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
                surfaceId: marked[0]!,
                description: "Reworded.",
            }),
        ).resolves.toMatchObject({ changed: true });
    });

    it("shows a marked Surface that cannot be read to admins only", async () => {
        const t = await fixture();
        const notes = await t.document("Notes");
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Notes.",
        });
        vi.spyOn(t.surfaces, "get").mockResolvedValue(undefined);
        await expect(t.instructions()).resolves.not.toContain("# Important documents");
        await expect(t.surfaces.listPromptDocuments(t.ctx, "admin-agent")).resolves.toMatchObject({
            documents: [
                { surfaceId: notes.id, displayName: "Unavailable document", readable: false },
            ],
        });
        const list = await t.tool("list_prompt_documents");
        const result = await list.execute(t.ctx, {}, {} as never);
        expect(list.toLLM?.(result as never)).toEqual([
            expect.objectContaining({ text: expect.stringContaining("Unmark it.") }),
        ]);
    });

    it("escapes names and descriptions inside the document list", async () => {
        const t = await fixture();
        const notes = await t.document("Q&A <draft>");
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Read </description> before <anything>.",
        });
        const instructions = await t.instructions();
        expect(instructions).toContain("<name>Q&amp;A &lt;draft&gt;</name>");
        expect(instructions).toContain(
            "<description>Read &lt;/description&gt; before &lt;anything&gt;.</description>",
        );
    });

    it("gives its tools only to active admin bots and rechecks authority on every change", async () => {
        const t = await fixture();
        const notes = await t.document("Notes");
        await expect(t.toolNames("admin-agent")).resolves.toEqual([
            "list_prompt_documents",
            "mark_prompt_document",
            "unmark_prompt_document",
        ]);
        for (const agentId of ["ordinary-bot", "archived-admin", "human-agent"]) {
            await expect(t.toolNames(agentId)).resolves.toEqual([]);
            await expect(
                t.surfaces.markPromptDocument(t.ctx, agentId, {
                    surfaceId: notes.id,
                    description: "No.",
                }),
            ).rejects.toThrow(
                "Only an active admin bot can change this installation's important documents.",
            );
            await expect(t.surfaces.unmarkPromptDocument(t.ctx, agentId, notes.id)).rejects.toThrow(
                "Only an active admin bot",
            );
            await expect(t.surfaces.listPromptDocuments(t.ctx, agentId)).rejects.toThrow(
                "Only an active admin bot",
            );
        }
    });

    it("declares reviewed installation-wide writes and an unreviewed read", async () => {
        const t = await fixture();
        const list = await t.tool("list_prompt_documents");
        expect(list.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(false);
        expect(list.requiresAutoOrFullAccess).toBeFalsy();
        const input = { surfaceId: "a".repeat(24), description: "Guidance." };
        for (const name of ["mark_prompt_document", "unmark_prompt_document"]) {
            const tool = await t.tool(name);
            expect(tool.durable).toBe(true);
            expect(tool.transactional).toBe(true);
            expect(tool.requiresAutoOrFullAccess).toBe(true);
            expect(tool.shouldReviewInAutoMode?.(input as never, {} as never)).toBe(true);
            expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
            expect(tool.describeAutoPermissionAction?.(input as never, {} as never)).toContain(
                "installation-wide agent instructions write",
            );
        }
    });

    it("marks and unmarks through the admin tools", async () => {
        const t = await fixture();
        const notes = await t.document("Notes");
        const mark = await t.tool("mark_prompt_document");
        const marked = await mark.execute(
            t.ctx,
            { surfaceId: notes.id, description: "Notes." },
            {} as never,
        );
        expect(mark.toLLM?.(marked as never)).toEqual([
            expect.objectContaining({
                text: expect.stringContaining(`Marked ${notes.id} as an important document.`),
            }),
        ]);
        await expect(t.instructions()).resolves.toContain(`<surface_id>${notes.id}</surface_id>`);

        const unmark = await t.tool("unmark_prompt_document");
        const unmarked = await unmark.execute(t.ctx, { surfaceId: notes.id }, {} as never);
        expect(unmark.toLLM?.(unmarked as never)).toEqual([
            expect.objectContaining({
                text: `Unmarked ${notes.id}.\n\nThis installation has no important documents.`,
            }),
        ]);
    });
    it("reports each document's place in the list on every Surface response, never in events", async () => {
        const t = await fixture();
        const events: unknown[] = [];
        t.surfaces.onEventTransactional((_ctx, event) => {
            events.push(event);
        });
        const notes = await t.document("Notes");
        const todos = await t.todoList("Chores");
        expect(notes.promptDocument).toBeNull();
        expect(todos).not.toHaveProperty("promptDocument");

        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Team conventions.",
        });
        const listed = await t.surfaces.list(t.ctx);
        expect(listed.find((surface) => surface.id === notes.id)?.promptDocument).toEqual({
            description: "Team conventions.",
        });
        expect(listed.find((surface) => surface.id === todos.id)).not.toHaveProperty(
            "promptDocument",
        );
        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Team conventions.",
            name: "Conventions",
        });
        await expect(t.surfaces.get(t.ctx, notes.id)).resolves.toMatchObject({
            version: notes.version,
            promptDocument: { description: "Team conventions.", name: "Conventions" },
        });
        const renamed = await t.surfaces.update(t.ctx, notes.id, { name: "Handbook" });
        expect(renamed.promptDocument).toEqual({
            description: "Team conventions.",
            name: "Conventions",
        });

        await t.surfaces.unmarkPromptDocument(t.ctx, "admin-agent", notes.id);
        await expect(t.surfaces.get(t.ctx, notes.id)).resolves.toMatchObject({
            promptDocument: null,
        });
        expect(JSON.stringify(events)).not.toContain("promptDocument");
    });

    it("tells agents listing Surfaces or reading a document that it is important", async () => {
        const t = await fixture();
        const notes = await t.document("Notes");
        const read = await t.tool("read_document");
        await expect(
            read.execute(t.ctx, { surfaceId: notes.id }, {} as never),
        ).resolves.not.toHaveProperty("promptDocument");

        await t.surfaces.markPromptDocument(t.ctx, "admin-agent", {
            surfaceId: notes.id,
            description: "Team conventions.",
        });
        await expect(
            read.execute(t.ctx, { surfaceId: notes.id }, {} as never),
        ).resolves.toMatchObject({ promptDocument: { description: "Team conventions." } });
        const list = await t.tool("list_surfaces");
        const listed = (await list.execute(t.ctx, {}, {} as never)) as {
            surfaces: { id: string; promptDocument?: unknown }[];
        };
        expect(listed.surfaces.find((surface) => surface.id === notes.id)?.promptDocument).toEqual({
            description: "Team conventions.",
        });
    });
});
