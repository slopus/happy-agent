import {
    defineAgentTool,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

const exact = { additionalProperties: false } as const;
const emptyResultSchema = Type.Object({}, exact);
const codexSearchParameters = Type.Object(
    {
        limit: Type.Optional(
            Type.Integer({
                description: "Maximum number of matching tools to return. Defaults to 8.",
                minimum: 1,
            }),
        ),
        query: Type.String({
            description: "Search terms describing the tool or capability needed next.",
            minLength: 1,
        }),
    },
    exact,
);

const CODEX_TOOL_SEARCH_DESCRIPTION =
    "Search the deferred Happy Agent tool catalog with BM25 and make the best matching tools callable. Use this when the capability summary says an appropriate tool exists but its definition is not currently loaded.";

const CLAUDE_TOOL_SEARCH_MODELS = [
    "anthropic/opus-5",
    "anthropic/sonnet-5",
    "anthropic/fable-5-1",
    "anthropic/fable-5",
    "anthropic/opus-4-8",
] as const;

const CODEX_TOOL_SEARCH_MODELS = [
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
] as const;

/** The provider/model identity that selects one exact native discovery surface. */
export interface ToolDiscoverySelection {
    readonly providerKind: ProviderModelCompatibilityType | undefined;
    readonly model: string | undefined;
}

const claudeToolSearch = defineAgentTool({
    name: "ToolSearch",
    server: { type: "ToolSearch" },
    persistInHistory: false,
    visibleToUser: false,
    returnType: emptyResultSchema,
    shouldReviewInAutoMode: () => false,
    execute: () => Promise.reject(new Error("Claude owns ToolSearch execution.")),
    toLLM: () => [],
});

const codexToolSearch = defineAgentTool({
    name: "tool_search",
    description: CODEX_TOOL_SEARCH_DESCRIPTION,
    parameters: codexSearchParameters,
    server: {
        type: "tool_search",
        execution: "client",
        description: CODEX_TOOL_SEARCH_DESCRIPTION,
        parameters: codexSearchParameters,
    },
    persistInHistory: false,
    visibleToUser: false,
    returnType: emptyResultSchema,
    shouldReviewInAutoMode: () => false,
    execute: () => Promise.reject(new Error("Codex owns tool_search execution.")),
    toLLM: () => [],
});

/**
 * Select the one native discovery tool this exact provider/model route supports.
 *
 * The lists are deliberately closed. A new or unproven route gets no search descriptor, which
 * makes Providers expose every `defer`-marked client tool eagerly instead of hiding usable tools.
 */
export function toolDiscoveryTools(selection: ToolDiscoverySelection): readonly AnyAgentTool[] {
    if (
        selection.providerKind === "claude" &&
        includes(CLAUDE_TOOL_SEARCH_MODELS, selection.model)
    ) {
        return [claudeToolSearch];
    }
    if (selection.providerKind === "codex" && includes(CODEX_TOOL_SEARCH_MODELS, selection.model)) {
        return [codexToolSearch];
    }
    return [];
}

/** Native tool discovery for the normal Happy Agent tool catalog. */
export class ToolDiscoveryModule implements AgentModule {
    readonly name = "toolDiscovery";

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] =>
            toolDiscoveryTools({
                providerKind: scope.agent.providerKind,
                model: scope.agent.model,
            }),
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}

function includes(values: readonly string[], value: string | undefined): boolean {
    return value !== undefined && values.includes(value);
}
