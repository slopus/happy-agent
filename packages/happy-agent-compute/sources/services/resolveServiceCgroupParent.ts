import { lstat, readFile, realpath, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Discover existing administrator delegation. Never enable controllers or move the daemon. */
export async function resolveServiceCgroupParent(configured?: string): Promise<string> {
    if (process.platform !== "linux") {
        throw new Error(
            "Workspace services require Linux namespace and cgroup isolation on this compute provider.",
        );
    }
    let candidate = configured;
    if (candidate === undefined) {
        const line = (await readFile("/proc/self/cgroup", "utf8"))
            .split("\n")
            .find((entry) => entry.startsWith("0::/"));
        if (line === undefined || line.includes(".."))
            throw new Error("Workspace services require a cgroup v2 delegation.");
        candidate = dirname(join("/sys/fs/cgroup", line.slice(3)));
    }
    if (resolve(candidate) !== candidate || !candidate.startsWith("/sys/fs/cgroup/")) {
        throw new Error(
            "Workspace services require an administrator-delegated cgroup, not the system cgroup root.",
        );
    }
    const metadata = await lstat(candidate);
    const filesystem = await statfs(candidate);
    const controllers = (await readFile(join(candidate, "cgroup.subtree_control"), "utf8")).split(
        /\s+/u,
    );
    if (
        (await realpath(candidate)) !== candidate ||
        !metadata.isDirectory() ||
        metadata.uid !== process.getuid?.() ||
        filesystem.type !== 0x63677270 ||
        !controllers.includes("memory") ||
        !controllers.includes("pids")
    ) {
        throw new Error(
            "Workspace services need an administrator-delegated cgroup owned by the daemon user with memory and process controls enabled. No host security settings were changed.",
        );
    }
    return candidate;
}
