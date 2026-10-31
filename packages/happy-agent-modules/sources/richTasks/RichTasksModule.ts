import type {
    AgentBaseAcceptedMessage,
    AgentKV,
    AgentModule,
    AgentModuleScope,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { isUserOriginMetadata } from "../impl/messageOrigin.js";
import { TasksModule } from "../tasks/index.js";
import { TeamModule } from "../team/index.js";
import { UserSettingsModule } from "../userSettings/index.js";

/** Only the JSON boolean `true` turns it on; anything else leaves a person on today's list. */
export const RICH_TASKS_SETTING = "tasks.rich";
/** Named sections in the person's list. */
export const TASK_SECTIONS_SETTING = "tasks.sections";
/** Focus arranges the person's list. */
export const TASK_FOCUS_SETTING = "tasks.focus";
export type RichTasksSetting =
    | typeof RICH_TASKS_SETTING
    | typeof TASK_SECTIONS_SETTING
    | typeof TASK_FOCUS_SETTING;

/** Whose message an agent's turn answers, kept in the store of the module that asks. */
const PERSON_KEY = "rich-tasks-person";

/**
 * Interprets the reserved rich-task settings, so the settings store stays opaque and Tasks needs
 * no path to it. Work follows the setting of the person it belongs to: a task's owner, or the
 * standalone installation's one person.
 */
export class RichTasksModule implements AgentModule {
    readonly name = "richTasks";
    readonly #tasks: TasksModule;
    readonly #team: TeamModule;
    readonly #settings: UserSettingsModule;

    constructor(tasks: TasksModule, team: TeamModule, settings: UserSettingsModule) {
        this.#tasks = tasks;
        this.#team = team;
        this.#settings = settings;
        // Rich tasks choose their own title and icon; everyone else keeps ordinary naming.
        tasks.decideIdentityWith(async (ctx, task) => await this.isOn(ctx, task.ownerUserId));
    }

    /** Whether a setting is on for a person: a team member's ID, or nobody when standalone. */
    async isOn(
        ctx: Context,
        userId: string | undefined,
        setting: RichTasksSetting = RICH_TASKS_SETTING,
    ): Promise<boolean> {
        let ownerCtx = ctx;
        if (this.#team.enabled) {
            const user = userId === undefined ? undefined : await this.#team.getUser(ctx, userId);
            if (user === undefined) return false;
            ownerCtx = this.#team.connectionContext(ctx, user);
        }
        return (await this.#settings.get(ownerCtx, setting)).value === true;
    }

    /**
     * Remember whose message an agent's turn answers, in the asking module's own store for that
     * agent. A module that gives tools through `isOnForAgent` calls this from its
     * `messageAcceptedTransact` hook, because module stores cannot be read across modules.
     */
    async notePerson(ctx: Context, kv: AgentKV, accepted: AgentBaseAcceptedMessage): Promise<void> {
        if (accepted.message.role !== "user" || !isUserOriginMetadata(accepted.metadata)) return;
        const userId = accepted.metadata?.["userId"];
        await kv.write(ctx, PERSON_KEY, typeof userId === "string" ? userId : null);
    }

    /**
     * Whether a setting is on for the person an agent works for: a task's owner, or, for a bot,
     * the person whose message its turn answers. Card tools are given only through this.
     */
    async isOnForAgent(
        ctx: Context,
        scope: AgentModuleScope,
        setting: RichTasksSetting = RICH_TASKS_SETTING,
    ): Promise<boolean> {
        const task = await this.#tasks.forAgent(ctx, scope.agent.id);
        const person = task === undefined ? await scope.kv.read(ctx, PERSON_KEY) : task.ownerUserId;
        return await this.isOn(ctx, typeof person === "string" ? person : undefined, setting);
    }
}
