import type {
    AgentBaseModelChange,
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionSystemMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { HistoryExcerpt, HistoryModule } from "../history/index.js";
import { createModelSwitchNotice } from "./impl/createModelSwitchNotice.js";

/** How much of the erased conversation the notice may carry. */
const MAX_EXCERPT_CHARACTERS = 32_000;
/**
 * The name of the one tool `HistoryModule` exposes. Fixed rather than configurable: a
 * `HistoryModule` always offers exactly `read_agent_history` (see
 * `history/tools/read_agent_history.ts`), so there is nothing to name separately.
 */
const HISTORY_TOOL_NAME = "read_agent_history";

/**
 * The notice a model gets when it inherits a conversation it cannot see.
 *
 * Switching between incompatible models erases the conversation: their transcripts cannot be
 * replayed to one another, so the new model starts with an empty context while the work the old
 * one did still stands. Left to itself it would answer the next message as though nothing had
 * happened. This module puts one system message at the head of that fresh context saying what
 * changed and that a conversation it cannot see came before, so the model orients itself instead
 * of starting over.
 *
 * A changed request profile takes the same reset path, even when the model/provider stays put.
 * A compatible model-only switch keeps the history and needs no notice, and none is produced.
 * Neither does a new agent's first message, which settles a model rather than replacing one.
 *
 * Model switching itself never requires a history: the notice degrades to saying plainly that an
 * invisible conversation came before, which is honest and sufficient on its own. The
 * `HistoryModule` is therefore an optional dependency; when it is given, the notice also quotes
 * both ends of the erased conversation and names the tool that can read the rest.
 */
export class ModelSwitchModule implements AgentModule {
    readonly name = "model-switch";

    /** The history the notice quotes and points the model at, when the agent keeps one. */
    readonly #history: HistoryModule | undefined;
    /** The collection this module belongs to, which is where model labels come from. */
    #agents: AgentSystemRef | undefined;

    constructor(history?: HistoryModule) {
        this.#history = history;
    }

    /** Keep the collection, so a model can be named the way a person would name it. */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    readonly #hooks: AgentModuleHooks = {
        modelChanged: async (
            ctx: Context,
            scope: AgentModuleScope,
            change: AgentBaseModelChange,
        ): Promise<SessionSystemMessage | undefined> => {
            // A compatible change carries the history across, so there is nothing to explain.
            if (!change.wasReset) return undefined;
            // An agent that never had a model never held a conversation either: its first message
            // settles the selection rather than replacing one. The base still reports that as a
            // reset because the empty context is discarded, but there is no erased work to inherit,
            // so a notice would only tell a new agent to go looking for a past it never had.
            if (change.previousModel === undefined) return undefined;
            const profileReset =
                change.previousModel === change.model &&
                change.previousProvider === change.provider;
            const text = createModelSwitchNotice({
                previousModel: this.#label(change.previousModel, change.previousProvider),
                previousProvider: change.previousProvider,
                model: this.#label(change.model, change.provider),
                provider: change.provider,
                ...(profileReset ? { profileReset: true } : {}),
                ...(this.#history === undefined ? {} : { historyTool: HISTORY_TOOL_NAME }),
                ...(await this.#excerpt(ctx, scope.agent.id)),
            });
            return { role: "system", content: [{ type: "text", text }] };
        },
    };

    /**
     * The two ends of the conversation being erased, when there is a history to read them from.
     *
     * A failure here is deliberately not fatal. This hook runs inside the switch: a rejection
     * rejects the switch itself and leaves the agent on the old model, which is far worse than a
     * notice that quotes nothing. So an unreadable history costs the excerpt and nothing else.
     */
    async #excerpt(
        ctx: Context,
        agentId: string,
    ): Promise<{ readonly excerpt?: HistoryExcerpt | undefined }> {
        if (this.#history === undefined) return {};
        try {
            const excerpt = await this.#history.readExcerpt(ctx, agentId, MAX_EXCERPT_CHARACTERS);
            return excerpt === undefined ? {} : { excerpt };
        } catch (error: unknown) {
            ctx.log.warn("A model switch could not quote the history it is replacing.", error);
            return {};
        }
    }

    /** What to call a model: its picker label when the collection offers it, else its ID. */
    #label(model: string | undefined, providerId: string): string {
        if (model === undefined) return "an unnamed model";
        const offered = this.#agents?.models.find(
            (candidate) => candidate.id === model && candidate.providerId === providerId,
        );
        return offered?.name ?? model;
    }
}
