import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";

export interface CodexModelProperties {
    readonly compactionHash: string;
    readonly contextWindow: number;
    readonly defaultEffort: SessionReasoningEffort;
    readonly responsesLite: boolean;
}

const MODEL_PROPERTIES: Readonly<Record<string, CodexModelProperties>> = {
    "codex-auto-review": {
        compactionHash: "2911",
        contextWindow: 272_000,
        defaultEffort: "low",
        responsesLite: false,
    },
    "gpt-5.4": {
        compactionHash: "2911",
        contextWindow: 272_000,
        defaultEffort: "medium",
        responsesLite: false,
    },
    "gpt-5.5": {
        compactionHash: "2911",
        contextWindow: 272_000,
        defaultEffort: "medium",
        responsesLite: false,
    },
    "gpt-6-astra": {
        compactionHash: "3000",
        contextWindow: 272_000,
        defaultEffort: "low",
        responsesLite: true,
    },
    "gpt-5.6-luna": {
        compactionHash: "3000",
        contextWindow: 272_000,
        defaultEffort: "medium",
        responsesLite: true,
    },
    "gpt-5.6-sol": {
        compactionHash: "3000",
        contextWindow: 272_000,
        defaultEffort: "medium",
        responsesLite: true,
    },
    "gpt-5.6-terra": {
        compactionHash: "3000",
        contextWindow: 272_000,
        defaultEffort: "medium",
        responsesLite: true,
    },
};

export function getCodexModelProperties(model: string): CodexModelProperties | undefined {
    const bedrock = model.startsWith("openai.");
    const properties = MODEL_PROPERTIES[model.replace(/^openai\./u, "")];
    if (!bedrock || properties === undefined) return properties;
    return {
        ...properties,
        // Bedrock's 5.6 catalog entries inherit the 5.5 wire and compaction contract.
        compactionHash: "2911",
        responsesLite: false,
    };
}
