/* eslint-disable no-control-regex -- Tests intentionally strip terminal ANSI controls. */
import { Input, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { createSecretInputPanel } from "./createSecretInputPanel.js";

describe("createSecretInputPanel", () => {
    it("masks the complete value on every render while submitting the original text", () => {
        const inputRender = vi.spyOn(Input.prototype, "render");
        const onSubmit = vi.fn();
        const panel = createSecretInputPanel({
            label: "Value",
            masked: true,
            onCancel: () => {},
            onSubmit,
            subtitle: "This value stays private",
            title: "Set API_TOKEN",
        });

        panel.handleInput?.("top-secret-value");
        const rendered = panel.render(48);
        const text = stripAnsi(rendered.join("\n"));

        expect(text).not.toContain("top-secret-value");
        expect(text).toContain("****************");
        expect(rendered.every((line) => visibleWidth(line) === 48)).toBe(true);
        expect(inputRender).not.toHaveBeenCalled();

        panel.handleInput?.("\r");
        expect(onSubmit).toHaveBeenCalledWith("top-secret-value");
        inputRender.mockRestore();
    });

    it("sanitizes terminal controls in visible fields and plain input", () => {
        const panel = createSecretInputPanel({
            label: "ID\x1b[2J",
            onCancel: () => {},
            onSubmit: () => {},
            subtitle: "Describe\x1b]0;bad\x07 this secret",
            title: "Add\x1b[2J Secret",
        });

        panel.handleInput?.("\x1b[200~safe\x1b[2J-id\x1b[201~");
        const rendered = panel.render(60).join("\n");
        const text = stripAnsi(rendered);

        expect(rendered).not.toContain("\x1b[2J");
        expect(rendered).not.toContain("\x1b]0;bad\x07");
        expect(text).toContain("Add Secret");
        expect(text).toContain("safe-id");
    });
});

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/gu, "");
}
