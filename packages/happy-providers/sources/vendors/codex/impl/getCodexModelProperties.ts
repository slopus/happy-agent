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
    // OpenAI's Codex models page gives the subscription windows (Astra 272k, Sol 500k, both up to
    // 1M opt-in): https://learn.chatgpt.com/docs/models. Codex's models.json has no 6.2 entry yet,
    // so the hash, Lite shape, and low default follow the GPT-6.1 Sol and GPT-6 Astra entries.
    "gpt-6.2-astra": {
        compactionHash: "3000",
        contextWindow: 272_000,
        defaultEffort: "low",
        responsesLite: true,
    },
    "gpt-6.2-sol": {
        compactionHash: "3000",
        contextWindow: 500_000,
        defaultEffort: "low",
        responsesLite: true,
    },
    "gpt-6.1-sol": {
        compactionHash: "3000",
        contextWindow: 272_000,
        defaultEffort: "low",
        responsesLite: true,
    },
    // Codex subscription defaults, not the larger OpenAI API window:
    // https://github.com/openai/codex/blob/126a0ee92ed2c5e73cd8a8f7e37563e8527552d7/codex-rs/models-manager/models.json
    "gpt-6.1-terra": {
        compactionHash: "3000",
        contextWindow: 500_000,
        defaultEffort: "low",
        responsesLite: true,
    },
    "gpt-6-astra": {
        compactionHash: "3000",
        contextWindow: 272_000,
        defaultEffort: "low",
        responsesLite: true,
    },
    "gpt-6-sol": {
        compactionHash: "3000",
        contextWindow: 272_000,
        defaultEffort: "low",
        responsesLite: true,
    },
    "gpt-6-luna": {
        compactionHash: "3000",
        contextWindow: 272_000,
        defaultEffort: "medium",
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
    const bedrock = /^(?:(?:global|us)\.)?openai\./u.test(model);
    const properties = MODEL_PROPERTIES[model.replace(/^(?:(?:global|us)\.)?openai\./u, "")];
    if (!bedrock || properties === undefined) return properties;
    return {
        ...properties,
        // Bedrock's 5.6 catalog entries inherit the 5.5 wire and compaction contract.
        compactionHash: "2911",
        responsesLite: false,
    };
}
