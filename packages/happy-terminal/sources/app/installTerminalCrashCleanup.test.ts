import { describe, expect, it, vi } from "vitest";

import { installTerminalCrashCleanup } from "./installTerminalCrashCleanup.js";

describe("installTerminalCrashCleanup", () => {
    it("restores terminal modes once without handling the fatal error", () => {
        const listeners = new Set<() => void>();
        const processEvents = {
            off: vi.fn((_event: "uncaughtExceptionMonitor", listener: () => void) => {
                listeners.delete(listener);
            }),
            on: vi.fn((_event: "uncaughtExceptionMonitor", listener: () => void) => {
                listeners.add(listener);
            }),
            prependListener: vi.fn((_event: "unhandledRejection", listener: () => void) => {
                listeners.add(listener);
            }),
        };
        const terminal = {
            stop: vi.fn(),
            write: vi.fn(),
        };
        const tui = {
            stop: vi.fn(),
        };

        const cleanup = installTerminalCrashCleanup({ processEvents, terminal, tui });
        // One restoration serves both fatal paths: a thrown error and a rejected promise.
        expect(listeners).toHaveLength(1);
        expect(processEvents.prependListener).toHaveBeenCalledWith(
            "unhandledRejection",
            expect.any(Function),
        );
        const [onFatalError] = listeners;
        expect(onFatalError).toBeDefined();

        onFatalError?.();
        cleanup.restore();

        expect(terminal.write.mock.calls.map(([value]) => value).join("")).toContain(
            "\x1b[?2026l\x1b[?1004l\x1b[?1049l",
        );
        expect(terminal.write.mock.calls.map(([value]) => value).join("")).toContain(
            "\x1b[0m\x1b[?25h",
        );
        expect(tui.stop).toHaveBeenCalledTimes(1);
        expect(terminal.stop).not.toHaveBeenCalled();

        cleanup.uninstall();
        cleanup.uninstall();
        expect(processEvents.off).toHaveBeenCalledTimes(2);
        expect(listeners).toHaveLength(0);
    });

    it("swallows late terminal answers before the terminal stops", async () => {
        const order: string[] = [];
        const processEvents = { off: vi.fn(), on: vi.fn(), prependListener: vi.fn() };
        const terminal = {
            drainInput: vi.fn(async () => {
                order.push("drain");
            }),
            stop: vi.fn(),
            write: vi.fn((value: string) => {
                order.push(value.includes("?1004l") ? "disable" : "reset");
            }),
        };
        const tui = {
            stop: vi.fn(() => {
                order.push("stop");
            }),
        };

        const cleanup = installTerminalCrashCleanup({ processEvents, terminal, tui });
        await cleanup.restoreAndDrain();
        await cleanup.restoreAndDrain();

        expect(order).toEqual(["disable", "drain", "stop", "reset"]);
        expect(terminal.drainInput).toHaveBeenCalledTimes(1);
    });

    it("still restores a terminal that cannot drain", async () => {
        const processEvents = { off: vi.fn(), on: vi.fn(), prependListener: vi.fn() };
        const terminal = {
            drainInput: vi.fn(async () => {
                throw new Error("stdin went away");
            }),
            stop: vi.fn(),
            write: vi.fn(),
        };
        const tui = { stop: vi.fn() };

        const cleanup = installTerminalCrashCleanup({ processEvents, terminal, tui });
        await expect(cleanup.restoreAndDrain()).resolves.toBeUndefined();

        expect(tui.stop).toHaveBeenCalledTimes(1);
    });

    it("falls back to stopping the terminal and never replaces the original crash", () => {
        const listener = vi.fn();
        const processEvents = {
            off: vi.fn(),
            on: vi.fn((_event: "uncaughtExceptionMonitor", value: () => void) => {
                listener.mockImplementation(value);
            }),
            prependListener: vi.fn(),
        };
        const terminal = {
            stop: vi.fn(),
            write: vi
                .fn()
                .mockImplementationOnce(() => {
                    throw new Error("write failed");
                })
                .mockImplementationOnce(() => {
                    throw new Error("final write failed");
                }),
        };
        const tui = {
            stop: vi.fn(() => {
                throw new Error("TUI stop failed");
            }),
        };

        installTerminalCrashCleanup({ processEvents, terminal, tui });

        expect(() => listener()).not.toThrow();
        expect(tui.stop).toHaveBeenCalledTimes(1);
        expect(terminal.stop).toHaveBeenCalledTimes(1);
    });
});
