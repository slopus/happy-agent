import { execFileSync, type ChildProcess } from "node:child_process";

/**
 * End a detached agent process and everything below it. Agents leave a running command alive
 * when their turn is cancelled, and some start each command in a process group of its own, so
 * every group in the tree is signalled, plus `groups` taken earlier for commands the agent may
 * have orphaned since. Whatever is still running a moment later is killed outright.
 */
export function terminateProcessTree(
    child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
    groups: readonly number[] = [],
): void {
    if (process.platform === "win32") {
        // Windows has no process groups; taskkill ends the whole tree below the agent.
        if (child.pid !== undefined) {
            try {
                execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true,
                });
            } catch {
                // Already gone.
            }
        }
        if (child.exitCode === null && child.signalCode === null) child.kill();
        return;
    }
    const all = new Set([...groups, ...processTreeGroups(child.pid)]);
    if (child.pid !== undefined) all.add(child.pid);
    signalGroups(all, "SIGTERM");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    setTimeout(() => signalGroups(all, "SIGKILL"), KILL_AFTER_MS).unref();
}

/** How long a terminated agent tree may take to exit on its own before it is killed. */
const KILL_AFTER_MS = 3_000;

function signalGroups(groups: Iterable<number>, signal: NodeJS.Signals): void {
    for (const group of groups) {
        try {
            process.kill(-group, signal);
        } catch {
            // Already gone.
        }
    }
}

/** The process groups of `root` and every process below it, from one process table snapshot. */
export function processTreeGroups(root: number | undefined): number[] {
    if (root === undefined || process.platform === "win32") return [];
    let table: string;
    try {
        table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
    } catch {
        return [];
    }
    const children = new Map<number, number[]>();
    const groupOf = new Map<number, number>();
    for (const line of table.split("\n")) {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        if (pid === undefined || ppid === undefined || pgid === undefined) continue;
        if (!Number.isFinite(pid) || !Number.isFinite(pgid)) continue;
        children.set(ppid, [...(children.get(ppid) ?? []), pid]);
        groupOf.set(pid, pgid);
    }
    const groups = new Set<number>();
    const pending = [root];
    while (pending.length > 0) {
        const pid = pending.pop()!;
        const group = groupOf.get(pid);
        if (group !== undefined) groups.add(group);
        pending.push(...(children.get(pid) ?? []));
    }
    // Never the daemon's own group, whatever a child did with its own.
    groups.delete(groupOf.get(process.pid) ?? -1);
    return [...groups];
}
