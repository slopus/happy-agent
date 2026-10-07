import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { ensureSafeBunRuntime } from "../sources/lifecycle/ensureSafeBunRuntime.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalBun = Object.getOwnPropertyDescriptor(process.versions, "bun");

describe("Windows safe Bun runtime restart", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(process, "platform", { value: "win32" });
        Object.defineProperty(process.versions, "bun", {
            configurable: true,
            value: "1.4.2",
        });
        vi.stubEnv("BUN_JSC_useBaselineJIT", "true");
        vi.stubEnv("BUN_JSC_useDFGJIT", "true");
        vi.stubEnv("BUN_JSC_useFTLJIT", "true");
    });

    afterEach(() => {
        Object.defineProperty(process, "platform", originalPlatform);
        if (originalBun === undefined) delete process.versions.bun;
        else Object.defineProperty(process.versions, "bun", originalBun);
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("hides the restart console while preserving streams, arguments and shutdown", async () => {
        const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
        spawn.mockReturnValue(child);
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const interrupts = process.listenerCount("SIGINT");
        const terminations = process.listenerCount("SIGTERM");
        const restart = ensureSafeBunRuntime();
        const launch = spawn.mock.calls[0]!;

        // Complete the restart even if the launch-options assertion fails below.
        process.emit("SIGINT");
        process.emit("SIGTERM");
        child.emit("exit", 7);
        await restart;

        expect(launch).toEqual([
            process.execPath,
            [...process.execArgv, ...process.argv.slice(1)],
            {
                env: {
                    ...process.env,
                    BUN_JSC_useBaselineJIT: "false",
                    BUN_JSC_useDFGJIT: "false",
                    BUN_JSC_useFTLJIT: "false",
                },
                stdio: "inherit",
                windowsHide: true,
            },
        ]);
        expect(child.kill.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
        expect(exit).toHaveBeenCalledExactlyOnceWith(7);
        expect(process.listenerCount("SIGINT")).toBe(interrupts);
        expect(process.listenerCount("SIGTERM")).toBe(terminations);
    });
});
