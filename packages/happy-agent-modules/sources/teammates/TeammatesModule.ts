import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { RichTasksModule } from "../richTasks/index.js";
import { TasksModule } from "../tasks/index.js";
import { TeamModule, type TeamUser } from "../team/index.js";
import { listTeammatesTool } from "./tools/list_teammates.js";
import { loopInTeammateTool } from "./tools/loop_in_teammate.js";

/** What an agent may say about one person on the team. */
export interface Teammate {
    readonly id: string;
    readonly name: string;
    readonly role: string | null;
    readonly follows: string | null;
}

export class TeammateNotFoundError extends Error {
    constructor() {
        super("No teammate has that user ID. Find IDs with list_teammates.");
        this.name = "TeammateNotFoundError";
    }
}

const TEAMMATES_INSTRUCTIONS = [
    "# Teammates",
    "",
    "Other people on the team can join this task. list_teammates shows each one's user ID, name, role, and what they follow. When this work clearly concerns what a teammate follows or does, loop them in with loop_in_teammate and say why in one sentence; it adds the task to their list and highlights it for them. Do not loop in someone already working with you here, and do not loop people in for work they would not care about.",
    "When you mention a person in a reply, link them as [their name](happy://users/<userId>); people see their current name as the link text. list_teammates and loop_in_teammate give you the exact link.",
].join("\n");

const BOT_TEAMMATES_INSTRUCTIONS = [
    "# Teammates",
    "",
    "list_teammates shows each person on the team: user ID, name, role, and what they follow. When something you found clearly concerns one teammate, such as work they follow or people they know, loop them in with loop_in_teammate and say why in one sentence: it marks this bot new for them and brings it back into their sidebar if they had hidden it, and nobody else is notified. Do not loop people in for things they would not care about.",
    "When you mention a person in a reply, link them as [their name](happy://users/<userId>); people see their current name as the link text. list_teammates and loop_in_teammate give you the exact link.",
].join("\n");

/** Where an agent loops people in: its own task, or its own bot. */
export type LoopInTarget = { readonly taskId: string } | { readonly botId: string };

/**
 * The people on the team, as agents see them, and looping one of them into a task.
 *
 * A task's agent reads the directory and adds a teammate to its own task: the teammate joins it
 * even when their automatic joining is off, and the task is marked unread for them. A bot's agent
 * does the same for its bot while its person has rich tasks on. Team mode only, because a
 * standalone installation is one person.
 */
export class TeammatesModule implements AgentModule {
    readonly name = "teammates";
    readonly #tasks: TasksModule;
    readonly #team: TeamModule;
    readonly #bots: BotsModule;
    readonly #richTasks: RichTasksModule;

    constructor(
        tasks: TasksModule,
        team: TeamModule,
        bots: BotsModule,
        richTasks: RichTasksModule,
    ) {
        this.#tasks = tasks;
        this.#team = team;
        this.#bots = bots;
        this.#richTasks = richTasks;
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const to = await this.#target(ctx, scope);
            if (to === undefined) return "";
            return "botId" in to ? BOT_TEAMMATES_INSTRUCTIONS : TEAMMATES_INSTRUCTIONS;
        },
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            const to = await this.#target(ctx, scope);
            if (to === undefined) return [];
            return [listTeammatesTool(this), loopInTeammateTool(this, to, scope.agent.id)];
        },
        // A bot's tools follow the person its turn answers.
        messageAcceptedTransact: async (ctx, scope, accepted) =>
            await this.#richTasks.notePerson(ctx, scope.kv, accepted),
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;

    /** Every person who signs in, guests left out, in name order. */
    async list(ctx: Context): Promise<readonly Teammate[]> {
        if (!this.#team.enabled) return [];
        return (await this.#team.listMembers(ctx))
            .map(teammate)
            .sort(
                (left, right) =>
                    left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
            );
    }

    /**
     * Add a teammate to the task and mark it unread for them with the agent's reason. For a bot,
     * show it to them again and mark it unread, in one change that touches nobody else.
     */
    async loopIn(
        ctx: Context,
        input: LoopInTarget & {
            readonly agentId: string;
            readonly userId: string;
            readonly reason: string;
        },
    ): Promise<{ readonly teammate: Teammate; readonly joined: boolean }> {
        return await ctx.inTx(async (txCtx) => {
            const user = this.#team.enabled
                ? await this.#team.getUser(txCtx, input.userId)
                : undefined;
            if (user === undefined || user.authentication === "guest") {
                throw new TeammateNotFoundError();
            }
            if ("botId" in input) {
                const { agentId, reason: note } = input;
                const unread = { reason: "looped_in", since: Date.now(), agentId, note };
                const change = { hidden: false, held: false, unread };
                await this.#bots.updateMembership(txCtx, input.botId, user.id, change);
                return { teammate: teammate(user), joined: true };
            }
            const result = await this.#tasks.loopIn(txCtx, input.taskId, user.id, {
                agentId: input.agentId,
                note: input.reason,
            });
            return { teammate: teammate(user), joined: result.joined };
        });
    }

    /** The agent's own task, or its own bot while its person has rich tasks on. */
    async #target(ctx: Context, scope: AgentModuleScope): Promise<LoopInTarget | undefined> {
        if (!this.#team.enabled) return undefined;
        const task = await this.#tasks.forAgent(ctx, scope.agent.id);
        if (task !== undefined) return { taskId: task.id };
        const bot = await this.#bots.forAgent(ctx, scope.agent.id);
        if (bot === undefined || !(await this.#richTasks.isOnForAgent(ctx, scope))) return;
        return { botId: bot.id };
    }
}

function teammate(user: TeamUser): Teammate {
    return {
        id: user.id,
        name: user.lastName === null ? user.firstName : `${user.firstName} ${user.lastName}`,
        role: user.role ?? null,
        follows: user.follows ?? null,
    };
}
