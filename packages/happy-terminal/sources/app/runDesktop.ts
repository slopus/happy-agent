import { spawn } from "node:child_process";
import { join } from "node:path";

import { getHappyTerminalHome } from "../config/index.js";
import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import { desktopApplicationBuild } from "./desktopApplicationBuild.js";
import { desktopApplicationName } from "./desktopApplicationRuntime.js";
import {
    desktopApplicationContentHash,
    desktopApplicationResolve,
    desktopBuildStampRead,
    happy2RepositoryRootResolve,
    rigRepositoryRootResolve,
} from "./desktopApplicationState.js";

export interface RunDesktopOptions {
    readonly buildOnly: boolean;
    readonly forceBuild: boolean;
    readonly happy2Root?: string;
    readonly skipBuild: boolean;
}

/** Builds and launches a relocatable Happy local app carrying the current Happy Terminal runtime. */
export async function runDesktop(options: RunDesktopOptions): Promise<void> {
    if (process.platform !== "darwin") {
        throw new HappyTerminalUserError("The Happy desktop app currently builds only on macOS.");
    }

    const desktopRoot = join(getHappyTerminalHome(), "desktop");
    const releaseDirectory = join(desktopRoot, "release");
    let application = await desktopApplicationResolve(releaseDirectory);

    if (options.skipBuild) {
        if (!application) {
            throw new HappyTerminalUserError(
                "Happy Terminal has no packaged Happy desktop app to launch.",
                {
                    hint: "Run happy-terminal desktop once without --skip-build.",
                },
            );
        }
        console.log(`Desktop build skipped; using ${application}`);
    } else {
        const rigRoot = await rigRepositoryRootResolve();
        const happy2Root = await happy2RepositoryRootResolve(options.happy2Root, rigRoot);
        const contentHash = await desktopApplicationContentHash(rigRoot, happy2Root);
        const stamp = await desktopBuildStampRead(join(desktopRoot, "build-stamp.json"));
        const buildNeeded =
            options.forceBuild ||
            !application ||
            stamp?.contentHash !== contentHash ||
            stamp?.happy2Root !== happy2Root;

        if (buildNeeded) {
            application = await desktopApplicationBuild({
                contentHash,
                desktopRoot,
                happy2Root,
                rigRoot,
            });
        } else {
            console.log("Happy desktop is up to date (content stamp matches).");
        }
    }

    if (!application) {
        throw new HappyTerminalUserError(
            "The Happy desktop build produced no runnable application.",
        );
    }
    if (options.buildOnly) {
        console.log(`Happy desktop is ready at ${application} (not launching; --build-only).`);
        return;
    }

    const executable = join(application, "Contents", "MacOS", desktopApplicationName);
    console.log(`Launching packaged Happy desktop: ${application}`);
    await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(executable, [], {
            cwd: application,
            env: process.env,
            stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else {
                reject(
                    new HappyTerminalUserError(
                        `${desktopApplicationName} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? 1}`}.`,
                    ),
                );
            }
        });
    });
}
