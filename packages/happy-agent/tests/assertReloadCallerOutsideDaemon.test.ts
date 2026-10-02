import { beforeEach, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
    const { promisify } = await import("node:util");
    return { execFile: Object.assign(() => undefined, { [promisify.custom]: execute }) };
});

import { assertReloadCallerOutsideDaemon } from "../sources/lifecycle/assertReloadCallerOutsideDaemon.js";

beforeEach(() => {
    execute.mockReset();
});

it("rejects an ancestor through intermediate shells before requesting shutdown", async () => {
    execute.mockResolvedValue({ stdout: `${process.ppid} 900001\n900001 1\n1 0\n` });
    await expect(assertReloadCallerOutsideDaemon(900001)).rejects.toThrow(
        "Cannot reload Happy Agent from a process owned by that daemon.",
    );
});

it("allows an independent caller and bounds the process snapshot", async () => {
    execute.mockResolvedValue({ stdout: `${process.ppid} 1\n1 0\n900001 1\n` });
    await expect(assertReloadCallerOutsideDaemon(900001)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
    });
});

it("rejects a daemon running as PID 1 through an intermediate process", async () => {
    execute.mockResolvedValue({ stdout: `${process.ppid} 1\n1 0\n` });
    await expect(assertReloadCallerOutsideDaemon(1)).rejects.toThrow(
        "Cannot reload Happy Agent from a process owned by that daemon.",
    );
});

it.each([
    "invalid output",
    `${process.ppid} 900001\n900001 ${process.ppid}\n`,
    `${process.ppid} 900001\n`,
    "",
])("leaves the daemon running when ancestry is invalid or incomplete: %s", async (stdout) => {
    execute.mockResolvedValue({ stdout });
    await expect(assertReloadCallerOutsideDaemon(900002)).rejects.toThrow(
        "Cannot verify that reloading Happy Agent is safe.",
    );
});

it("leaves the daemon running when process inspection fails", async () => {
    execute.mockRejectedValue(new Error("snapshot timed out"));
    await expect(assertReloadCallerOutsideDaemon(900001)).rejects.toMatchObject({
        name: "AgentDaemonError",
        message: "Cannot verify that reloading Happy Agent is safe.",
    });
});

it("leaves a responding daemon alone when its PID file is missing", async () => {
    await expect(assertReloadCallerOutsideDaemon(undefined)).rejects.toThrow(
        "Cannot verify that reloading Happy Agent is safe.",
    );
    expect(execute).not.toHaveBeenCalled();
});
