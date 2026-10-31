import { AsyncResource } from "node:async_hooks";
import {
    cuid2Schema,
    type AgentModule,
    type AgentModuleHooks,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { RichTasksModule } from "../richTasks/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import {
    TasksModule,
    TaskConflictError,
    taskIdentityChangeSchema,
    type TaskRecord,
    type TaskIdentityChange,
} from "../tasks/index.js";
import { assertTaskIconSlug, taskIconAsset } from "./searchTaskIcons.js";
import { taskIconPath } from "./impl/taskIconPath.js";
import { searchTaskIconsTool } from "./tools/search_task_icons.js";
import { setTaskTitleIconTool } from "./tools/set_task_title_icon.js";

/** Bundled artwork and scoped identity tools, with durable writes outside the calling turn. */
export class TaskIconsModule implements AgentModule<AnyAgentTool> {
    readonly name = "taskIcons";
    readonly #tasks: TasksModule;
    readonly #richTasks: RichTasksModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #backgroundScope = new AsyncResource("happy-agent-task-identity");

    constructor(
        tasks: TasksModule,
        richTasks: RichTasksModule,
        durableFunctions: DurableFunctionsModule,
    ) {
        this.#tasks = tasks;
        this.#richTasks = richTasks;
        this.#durableFunctions = durableFunctions;
        durableFunctions.register({
            name: "task-icons.set-identity",
            argumentsSchema: Type.Object({
                agentId: cuid2Schema,
                change: taskIdentityChangeSchema,
            }),
            resultSchema: Type.Null(),
            executor: (ctx, call) =>
                this.#backgroundScope.runInAsyncScope(async () => {
                    try {
                        // Tasks rechecks the setting, ownership and human choices inside this write.
                        await this.#tasks.setIdentityForAgent(
                            ctx,
                            call.arguments.agentId,
                            call.arguments.change,
                        );
                    } catch (error) {
                        if (!(error instanceof TaskConflictError)) throw error;
                        // A person chose, disabled rich tasks, or archived it after queueing.
                    }
                    return null;
                }),
        });
    }

    readonly beforeStart = (): AgentModuleHooks<AnyAgentTool> => ({
        tools: async (ctx, scope) =>
            (await this.#eligible(ctx, scope.agent.id)) === undefined
                ? []
                : [
                      searchTaskIconsTool(this, scope.agent.id),
                      setTaskTitleIconTool(this, scope.agent.id),
                  ],
        instructions: async (ctx, scope) =>
            (await this.#eligible(ctx, scope.agent.id)) === undefined
                ? ""
                : [
                      "Choose this task's title and icon yourself early in the work, alongside your other tools.",
                      "Search with search_task_icons using a few concrete words about the task. Inspect its top ten candidates, choose the best fitting slug, and call set_task_title_icon with a short title and that icon.",
                      "You can update them as the work changes. A person's title or icon choice is final for that field; if refused, keep their choice and continue the task.",
                  ].join("\n"),
    });

    async assertEligible(ctx: Context, agentId: string): Promise<void> {
        if ((await this.#eligible(ctx, agentId)) === undefined) {
            throw new Error(
                "Only a top-level task with rich tasks enabled may use its identity tools.",
            );
        }
    }

    async setIdentity(
        ctx: Context,
        agentId: string,
        change: TaskIdentityChange,
        toolCallId: string,
    ): Promise<void> {
        await this.assertEligible(ctx, agentId);
        if (change.icon !== undefined && change.icon !== null) assertTaskIconSlug(change.icon);
        await this.#tasks.checkIdentityForAgent(ctx, agentId, change);
        await this.#durableFunctions.invoke(ctx, {
            function: "task-icons.set-identity",
            operationId: `task-icons.identity:${toolCallId}`,
            lockKeys: [`task:${agentId}`],
            arguments: { agentId, change },
        });
    }

    assertSlug(slug: string): void {
        assertTaskIconSlug(slug);
    }

    /** A known legacy slug receives its current digest on projection without rewriting storage. */
    icon(slug: string): {
        readonly type: "library";
        readonly slug: string;
        readonly hash?: string;
    } {
        const asset = taskIconAsset(slug);
        return { type: "library", slug, ...(asset === undefined ? {} : { hash: asset.hash }) };
    }

    /** Only catalog slugs can resolve a path; a stale version never becomes an immutable URL. */
    asset(slug: string, version?: string) {
        const asset = taskIconAsset(slug);
        if (asset === undefined || (version !== undefined && version !== asset.hash))
            return undefined;
        return {
            contentPath: taskIconPath(asset.slug),
            sha256: asset.hash,
            size: asset.size,
            mimeType: "image/webp",
            name: `${asset.slug}.webp`,
            cacheControl:
                version === undefined ? "no-cache" : "public, max-age=31536000, immutable",
        };
    }

    async #eligible(ctx: Context, agentId: string): Promise<TaskRecord | undefined> {
        const task = await this.#tasks.forAgent(ctx, agentId);
        return task !== undefined &&
            task.status === "active" &&
            (await this.#richTasks.isOn(ctx, task.ownerUserId))
            ? task
            : undefined;
    }
}
