import { afterEach, describe, expect, it, vi } from "vitest";

const nodePty = vi.hoisted(() => ({
    spawn: vi.fn(),
}));

vi.mock("@lydell/node-pty", () => nodePty);

import { createHostTerminalProcessFactory } from "../../sources/terminals/impl/createHostTerminalProcessFactory.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("createHostTerminalProcessFactory", () => {
    it("does not resize or write to the native PTY after the process exits", async () => {
        let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
        const closedDescriptor = Object.assign(new Error("ioctl(2) failed, EBADF"), {
            code: "EBADF",
        });
        const pty = {
            kill: vi.fn(),
            onData: vi.fn(() => ({ dispose: vi.fn() })),
            onExit: vi.fn((listener: typeof exit) => {
                exit = listener;
                return { dispose: vi.fn() };
            }),
            pause: vi.fn(),
            resize: vi.fn(() => {
                throw closedDescriptor;
            }),
            resume: vi.fn(),
            write: vi.fn(() => {
                throw closedDescriptor;
            }),
        };
        nodePty.spawn.mockReturnValue(pty);
        const process = await createHostTerminalProcessFactory({ SHELL: "/bin/sh" }).start({
            cols: 80,
            command: "exit 0",
            cwd: "/workspace",
            rows: 24,
        });

        exit?.({ exitCode: 0 });
        await expect(process.wait()).resolves.toEqual({ exitCode: 0 });

        expect(() => process.resize(100, 30)).not.toThrow();
        expect(process.write("after exit")).toBe(false);
        expect(pty.resize).not.toHaveBeenCalled();
        expect(pty.write).not.toHaveBeenCalled();
    });

    it("kills the native PTY outright rather than hanging it up", async () => {
        const pty = {
            kill: vi.fn(),
            onData: vi.fn(() => ({ dispose: vi.fn() })),
            onExit: vi.fn(() => ({ dispose: vi.fn() })),
            pause: vi.fn(),
            resize: vi.fn(),
            resume: vi.fn(),
            write: vi.fn(),
        };
        nodePty.spawn.mockReturnValue(pty);
        const process = await createHostTerminalProcessFactory({ SHELL: "/bin/sh" }).start({
            cols: 80,
            cwd: "/workspace",
            rows: 24,
        });

        await process.kill();

        expect(pty.kill).toHaveBeenCalledWith("SIGKILL");
    });
});
