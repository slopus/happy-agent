import { describe, expect, it } from "vitest";

import { BoundedOutputBuffer } from "./BoundedOutputBuffer.js";

describe("BoundedOutputBuffer", () => {
    it("omits a whole UTF-8 character when the head budget cuts through it", () => {
        const buffer = new BoundedOutputBuffer(5);

        buffer.append(Buffer.from("€abc", "utf8"));

        expect(buffer.snapshot().toString("utf8")).toBe("... 3 bytes omitted ...\nabc");
        expect(buffer.omittedBytes).toBe(3);
        expect(buffer.snapshot().toString("utf8")).not.toContain("�");
    });

    it("does not let later bytes jump into a prefix that rejected a whole character", () => {
        const buffer = new BoundedOutputBuffer(5);

        buffer.append(Buffer.from("€abc", "utf8"));
        buffer.append(Buffer.from("d", "utf8"));

        expect(buffer.snapshot().toString("utf8")).toBe("... 4 bytes omitted ...\nbcd");
    });
});
