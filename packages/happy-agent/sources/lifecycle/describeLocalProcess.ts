import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `happy-agent`, or a build named for its platform such as `happy-agent-darwin-arm64`. */
const HAPPY_AGENT_EXECUTABLE = /^happy-agent(?:-[a-z0-9._-]+)?(?:\.exe)?$/i;

/** What the operating system says about one running process. */
export interface LocalProcess {
    readonly pid: number;
    readonly parentPid: number;
    readonly uid: number;
    /** The absolute path of the executable image. */
    readonly executable: string;
    /** The whole command line, its arguments separated by spaces. */
    readonly commandLine: string;
}

/** Reads a live process's owner, parent, executable, and command line; undefined when gone. */
export async function describeLocalProcess(pid: number): Promise<LocalProcess | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    try {
        if (process.platform === "linux") return await describeLinuxProcess(pid);
        if (process.platform === "darwin") return await describeDarwinProcess(pid);
    } catch {
        return undefined;
    }
    return undefined;
}

async function describeLinuxProcess(pid: number): Promise<LocalProcess | undefined> {
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
        pid,
        parentPid: Number(parentPid),
        uid: Number(uid),
        executable: executable.replace(/ \(deleted\)$/, ""),
        commandLine: commandLine.split("\0").filter(Boolean).join(" "),
    };
}

async function describeDarwinProcess(pid: number): Promise<LocalProcess | undefined> {
    const ps = async (format: string) =>
        (
            await execFileAsync("/bin/ps", ["-p", String(pid), "-o", format], {
                env: { ...process.env, LC_ALL: "C" },
                timeout: 2_000,
                maxBuffer: 65_536,
            })
        ).stdout.trim();
    // `comm` is the full executable path only as the last column; ps truncates it elsewhere.
    const [identity, commandLine] = await Promise.all([ps("uid=,ppid=,comm="), ps("args=")]);
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(identity);
    if (match === null) return undefined;
    return {
        pid,
        uid: Number(match[1]),
        parentPid: Number(match[2]),
        executable: match[3]!,
        commandLine,
    };
}

/**
 * Whether a process is a Happy Agent: the standalone `happy-agent` executable, or Node or Bun
 * running a Happy Agent package's CLI entry, as a source or development install does.
 */
export function isHappyAgentProcess(
    candidate: Pick<LocalProcess, "executable" | "commandLine">,
): boolean {
    if (HAPPY_AGENT_EXECUTABLE.test(fileName(candidate.executable))) return true;
    if (!/^(?:node|bun)(?:\.exe)?$/i.test(fileName(candidate.executable))) return false;
    return /[\\/]happy-agent[\\/](?:dist|sources)[\\/]cli\.(?:js|mjs|ts)(?:\s|$)/.test(
        candidate.commandLine,
    );
}

/** The version a standalone Happy Agent executable reports, when it reports one in time. */
export async function readHappyAgentVersion(executable: string): Promise<string | undefined> {
    if (!HAPPY_AGENT_EXECUTABLE.test(fileName(executable))) return undefined;
    try {
        const { stdout } = await execFileAsync(executable, ["--version"], {
            timeout: 5_000,
            maxBuffer: 16_384,
            windowsHide: true,
        });
        return /^Happy Agent (\S+)$/m.exec(stdout)?.[1];
    } catch {
        return undefined;
    }
}

/** The last path segment, whichever separator the path uses. */
function fileName(path: string): string {
    return path.split(/[\\/]/).pop() ?? "";
}
