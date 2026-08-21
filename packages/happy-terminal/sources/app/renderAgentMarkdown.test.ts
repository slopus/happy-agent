import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { renderAgentMarkdown } from "./renderAgentMarkdown.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderAgentMarkdown", () => {
    it("renders markdown formatting instead of plain wrapping", () => {
        const raw = renderAgentMarkdown({
            text: "## Plan\n\n- **Build** `agent`\n\n```ts\nconst value = 1;\n```",
            width: 64,
            cwd: "/workspace",
        }).join("\n");
        const rendered = stripAnsi(raw);

        expect(raw).toContain("\x1b[1m");
        expect(raw).toContain("\x1b[39m");
        expect(raw).not.toContain("\x1b[38;5;252m");
        expect(raw).not.toContain("\x1b[48;5;236m");
        expect(rendered).toContain("Plan");
        expect(rendered).toContain("- Build");
        expect(rendered).toContain("Build agent");
        expect(rendered).not.toContain("Build  agent");
        expect(rendered).toContain("agent");
        expect(rendered).toContain("const value = 1;");
    });

    it("does not leak dim code-fence styling into code or following prose", () => {
        const raw = renderAgentMarkdown({
            text: "```ts\nconst value = 1;\n```\n\nRendered normally.",
            width: 64,
            cwd: "/workspace",
        }).join("\n");

        expect(isDimAtText(raw, "const value = 1;")).toBe(false);
        expect(isDimAtText(raw, "Rendered normally.")).toBe(false);
    });

    it("renders explicit markdown links as terminal hyperlinks", () => {
        setCapabilities({ images: null, trueColor: true, hyperlinks: true });
        try {
            const raw = renderAgentMarkdown({
                text: "Open [the app](file:///workspace/sources/app/CodingAssistantApp.ts#L12) and https://example.com/docs.",
                width: 100,
                cwd: "/workspace",
            }).join("\n");
            const rendered = stripAnsi(raw);

            expect(raw).toContain("file:///workspace/sources/app/CodingAssistantApp.ts#L12");
            expect(raw).toContain("https://example.com/docs");
            expect(raw).toContain("\x1b[36m\x1b[4m\x1b[36mthe app");
            expect(rendered).toContain("the app");
        } finally {
            resetCapabilitiesCache();
        }
    });

    it("does not auto-link slash-containing local paths", () => {
        const raw = renderAgentMarkdown({
            text: "Open sources/app/CodingAssistantApp.ts:12 and github.com/openai/codex.",
            width: 100,
            cwd: "/workspace",
        }).join("\n");

        expect(raw).not.toContain("file:///workspace");
        expect(stripAnsi(raw)).toContain("sources/app/CodingAssistantApp.ts:12");
    });

    it("keeps true-color escape sequences intact in fenced YAML", () => {
        setCapabilities({ images: null, trueColor: true, hyperlinks: false });
        try {
            const raw = renderAgentMarkdown({
                text: "```yaml\ncontainers:\n  - expose:\n      - public: true\n```",
                width: 38,
                cwd: "/workspace",
            }).join("\n");
            const rendered = stripAnsi(raw);

            expect(rendered).toContain("containers:");
            expect(rendered).toContain("public: true");
            expect(rendered).not.toMatch(/(?:38|48);2;\d+;\d+;\d+m/u);
        } finally {
            resetCapabilitiesCache();
        }
    });

    it("sanitizes terminal control sequences without dropping malformed trailing text", () => {
        const raw = renderAgentMarkdown({
            text: [
                "## Status",
                "\x1b[31m**failed**\x1b[0m",
                "\x1b[2Jcursor text",
                "\x1b]8;;https://example.com\x07linked\x1b]8;;\x07",
                "\x1b]8;;unterminated trailing text",
                "\x1b[31\nunterminated CSI trailing text",
            ].join("\n"),
            width: 64,
            cwd: "/workspace",
        }).join("\n");
        const rendered = stripAnsi(raw);

        expect(raw).not.toContain("\x1b[31m\x1b[1m");
        expect(raw).not.toContain("\x1b[2J");
        expect(raw).not.toContain("https://example.com");
        expect(rendered).toContain("Status");
        expect(rendered).toContain("failed");
        expect(rendered).toContain("cursor text");
        expect(rendered).toContain("linked");
        expect(rendered).toContain("\\x1b]8;;unterminated trailing text");
        expect(rendered).toContain("\\x1b[31");
        expect(rendered).toContain("unterminated CSI trailing text");
        expect(raw.split("\n").every((line) => visibleLength(line) <= 64)).toBe(true);
    });
});

function visibleLength(text: string): number {
    return [...stripAnsi(text)].length;
}

function isDimAtText(text: string, needle: string): boolean {
    const needleIndex = text.indexOf(needle);
    expect(needleIndex).toBeGreaterThanOrEqual(0);

    const prefix = text.slice(0, needleIndex);
    const dimStart = prefix.lastIndexOf("\x1b[2m");
    const dimEnd = Math.max(prefix.lastIndexOf("\x1b[0m"), prefix.lastIndexOf("\x1b[22m"));
    return dimStart > dimEnd;
}
