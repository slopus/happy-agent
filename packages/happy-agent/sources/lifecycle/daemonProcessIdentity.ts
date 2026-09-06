import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Distinguish a live daemon from an unrelated process that reused a stale PID. */
export async function daemonProcessIdentity(pid: number): Promise<string> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid daemon process ID.");
    if (process.platform === "linux") {
        const [stat, boot] = await Promise.all([
            readFile(`/proc/${String(pid)}/stat`, "utf8"),
            readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        ]);
        // Field 22 is the process start tick; the command in field 2 can contain spaces or ')'.
        const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
        if (start === undefined || !/^\d+$/.test(start)) {
            throw new Error("Could not identify the daemon process.");
        }
        return `${boot.trim()}:${start}`;
    }
    if (process.platform === "darwin") {
        const { stdout } = await execFileAsync(
            "/bin/ps",
            ["-p", String(pid), "-o", "lstart=,comm="],
            {
                env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
                timeout: 2_000,
                maxBuffer: 16_384,
            },
        );
        if (stdout.trim().length === 0) throw new Error("The daemon process is not running.");
        return stdout.trim();
    }
    throw new Error("Signal-based draining is supported on macOS and Linux.");
}
