import { describe, expect, it } from "vitest";

import { subagentLogMessageText } from "./subagentLogMessageText.js";

describe("subagentLogMessageText", () => {
    it("shows response text without exposing hidden reasoning", () => {
        expect(
            subagentLogMessageText({
                blocks: [
                    { thinking: "private chain of thought", type: "thinking" },
                    { text: "Visible result", type: "text" },
                ],
                id: "message-1",
                role: "agent",
            }),
        ).toBe("Visible result");
    });
});
