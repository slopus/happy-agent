import { isAbsolute, resolve } from "node:path";

import { defaultAppletsRootDirectory } from "@slopus/happy-agent-features";

/** Resolves Rig's optional applet install-root override for the shared applet feature. */
export function resolveAppletRootDirectory(
    environment: NodeJS.ProcessEnv = process.env,
): string {
    const configured = environment.HAPPY_APPLETS_DIRECTORY?.trim();
    if (configured === undefined || configured === "") return defaultAppletsRootDirectory();
    if (!isAbsolute(configured)) {
        throw new Error("HAPPY_APPLETS_DIRECTORY must be an absolute path.");
    }
    return resolve(configured);
}