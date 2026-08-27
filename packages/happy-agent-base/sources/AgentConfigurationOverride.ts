import type {
    ProviderModelCompatibilityType,
    SessionReasoningEffort,
    SessionServiceTier,
} from "@slopus/happy-providers";

import type { AnyAgentTool } from "./AgentTool.js";

/** The provider/model selection whose prompt and tool surface is being resolved. */
export interface AgentConfigurationSelection {
    /** Registry ID of the provider in force. */
    readonly provider: string;
    /** Vendor-compatible shape registered for that provider, when it is known. */
    readonly providerKind: ProviderModelCompatibilityType | undefined;
    /** Model in force, when one has been selected. */
    readonly model: string | undefined;
    /** Reasoning effort in force, when one has been selected. */
    readonly effort: SessionReasoningEffort | undefined;
    /** Service tier in force, when one has been selected. */
    readonly tier: SessionServiceTier | undefined;
}

/** Identity of one source that contributed to the provider-facing configuration. */
export interface AgentConfigurationContributor {
    /** Whether mutable state, Base itself, direct hooks, or a module made the contribution. */
    readonly type: "agent" | "base" | "hooks" | "module";
    /** Stable source identity; direct hooks use `agent-base-hooks`. */
    readonly id: string;
}

/** One non-empty system-instruction fragment before override middleware runs. */
export interface AgentInstructionsContribution {
    readonly contributor: AgentConfigurationContributor;
    readonly instructions: string;
}

/** Complete input to one ordered system-instruction override. */
export interface AgentInstructionsOverride {
    /** Selection this exact provider request will use. */
    readonly selection: AgentConfigurationSelection;
    /** Every original instruction fragment, with the agent or module that contributed it. */
    readonly contributions: readonly AgentInstructionsContribution[];
    /** Current final instructions, including the answers of earlier override hooks. */
    readonly instructions: string;
}

/** One non-empty fixed tool-array contribution before override middleware runs. */
export interface AgentToolsContribution<Tool extends AnyAgentTool = AnyAgentTool> {
    readonly contributor: AgentConfigurationContributor;
    readonly tools: readonly Tool[];
}

/** Complete input to one ordered tool-array override. */
export interface AgentToolsOverride<Tool extends AnyAgentTool = AnyAgentTool> {
    /** Selection this exact provider request will use. */
    readonly selection: AgentConfigurationSelection;
    /** Every original fixed tool array, with the agent or module that contributed it. */
    readonly contributions: readonly AgentToolsContribution<Tool>[];
    /** Current final tool array, including the answers of earlier override hooks. */
    readonly tools: readonly Tool[];
}
