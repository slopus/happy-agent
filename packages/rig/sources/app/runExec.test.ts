import { describe, expect, it, vi } from "vitest";

import { writeStdout } from "./runExec.js";

describe("writeStdout", () => {
    it("does not accept a stream-json event until stdout drains", async () => {
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => false);
        let settled = false;
        const pending = writeStdout("event\n").then(() => {
            settled = true;
        });

        try {
            await Promise.resolve();
            expect(settled).toBe(false);
            process.stdout.emit("drain");
            await pending;
            expect(settled).toBe(true);
            expect(write).toHaveBeenCalledWith("event\n");
        } finally {
            write.mockRestore();
        }
    });
});
