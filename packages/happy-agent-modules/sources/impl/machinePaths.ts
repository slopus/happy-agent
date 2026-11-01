import { posix, win32, type PlatformPath } from "node:path";

/**
 * The path rules of a machine that runs this platform: Windows paths on Windows, POSIX paths
 * everywhere else. A runner may run another platform than the daemon, so a path on it is joined,
 * split, and compared by its own rules; for this machine's platform this is `node:path` itself.
 */
export function machinePaths(platform: NodeJS.Platform): PlatformPath {
    return platform === "win32" ? win32 : posix;
}
