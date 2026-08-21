import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { agentCatalogEntry, AGENT_FIXTURE_NOW } from "./agentCatalogTestFixture.js";
import { createSessionPicker, fitSessionPickerToViewport } from "./createSessionPicker.js";

describe("createSessionPicker", () => {
    it("renders and selects the ordered agent resources", () => {
        const onSelect = vi.fn();
        const picker = createSessionPicker({
            agents: [
                agentCatalogEntry({ id: "first", title: "Startup polish", titleStatus: "ready" }),
                agentCatalogEntry({ id: "second", title: "Docker sandbox", titleStatus: "ready" }),
            ],
            confirmVerb: "resume",
            now: () => AGENT_FIXTURE_NOW,
            onCancel: vi.fn(),
            onSelect,
            showDirectory: false,
            subtitle: "2 saved agents.",
            title: "Resume an agent",
        });

        expect(stripAnsi(picker.render(80).join("\n"))).toContain("❯ Startup polish");
        picker.handleInput?.("\x1b[B");
        picker.handleInput?.("\r");
        expect(onSelect.mock.calls[0]?.[0]?.agent.id).toBe("second");
    });

    it("scrolls and keeps narrow rows bounded", () => {
        const picker = createSessionPicker({
            agents: Array.from({ length: 10 }, (_, index) =>
                agentCatalogEntry({
                    id: `agent-${String(index)}`,
                    title: `Agent ${String(index)} with a long title`,
                    titleStatus: "ready",
                }),
            ),
            confirmVerb: "resume",
            now: () => AGENT_FIXTURE_NOW,
            onCancel: vi.fn(),
            onSelect: vi.fn(),
            showDirectory: false,
            subtitle: "Saved agents",
            title: "Resume an agent",
        });
        fitSessionPickerToViewport(picker, 30, 14);
        for (let step = 0; step < 9; step += 1) picker.handleInput?.("\x1b[B");

        const lines = picker.render(30);
        expect(stripAnsi(lines.join("\n"))).toContain("❯ Agent 9");
        for (const line of lines) expect(visibleWidth(line)).toBe(30);
    });
});

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/gu, "");
}
