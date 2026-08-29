import { describe, expect, it } from "vitest";

import type { HistoryExcerpt } from "../../sources/history/index.js";
import {
    createModelSwitchNotice,
    type ModelSwitchNotice,
} from "../../sources/modelSwitch/impl/createModelSwitchNotice.js";

function notice(overrides: Partial<ModelSwitchNotice> = {}): ModelSwitchNotice {
    return {
        previousModel: "Old label",
        previousProvider: "old-provider",
        model: "New label",
        provider: "new-provider",
        ...overrides,
    };
}

function excerpt(overrides: Partial<HistoryExcerpt> = {}): HistoryExcerpt {
    return {
        beginning: "1. USER\nText: Asked for something.",
        recent: "2. ASSISTANT\nText: Finished it.",
        stats: {
            assistantMessages: 1,
            messages: 2,
            textCharacters: 29,
            thinkingBlocks: 0,
            toolCalls: 0,
            toolResults: 0,
            userMessages: 1,
        },
        statsAreSampled: false,
        ...overrides,
    };
}

describe("createModelSwitchNotice", () => {
    it("renders an honest no-history handoff when neither excerpt nor reader exists", () => {
        const text = createModelSwitchNotice(notice());

        expect(text).toContain("<model-switch-history-context>");
        expect(text).toContain("</model-switch-history-context>");
        expect(text).toContain("Old label on old-provider");
        expect(text).toContain("New label on new-provider");
        expect(text).toContain("Durable history lookup is unavailable in this runtime");
        expect(text).toContain("none of it is visible to you");
        expect(text).not.toContain("History overview:");
    });

    it("asks a model with a reader but no excerpt to use the durable history tool", () => {
        const text = createModelSwitchNotice(notice({ historyTool: "read_agent_history" }));

        expect(text).toContain(
            "Use read_agent_history proactively whenever more detail could affect your answer.",
        );
        expect(text).toContain("The conversation itself is not part of this context");
        expect(text).not.toContain("Beginning history excerpt:");
    });

    it("describes a request-profile reset without claiming the model configuration changed", () => {
        const text = createModelSwitchNotice(
            notice({
                model: "Same model",
                previousModel: "Same model",
                previousProvider: "same-provider",
                provider: "same-provider",
                profileReset: true,
            }),
        );

        expect(text).toContain("<profile-reset-history-context>");
        expect(text).toContain("The request profile changed");
        expect(text).toContain("the request profile requires a fresh context");
        expect(text).not.toContain("configuration changed from");
        expect(text).not.toContain("same-provider");
    });

    it("renders a complete exact excerpt and tells the model when more history is available", () => {
        const text = createModelSwitchNotice(
            notice({ historyTool: "read_agent_history", excerpt: excerpt() }),
        );

        expect(text).toContain("History overview: 2 messages");
        expect(text).toContain("Beginning history excerpt:\n1. USER");
        expect(text).toContain("Recent history excerpt:\n2. ASSISTANT");
        expect(text).toContain(
            "then use read_agent_history proactively whenever the excerpt is incomplete",
        );
        expect(text).toContain("not raw provider protocol traffic or hidden reasoning");
    });

    it("labels sampled statistics as a bounded sample rather than archive totals", () => {
        const text = createModelSwitchNotice(
            notice({
                excerpt: excerpt({
                    statsAreSampled: true,
                }),
            }),
        );

        expect(text).toContain(
            "History sample overview (counts cover only the bounded excerpt, not the full archive)",
        );
        expect(text).not.toContain("\nHistory overview:");
    });

    it("omits the recent section when the beginning already covers the history", () => {
        const text = createModelSwitchNotice(
            notice({
                excerpt: excerpt({ recent: "" }),
            }),
        );

        expect(text).toContain("Beginning history excerpt:");
        expect(text).not.toContain("Recent history excerpt:");
    });

    it("preserves the configured provider identities even when display labels are supplied", () => {
        const text = createModelSwitchNotice(
            notice({
                previousModel: "A model with spaces",
                model: "Another model",
                previousProvider: "provider-A",
                provider: "provider-B",
            }),
        );

        expect(text).toContain("A model with spaces on provider-A");
        expect(text).toContain("Another model on provider-B");
    });
});
