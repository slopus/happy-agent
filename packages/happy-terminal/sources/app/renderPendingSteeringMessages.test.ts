import { describe, expect, it } from "vitest";

import { renderPendingSteeringMessages } from "./renderPendingSteeringMessages.js";
import { stripAnsi } from "./testing/stripAnsi.js";

describe("renderPendingSteeringMessages", () => {
    it("renders the Escape hint and dedented ordered previews at normal width", () => {
        const rendered = renderPendingSteeringMessages(
            ["First steering message", "Second steering message"],
            100,
        );
        const plain = rendered.map((line) => stripAnsi(line).trimEnd());

        expect(plain).toEqual([
            " • Messages to be submitted after next tool call (esc to send now)",
            "  └ First steering message",
            "    Second steering message",
        ]);
        expect(plain.filter((line) => line.includes("└"))).toHaveLength(1);
        expect(plain.join("\n")).not.toMatch(/[│├↳]/u);
    });

    it("keeps the heading and previews dedented within a narrow terminal", () => {
        const rendered = renderPendingSteeringMessages(
            ["First steering message", "Second steering message"],
            40,
        );
        const plain = rendered.map((line) => stripAnsi(line).trimEnd());

        expect(plain).toEqual([
            " • Messages to be submitted after next t",
            "  └ First steering message",
            "    Second steering message",
        ]);
        expect(plain.every((line) => line.length <= 40)).toBe(true);
        expect(plain.filter((line) => line.includes("└"))).toHaveLength(1);
        expect(plain.join("\n")).not.toMatch(/[│├↳]/u);
    });
});
