import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { createSelectionPanel } from "./createSelectionPanel.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("createSelectionPanel", () => {
    it("wraps a long subtitle without overflowing or losing its approval details", () => {
        const subtitle =
            "Approve running the complete command that writes auto-denied.txt? · 1 of 1";
        const panel = createSelectionPanel({
            items: [
                {
                    description: "Permit this exact command once.",
                    label: "Allow once",
                    value: "allow",
                },
                {
                    description: "Keep the current restrictions.",
                    label: "Deny",
                    value: "deny",
                },
            ],
            onCancel: () => {},
            onSelect: () => {},
            subtitle,
            title: "Permission",
        });

        const rendered = panel.render(32);
        const text = stripAnsi(rendered.join("\n"));

        expect(text.replace(/\s+/gu, " ")).toContain(subtitle);
        expect(rendered.every((line) => visibleWidth(line) === 32)).toBe(true);
        expect(text).toContain("auto-denied.txt? · 1");
        expect(text).toContain("of 1");
        expect(rendered.every((line) => line.startsWith("\x1b[48;5;235m\x1b[39m"))).toBe(true);
        expect(rendered.join("\n")).not.toContain("\x1b[48;5;236m");
    });

    it("wraps long option labels and descriptions into aligned columns", () => {
        const panel = createSelectionPanel({
            cancelDisabled: true,
            items: [
                {
                    description:
                        "Keep instant renderer deploys and ship a runtime capability check.",
                    label: "Detect and gate (keep live renderer deploys)",
                    value: "detect",
                },
                {
                    description: "Pages serves versioned bundles and the shell pins one.",
                    label: "Eliminate skew (pin renderer to shell release)",
                    value: "pin",
                },
            ],
            onCancel: () => {},
            onSelect: () => {},
            subtitle: "How should that gap be handled? · 1 of 2",
            title: "Skew policy",
        });

        const rendered = panel.render(80);
        const text = stripAnsi(rendered.join("\n"));

        expect(rendered.every((line) => visibleWidth(line) === 80)).toBe(true);
        expect(text).toContain("Detect and gate (keep live renderer");
        expect(text).toContain("deploys)");
        expect(text).toContain("Keep instant renderer deploys and");
        expect(text).toContain("ship a runtime capability check.");
        expect(text).not.toContain("…");

        const descriptionColumns = stripAnsi(rendered.join("\n"))
            .split("\n")
            .filter((line) => line.includes("Keep instant") || line.includes("Pages serves"))
            .map((line) => line.indexOf(line.includes("Keep instant") ? "Keep" : "Pages"));
        expect(new Set(descriptionColumns).size).toBe(1);
    });

    it("stacks the description under the label when the terminal is narrow", () => {
        const panel = createSelectionPanel({
            cancelDisabled: true,
            items: [
                {
                    description: "Enter a response that is not listed.",
                    label: "Type another answer",
                    value: "other",
                },
            ],
            onCancel: () => {},
            onSelect: () => {},
            subtitle: "Pick one · 1 of 1",
            title: "Question",
        });

        const text = stripAnsi(panel.render(36).join("\n"));

        expect(text.replace(/\s+/gu, " ")).toContain("Type another answer");
        expect(text.replace(/\s+/gu, " ")).toContain("Enter a response that is not listed.");
        expect(text.split("\n").some((line) => line.trimStart().startsWith("Enter a"))).toBe(true);
    });

    it("removes terminal controls from every user-visible field", () => {
        const titleControl = "\x1b]0;CORRUPTED_TITLE\x07";
        const eraseControl = "\x1b[2J";
        const panel = createSelectionPanel({
            items: [
                {
                    description: `Before ${titleControl} after`,
                    label: `Allow ${eraseControl} once`,
                    value: "allow",
                },
            ],
            onCancel: () => {},
            onSelect: () => {},
            subtitle: `Question ${titleControl} remains visible`,
            title: `Permission ${eraseControl}`,
        });

        const rendered = panel.render(60).join("\n");
        const text = stripAnsi(rendered);

        expect(rendered).not.toContain(titleControl);
        expect(rendered).not.toContain(eraseControl);
        expect(text).not.toContain("CORRUPTED_TITLE");
        expect(text).toContain("Permission");
        expect(text).toContain("Question  remains visible");
        expect(text).toContain("Allow  once");
        expect(text).toContain("Before  after");
    });

    it("keeps Escape inside a selection when cancellation is disabled", () => {
        const onCancel = vi.fn();
        const panel = createSelectionPanel({
            cancelDisabled: true,
            items: [{ label: "Continue", value: "continue" }],
            onCancel,
            onSelect: () => {},
            subtitle: "Choose an answer.",
            title: "Required question",
        });

        panel.handleInput?.("\x1b");

        expect(onCancel).not.toHaveBeenCalled();
        expect(stripAnsi(panel.render(80).join("\n"))).toContain(
            "Use ↑/↓ to move and Enter to select.",
        );
    });
});
