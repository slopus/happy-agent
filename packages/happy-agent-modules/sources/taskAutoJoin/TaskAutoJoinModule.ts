import type { AgentModule, AgentModuleHooks } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { TasksModule } from "../tasks/index.js";
import { TeamModule, type TeamUser } from "../team/index.js";
import { UserSettingsModule } from "../userSettings/index.js";

/** Only an explicit false opts out; missing, cleared, and unfamiliar values keep the default. */
export const TASK_AUTO_JOIN_SETTING = "tasks.autoJoin";
const RECONCILE_FUNCTION = "taskAutoJoin.reconcile";

/**
 * Default task participation for enrolled team members. Policy lives here so the settings store
 * remains opaque and neither Tasks nor Team acquires a dependency cycle through user settings.
 */
export class TaskAutoJoinModule implements AgentModule {
    readonly name = "taskAutoJoin";
    readonly #tasks: TasksModule;
    readonly #team: TeamModule;
    readonly #settings: UserSettingsModule;
    readonly #durableFunctions: DurableFunctionsModule;

    constructor(
        tasks: TasksModule,
        team: TeamModule,
        settings: UserSettingsModule,
        durableFunctions: DurableFunctionsModule,
    ) {
        this.#tasks = tasks;
        this.#team = team;
        this.#settings = settings;
        this.#durableFunctions = durableFunctions;

        durableFunctions.register({
            name: RECONCILE_FUNCTION,
            argumentsSchema: Type.Null(),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                if (!this.#team.enabled) return null;
                // Startup catch-up is resumable and releases the database between bounded batches.
                // Each batch rechecks the setting, so a concurrent opt-out stops further joining.
                for (const user of await this.#team.listMembers(ctx)) {
                    await this.#joinAll(ctx, user);
                }
                return null;
            },
        });

        tasks.onEventTransactional(async (ctx, event) => {
            if (!team.enabled) return;
            if (
                event.type !== "task_created" &&
                !(
                    event.type === "task_updated" &&
                    event.previousTask.status === "archived" &&
                    event.task.status === "active"
                )
            ) {
                return;
            }
            for (const user of await team.listMembers(ctx)) {
                // Creation joins the owner itself, even when they have opted out of autojoin.
                if (event.type === "task_created" && user.id === event.task.ownerUserId) continue;
                await this.#joinBatch(ctx, user, event.task.id);
            }
        });

        team.onProfileUpdatedTransactional(async (ctx, event) => {
            if (!team.enabled || event.previousVersion !== null) return;
            if (event.user.authentication === "guest") return;
            // A member machine configuration lists with auto_join_tasks = false starts opted out,
            // through the same setting they can change later.
            if (team.seededMember(event.user)?.autoJoinTasks === false) {
                const userCtx = team.connectionContext(ctx, event.user);
                const current = await settings.get(userCtx, TASK_AUTO_JOIN_SETTING);
                if (current.updatedAt === null) {
                    await settings.save(userCtx, TASK_AUTO_JOIN_SETTING, { value: false });
                }
            }
            await this.#joinAll(ctx, event.user);
        });

        settings.onEventTransactional(async (ctx, event) => {
            if (!team.enabled || event.setting.key !== TASK_AUTO_JOIN_SETTING) return;
            if (event.setting.value === false) return;
            const user = await team.getUser(ctx, event.owner);
            if (user === undefined || user.authentication === "guest") return;
            await this.#joinAll(ctx, user);
        });
    }

    readonly beforeStart = (): AgentModuleHooks => ({
        afterStart: async (ctx) => {
            if (!this.#team.enabled) return;
            await this.#durableFunctions.invoke(ctx, {
                function: RECONCILE_FUNCTION,
                arguments: null,
                operationId: RECONCILE_FUNCTION,
                lockKeys: [RECONCILE_FUNCTION],
            });
        },
    });

    async #joinAll(ctx: Context, user: TeamUser): Promise<void> {
        while ((await this.#joinBatch(ctx, user)) > 0) {
            ctx.lifetime?.throwIfAborted();
        }
    }

    async #joinBatch(ctx: Context, user: TeamUser, taskId?: string): Promise<number> {
        return await ctx.inTx(async (txCtx) => {
            const userCtx = this.#team.connectionContext(txCtx, user);
            const setting = await this.#settings.get(userCtx, TASK_AUTO_JOIN_SETTING);
            if (setting.value === false) return 0;
            return await this.#tasks.joinAutomatically(txCtx, user.id, taskId);
        });
    }
}
