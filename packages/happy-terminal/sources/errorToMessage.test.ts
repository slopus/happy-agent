import { describe, expect, it } from "vitest";

import { errorToMessage } from "./errorToMessage.js";

describe("errorToMessage", () => {
    it("extracts Error messages and stringifies other thrown values", () => {
        expect(errorToMessage(new Error("failed"))).toBe("failed");
        expect(errorToMessage("failed")).toBe("failed");
        expect(errorToMessage({ reason: "failed" })).toBe("[object Object]");
    });
});
