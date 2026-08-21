import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeModule } from "../../compute/index.js";

/**
 * The private review system's inspection-only compute surface.
 *
 * Happy Agent v1 exposed its reviewer a fixed, read-only slice of its coding tools — the file readers, the
 * directory and search tools, and the shell tools — so a review could gather evidence about local
 * state before deciding, exactly as Codex's guardian does. This module is the v2 equivalent: it
 * contributes that same fixed set and nothing else. There is no `write_file`, `edit_file`,
 * `delete_file`, or `move_file`, so a review can look but never change the workspace, and every
 * private send selects `read_only`, so the shell tools stay inside the sandbox that is the real
 * enforcement boundary for redirection and subprocesses.
 *
 * The array itself belongs to the compute module, which owns the machine the reviewer looks at and
 * the reviewer's own read bookkeeping. This module asks for it with the reviewer's own scope, so
 * the vendor of the reviewer's model route decides which fixed read-only array it receives — a
 * Claude review gets Claude's tools, a Codex review Codex's — exactly as Happy Agent v1 gave its review
 * side agent its own provider's tools. Nothing here widens what came back, and nothing caches it:
 * each review is handed the array the compute module builds for that review.
 *
 * The machine outlives any one review, so it is created on the review system's own lifetime rather
 * than on the turn that first needed it.
 */
export class AutoReviewComputeModule implements AgentModule {
    readonly name = "autoReviewCompute";

    readonly #compute: ComputeModule;
    readonly #lifetime: Context;

    constructor(compute: ComputeModule, lifetime: Context) {
        this.#compute = compute;
        this.#lifetime = lifetime;
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (_ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> =>
            await this.#compute.reviewerTools(this.#lifetime, scope),
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}
