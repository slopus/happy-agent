import type { Model, Provider } from "@slopus/rig-execution";

/**
 * How a provider and model reach the world outside the workspace, if they can at all.
 *
 * `claude_auxiliary` runs Rig's own `WebSearch` tool, which asks Claude a bounded isolated question
 * with Claude's server-side search enabled. `responses_hosted` and `grok_hosted` are declared on the
 * request and answered by the provider's own backend inside its response.
 */
export type WebSearchExecution = "claude_auxiliary" | "grok_hosted" | "responses_hosted";

/**
 * Whether this provider can search with this model, and how.
 *
 * A capability, deliberately, rather than a list of tool names to add or remove. The same Anthropic
 * model reached through Claude can search and reached through Bedrock cannot, so neither the model
 * nor the provider answers this alone — which is exactly why removing a tool by name after
 * assembling it was the wrong shape. Nothing here names a tool.
 */
export function webSearchCapability(
    provider: Pick<Provider, "id" | "type">,
    model: Model,
): WebSearchExecution | undefined {
    // Bedrock serves Anthropic models without Anthropic's server-side search, so a model that can
    // search everywhere else cannot search here.
    if (provider.type === "bedrock") return undefined;
    if (provider.type === "claude") return "claude_auxiliary";
    if (provider.type === "grok") return "grok_hosted";
    if (provider.type === "codex") return "responses_hosted";
    return modelIsAnthropic(model) ? "claude_auxiliary" : undefined;
}

function modelIsAnthropic(model: Model): boolean {
    return model.id.startsWith("anthropic/");
}
