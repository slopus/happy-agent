import { describe, expect, it } from "vitest";

import { agentCatalogEntry, AGENT_FIXTURE_NOW } from "./agentCatalogTestFixture.js";
import { formatSessionPickerEntry } from "./formatSessionPickerEntry.js";

describe("formatSessionPickerEntry", () => {
    it("formats public agent state and its owning workspace path", () => {
        const formatted = formatSessionPickerEntry(
            agentCatalogEntry(
                {
                    pendingQuestionId: "question-1",
                    title: "Choose a database",
                    titleStatus: "ready",
                    updatedAt: AGENT_FIXTURE_NOW - 60_000,
                },
                "/workspace/happy-terminal",
            ),
            { now: AGENT_FIXTURE_NOW, showDirectory: true },
        );

        expect(formatted).toEqual({
            badge: "Needs attention",
            detail: "/workspace/happy-terminal",
            meta: "1 minute ago",
            title: "Choose a database",
        });
    });
});
