import type { ComputeService } from "@slopus/happy-agent-compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceOutputReaders } from "../../../sources/services/impl/ServiceOutputReaders.js";

const books: ServiceOutputReaders[] = [];
afterEach(() => {
    for (const book of books.splice(0)) book.close();
    vi.useRealTimers();
});
function fixture(stdout = "hello", stderr = "") {
    let captureLost = false;
    const read = vi.fn((position: { stdout: number; stderr: number }) => ({
        stdout: stdout.slice(position.stdout),
        stderr: stderr.slice(position.stderr),
        position: { stdout: stdout.length, stderr: stderr.length },
        truncated: captureLost,
    }));
    const book = new ServiceOutputReaders({ read } as unknown as ComputeService);
    books.push(book);
    return {
        book,
        read,
        loseCapture: () => {
            captureLost = true;
        },
    };
}
const owner = { kind: "agent", agentId: "aaowner" } as const;
const api = { kind: "api", principalId: "aaowner", readerId: "view" } as const;

describe("independent bounded service output readers", () => {
    it("consumes once per trusted identity, with API principals and agents in separate domains", () => {
        const { book } = fixture("out", "err");
        for (const reader of [
            owner,
            api,
            { ...api, principalId: "peer" },
            { ...api, readerId: "other" },
        ]) {
            expect(book.read(reader, 100)).toEqual({ output: "out\nerr", truncated: false });
            expect(book.read(reader, 100)).toEqual({ output: "", truncated: false });
        }
        expect(
            book.read({ readerId: "view", principalId: "aaowner", kind: "api" }, 100).output,
        ).toBe("");
    });

    it("admits exactly 64 positions and does not evict a live reader to make room", () => {
        const { book } = fixture();
        for (let i = 0; i < 64; i += 1) book.reserve({ ...api, readerId: String(i) });
        expect(() => book.reserve(api)).toThrow("64 active output readers");
        expect(book.read({ ...api, readerId: "0" }, 100).output).toBe("hello");
    });

    it("discards idle positions on a bounded timer and discloses resets even after repeated retirements", () => {
        vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
        const { book } = fixture();
        expect(book.read(owner, 100).truncated).toBe(false);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(30 * 60_000);
        expect(vi.getTimerCount()).toBe(0);
        expect(book.read(owner, 100)).toEqual({ output: "hello", truncated: true });
        expect(book.read(owner, 100)).toEqual({ output: "", truncated: false });
        for (let i = 0; i < 1000; i += 1) {
            book.read({ ...api, readerId: String(i) }, 100);
            vi.advanceTimersByTime(30 * 60_000);
        }
        expect(book.read(owner, 100)).toEqual({ output: "hello", truncated: true });
    });

    it("refreshes active readers without letting another reader keep idle positions alive", () => {
        vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
        const { book } = fixture();
        book.read(owner, 100);
        book.read(api, 100);
        vi.advanceTimersByTime(29 * 60_000);
        book.read(owner, 100);
        vi.advanceTimersByTime(60_000);
        expect(book.read(owner, 100)).toEqual({ output: "", truncated: false });
        expect(book.read(api, 100)).toEqual({ output: "hello", truncated: true });
    });

    it.each([1, 2, 3, 4, 7, 16, 100])(
        "bounds UTF-8 output to %i bytes, advances across omitted output and reports loss",
        (limit) => {
            const text = "hello🌍é世界".repeat(10);
            const { book } = fixture(text, "error🔥");
            const result = book.read(owner, limit);
            expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(limit);
            expect(result.output).not.toContain("�");
            expect(result.truncated).toBe(true);
            expect(book.read(owner, 100)).toEqual({ output: "", truncated: false });
        },
    );

    it("reports capture loss even when all retained text fits", () => {
        const { book, loseCapture } = fixture();
        loseCapture();
        expect(book.read(owner, 100)).toEqual({ output: "hello", truncated: true });
    });

    it("validates before reading or reserving, and retires positions with the buffer", () => {
        const { book, read } = fixture();
        expect(() => book.read({ ...api, readerId: "" }, 100)).toThrow("identity");
        expect(() => book.read(owner, 0)).toThrow("byte limit");
        expect(() => book.read(owner, 262145)).toThrow("byte limit");
        expect(read).not.toHaveBeenCalled();
        book.close();
        expect(() => book.read(owner, 100)).toThrow("retired");
    });
});
