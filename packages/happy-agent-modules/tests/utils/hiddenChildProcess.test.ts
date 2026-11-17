import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
    execFileHidden,
    execFileSyncHidden,
    spawnHidden,
    spawnSyncHidden,
    withHiddenWindow,
} from "../../sources/utils/hiddenChildProcess.js";

const PRINT = ["-e", "process.stdout.write('out'); process.stderr.write('err')"];

describe("withHiddenWindow", () => {
    const callback = () => undefined;

    it("sets windowsHide wherever the options sit", () => {
        expect(withHiddenWindow([])).toEqual([{ windowsHide: true }]);
        expect(withHiddenWindow([["a"]])).toEqual([["a"], { windowsHide: true }]);
        expect(withHiddenWindow([{ cwd: "/" }])).toEqual([{ cwd: "/", windowsHide: true }]);
        expect(withHiddenWindow([["a"], { cwd: "/" }])).toEqual([
            ["a"],
            { cwd: "/", windowsHide: true },
        ]);
    });

    it("keeps a callback after the options", () => {
        expect(withHiddenWindow([callback])).toEqual([{ windowsHide: true }, callback]);
        expect(withHiddenWindow([["a"], callback])).toEqual([
            ["a"],
            { windowsHide: true },
            callback,
        ]);
        expect(withHiddenWindow([["a"], undefined, callback])).toEqual([
            ["a"],
            { windowsHide: true },
            callback,
        ]);
        expect(withHiddenWindow([["a"], null, callback])).toEqual([
            ["a"],
            { windowsHide: true },
            callback,
        ]);
        expect(withHiddenWindow([["a"], { cwd: "/" }, callback])).toEqual([
            ["a"],
            { cwd: "/", windowsHide: true },
            callback,
        ]);
    });

    it("cannot be turned off by a caller", () => {
        expect(withHiddenWindow([["a"], { windowsHide: false }])).toEqual([
            ["a"],
            { windowsHide: true },
        ]);
    });
});

describe("hidden launchers", () => {
    it("start programs like the Node functions they wrap", async () => {
        await expect(
            promisify(execFileHidden)(process.execPath, PRINT, { encoding: "utf8" }),
        ).resolves.toEqual({ stdout: "out", stderr: "err" });
        const fromCallback = await new Promise<string>((resolve, reject) => {
            execFileHidden(process.execPath, PRINT, (error, stdout) =>
                error === null ? resolve(String(stdout)) : reject(error),
            );
        });
        expect(fromCallback).toBe("out");
        expect(execFileSyncHidden(process.execPath, PRINT, { stdio: "pipe" }).toString()).toBe(
            "out",
        );
        expect(spawnSyncHidden(process.execPath, PRINT, { encoding: "utf8" }).stdout).toBe("out");
        const child = spawnHidden(process.execPath, PRINT, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        await new Promise((resolve) => child.once("close", resolve));
        expect(stdout).toBe("out");
    });
});
