import { describe, expect, it, vi } from "vitest";

import { getHappyDaemonPaths } from "../daemon/index.js";
import { runUpgradeCommand } from "./runUpgradeCommand.js";

describe("runUpgradeCommand", () => {
    it("downloads a newer Happy Agent release before reloading the daemon", async () => {
        const order: string[] = [];
        const log = vi.fn((line: string) => order.push(line));
        const selectedBinary = vi.fn(async () => ({ path: "/agent/1.2.3", version: "1.2.3" }));
        const upgradeBinary = vi.fn(async (options) => {
            options.onStatus?.("Downloading Happy Agent 1.2.4.");
            order.push("selected 1.2.4");
            return { path: "/agent/1.2.4", version: "1.2.4" };
        });
        const reloadDaemon = vi.fn(async () => {
            order.push("reloaded");
        });

        await runUpgradeCommand({
            isReleaseInstallation: () => true,
            log,
            reloadDaemon,
            runningVersion: async () => "1.2.3",
            selectedBinary,
            upgradeBinary,
        });

        expect(order).toEqual([
            "Downloading Happy Agent 1.2.4.",
            "selected 1.2.4",
            "Restarting with Happy Agent 1.2.4.",
            "reloaded",
        ]);
        expect(upgradeBinary).toHaveBeenCalledWith({
            onStatus: log,
            paths: getHappyDaemonPaths(),
        });
        expect(reloadDaemon).toHaveBeenCalledOnce();
    });

    it("does not restart an already-current Happy Agent", async () => {
        const log = vi.fn();
        const reloadDaemon = vi.fn();

        await runUpgradeCommand({
            isReleaseInstallation: () => true,
            log,
            reloadDaemon,
            runningVersion: async () => "1.2.3",
            selectedBinary: async () => ({ path: "/agent/1.2.3", version: "1.2.3" }),
            upgradeBinary: async () => ({ path: "/agent/1.2.3", version: "1.2.3" }),
        });

        expect(log).toHaveBeenLastCalledWith("Happy Agent 1.2.3 is already up to date.");
        expect(reloadDaemon).not.toHaveBeenCalled();
    });

    it("retries the reload when the binary was selected but the old daemon kept running", async () => {
        const log = vi.fn();
        const reloadDaemon = vi.fn();

        await runUpgradeCommand({
            isReleaseInstallation: () => true,
            log,
            reloadDaemon,
            runningVersion: async () => "1.2.2",
            selectedBinary: async () => ({ path: "/agent/1.2.3", version: "1.2.3" }),
            upgradeBinary: async () => ({ path: "/agent/1.2.3", version: "1.2.3" }),
        });

        expect(log).toHaveBeenLastCalledWith("Restarting with Happy Agent 1.2.3.");
        expect(reloadDaemon).toHaveBeenCalledOnce();
    });

    it("refuses to replace a local source checkout", async () => {
        const upgradeBinary = vi.fn();

        await expect(
            runUpgradeCommand({
                isReleaseInstallation: () => false,
                upgradeBinary,
            }),
        ).rejects.toThrow("A local Happy Agent source checkout cannot self-upgrade.");
        expect(upgradeBinary).not.toHaveBeenCalled();
    });

    it("reports download and reload failures as user-facing upgrade errors", async () => {
        await expect(
            runUpgradeCommand({
                isReleaseInstallation: () => true,
                runningVersion: async () => undefined,
                selectedBinary: async () => undefined,
                upgradeBinary: async () => {
                    throw new Error("GitHub is unavailable");
                },
            }),
        ).rejects.toThrow("Happy Agent could not be upgraded.");
    });
});
