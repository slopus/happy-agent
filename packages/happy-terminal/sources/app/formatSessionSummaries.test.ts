import { describe, expect, it } from "vitest";

import { agentCatalogEntry } from "./agentCatalogTestFixture.js";
import { formatSessionSummaries } from "./formatSessionSummaries.js";

describe("formatSessionSummaries", () => {
    it("renders agent IDs, titles, and granular activity", () => {
        const lines = formatSessionSummaries(
            [
                agentCatalogEntry({
                    id: "agent-running",
                    status: "running_tools",
                    title: "Run tests",
                    titleStatus: "ready",
                }),
            ],
            { columns: 100, rows: 4 },
        );

        expect(lines.join("\n")).toContain("agent-running");
        expect(lines.join("\n")).toContain("Running tools");
        expect(lines.join("\n")).toContain("Run tests");
    });
});
