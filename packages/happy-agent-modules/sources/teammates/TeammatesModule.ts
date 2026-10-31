import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { TasksModule, type TaskMembership } from "../tasks/index.js";
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

/**
 * The people on the team, as agents see them, and looping one of them into a task.
 *
 * A task's agent reads the directory and adds a teammate to its own task: the teammate joins it
 * even when their automatic joining is off, and the task is marked unread for them. Team mode
 * only, because a standalone installation is one person.
 */
export class TeammatesModule implements AgentModule {
    readonly name = "teammates";
    readonly #tasks: TasksModule;
    readonly #team: TeamModule;

    constructor(tasks: TasksModule, team: TeamModule) {
        this.#tasks = tasks;
        this.#team = team;
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> =>
            (await this.#offersTools(ctx, scope.agent.id)) ? TEAMMATES_INSTRUCTIONS : "",
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            const task = this.#team.enabled
                ? await this.#tasks.forAgent(ctx, scope.agent.id)
                : undefined;
            if (task === undefined) return [];
            return [listTeammatesTool(this), loopInTeammateTool(this, task.id, scope.agent.id)];
        },
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

    /** Add a teammate to the task and mark it unread for them with the agent's reason. */
    async loopIn(
        ctx: Context,
        input: {
            readonly taskId: string;
            readonly agentId: string;
            readonly userId: string;
            readonly reason: string;
        },
    ): Promise<{
        readonly teammate: Teammate;
        readonly membership: TaskMembership;
        readonly joined: boolean;
    }> {
        return await ctx.inTx(async (txCtx) => {
            const user = this.#team.enabled
                ? await this.#team.getUser(txCtx, input.userId)
                : undefined;
            if (user === undefined || user.authentication === "guest") {
                throw new TeammateNotFoundError();
            }
            const result = await this.#tasks.loopIn(txCtx, input.taskId, user.id, {
                agentId: input.agentId,
                note: input.reason,
            });
            return { teammate: teammate(user), ...result };
        });
    }

    async #offersTools(ctx: Context, agentId: string): Promise<boolean> {
        return this.#team.enabled && (await this.#tasks.forAgent(ctx, agentId)) !== undefined;
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
