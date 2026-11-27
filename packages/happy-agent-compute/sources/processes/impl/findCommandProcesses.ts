import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { execFileHidden } from "../hiddenChildProcess.js";
import type { CommandProcess } from "../types.js";

/**
 * The variable every command is started with, naming the one command it belongs to.
 *
 * A process that calls `setsid` leaves the command's session and process group, and one whose
 * parent exits is handed to init, so neither can be found by group or by parentage once the
 * command's shell is gone. The environment is inherited across both, which makes it the one
 * trace that still says which command a process came from.
 */
export const COMMAND_MARKER_VARIABLE = "HAPPY_AGENT_COMMAND";

/** A process found to belong to a command, with what tells it apart from a later reuse of its id. */
export interface TrackedCommandProcess extends CommandProcess {
    /** The kernel's start time on Linux; empty where the platform has nothing cheaper to compare. */
    readonly startTime: string;
}

export interface CommandProcessQuery {
    /** The process the command was spawned as. It leads the command's session and group. */
    readonly leaderPid: number;
    /**
     * Whether the leader is still ours. Once it has been reaped its number may be handed to a
     * stranger, so membership by session, group, or parentage from it is no longer trusted.
     */
    readonly leaderAlive: boolean;
    /** The command's marker value, when the command was started with one. */
    readonly marker?: string;
}

/**
 * Every running process that belongs to one command: the leader, everything in its session or
 * group, everything carrying its marker, and every descendant of any of those.
 *
 * Linux reads the whole picture from procfs. macOS has no procfs and does not expose another
 * process's environment cheaply, so there a process that both left the group and lost its parent
 * before the stop cannot be found. Windows is left to `taskkill /T`, which walks the tree itself.
 */
export async function findCommandProcesses(
    query: CommandProcessQuery,
): Promise<TrackedCommandProcess[]> {
    if (process.platform === "linux") return findLinuxCommandProcesses(query);
    if (process.platform === "win32") return [];
    return findPosixCommandProcesses(query);
}

/** Whether a process found earlier is still running as the same process. */
export async function isCommandProcessAlive(tracked: TrackedCommandProcess): Promise<boolean> {
    if (process.platform === "linux") {
        const entry = await readLinuxProcess(tracked.pid, undefined);
        return entry !== undefined && entry.startTime === tracked.startTime;
    }
    try {
        process.kill(tracked.pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

interface ProcessEntry {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
    readonly sid: number;
    readonly startTime: string;
    readonly name: string;
    readonly marked: boolean;
}

/** Bounds how many procfs files are open at once while the table is read. */
const PROCFS_READ_BATCH = 64;

/** Keeps a report readable when a launcher carries a long policy on its command line. */
const MAX_REPORTED_COMMAND_LENGTH = 200;

async function findLinuxCommandProcesses(
    query: CommandProcessQuery,
): Promise<TrackedCommandProcess[]> {
    let names: string[];
    try {
        names = await readdir("/proc");
    } catch {
        return [];
    }
    const pids = names.filter((name) => /^\d+$/u.test(name)).map(Number);
    const marker =
        query.marker === undefined
            ? undefined
            : Buffer.from(`${COMMAND_MARKER_VARIABLE}=${query.marker}\0`);
    const entries: ProcessEntry[] = [];
    for (let index = 0; index < pids.length; index += PROCFS_READ_BATCH) {
        const batch = await Promise.all(
            pids
                .slice(index, index + PROCFS_READ_BATCH)
                .map((pid) => readLinuxProcess(pid, marker)),
        );
        for (const entry of batch) if (entry !== undefined) entries.push(entry);
    }
    const members = selectMembers(entries, query);
    return Promise.all(
        entries
            .filter((entry) => members.has(entry.pid))
            .map(async (entry) => ({
                command: await readLinuxCommandLine(entry.pid, entry.name),
                pid: entry.pid,
                startTime: entry.startTime,
            })),
    );
}

async function readLinuxProcess(
    pid: number,
    marker: Buffer | undefined,
): Promise<ProcessEntry | undefined> {
    let stat: string;
    try {
        stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    } catch {
        return undefined;
    }
    const nameStart = stat.indexOf("(");
    const nameEnd = stat.lastIndexOf(")");
    if (nameStart < 0 || nameEnd < nameStart) return undefined;
    // Fields after the name, starting with the state, which is field 3 of proc_pid_stat(5).
    const fields = stat.slice(nameEnd + 2).split(" ");
    // A zombie has already ended; only its parent's bookkeeping remains.
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    return {
        marked: marker !== undefined && (await hasMarker(pid, marker)),
        name: stat.slice(nameStart + 1, nameEnd),
        pgid: Number(fields[2]),
        pid,
        ppid: Number(fields[1]),
        sid: Number(fields[3]),
        startTime: fields[19] ?? "",
    };
}

async function hasMarker(pid: number, marker: Buffer): Promise<boolean> {
    let environment: Buffer;
    try {
        environment = await readFile(`/proc/${String(pid)}/environ`);
    } catch {
        // Another user's process, or one already gone. Neither is ours to stop.
        return false;
    }
    for (let at = environment.indexOf(marker); at >= 0; at = environment.indexOf(marker, at + 1)) {
        if (at === 0 || environment[at - 1] === 0) return true;
    }
    return false;
}

async function readLinuxCommandLine(pid: number, name: string): Promise<string> {
    try {
        const commandLine = (await readFile(`/proc/${String(pid)}/cmdline`, "utf8"))
            .split("\0")
            .filter((part) => part.length > 0)
            .join(" ");
        return boundCommand(commandLine.length === 0 ? name : commandLine);
    } catch {
        return name;
    }
}

function boundCommand(command: string): string {
    return command.length <= MAX_REPORTED_COMMAND_LENGTH
        ? command
        : `${command.slice(0, MAX_REPORTED_COMMAND_LENGTH - 1)}…`;
}

async function findPosixCommandProcesses(
    query: CommandProcessQuery,
): Promise<TrackedCommandProcess[]> {
    if (!query.leaderAlive) return [];
    let listing: string;
    try {
        listing = (
            await promisify(execFileHidden)(
                "ps",
                ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "command="],
                { maxBuffer: 16 * 1024 * 1024 },
            )
        ).stdout;
    } catch {
        return [];
    }
    const entries: ProcessEntry[] = [];
    for (const line of listing.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
        if (match === null) continue;
        entries.push({
            marked: false,
            name: match[4]!,
            pgid: Number(match[3]),
            pid: Number(match[1]),
            ppid: Number(match[2]),
            // macOS `ps` does not report a session id, so membership by session is left out.
            sid: Number.NaN,
            startTime: "",
        });
    }
    const members = selectMembers(entries, query);
    return entries
        .filter((entry) => members.has(entry.pid))
        .map((entry) => ({ command: boundCommand(entry.name), pid: entry.pid, startTime: "" }));
}

function selectMembers(entries: readonly ProcessEntry[], query: CommandProcessQuery): Set<number> {
    const members = new Set<number>();
    const leader = query.leaderPid;
    for (const entry of entries) {
        if (entry.pid === process.pid) continue;
        if (
            entry.marked ||
            (query.leaderAlive &&
                (entry.pid === leader || entry.pgid === leader || entry.sid === leader))
        ) {
            members.add(entry.pid);
        }
    }
    // Descendants of any member belong too, however they rearranged their session or group.
    for (let grew = true; grew; ) {
        grew = false;
        for (const entry of entries) {
            if (entry.pid === process.pid || members.has(entry.pid)) continue;
            if (members.has(entry.ppid)) {
                members.add(entry.pid);
                grew = true;
            }
        }
    }
    return members;
}
