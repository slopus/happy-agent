import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { askParentTool, type AskParent } from "./askParentTool.js";

/**
 * The private review system's `ask_parent` surface.
 *
 * A reviewer whose reviewed agent was created by another agent may ask that parent's reviewer
 * before it denies, and a forked parent reviewer may ask further up, toward the root. Whether a
 * private agent may ask, and whom, is decided by `AutoModule` for exactly one review or one
 * question and forgotten when it settles, so the tool array is empty for a root agent's reviewer,
 * for a chain that has run out of hops, and outside any review.
 */
export class AutoReviewAskParentModule implements AgentModule {
    readonly name = "autoReviewAskParent";

    /** Who each private agent asks while its review or question runs. */
    readonly #sessions = new Map<string, AskParent>();

    /** Let one private agent ask its reviewed agent's parent until `endReview`. */
    beginReview(privateAgentId: string, session: AskParent): void {
        this.#sessions.set(privateAgentId, session);
    }

    endReview(privateAgentId: string): void {
        this.#sessions.delete(privateAgentId);
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => {
            const session = this.#sessions.get(scope.agent.id);
            return session === undefined ? [] : [askParentTool(session)];
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}
