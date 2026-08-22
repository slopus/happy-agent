import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleInferencePreparationAction,
    AgentModuleScope,
} from "@slopus/happy-agent-base";

import { ConfigModule } from "../config/index.js";

/** Checks the curated context limit at the safe boundary before every provider inference. */
export class ContextWindowModule implements AgentModule {
    readonly name = "contextWindow";

    constructor(private readonly config: ConfigModule) {}

    readonly beforeStart = (): AgentModuleHooks => ({
        prepareInference: (_ctx, scope, preparation) =>
            this.#compactionAction(scope, preparation.contextTokens),
    });

    #compactionAction(
        scope: AgentModuleScope,
        contextTokens: number | undefined,
    ): readonly AgentModuleInferencePreparationAction[] | undefined {
        if (contextTokens === undefined || scope.agent.model === undefined) return undefined;
        const context = this.config.modelContext(scope.agent.provider, scope.agent.model);
        if (context === undefined || contextTokens < context.autoCompactWindow) return undefined;
        return [{ type: "compact" }];
    }
}
