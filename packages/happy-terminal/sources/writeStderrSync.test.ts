import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ writeSync }));

let writeStderrSync: (text: string) => void;

/*
 * Tests share one module registry, so another suite may have already imported the real module and
 * bound it to the real `node:fs`. Reset the registry to import the mocked module here.
 */
beforeEach(async () => {
    vi.resetModules();
    ({ writeStderrSync } = await import("./writeStderrSync.js"));
});

afterEach(() => {
    vi.restoreAllMocks();
    writeSync.mockReset();
});

describe("writeStderrSync", () => {
    it("writes the whole report through the synchronous file descriptor", () => {
        writeSync.mockImplementation(() => 4);

        writeStderrSync("abcdefgh");

        expect(writeSync).toHaveBeenCalledTimes(2);
        expect(writeSync.mock.calls[0]?.[0]).toBe(2);
        expect(writeSync.mock.calls[1]?.[2]).toBe(4);
    });

    it("retries a pipe that is not ready yet", () => {
        let attempts = 0;
        writeSync.mockImplementation((_fd: number, buffer: Buffer) => {
            attempts += 1;
            if (attempts < 3) throw Object.assign(new Error("try again"), { code: "EAGAIN" });
            return buffer.length;
        });

        writeStderrSync("done");

        expect(attempts).toBe(3);
    });

    it("falls back to the buffered stream when the descriptor cannot be written", () => {
        const buffered = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        writeSync.mockImplementation(() => {
            throw Object.assign(new Error("closed"), { code: "EBADF" });
        });

        writeStderrSync("lost?");

        expect(buffered).toHaveBeenCalledTimes(1);
        expect(String(buffered.mock.calls[0]?.[0])).toBe("lost?");
    });
});
