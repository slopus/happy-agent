import { describe, expect, it } from "vitest";

import { containsMarkdownTable } from "./containsMarkdownTable.js";

describe("containsMarkdownTable", () => {
    it("recognizes a complete pipe-table header and delimiter", () => {
        expect(containsMarkdownTable("Before\n\n| Key | Value |\n| --- | :---: |\n| a | b |")).toBe(
            true,
        );
    });

    it("does not treat ordinary pipe text or a partial delimiter as a table", () => {
        expect(containsMarkdownTable("Use alpha | beta in prose.")).toBe(false);
        expect(containsMarkdownTable("| Key | Value |\n| --")).toBe(false);
        expect(containsMarkdownTable("```md\n| Key | Value |\n| --- | --- |\n```")).toBe(false);
    });
});
