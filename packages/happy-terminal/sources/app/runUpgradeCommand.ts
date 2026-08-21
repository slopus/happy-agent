import { spawn } from "node:child_process";

import { readPackageVersion } from "../readPackageVersion.js";
import { HappyTerminalUserError } from "../HappyTerminalUserError.js";

export interface RunUpgradeCommandOptions {
    installedVersion?: string;
    platform?: NodeJS.Platform;
    spawnProcess?: typeof spawn;
}

export async function runUpgradeCommand(options: RunUpgradeCommandOptions = {}): Promise<void> {
    const spawnProcess = options.spawnProcess ?? spawn;
    const npm = (options.platform ?? process.platform) === "win32" ? "npm.cmd" : "npm";
    const releaseChannel = (options.installedVersion ?? readPackageVersion()).includes("-canary.")
        ? "canary"
        : "beta";
    const releasePackage = `@slopus/happy-terminal@${releaseChannel}`;
    const child = spawnProcess(npm, ["install", "-g", releasePackage], {
        stdio: "inherit",
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", () => reject(upgradeError(releasePackage)));
        child.once("exit", resolve);
    });
    if (exitCode !== 0) {
        throw upgradeError(releasePackage);
    }
}

function upgradeError(releasePackage: string): HappyTerminalUserError {
    return new HappyTerminalUserError("Happy Terminal could not upgrade itself.", {
        hint: `Run npm install -g ${releasePackage} to see the npm error.`,
    });
}
