import { spawn } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { RigUserError } from "../RigUserError.js";
import {
    desktopApplicationName,
    desktopApplicationStagingPrepare,
    desktopBuilderConfiguration,
} from "./desktopApplicationRuntime.js";
import { desktopApplicationResolve, desktopBuildStampWrite } from "./desktopApplicationState.js";

/**
 * The Electron package, whose directory name and workspace name are the same string. Named once
 * because a build that looks for the wrong one does not fail here — it fails several steps later,
 * or silently packages nothing.
 */
export const HAPPY_DESKTOP_PACKAGE = "happy-desktop-electron";

/** Builds and installs one current-architecture Happy app with a bundled Rig runtime. */
export async function desktopApplicationBuild(input: {
    contentHash: string;
    desktopRoot: string;
    happy2Root: string;
    rigRoot: string;
}): Promise<string> {
    const desktopDirectory = join(input.happy2Root, "packages", HAPPY_DESKTOP_PACKAGE);
    const stagingRoot = join(input.desktopRoot, ".staging");
    const happy2Staging = join(stagingRoot, "happy2");
    const rigRuntime = join(stagingRoot, "rig-runtime");
    const stagedRelease = join(stagingRoot, "release");
    const finalRelease = join(input.desktopRoot, "release");
    await rm(stagingRoot, { force: true, recursive: true });
    await mkdir(stagingRoot, { recursive: true });

    try {
        console.log("Installing Happy desktop workspace dependencies.");
        await commandRun(
            "pnpm",
            ["--dir", input.happy2Root, "install", "--frozen-lockfile"],
            input.happy2Root,
            process.env,
        );

        console.log("Building the current Rig runtime.");
        await commandRun("pnpm", ["--dir", input.rigRoot, "build"], input.rigRoot, process.env);

        console.log("Building the Happy local desktop shell.");
        await commandRun(
            "pnpm",
            ["--dir", input.happy2Root, "desktop:assets"],
            input.happy2Root,
            process.env,
        );
        await commandRun(
            "pnpm",
            ["--dir", desktopDirectory, "build:local-shell"],
            input.happy2Root,
            process.env,
        );

        console.log("Assembling the standalone application runtime.");
        await commandRun(
            "pnpm",
            [
                "--dir",
                input.happy2Root,
                "--config.inject-workspace-packages=true",
                "--config.node-linker=hoisted",
                "--filter",
                HAPPY_DESKTOP_PACKAGE,
                "deploy",
                "--prod",
                happy2Staging,
            ],
            input.happy2Root,
            process.env,
        );
        await commandRun(
            "pnpm",
            [
                "--dir",
                input.rigRoot,
                "--config.inject-workspace-packages=true",
                "--config.node-linker=hoisted",
                "--filter",
                "@slopus/rig",
                "deploy",
                "--prod",
                rigRuntime,
            ],
            input.rigRoot,
            process.env,
        );
        await desktopApplicationStagingPrepare(happy2Staging, rigRuntime);
        const builderConfigurationPath = join(stagingRoot, "electron-builder.json");
        await writeFile(
            builderConfigurationPath,
            `${JSON.stringify(
                desktopBuilderConfiguration({
                    buildResources: join(desktopDirectory, "build"),
                    happy2NodeModules: join(happy2Staging, "node_modules"),
                    output: stagedRelease,
                    rigRuntime,
                }),
                null,
                4,
            )}\n`,
        );
        await commandRun(
            "pnpm",
            [
                "--dir",
                desktopDirectory,
                "exec",
                "electron-builder",
                "--projectDir",
                happy2Staging,
                "--mac",
                "dir",
                `--${process.arch}`,
                "--config",
                builderConfigurationPath,
            ],
            input.happy2Root,
            {
                ...process.env,
                CSC_IDENTITY_AUTO_DISCOVERY: "false",
            },
        );

        const stagedApplication = await desktopApplicationResolve(stagedRelease);
        if (!stagedApplication) {
            throw new RigUserError("Happy finished packaging without producing a macOS app.");
        }
        await commandRun(
            "/usr/bin/codesign",
            ["--force", "--deep", "--sign", "-", stagedApplication],
            input.happy2Root,
            process.env,
        );

        await rm(finalRelease, { force: true, recursive: true });
        await mkdir(dirname(finalRelease), { recursive: true });
        await rename(stagedRelease, finalRelease);
        const application = await desktopApplicationResolve(finalRelease);
        if (!application) {
            throw new RigUserError("The packaged Happy desktop app could not be installed.");
        }
        await desktopBuildStampWrite(join(input.desktopRoot, "build-stamp.json"), {
            builtAt: new Date().toISOString(),
            contentHash: input.contentHash,
            happy2Root: input.happy2Root,
        });
        console.log(`Built standalone ${desktopApplicationName} at ${application}.`);
        return application;
    } finally {
        await rm(stagingRoot, { force: true, recursive: true });
    }
}

function commandRun(
    command: string,
    arguments_: readonly string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, [...arguments_], {
            cwd,
            env: environment,
            stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else {
                reject(
                    new RigUserError(
                        `${command} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? 1}`}.`,
                    ),
                );
            }
        });
    });
}
