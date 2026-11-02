import { readFileSync, readdirSync } from "node:fs";

/** How many inotify watches this process holds right now, or undefined off Linux. */
export function inotifyWatchCount(): number | undefined {
    if (process.platform !== "linux") return undefined;
    let count = 0;
    for (const descriptor of readdirSync("/proc/self/fdinfo")) {
        let info: string;
        try {
            info = readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8");
        } catch {
            continue;
        }
        for (const line of info.split("\n")) if (line.startsWith("inotify wd:")) count += 1;
    }
    return count;
}
