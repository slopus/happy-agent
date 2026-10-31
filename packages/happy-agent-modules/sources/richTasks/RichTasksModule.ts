import type { AgentModule } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { TasksModule } from "../tasks/index.js";
import { TeamModule } from "../team/index.js";
import { UserSettingsModule } from "../userSettings/index.js";

/** Only the JSON boolean `true` turns it on; anything else leaves a person on today's list. */
export const RICH_TASKS_SETTING = "tasks.rich";

/**
 * Interprets the reserved rich-task settings, so the settings store stays opaque and Tasks needs
 * no path to it. Work follows the setting of the person it belongs to: a task's owner, or the
 * standalone installation's one person.
 */
export class RichTasksModule implements AgentModule {
    readonly name = "richTasks";
    readonly #team: TeamModule;
    readonly #settings: UserSettingsModule;

    constructor(tasks: TasksModule, team: TeamModule, settings: UserSettingsModule) {
        this.#team = team;
        this.#settings = settings;
        // Naming picks an icon only for people who see rich tasks; everyone else keeps today's
        // naming request exactly as it was.
        tasks.decideIconsWith(async (ctx, task) => await this.isOn(ctx, task.ownerUserId));
    }

    /** Whether rich tasks are on for a person: a team member's ID, or nobody when standalone. */
    async isOn(ctx: Context, userId: string | undefined): Promise<boolean> {
        let ownerCtx = ctx;
        if (this.#team.enabled) {
            const user = userId === undefined ? undefined : await this.#team.getUser(ctx, userId);
            if (user === undefined) return false;
            ownerCtx = this.#team.connectionContext(ctx, user);
        }
        return (await this.#settings.get(ownerCtx, RICH_TASKS_SETTING)).value === true;
    }
}
