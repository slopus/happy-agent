import { win32 } from "node:path";

import type { Compute } from "@slopus/happy-agent-compute";
import { describe, expect, it } from "vitest";

import {
    canonicalMachinePath,
    futureMachinePath,
} from "../../../sources/runners/impl/canonicalMachinePath.js";
import { runnerEnvironment } from "../../../sources/runners/impl/runnerEnvironment.js";

/** A Windows runner's filesystem that holds only `existing`, where `C:\Users\Runner` resolves to `D:\Profiles\Runner`. */
function windowsMachine(existing: string[]): Compute {
    const resolve = (path: string) => path.replace(/^C:\\Users\\Runner/i, "D:\\Profiles\\Runner");
    return {
        fs: {
            exists: async (_permissions: unknown, path: string) => existing.includes(path),
            realpath: async (_permissions: unknown, path: string) => {
                if (!existing.includes(path)) throw new Error("ENOENT");
                return resolve(path);
            },
        },
    } as unknown as Compute;
}

describe("paths on a runner with other path rules", () => {
    it("names a Windows runner's folders with Windows path rules under any daemon", async () => {
        const machine = windowsMachine(["C:\\", "C:\\Users", "C:\\Users\\Runner"]);
        await expect(canonicalMachinePath(machine, win32, "C:\\Users\\Runner")).resolves.toBe(
            "D:\\Profiles\\Runner",
        );
        await expect(
            canonicalMachinePath(machine, win32, "C:\\Users\\Runner\\..\\Other\\rig"),
        ).resolves.toBe("C:\\Users\\Other\\rig");
        await expect(
            futureMachinePath(machine, win32, "C:\\Users\\Runner\\Happy\\Projects\\rig"),
        ).resolves.toBe("D:\\Profiles\\Runner\\Happy\\Projects\\rig");
    });

    it("tells an agent the platform its runner reported, not the daemon's", () => {
        expect(runnerEnvironment("win32", "C:\\work")).toEqual({
            osVersion: "Windows",
            platform: "win32",
            shell: "",
            workingDirectory: "C:\\work",
        });
        expect(runnerEnvironment("darwin", "/Users/runner")).toMatchObject({
            osVersion: "macOS",
            platform: "darwin",
        });
        expect(runnerEnvironment("freebsd", "/home/runner")).toMatchObject({
            osVersion: "freebsd",
            platform: "freebsd",
        });
        expect(runnerEnvironment(undefined, "/home/runner")).toMatchObject({ platform: "linux" });
        expect(runnerEnvironment("plan9", "/home/runner")).toMatchObject({ platform: "linux" });
    });
});
