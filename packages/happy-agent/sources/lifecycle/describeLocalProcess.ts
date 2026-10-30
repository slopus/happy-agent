import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

import type { BunFfi } from "./readSocketPeer.js";

const execFileAsync = promisify(execFile);

/** `happy-agent`, or a build named for its platform such as `happy-agent-darwin-arm64`. */
const HAPPY_AGENT_EXECUTABLE = /^happy-agent(?:-[a-z0-9._-]+)?(?:\.exe)?$/i;

/** What the operating system says about one running process. */
export interface LocalProcess {
    readonly parentPid: number;
    readonly uid: number;
    /** The absolute path of the executable image. */
    readonly executable: string;
    /** The whole command line, its arguments separated by spaces. */
    readonly commandLine: string;
}

/** Reads a live process's owner, parent, executable, and command line; undefined when gone. */
export async function describeLocalProcess(pid: number): Promise<LocalProcess | undefined> {
    try {
        if (process.platform === "linux") {
            const directory = `/proc/${String(pid)}`;
            const [status, executable, commandLine] = await Promise.all([
                readFile(`${directory}/status`, "utf8"),
                readlink(`${directory}/exe`),
                readFile(`${directory}/cmdline`, "utf8"),
            ]);
            const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
            const parentPid = /^PPid:\s+(\d+)/m.exec(status)?.[1];
            if (uid === undefined || parentPid === undefined) return undefined;
            return {
                parentPid: Number(parentPid),
                uid: Number(uid),
                executable: executable.replace(/ \(deleted\)$/, ""),
                commandLine: commandLine.split("\0").filter(Boolean).join(" "),
            };
        }
        if (process.platform === "darwin") {
            const [{ stdout }, executable] = await Promise.all([
                execFileAsync("/bin/ps", ["-ww", "-p", String(pid), "-o", "uid=,ppid=,args="], {
                    env: { ...process.env, LC_ALL: "C" },
                    timeout: 2_000,
                }),
                darwinExecutable(pid),
            ]);
            const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(stdout.trim());
            if (match === null || executable === undefined) return undefined;
            const [, uid, parentPid, commandLine] = match;
            return {
                uid: Number(uid),
                parentPid: Number(parentPid),
                executable,
                commandLine: commandLine!,
            };
        }
    } catch {
        return undefined;
    }
    return undefined;
}

/**
 * The executable image the kernel loaded, from `proc_pidpath`. `ps` reports only the name the
 * process was started with, which may be bare, such as `node`.
 */
async function darwinExecutable(pid: number): Promise<string | undefined> {
    if (!("bun" in process.versions)) return undefined;
    const ffi = (await import("bun:ffi" as string)) as BunFfi;
    const { i32, u32, ptr } = ffi.FFIType;
    const library = ffi.dlopen("libSystem.B.dylib", {
        proc_pidpath: { args: [i32, ptr, u32], returns: i32 },
    });
    try {
        const path = new Uint8Array(4_096);
        const length = library.symbols.proc_pidpath!(pid, path, path.byteLength);
        return length > 0 ? Buffer.from(path.subarray(0, length)).toString("utf8") : undefined;
    } finally {
        library.close();
    }
}

/**
 * Whether a process is a Happy Agent: the standalone `happy-agent` executable, or Node or Bun
 * running a Happy Agent package's CLI entry, as a source or development install does.
 */
export function isHappyAgentProcess(
    candidate: Pick<LocalProcess, "executable" | "commandLine">,
): boolean {
    const name = candidate.executable.split(/[\\/]/).pop() ?? "";
    if (HAPPY_AGENT_EXECUTABLE.test(name)) return true;
    return (
        /^(?:node|bun)(?:\.exe)?$/i.test(name) &&
        /[\\/]happy-agent[\\/](?:dist|sources)[\\/]cli\.(?:js|mjs|ts)(?:\s|$)/.test(
            candidate.commandLine,
        )
    );
}

/** The version of an installed release, from its `.../dist/version/<version>/happy-agent` path. */
export function happyAgentVersionFromPath(executable: string): string | undefined {
    const match = /[\\/]dist[\\/]version[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(executable);
    return match !== null && HAPPY_AGENT_EXECUTABLE.test(match[2]!) ? match[1] : undefined;
}
