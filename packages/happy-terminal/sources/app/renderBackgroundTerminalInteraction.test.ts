import { describe, expect, it } from "vitest";

import { renderBackgroundTerminalInteraction } from "./renderBackgroundTerminalInteraction.js";

describe("renderBackgroundTerminalInteraction", () => {
    it("does not render empty background terminal polls", () => {
        expect(
            renderBackgroundTerminalInteraction(
                {
                    command: "sleep 5",
                    input: "",
                    sessionId: 1,
                    type: "background_terminal_interaction",
                },
                80,
            ),
        ).toEqual([]);
    });

    it("renders actual input without terminal controls", () => {
        expect(
            stripAnsi(
                renderBackgroundTerminalInteraction(
                    {
                        command: "read value",
                        input: "hello\nworld\x1b[2J",
                        sessionId: 1,
                        type: "background_terminal_interaction",
                    },
                    80,
                ).join("\n"),
            ),
        ).toBe("↳ Interacted with background terminal · read value\n  └ hello\n    world");
    });

    it("keeps an automatic review notice attached to actual input", () => {
        expect(
            stripAnsi(
                renderBackgroundTerminalInteraction(
                    {
                        command: "read value",
                        input: "hello",
                        sessionId: 1,
                        type: "background_terminal_interaction",
                    },
                    80,
                    "Auto-reviewed: Allowed. Stayed sandboxed.",
                ).join("\n"),
            ),
        ).toBe(
            "↳ Interacted with background terminal · read value\n  └ Auto-reviewed: Allowed. Stayed sandboxed.\n    hello",
        );
    });
});

function stripAnsi(value: string): string {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== "\u001b") {
            result += value[index];
            continue;
        }
        while (index < value.length && value[index] !== "m") index += 1;
    }
    return result
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n");
}
