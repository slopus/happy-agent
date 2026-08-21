import { describe, expect, it } from "vitest";

import { parseSessionCommand } from "./parseSessionCommand.js";

describe("parseSessionCommand", () => {
    it("supports picker, latest, and explicit session forms", () => {
        expect(parseSessionCommand([])).toEqual({ all: false, last: false });
        expect(parseSessionCommand(["--last", "--all"])).toEqual({ all: true, last: true });
        expect(parseSessionCommand(["session-1"])).toEqual({
            all: false,
            last: false,
            sessionId: "session-1",
        });
    });

    it("rejects conflicting selectors", () => {
        expect(() => parseSessionCommand(["--last", "session-1"])).toThrow(
            "Happy Terminal cannot use --last together with a session identifier.",
        );
    });
});
