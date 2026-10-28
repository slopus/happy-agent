import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { SpacesModule } from "../spaces/index.js";
import { TasksModule } from "../tasks/index.js";
import { TeamModule, type TeamUser } from "../team/index.js";
import { listTeammatesTool } from "./tools/list_teammates.js";
import { notifyTeammateTool } from "./tools/notify_teammate.js";

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
    "Other people on the team may want to know about this task. list_teammates shows each one's user ID, name, role, and what they follow. When this work clearly concerns what a teammate does or follows, tell them with notify_teammate and say why in one sentence; their own Focus decides whether to add the task to their sidebar. Do not notify someone already working with you here, and do not notify people about work they would not care about.",
    'When you mention a person in a reply, write <happy-user id="…"/> with their user ID; people see their name in its place. notify_teammate gives you the exact tag.',
].join("\n");

/**
 * The people on the team, as agents see them, and telling one of them about a task.
 *
 * A task's agent reads the directory and mentions a teammate to that teammate's own Prioritizing,
 * which decides whether the task belongs in their sidebar. Nothing here joins anyone: only a
 * person's Prioritizing changes how their sidebar is organized. Team mode only, because a
 * standalone installation is one person.
 */
export class TeammatesModule implements AgentModule {
    readonly name = "teammates";
    readonly #tasks: TasksModule;
    readonly #team: TeamModule;
    readonly #spaces: SpacesModule;

    constructor(tasks: TasksModule, team: TeamModule, spaces: SpacesModule) {
        this.#tasks = tasks;
        this.#team = team;
        this.#spaces = spaces;
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> =>
            (await this.#offersTools(ctx, scope.agent.id)) ? TEAMMATES_INSTRUCTIONS : "",
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            const task = this.#team.enabled
                ? await this.#tasks.forAgent(ctx, scope.agent.id)
                : undefined;
            if (task === undefined) return [];
            return [listTeammatesTool(this), notifyTeammateTool(this, task.id)];
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

    /**
     * Tell a teammate's Prioritizing that this task concerns them. `delivered` is false when they
     * have no Prioritizing to hear it, because Stem Cells is off for them.
     */
    async notify(
        ctx: Context,
        input: { readonly taskId: string; readonly userId: string; readonly reason: string },
    ): Promise<{ readonly teammate: Teammate; readonly delivered: boolean }> {
        return await ctx.inTx(async (txCtx) => {
            const user = this.#team.enabled
                ? await this.#team.getUser(txCtx, input.userId)
                : undefined;
            if (user === undefined || user.authentication === "guest") {
                throw new TeammateNotFoundError();
            }
            const task = await this.#tasks.get(txCtx, input.taskId);
            const owner =
                task?.ownerUserId === undefined
                    ? undefined
                    : await this.#team.getUser(txCtx, task.ownerUserId);
            const delivered = await this.#spaces.forwardMention(txCtx, {
                userId: user.id,
                taskId: input.taskId,
                reason: input.reason,
                ...(owner === undefined ? {} : { fromName: teammate(owner).name }),
            });
            return { teammate: teammate(user), delivered };
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
