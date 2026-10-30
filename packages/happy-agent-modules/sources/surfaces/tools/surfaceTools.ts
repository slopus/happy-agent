import { createId } from "@paralleldrive/cuid2";
import {
    defineAgentTool,
    cuid2Schema,
    type AgentKV,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import {
    surfaceIdSchema,
    surfaceSchema,
    surfaceMemberSchema,
    todoSchema,
    todoStatusSchema,
    todoTextSchema,
    todoListScopeSchema,
    todoVersionListResponseSchema,
    surfaceNameSchema,
    surfaceDocumentSchema,
    surfaceDocumentSeqSchema,
    surfacePromptDocumentSchema,
    surfaceDocumentTextSchema,
    surfaceDocumentChangeListResponseSchema,
    resourceVersionSchema,
    systemMonitorSnapshotSchema,
    type Surface,
} from "@slopus/happy-agent-client";
import type { SurfacesModule } from "../SurfacesModule.js";
import { SurfaceError } from "../SurfaceError.js";
import { calendarTools } from "./calendarTools.js";
import { formatSystemMonitor } from "../systemMonitor/formatSystemMonitor.js";
import { listPromptDocumentsTool } from "../promptDocuments/tools/list_prompt_documents.js";
import { markPromptDocumentTool } from "../promptDocuments/tools/mark_prompt_document.js";
import { unmarkPromptDocumentTool } from "../promptDocuments/tools/unmark_prompt_document.js";

const identity = { surfaceId: surfaceIdSchema, todoId: cuid2Schema };
const guard = { ...identity, version: resourceVersionSchema };
const page = {
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
const textResult = (result: unknown) => [{ type: "text" as const, text: JSON.stringify(result) }];
/** A document as an agent reads it: Markdown, the version it is at, and what Markdown leaves out. */
const documentReadingSchema = Type.Object({
    document: Type.Object({ ...surfaceDocumentSchema.properties, seq: surfaceDocumentSeqSchema }),
    omitted: Type.Optional(Type.String()),
    /** Present only when admins marked it as one of the installation's important documents. */
    promptDocument: Type.Optional(surfacePromptDocumentSchema),
});
const documentWriteSchema = Type.Object({
    ...documentReadingSchema.properties,
    changed: Type.Boolean(),
});
/** Name what the Markdown leaves out, so the agent knows the document holds more than it sees. */
const omittedNote = (omitted: readonly string[]) =>
    omitted.length === 0
        ? {}
        : {
              omitted: `Markdown cannot show this document's ${list(omitted)}. They stay in place when you edit other text, and on the unchanged start and end of text you edit.`,
          };
const list = (items: readonly string[]) =>
    items.length < 3
        ? items.join(" and ")
        : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
const absoluteImagePath = Type.String({
    minLength: 1,
    maxLength: 4096,
    pattern: "^(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\u0000]*$",
});
const imagePath = Type.Optional(absoluteImagePath);
const fromImage = (path: string | undefined) =>
    path === undefined ? "" : ` from image ${JSON.stringify(path)}`;
const referenceRules =
    "The name is the Surface's permanent label, shown when the target is unavailable; while available, people see the target's live name. A missing, deleted, or archived target is rejected as not found. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. A named creator joins at the end of their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum) for the Surface's own picture.";
const imageAccess =
    "Access: shared data write and, when supplied, filesystem image read; outside-workspace and symlink targets require Full access";

/** Fixed common arrays; model providers never affect the Surface tool or permission contract. */
export function surfaceTools(surfaces: SurfacesModule, scope: AgentModuleScope, admin: boolean) {
    type ToolContext = Parameters<SurfacesModule["actor"]>[0];
    const actor = (ctx: ToolContext) => surfaces.actor(ctx, scope.agent.id, scope.kv);
    /** Replays reuse the creation's first identity and image bytes rather than rereading the file. */
    const creation = async (ctx: ToolContext, call: { kv: AgentKV }, path: string | undefined) => {
        await surfaces.requireAdmin(ctx, scope.agent.id);
        const id = await call.kv.getOrCreate(ctx, "surfaceId", createId);
        if (path === undefined) return { id };
        const data = await call.kv.getOrCreate(ctx, "image", () =>
            surfaces.imageFromPath(ctx, scope.agent.id, path),
        );
        return { id, image: { data } };
    };
    const ordinary = [
        defineAgentTool({
            name: "read_system_monitor",
            defer: true,
            capabilities: ["Read live host CPU, GPU, memory, disk, and process usage."],
            searchKeywords: [
                "system monitor",
                "cpu gpu memory disk usage",
                "running processes",
                "task manager",
            ],
            description:
                "Read the machine running this daemon through one System Monitor Surface. Includes CPU, GPU, memory, mounted disks, disk activity, recent history, and top processes by CPU and resident memory. Several System Monitors show the same host. Unavailable measurements are null. Process names exclude command-line arguments and environments. Reading never changes membership.",
            parameters: Type.Object(
                { surfaceId: surfaceIdSchema },
                { additionalProperties: false },
            ),
            returnType: systemMonitorSnapshotSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: (ctx, input) => surfaces.systemMonitor(ctx, input.surfaceId),
            toLLM: (snapshot) => [{ type: "text" as const, text: formatSystemMonitor(snapshot) }],
        }),
        defineAgentTool({
            name: "list_surfaces",
            defer: true,
            capabilities: ["Find shared Surfaces and their members."],
            searchKeywords: ["list surfaces", "shared todo lists", "sidebar members"],
            description:
                "List shared Surface instances, their IDs, names, types, and joined people. Artifact, bot, and task Surfaces include their target's live name and ID while it is available, or an unavailable state without them. Document Surfaces include promptDocument: null, or the description admins gave it as one of the installation's important documents. Each todo, document, calendar, or System Monitor tool requires a Surface ID. Results are paged.",
            parameters: Type.Object(page, { additionalProperties: false }),
            returnType: Type.Object({
                surfaces: Type.Array(surfaceSchema),
                nextOffset: Type.Union([Type.Integer(), Type.Null()]),
            }),
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const all = await surfaces.list(ctx);
                const start = input.offset ?? 0;
                const end = start + (input.limit ?? 20);
                return {
                    surfaces: all.slice(start, end),
                    nextOffset: end < all.length ? end : null,
                };
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "update_surface",
            defer: true,
            capabilities: ["Rename a shared Surface or change or remove its picture."],
            searchKeywords: [
                "rename surface",
                "surface picture",
                "change document icon",
                "remove surface image",
            ],
            description:
                "Rename a shared Surface of any type, or change or remove its picture. Supply a new name, an absolute PNG, JPEG, or WebP imagePath (8 MiB maximum) to replace the picture, or imagePath null to remove it; at least one is required. Write or generate the image first, then point this tool at it. For artifact, bot, and task Surfaces the name is the label shown while the target is unavailable. Values equal to the current ones change nothing. This never joins anyone or changes the Surface's content.",
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    name: Type.Optional(surfaceNameSchema),
                    imagePath: Type.Optional(Type.Union([absoluteImagePath, Type.Null()])),
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath ?? undefined),
            describeAutoPermissionAction: ({ surfaceId, name, imagePath }) => {
                const edits = [
                    ...(name === undefined ? [] : [`renaming it to ${JSON.stringify(name)}`]),
                    ...(imagePath === undefined
                        ? []
                        : imagePath === null
                          ? ["removing its picture"]
                          : [`setting its picture${fromImage(imagePath)}`]),
                ];
                return `editing shared Surface ${JSON.stringify(surfaceId)}${edits.length === 0 ? "" : `: ${edits.join(" and ")}`}. ${imageAccess}`;
            },
            // Replays reuse the first image bytes, and the result commits with the edit.
            execute: async (ctx, { surfaceId, name, imagePath: path }, call) => {
                const settle = (tx: ToolContext, surface: Surface) => call.commit(tx, surface);
                if (path === undefined) {
                    if (name === undefined)
                        throw new SurfaceError(
                            "invalid_request",
                            "Supply a new name, an imagePath, or imagePath null to remove the picture.",
                        );
                    return surfaces.update(ctx, surfaceId, { name }, settle);
                }
                const image =
                    path === null
                        ? null
                        : {
                              data: await call.kv.getOrCreate(ctx, "image", () =>
                                  surfaces.imageFromPath(ctx, scope.agent.id, path),
                              ),
                          };
                return surfaces.update(
                    ctx,
                    surfaceId,
                    { image, ...(name === undefined ? {} : { name }) },
                    settle,
                );
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "list_todos",
            defer: true,
            capabilities: ["Read active, completed, or deleted todos in a Surface."],
            searchKeywords: ["list todos", "checklist items", "completed todos", "deleted todos"],
            description:
                "List todos in one Surface, active by default. Active text starting with exact '# ' is a section heading, not an outstanding task; exclude headings from task counts. Do not trim text before checking that prefix. Use completed, deleted, or all to find older items. Keep returned versions for guarded edits. Results are paged.",
            parameters: Type.Object(
                { surfaceId: surfaceIdSchema, scope: Type.Optional(todoListScopeSchema), ...page },
                { additionalProperties: false },
            ),
            returnType: Type.Object({
                todos: Type.Array(todoSchema),
                nextOffset: Type.Union([Type.Integer(), Type.Null()]),
            }),
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const all = await surfaces.listTodos(ctx, input.surfaceId, input.scope);
                const start = input.offset ?? 0;
                const end = start + (input.limit ?? 20);
                return { todos: all.slice(start, end), nextOffset: end < all.length ? end : null };
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_todo",
            defer: true,
            capabilities: ["Add a todo to a shared Surface."],
            searchKeywords: ["create todo", "add checklist item", "new reminder"],
            description:
                "Add a plain-text todo at the top of one shared Surface. For a section heading, start the text with exact '# ' (hash and space); it remains an ordinary ordered todo without a checkbox. Explicitly supply authorUserId as a local Happy user ID, or null for no attribution; only null is allowed in standalone mode. The author is immutable and separate from the revision's audit actor. This never creates a chat or joins anyone to the Surface.",
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    text: todoTextSchema,
                    authorUserId: surfaceMemberSchema.properties.userId,
                },
                { additionalProperties: false },
            ),
            returnType: todoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId }) =>
                `adding a todo to shared Surface ${JSON.stringify(surfaceId)}. Access: shared data write`,
            execute: async (ctx, input, call) =>
                surfaces.createTodo(
                    ctx,
                    input.surfaceId,
                    { text: input.text, id: await call.kv.getOrCreate(ctx, "todoId", createId) },
                    await actor(ctx),
                    input.authorUserId,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "update_todo",
            defer: true,
            capabilities: ["Change a todo's text or active, completed, or deleted state."],
            searchKeywords: ["edit todo", "complete todo", "uncomplete todo", "change todo state"],
            description:
                "Edit text or status (active, completed, deleted) with the current version. Returning an inactive todo to active appends it to the list. To apply a historical state, read its revision and supply the desired fields here; use reorder_todo for placement. Conflicts require a fresh read.",
            parameters: Type.Object(
                {
                    ...guard,
                    text: Type.Optional(todoTextSchema),
                    status: Type.Optional(todoStatusSchema),
                },
                { additionalProperties: false },
            ),
            returnType: todoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, todoId }) =>
                `editing todo ${JSON.stringify(todoId)} in shared Surface ${JSON.stringify(surfaceId)}. Access: shared data write`,
            execute: async (ctx, { surfaceId, todoId, version, ...edit }) =>
                surfaces.mutateTodo(
                    ctx,
                    surfaceId,
                    todoId,
                    version,
                    "update",
                    edit,
                    await actor(ctx),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "reorder_todo",
            defer: true,
            capabilities: ["Move an active todo within its Surface list."],
            searchKeywords: ["reorder todo", "move checklist item", "todo position"],
            description:
                "Move an active todo after another active todo in the same Surface, or first with afterId null. Completed and deleted todos cannot be reordered.",
            parameters: Type.Object(
                { ...guard, afterId: Type.Union([cuid2Schema, Type.Null()]) },
                { additionalProperties: false },
            ),
            returnType: todoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, todoId }) =>
                `moving todo ${JSON.stringify(todoId)} in shared Surface ${JSON.stringify(surfaceId)}. Access: shared data write`,
            execute: async (ctx, input) =>
                surfaces.mutateTodo(
                    ctx,
                    input.surfaceId,
                    input.todoId,
                    input.version,
                    "reorder",
                    { afterId: input.afterId },
                    await actor(ctx),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "delete_todo",
            defer: true,
            capabilities: ["Delete a todo while preserving its permanent history."],
            searchKeywords: ["delete todo", "remove checklist item"],
            description:
                "Delete a todo from one Surface. Its text and every revision remain permanently recoverable.",
            parameters: Type.Object(guard, { additionalProperties: false }),
            returnType: todoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, todoId }) =>
                `deleting todo ${JSON.stringify(todoId)} from shared Surface ${JSON.stringify(surfaceId)} while preserving its history. Access: shared data write`,
            execute: async (ctx, input) =>
                surfaces.mutateTodo(
                    ctx,
                    input.surfaceId,
                    input.todoId,
                    input.version,
                    "delete",
                    {},
                    await actor(ctx),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "list_todo_versions",
            defer: true,
            capabilities: ["Read a todo's permanent revisions and their authors."],
            searchKeywords: ["todo history", "todo versions", "previous todo state", "todo author"],
            description:
                "Read a bounded page of a todo's permanent full revisions and their actors, oldest first. Continue with nextAfterVersion.",
            parameters: Type.Object(
                {
                    ...identity,
                    afterVersion: Type.Optional(resourceVersionSchema),
                    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
                },
                { additionalProperties: false },
            ),
            returnType: todoVersionListResponseSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) =>
                surfaces.versions(
                    ctx,
                    input.surfaceId,
                    input.todoId,
                    input.afterVersion,
                    input.limit ?? 10,
                ),
            toLLM: textResult,
        }),
    ];
    const documents = [
        defineAgentTool({
            name: "read_document",
            defer: true,
            capabilities: [
                "Read a shared document Surface as Markdown, now or at an earlier version.",
            ],
            searchKeywords: ["read document", "surface markdown", "previous document text"],
            description:
                "Read a document Surface as Markdown with the seq it was read at, or as of an optional earlier seq. People may be editing it at the same time. Keep the seq: update_document needs the seq your edit is based on. The result says when the document holds content Markdown cannot show, such as comments or colors. When admins marked it as one of the installation's important documents, the result includes promptDocument with their description.",
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    seq: Type.Optional(
                        Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
                    ),
                },
                { additionalProperties: false },
            ),
            returnType: documentReadingSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const reading = await surfaces.document(ctx, input.surfaceId, input.seq);
                const promptDocument = await surfaces.promptDocumentEntry(ctx, input.surfaceId);
                return {
                    document: reading.document,
                    ...omittedNote(reading.omitted),
                    ...(promptDocument === null ? {} : { promptDocument }),
                };
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "update_document",
            defer: true,
            capabilities: [
                "Edit a shared document's Markdown alongside the people editing it, keeping permanent history.",
            ],
            searchKeywords: [
                "update document",
                "edit markdown",
                "clear shared document",
                "restore document revision",
            ],
            description:
                "Edit a document Surface by giving its entire new Markdown and the seq of the version you read. Happy compares your Markdown with that version block by block and applies only what you changed, so edits people made since then are kept. Unchanged Markdown changes nothing. Empty text clears the content; history keeps every version. To restore an earlier version, read it with read_document and write its text with the latest seq. Use seq 0 only for a document you read as empty.",
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    seq: surfaceDocumentSeqSchema,
                    text: surfaceDocumentTextSchema,
                },
                { additionalProperties: false },
            ),
            returnType: documentWriteSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId }) =>
                `editing the shared document in Surface ${JSON.stringify(surfaceId)} while preserving history. Access: shared data write; no filesystem access`,
            execute: async (ctx, input) => {
                const result = await surfaces.changeDocumentFromMarkdown(
                    ctx,
                    input.surfaceId,
                    input.seq,
                    input.text,
                    await actor(ctx),
                );
                return {
                    document: result.document,
                    changed: result.changed,
                    ...omittedNote(result.omitted),
                };
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "list_document_versions",
            defer: true,
            capabilities: ["List a shared document's permanent changes and who made them."],
            searchKeywords: ["document history", "document versions", "markdown revision authors"],
            description:
                "List a document Surface's permanent changes, oldest first: each seq with who made it, when, and whether a person, an agent, or the one-time conversion of an older document. Returns up to 20 entries, default 10; continue with nextAfterSeq. Read any version's Markdown with read_document and its seq.",
            parameters: Type.Object(
                {
                    surfaceId: surfaceIdSchema,
                    afterSeq: Type.Optional(surfaceDocumentSeqSchema),
                    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
                },
                { additionalProperties: false },
            ),
            returnType: surfaceDocumentChangeListResponseSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) =>
                surfaces.documentChanges(
                    ctx,
                    input.surfaceId,
                    input.afterSeq ?? 0,
                    input.limit ?? 10,
                ),
            toLLM: textResult,
        }),
    ];
    const administration = [
        defineAgentTool({
            name: "create_system_monitor_surface",
            defer: true,
            capabilities: ["Create a System Monitor Surface as an admin bot."],
            searchKeywords: [
                "create system monitor",
                "host resource dashboard",
                "new task manager",
            ],
            description:
                "Admin bots only: create a named System Monitor Surface for the machine running this daemon. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The immutable creator joins their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared System Monitor Surface${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "system_monitor",
                        name: input.name,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_todo_surface",
            defer: true,
            capabilities: ["Create a named shared todo-list Surface as an admin bot."],
            searchKeywords: ["create todo surface", "new shared todo list", "todo list image"],
            description:
                "Admin bots only: create a distinct named shared todo-list Surface. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The creator is immutable. A named creator joins at the end of their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared todo Surface${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "todo",
                        name: input.name,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_document_surface",
            defer: true,
            capabilities: ["Create a named shared Markdown document Surface as an admin bot."],
            searchKeywords: ["create document surface", "new shared markdown", "document image"],
            description:
                "Admin bots only: create a document Surface with optional initial Markdown, empty by default. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The creator is the immutable author and joins their sidebar; null joins nobody in team mode and the local person in standalone mode. Revision audit identity remains the actual caller. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    text: Type.Optional(surfaceDocumentTextSchema),
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared Markdown document Surface${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "document",
                        name: input.name,
                        ...(input.text === undefined ? {} : { text: input.text }),
                    },
                    input.creatorUserId,
                    scope.agent.id,
                    await actor(ctx),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_calendar_surface",
            defer: true,
            capabilities: ["Create a named shared calendar Surface as an admin bot."],
            searchKeywords: ["create calendar surface", "new shared calendar", "calendar image"],
            description:
                "Admin bots only: create a distinct named shared calendar Surface, empty at first. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The creator is immutable. A named creator joins at the end of their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared calendar Surface${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "calendar",
                        name: input.name,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_artifact_surface",
            defer: true,
            capabilities: ["Create a Surface that points at an existing artifact as an admin bot."],
            searchKeywords: ["artifact surface", "pin artifact to sidebar", "artifact reference"],
            description: `Admin bots only: create a Surface pointing at one existing, undeleted artifact so people can keep it in their sidebar. It neither copies nor changes the artifact. ${referenceRules}`,
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    artifactId: cuid2Schema,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared Surface referencing artifact ${JSON.stringify(input.artifactId)}${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "artifact",
                        name: input.name,
                        artifactId: input.artifactId,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_bot_surface",
            defer: true,
            capabilities: ["Create a Surface that points at an existing bot as an admin bot."],
            searchKeywords: ["bot surface", "pin bot to sidebar", "bot reference"],
            description: `Admin bots only: create a Surface pointing at one existing, active bot so people can keep it in their sidebar. Opening it shows that bot's existing conversation; it grants no access and changes nothing about the bot. ${referenceRules}`,
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    botId: cuid2Schema,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared Surface referencing bot ${JSON.stringify(input.botId)}${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "bot",
                        name: input.name,
                        botId: input.botId,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_task_surface",
            defer: true,
            capabilities: ["Create a Surface that points at an existing task as an admin bot."],
            searchKeywords: ["task surface", "pin task to sidebar", "task reference"],
            description: `Admin bots only: create a Surface pointing at one existing, active task so people can keep it in their sidebar. Opening it shows that task's existing conversation; it never joins anyone to the task or changes who may archive it. ${referenceRules}`,
            parameters: Type.Object(
                {
                    name: surfaceNameSchema,
                    creatorUserId: surfaceMemberSchema.properties.userId,
                    taskId: cuid2Schema,
                    imagePath,
                },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                surfaces.shouldElevateImage(ctx, scope.agent.id, input.imagePath),
            describeAutoPermissionAction: (input) =>
                `creating a shared Surface referencing task ${JSON.stringify(input.taskId)}${fromImage(input.imagePath)}. ${imageAccess}`,
            execute: async (ctx, input, call) =>
                surfaces.create(
                    ctx,
                    {
                        ...(await creation(ctx, call, input.imagePath)),
                        type: "task",
                        name: input.name,
                        taskId: input.taskId,
                    },
                    input.creatorUserId,
                    scope.agent.id,
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "add_surface_user",
            defer: true,
            capabilities: ["Add a person to a Surface as an admin bot."],
            searchKeywords: ["add surface member", "join shared list", "surface sidebar"],
            description:
                "Admin bots only: add an existing user to a Surface, appending it to their own sidebar. Use null for the standalone person. Existing members keep their order.",
            parameters: Type.Object(
                { surfaceId: surfaceIdSchema, userId: Type.Union([cuid2Schema, Type.Null()]) },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, userId }) =>
                `adding ${userId === null ? "the standalone person" : `user ${JSON.stringify(userId)}`} to shared Surface ${JSON.stringify(surfaceId)}. Access: shared membership and sidebar write`,
            execute: async (ctx, input) => {
                await surfaces.requireAdmin(ctx, scope.agent.id);
                return surfaces.changeMember(ctx, input.surfaceId, input.userId, "join");
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "remove_surface_user",
            defer: true,
            capabilities: ["Remove a person's Surface membership as an admin bot."],
            searchKeywords: ["remove surface member", "leave shared list", "remove sidebar list"],
            description:
                "Admin bots only: remove a user's Surface from their sidebar. Todos, revisions, and all other users' memberships stay intact.",
            parameters: Type.Object(
                { surfaceId: surfaceIdSchema, userId: Type.Union([cuid2Schema, Type.Null()]) },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ surfaceId, userId }) =>
                `removing ${userId === null ? "the standalone person" : `user ${JSON.stringify(userId)}`} from shared Surface ${JSON.stringify(surfaceId)} without deleting its data. Access: shared membership and sidebar write`,
            execute: async (ctx, input) => {
                await surfaces.requireAdmin(ctx, scope.agent.id);
                return surfaces.changeMember(ctx, input.surfaceId, input.userId, "leave");
            },
            toLLM: textResult,
        }),
        listPromptDocumentsTool(surfaces, scope.agent.id),
        markPromptDocumentTool(surfaces, scope.agent.id),
        unmarkPromptDocumentTool(surfaces, scope.agent.id),
    ];
    const calendars = calendarTools(surfaces, actor);
    return admin
        ? [...ordinary, ...documents, ...calendars, ...administration]
        : [...ordinary, ...documents, ...calendars];
}
