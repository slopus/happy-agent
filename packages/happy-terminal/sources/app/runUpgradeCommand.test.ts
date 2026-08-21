import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { runUpgradeCommand } from "./runUpgradeCommand.js";

describe("runUpgradeCommand", () => {
    it("installs the newest Happy Terminal beta globally with npm", async () => {
        const child = new EventEmitter() as ChildProcess;
        const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;

        const upgrading = runUpgradeCommand({ installedVersion: "0.0.165-beta.0", spawnProcess });
        child.emit("exit", 0);
        await upgrading;

        expect(spawnProcess).toHaveBeenCalledWith(
            "npm",
            ["install", "-g", "@slopus/happy-terminal@beta"],
            {
                stdio: "inherit",
            },
        );
    });

    it("keeps a canary installation on the newest canary", async () => {
        const child = new EventEmitter() as ChildProcess;
        const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;

        const upgrading = runUpgradeCommand({
            installedVersion: "0.0.166-canary.42.abcdef0",
            spawnProcess,
        });
        child.emit("exit", 0);
        await upgrading;

        expect(spawnProcess).toHaveBeenCalledWith(
            "npm",
            ["install", "-g", "@slopus/happy-terminal@canary"],
            {
                stdio: "inherit",
            },
        );
    });

    it("reports a failed npm install as a user-facing upgrade error", async () => {
        const child = new EventEmitter() as ChildProcess;
        const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;

        const upgrading = runUpgradeCommand({ spawnProcess });
        child.emit("exit", 1);

        await expect(upgrading).rejects.toThrow("Happy Terminal could not upgrade itself.");
    });

    it("uses the npm command shim on Windows", async () => {
        const child = new EventEmitter() as ChildProcess;
        const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;

        const upgrading = runUpgradeCommand({
            installedVersion: "0.0.165-beta.0",
            platform: "win32",
            spawnProcess,
        });
        child.emit("exit", 0);
        await upgrading;

        expect(spawnProcess).toHaveBeenCalledWith(
            "npm.cmd",
            ["install", "-g", "@slopus/happy-terminal@beta"],
            { stdio: "inherit" },
        );
    });

    it("reports npm startup failures as user-facing upgrade errors", async () => {
        const child = new EventEmitter() as ChildProcess;
        const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;

        const upgrading = runUpgradeCommand({ spawnProcess });
        child.emit("error", new Error("npm was not found"));

        await expect(upgrading).rejects.toThrow("Happy Terminal could not upgrade itself.");
    });
});
