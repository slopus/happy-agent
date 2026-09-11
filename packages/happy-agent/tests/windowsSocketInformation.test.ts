import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lstat: vi.fn(), query: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat }));
vi.mock("node:util", () => ({ promisify: () => mocks.query }));
import { readAgentSocketInformation } from "../sources/socket/agentSocketPaths.js";
afterEach(() => vi.resetAllMocks());

describe.skipIf(process.platform !== "win32")("Windows Unix socket identification", () => {
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
    it("recognizes only a proven AF_UNIX reparse tag after lstat fails", async () => {
        mocks.lstat.mockRejectedValue(denied);
        mocks.query.mockResolvedValue({ stdout: "Reparse Tag Value : 0x80000023\r\n" });
        expect((await readAgentSocketInformation("C:\\fixture\\p.sock")).isSocket()).toBe(true);
    });
    it("preserves symlinks even when their target text includes the socket tag", async () => {
        mocks.lstat.mockRejectedValue(denied);
        mocks.query.mockResolvedValue({
            stdout: "Reparse Tag Value : 0xA000000C\r\nTarget: 0x80000023",
        });
        await expect(readAgentSocketInformation("C:\\fixture\\link")).rejects.toBe(denied);
    });
    it("preserves the original access error if the OS query fails", async () => {
        mocks.lstat.mockRejectedValue(denied);
        mocks.query.mockRejectedValue(new Error("query failed"));
        await expect(readAgentSocketInformation("C:\\fixture\\private")).rejects.toBe(denied);
    });
    it("does not probe ordinary files or missing paths", async () => {
        const file = { isSocket: () => false, uid: 1000 };
        mocks.lstat.mockResolvedValueOnce(file);
        expect(await readAgentSocketInformation("C:\\fixture\\file")).toBe(file);
        const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
        mocks.lstat.mockRejectedValueOnce(missing);
        await expect(readAgentSocketInformation("C:\\fixture\\missing")).rejects.toBe(missing);
        expect(mocks.query).not.toHaveBeenCalled();
    });
});
