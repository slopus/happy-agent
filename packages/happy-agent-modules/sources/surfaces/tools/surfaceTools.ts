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
    type Surface as Tab,
} from "@slopus/happy-agent-client";
import type { SurfacesModule } from "../SurfacesModule.js";
import { SurfaceError } from "../SurfaceError.js";
import { calendarTools } from "./calendarTools.js";
import { formatSystemMonitor } from "../systemMonitor/formatSystemMonitor.js";
import { listPromptDocumentsTool } from "../promptDocuments/tools/list_prompt_documents.js";
import { markPromptDocumentTool } from "../promptDocuments/tools/mark_prompt_document.js";
import { unmarkPromptDocumentTool } from "../promptDocuments/tools/unmark_prompt_document.js";
import { tabContent, tabContentSchema } from "./tabContent.js";

const tabTodoSchema = Type.Union([
    tabContentSchema(todoSchema.anyOf[0]),
    tabContentSchema(todoSchema.anyOf[1]),
    tabContentSchema(todoSchema.anyOf[2]),
]);
const tabTodoVersionsSchema = Type.Object({
    ...todoVersionListResponseSchema.properties,
    versions: Type.Array(
        Type.Object({
            ...todoVersionListResponseSchema.properties.versions.items.properties,
            todo: tabTodoSchema,
        }),
    ),
});

const identity = { tabId: surfaceIdSchema, todoId: cuid2Schema };
const guard = { ...identity, version: resourceVersionSchema };
const page = {
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
const textResult = (result: unknown) => [{ type: "text" as const, text: JSON.stringify(result) }];
/** A document as an agent reads it: Markdown, the version it is at, and what Markdown leaves out. */
const documentReadingSchema = Type.Object({
    document: Type.Object({
        ...tabContentSchema(surfaceDocumentSchema).properties,
        seq: surfaceDocumentSeqSchema,
    }),
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
    "The name is the Tab's permanent label, shown when the target is unavailable; while available, people see the target's live name. A missing, deleted, or archived target is rejected as not found. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. A named creator joins at the end of their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum) for the Tab's own picture.";
const imageAccess =
    "Access: shared data write and, when supplied, filesystem image read; outside-workspace and symlink targets require Full access";

/** Fixed common arrays; model providers never affect the Tab tool or permission contract. */
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
                "Read the machine running this daemon through one System Monitor Tab. Includes CPU, GPU, memory, mounted disks, disk activity, recent history, and top processes by CPU and resident memory. Several System Monitors show the same host. Unavailable measurements are null. Process names exclude command-line arguments and environments. Reading never changes membership.",
            parameters: Type.Object({ tabId: surfaceIdSchema }, { additionalProperties: false }),
            returnType: systemMonitorSnapshotSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: (ctx, input) => surfaces.systemMonitor(ctx, input.tabId),
            toLLM: (snapshot) => [{ type: "text" as const, text: formatSystemMonitor(snapshot) }],
        }),
        defineAgentTool({
            name: "list_tabs",
            defer: true,
            capabilities: ["Find shared Tabs and their members."],
            searchKeywords: ["list tabs", "shared todo lists", "sidebar members"],
            description:
                "List shared Tab instances, their IDs, names, types, and joined people. Artifact, bot, and task Tabs include their target's live name and ID while it is available, or an unavailable state without them. Document Tabs include promptDocument: null, or the description admins gave it as one of the installation's important documents. Each todo, document, calendar, or System Monitor tool requires a Tab ID. Results are paged.",
            parameters: Type.Object(page, { additionalProperties: false }),
            returnType: Type.Object({
                tabs: Type.Array(surfaceSchema),
                nextOffset: Type.Union([Type.Integer(), Type.Null()]),
            }),
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const all = await surfaces.list(ctx);
                const start = input.offset ?? 0;
                const end = start + (input.limit ?? 20);
                return {
                    tabs: all.slice(start, end),
                    nextOffset: end < all.length ? end : null,
                };
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "update_tab",
            defer: true,
            capabilities: ["Rename a shared Tab or change or remove its picture."],
            searchKeywords: [
                "rename tab",
                "tab picture",
                "change document icon",
                "remove tab image",
            ],
            description:
                "Rename a shared Tab of any type, or change or remove its picture. Supply a new name, an absolute PNG, JPEG, or WebP imagePath (8 MiB maximum) to replace the picture, or imagePath null to remove it; at least one is required. Write or generate the image first, then point this tool at it. For artifact, bot, and task Tabs the name is the label shown while the target is unavailable. Values equal to the current ones change nothing. This never joins anyone or changes the Tab's content.",
            parameters: Type.Object(
                {
                    tabId: surfaceIdSchema,
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
            describeAutoPermissionAction: ({ tabId, name, imagePath }) => {
                const edits = [
                    ...(name === undefined ? [] : [`renaming it to ${JSON.stringify(name)}`]),
                    ...(imagePath === undefined
                        ? []
                        : imagePath === null
                          ? ["removing its picture"]
                          : [`setting its picture${fromImage(imagePath)}`]),
                ];
                return `editing shared Tab ${JSON.stringify(tabId)}${edits.length === 0 ? "" : `: ${edits.join(" and ")}`}. ${imageAccess}`;
            },
            // Replays reuse the first image bytes, and the result commits with the edit.
            execute: async (ctx, { tabId, name, imagePath: path }, call) => {
                const settle = (tx: ToolContext, tab: Tab) => call.commit(tx, tab);
                if (path === undefined) {
                    if (name === undefined)
                        throw new SurfaceError(
                            "invalid_request",
                            "Supply a new name, an imagePath, or imagePath null to remove the picture.",
                        );
                    return surfaces.update(ctx, tabId, { name }, settle);
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
                    tabId,
                    { image, ...(name === undefined ? {} : { name }) },
                    settle,
                );
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "list_todos",
            defer: true,
            capabilities: ["Read active, completed, or deleted todos in a Tab."],
            searchKeywords: ["list todos", "checklist items", "completed todos", "deleted todos"],
            description:
                "List todos in one Tab, active by default. Active text starting with exact '# ' is a section heading, not an outstanding task; exclude headings from task counts. Do not trim text before checking that prefix. Use completed, deleted, or all to find older items. Keep returned versions for guarded edits. Results are paged.",
            parameters: Type.Object(
                { tabId: surfaceIdSchema, scope: Type.Optional(todoListScopeSchema), ...page },
                { additionalProperties: false },
            ),
            returnType: Type.Object({
                todos: Type.Array(tabTodoSchema),
                nextOffset: Type.Union([Type.Integer(), Type.Null()]),
            }),
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const all = await surfaces.listTodos(ctx, input.tabId, input.scope);
                const start = input.offset ?? 0;
                const end = start + (input.limit ?? 20);
                return {
                    todos: all.slice(start, end).map(tabContent),
                    nextOffset: end < all.length ? end : null,
                };
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "create_todo",
            defer: true,
            capabilities: ["Add a todo to a shared Tab."],
            searchKeywords: ["create todo", "add checklist item", "new reminder"],
            description:
                "Add a plain-text todo at the top of one shared Tab. For a section heading, start the text with exact '# ' (hash and space); it remains an ordinary ordered todo without a checkbox. Explicitly supply authorUserId as a local Happy user ID, or null for no attribution; only null is allowed in standalone mode. The author is immutable and separate from the revision's audit actor. This never creates a chat or joins anyone to the Tab.",
            parameters: Type.Object(
                {
                    tabId: surfaceIdSchema,
                    text: todoTextSchema,
                    authorUserId: surfaceMemberSchema.properties.userId,
                },
                { additionalProperties: false },
            ),
            returnType: tabTodoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ tabId }) =>
                `adding a todo to shared Tab ${JSON.stringify(tabId)}. Access: shared data write`,
            execute: async (ctx, input, call) =>
                tabContent(
                    await surfaces.createTodo(
                        ctx,
                        input.tabId,
                        {
                            text: input.text,
                            id: await call.kv.getOrCreate(ctx, "todoId", createId),
                        },
                        await actor(ctx),
                        input.authorUserId,
                    ),
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
            returnType: tabTodoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ tabId, todoId }) =>
                `editing todo ${JSON.stringify(todoId)} in shared Tab ${JSON.stringify(tabId)}. Access: shared data write`,
            execute: async (ctx, { tabId, todoId, version, ...edit }) =>
                tabContent(
                    await surfaces.mutateTodo(
                        ctx,
                        tabId,
                        todoId,
                        version,
                        "update",
                        edit,
                        await actor(ctx),
                    ),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "reorder_todo",
            defer: true,
            capabilities: ["Move an active todo within its Tab list."],
            searchKeywords: ["reorder todo", "move checklist item", "todo position"],
            description:
                "Move an active todo after another active todo in the same Tab, or first with afterId null. Completed and deleted todos cannot be reordered.",
            parameters: Type.Object(
                { ...guard, afterId: Type.Union([cuid2Schema, Type.Null()]) },
                { additionalProperties: false },
            ),
            returnType: tabTodoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ tabId, todoId }) =>
                `moving todo ${JSON.stringify(todoId)} in shared Tab ${JSON.stringify(tabId)}. Access: shared data write`,
            execute: async (ctx, input) =>
                tabContent(
                    await surfaces.mutateTodo(
                        ctx,
                        input.tabId,
                        input.todoId,
                        input.version,
                        "reorder",
                        { afterId: input.afterId },
                        await actor(ctx),
                    ),
                ),
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "delete_todo",
            defer: true,
            capabilities: ["Delete a todo while preserving its permanent history."],
            searchKeywords: ["delete todo", "remove checklist item"],
            description:
                "Delete a todo from one Tab. Its text and every revision remain permanently recoverable.",
            parameters: Type.Object(guard, { additionalProperties: false }),
            returnType: tabTodoSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ tabId, todoId }) =>
                `deleting todo ${JSON.stringify(todoId)} from shared Tab ${JSON.stringify(tabId)} while preserving its history. Access: shared data write`,
            execute: async (ctx, input) =>
                tabContent(
                    await surfaces.mutateTodo(
                        ctx,
                        input.tabId,
                        input.todoId,
                        input.version,
                        "delete",
                        {},
                        await actor(ctx),
                    ),
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
            returnType: tabTodoVersionsSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const result = await surfaces.versions(
                    ctx,
                    input.tabId,
                    input.todoId,
                    input.afterVersion,
                    input.limit ?? 10,
                );
                return {
                    ...result,
                    versions: result.versions.map((revision) => ({
                        ...revision,
                        todo: tabContent(revision.todo),
                    })),
                };
            },
            toLLM: textResult,
        }),
    ];
    const documents = [
        defineAgentTool({
            name: "read_document",
            defer: true,
            capabilities: ["Read a shared document Tab as Markdown, now or at an earlier version."],
            searchKeywords: ["read document", "tab markdown", "previous document text"],
            description:
                "Read a document Tab as Markdown with the seq it was read at, or as of an optional earlier seq. People may be editing it at the same time. Keep the seq: update_document needs the seq your edit is based on. The result says when the document holds content Markdown cannot show, such as comments or colors. When admins marked it as one of the installation's important documents, the result includes promptDocument with their description.",
            parameters: Type.Object(
                {
                    tabId: surfaceIdSchema,
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
                const reading = await surfaces.document(ctx, input.tabId, input.seq);
                const promptDocument = await surfaces.promptDocumentEntry(ctx, input.tabId);
                return {
                    document: tabContent(reading.document),
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
                "Edit a document Tab by giving its entire new Markdown and the seq of the version you read. Happy compares your Markdown with that version block by block and applies only what you changed, so edits people made since then are kept. Unchanged Markdown changes nothing. Empty text clears the content; history keeps every version. To restore an earlier version, read it with read_document and write its text with the latest seq. Use seq 0 only for a document you read as empty.",
            parameters: Type.Object(
                {
                    tabId: surfaceIdSchema,
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
            describeAutoPermissionAction: ({ tabId }) =>
                `editing the shared document in Tab ${JSON.stringify(tabId)} while preserving history. Access: shared data write; no filesystem access`,
            execute: async (ctx, input) => {
                const result = await surfaces.changeDocumentFromMarkdown(
                    ctx,
                    input.tabId,
                    input.seq,
                    input.text,
                    await actor(ctx),
                );
                return {
                    document: tabContent(result.document),
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
                "List a document Tab's permanent changes, oldest first: each seq with who made it, when, and whether a person, an agent, or the one-time conversion of an older document. Returns up to 20 entries, default 10; continue with nextAfterSeq. Read any version's Markdown with read_document and its seq.",
            parameters: Type.Object(
                {
                    tabId: surfaceIdSchema,
                    afterSeq: Type.Optional(surfaceDocumentSeqSchema),
                    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
                },
                { additionalProperties: false },
            ),
            returnType: surfaceDocumentChangeListResponseSchema,
            durable: false,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) =>
                surfaces.documentChanges(ctx, input.tabId, input.afterSeq ?? 0, input.limit ?? 10),
            toLLM: textResult,
        }),
    ];
    const administration = [
        defineAgentTool({
            name: "create_system_monitor_tab",
            defer: true,
            capabilities: ["Create a System Monitor Tab as an admin bot."],
            searchKeywords: [
                "create system monitor",
                "host resource dashboard",
                "new task manager",
            ],
            description:
                "Admin bots only: create a named System Monitor Tab for the machine running this daemon. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The immutable creator joins their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
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
                `creating a shared System Monitor Tab${fromImage(input.imagePath)}. ${imageAccess}`,
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
            name: "create_todo_tab",
            defer: true,
            capabilities: ["Create a named shared todo-list Tab as an admin bot."],
            searchKeywords: ["create todo tab", "new shared todo list", "todo list image"],
            description:
                "Admin bots only: create a distinct named shared todo-list Tab. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The creator is immutable. A named creator joins at the end of their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
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
                `creating a shared todo Tab${fromImage(input.imagePath)}. ${imageAccess}`,
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
            name: "create_document_tab",
            defer: true,
            capabilities: ["Create a named shared Markdown document Tab as an admin bot."],
            searchKeywords: ["create document tab", "new shared markdown", "document image"],
            description:
                "Admin bots only: create a document Tab with optional initial Markdown, empty by default. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The creator is the immutable author and joins their sidebar; null joins nobody in team mode and the local person in standalone mode. Revision audit identity remains the actual caller. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
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
                `creating a shared Markdown document Tab${fromImage(input.imagePath)}. ${imageAccess}`,
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
            name: "create_calendar_tab",
            defer: true,
            capabilities: ["Create a named shared calendar Tab as an admin bot."],
            searchKeywords: ["create calendar tab", "new shared calendar", "calendar image"],
            description:
                "Admin bots only: create a distinct named shared calendar Tab, empty at first. Explicitly supply creatorUserId as a local Happy user ID or null; only null is allowed in standalone mode. The creator is immutable. A named creator joins at the end of their sidebar; null joins nobody in team mode and the local person in standalone mode. Optionally supply an absolute PNG, JPEG, or WebP image path (8 MiB maximum).",
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
                `creating a shared calendar Tab${fromImage(input.imagePath)}. ${imageAccess}`,
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
            name: "create_artifact_tab",
            defer: true,
            capabilities: ["Create a Tab that points at an existing artifact as an admin bot."],
            searchKeywords: ["artifact tab", "pin artifact to sidebar", "artifact reference"],
            description: `Admin bots only: create a Tab pointing at one existing, undeleted artifact so people can keep it in their sidebar. It neither copies nor changes the artifact. ${referenceRules}`,
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
                `creating a shared Tab referencing artifact ${JSON.stringify(input.artifactId)}${fromImage(input.imagePath)}. ${imageAccess}`,
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
            name: "create_bot_tab",
            defer: true,
            capabilities: ["Create a Tab that points at an existing bot as an admin bot."],
            searchKeywords: ["bot tab", "pin bot to sidebar", "bot reference"],
            description: `Admin bots only: create a Tab pointing at one existing, active bot so people can keep it in their sidebar. Opening it shows that bot's existing conversation; it grants no access and changes nothing about the bot. ${referenceRules}`,
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
                `creating a shared Tab referencing bot ${JSON.stringify(input.botId)}${fromImage(input.imagePath)}. ${imageAccess}`,
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
            name: "create_task_tab",
            defer: true,
            capabilities: ["Create a Tab that points at an existing task as an admin bot."],
            searchKeywords: ["task tab", "pin task to sidebar", "task reference"],
            description: `Admin bots only: create a Tab pointing at one existing, active task so people can keep it in their sidebar. Opening it shows that task's existing conversation; it never joins anyone to the task or changes who may archive it. ${referenceRules}`,
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
                `creating a shared Tab referencing task ${JSON.stringify(input.taskId)}${fromImage(input.imagePath)}. ${imageAccess}`,
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
            name: "add_tab_user",
            defer: true,
            capabilities: ["Add a person to a Tab as an admin bot."],
            searchKeywords: ["add tab member", "join shared list", "tab sidebar"],
            description:
                "Admin bots only: add an existing user to a Tab, appending it to their own sidebar. Use null for the standalone person. Existing members keep their order.",
            parameters: Type.Object(
                { tabId: surfaceIdSchema, userId: Type.Union([cuid2Schema, Type.Null()]) },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ tabId, userId }) =>
                `adding ${userId === null ? "the standalone person" : `user ${JSON.stringify(userId)}`} to shared Tab ${JSON.stringify(tabId)}. Access: shared membership and sidebar write`,
            execute: async (ctx, input) => {
                await surfaces.requireAdmin(ctx, scope.agent.id);
                return surfaces.changeMember(ctx, input.tabId, input.userId, "join");
            },
            toLLM: textResult,
        }),
        defineAgentTool({
            name: "remove_tab_user",
            defer: true,
            capabilities: ["Remove a person's Tab membership as an admin bot."],
            searchKeywords: ["remove tab member", "leave shared list", "remove sidebar list"],
            description:
                "Admin bots only: remove a user's Tab from their sidebar. Todos, revisions, and all other users' memberships stay intact.",
            parameters: Type.Object(
                { tabId: surfaceIdSchema, userId: Type.Union([cuid2Schema, Type.Null()]) },
                { additionalProperties: false },
            ),
            returnType: surfaceSchema,
            durable: true,
            transactional: true,
            requiresAutoOrFullAccess: true,
            shouldReviewInAutoMode: () => true,
            describeAutoPermissionAction: ({ tabId, userId }) =>
                `removing ${userId === null ? "the standalone person" : `user ${JSON.stringify(userId)}`} from shared Tab ${JSON.stringify(tabId)} without deleting its data. Access: shared membership and sidebar write`,
            execute: async (ctx, input) => {
                await surfaces.requireAdmin(ctx, scope.agent.id);
                return surfaces.changeMember(ctx, input.tabId, input.userId, "leave");
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
