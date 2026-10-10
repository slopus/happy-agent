import { defineAgentTool, type AgentKV } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { taskRecordSchema, taskStatusSchema, type TaskRecord } from "../Task.js";
import type { TasksModule } from "../TasksModule.js";

/** The largest page `list_tasks` returns, and its size when the caller asks for none. */
export const MAX_TASK_PAGE_SIZE = 50;

export const listTasksInputSchema = Type.Object(
    {
        /** Every task, or only those the person you are working for joined, in their order. */
        scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("joined")])),
        status: Type.Optional(taskStatusSchema),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_PAGE_SIZE })),
    },
    { additionalProperties: false },
);
type ListTasksInput = Static<typeof listTasksInputSchema>;

const listedTaskSchema = Type.Object({
    task: taskRecordSchema,
    owner: Type.Union([Type.String(), Type.Null()]),
});
type ListedTask = Static<typeof listedTaskSchema>;
const taskPageSchema = Type.Object({
    tasks: Type.Array(listedTaskSchema),
    total: Type.Integer({ minimum: 0 }),
    nextOffset: Type.Optional(Type.Integer({ minimum: 0 })),
});
type TaskPage = Static<typeof taskPageSchema>;

/**
 * List a bounded page of persistent tasks with their owners, archived ones included unless
 * filtered: every task, or the joined list of the person this conversation works for.
 */
export function listTasksTool(tasks: TasksModule, kv: AgentKV) {
    return defineAgentTool({
        name: "list_tasks",
        defer: true,
        capabilities: [
            "Create, list, message, and archive persistent tasks with their own folders.",
        ],
        searchKeywords: ["task catalog", "open tasks", "task owners", "find task"],
        description:
            'List persistent tasks on this installation: user-visible conversations, each with its own folder. Each line shows the task\'s ID, name, status, owner, creating agent, and folder. Omit scope or pass "all" for every task, oldest first; pass "joined" for only the tasks the person you are working for joined, in the order they arranged their list. Omit status to include every status, or pass "active" or "archived". Results are paged; follow nextOffset until every task you need is read. Use send_task_message with a task\'s ID to talk to an active one.',
        parameters: listTasksInputSchema,
        returnType: taskPageSchema,
        durable: false,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx: Context, input: ListTasksInput): Promise<TaskPage> => {
            const matching = (await listScope(ctx, tasks, kv, input.scope ?? "all")).filter(
                (task) => input.status === undefined || task.status === input.status,
            );
            const offset = input.offset ?? 0;
            const page = matching.slice(offset, offset + (input.limit ?? MAX_TASK_PAGE_SIZE));
            const next = offset + page.length;
            return {
                tasks: page.map((task) => ({
                    task: structuredClone(task) as TaskRecord,
                    owner: tasks.ownerLabel(task) ?? null,
                })),
                total: matching.length,
                ...(next < matching.length ? { nextOffset: next } : {}),
            };
        },
        toLLM: ({ tasks: listed, total, nextOffset }) => [
            {
                type: "text",
                text:
                    total === 0
                        ? "No tasks found."
                        : [
                              ...listed.map(formatTaskLine),
                              ...(nextOffset === undefined
                                  ? []
                                  : [
                                        `Showing ${String(listed.length)} of ${String(total)} tasks; continue with offset ${String(nextOffset)}.`,
                                    ]),
                          ].join("\n"),
            },
        ],
    });
}

async function listScope(
    ctx: Context,
    tasks: TasksModule,
    kv: AgentKV,
    scope: "all" | "joined",
): Promise<readonly TaskRecord[]> {
    if (scope === "all") return await tasks.list(ctx);
    const member = tasks.memberFor(await tasks.ownerFor(ctx, kv));
    if (member === undefined) {
        throw new Error(
            "No person is identified in this conversation, so there is no joined task list to read. List every task instead.",
        );
    }
    return (await tasks.listForMember(ctx, member)).map(({ task }) => task);
}

function formatTaskLine({ task, owner }: ListedTask): string {
    const status = task.status === "archived" ? " (archived)" : "";
    const facts = [
        `id ${task.id}`,
        ...(owner === null ? [] : [`owner ${owner}`]),
        ...(task.creatorAgentId === undefined ? [] : [`created by agent ${task.creatorAgentId}`]),
        `folder ${task.path}`,
    ];
    return `- ${task.name}${status} — ${facts.join(", ")}`;
}
