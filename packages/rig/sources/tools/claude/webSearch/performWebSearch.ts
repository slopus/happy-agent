import type { Model, Provider } from "@slopus/rig-execution";
import {
    blocksContainSearch,
    makeWebSearchOutput,
    type WebSearchHelperBlock,
} from "./makeWebSearchOutput.js";
import type { WebSearchInput, WebSearchOutput } from "./types.js";

export async function performWebSearch(
    input: WebSearchInput,
    provider: Provider,
    model: Model,
    signal?: AbortSignal,
): Promise<WebSearchOutput> {
    const auxiliaryProvider = provider as Provider & {
        runClaudeAuxiliaryQuery?: (
            model: Model,
            request: {
                prompt: string;
                signal?: AbortSignal;
                systemPrompt: string;
                tools?: readonly "WebSearch"[];
            },
        ) => Promise<{ content: readonly unknown[] }>;
    };
    if (auxiliaryProvider.runClaudeAuxiliaryQuery === undefined) {
        throw new Error(
            `The selected provider '${provider.id}' does not support Claude web helper inference.`,
        );
    }
    const startedAt = performance.now();
    const response = await auxiliaryProvider.runClaudeAuxiliaryQuery(model, {
        prompt: makeSearchPrompt(input),
        ...(signal === undefined ? {} : { signal }),
        systemPrompt: "You are an assistant for performing a web search tool use.",
        tools: ["WebSearch"],
    });

    const blocks = response.content as readonly WebSearchHelperBlock[];
    // The helper is asked to search and is capable of answering from memory instead. Returning
    // that as a successful search would report pages it never consulted, and cite none — so not
    // searching is reported as the failure it is rather than as an empty success.
    //
    // What is checked is whether a search happened, not whether it found anything. A search that
    // ran and came back empty, or came back an error, did happen: its own outcome is the honest
    // answer, and calling it "answered without searching" would be a different and untrue report.
    if (!blocksContainSearch(blocks)) {
        throw new Error(
            `The web search for "${input.query}" did not run. The model answered without searching.`,
        );
    }
    return makeWebSearchOutput(blocks, input.query, (performance.now() - startedAt) / 1000);
}

function makeSearchPrompt(input: WebSearchInput): string {
    const filters = [
        input.allowed_domains === undefined
            ? undefined
            : `Only include these domains: ${input.allowed_domains.join(", ")}`,
        input.blocked_domains === undefined
            ? undefined
            : `Exclude these domains: ${input.blocked_domains.join(", ")}`,
    ].filter(Boolean);
    return [`Perform a web search for the query: ${input.query}`, ...filters].join("\n");
}
