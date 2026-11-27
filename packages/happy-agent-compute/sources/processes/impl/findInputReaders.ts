import { readdir, readFile, readlink } from "node:fs/promises";

import type { CommandProcess } from "../types.js";

/**
 * System call numbers that read from one file descriptor, by architecture. A process blocked in
 * one of these on descriptor 0 is waiting for its input and nothing else.
 */
const READ_SYSCALLS: Partial<Record<NodeJS.Architecture, ReadonlySet<number>>> = {
    // read, pread64, readv, preadv
    arm64: new Set([63, 65, 67, 69]),
    x64: new Set([0, 17, 19, 295]),
};

/** Bounds how many procfs files are open at once while the table is read. */
const PROCFS_READ_BATCH = 64;

interface ProcessEntry {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
    readonly sid: number;
    readonly state: string;
    readonly startTime: number;
    readonly name: string;
}

/**
 * The processes of a running command that are blocked reading the command's own input.
 *
 * A command's input stays open so it can be typed into later, which means a program that reads it
 * waits for as long as nobody types. That state is visible on Linux: such a process is asleep in a
 * read system call on descriptor 0, and its descriptor 0 is the same object the command was given.
 * Comparing that object keeps a pipeline reader, whose descriptor 0 is the pipe from the previous
 * stage, from being mistaken for one. A server asleep in `epoll_wait`, `poll`, or `select` is not
 * reading anything in particular and is never reported, which also means a program that waits for
 * its input through an event loop is not seen.
 *
 * Only the command's session and group and their descendants are looked at, and only while the
 * leader is still the command's own. Other platforms report nothing.
 */
export async function findInputReaders(leaderPid: number): Promise<CommandProcess[]> {
    const readSyscalls = READ_SYSCALLS[process.arch];
    if (process.platform !== "linux" || readSyscalls === undefined) return [];
    const members = await readCommandMembers(leaderPid);
    const input = await readCommandInput(members);
    if (input === undefined) return [];
    const readers: CommandProcess[] = [];
    for (const member of members) {
        if (member.state !== "S") continue;
        if (!(await isReadingInput(member.pid, readSyscalls))) continue;
        if ((await readDescriptorTarget(member.pid)) !== input) continue;
        readers.push({ command: await readCommandLine(member.pid, member.name), pid: member.pid });
    }
    return readers;
}

/** The command's processes, oldest first. */
async function readCommandMembers(leaderPid: number): Promise<ProcessEntry[]> {
    let names: string[];
    try {
        names = await readdir("/proc");
    } catch {
        return [];
    }
    const pids = names.filter((name) => /^\d+$/u.test(name)).map(Number);
    const entries: ProcessEntry[] = [];
    for (let index = 0; index < pids.length; index += PROCFS_READ_BATCH) {
        const batch = await Promise.all(
            pids.slice(index, index + PROCFS_READ_BATCH).map(readProcessEntry),
        );
        for (const entry of batch) if (entry !== undefined) entries.push(entry);
    }
    const members = new Set(
        entries
            .filter(
                (entry) =>
                    entry.pid === leaderPid || entry.sid === leaderPid || entry.pgid === leaderPid,
            )
            .map((entry) => entry.pid),
    );
    for (let grew = true; grew; ) {
        grew = false;
        for (const entry of entries) {
            if (!members.has(entry.pid) && members.has(entry.ppid)) {
                members.add(entry.pid);
                grew = true;
            }
        }
    }
    return entries
        .filter((entry) => members.has(entry.pid) && entry.pid !== process.pid)
        .sort((left, right) => left.startTime - right.startTime || left.pid - right.pid);
}

async function readProcessEntry(pid: number): Promise<ProcessEntry | undefined> {
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
    return {
        name: stat.slice(nameStart + 1, nameEnd),
        pgid: Number(fields[2]),
        pid,
        ppid: Number(fields[1]),
        sid: Number(fields[3]),
        startTime: Number(fields[19]),
        state: fields[0] ?? "",
    };
}

/**
 * The object the command was given as its input: descriptor 0 of its oldest process that lets us
 * look. A sandboxed command's launcher hides its descriptors, but the shell it runs inherits the
 * same input unchanged.
 */
async function readCommandInput(members: readonly ProcessEntry[]): Promise<string | undefined> {
    for (const member of members) {
        const target = await readDescriptorTarget(member.pid);
        if (target !== undefined) return target;
    }
    return undefined;
}

async function readDescriptorTarget(pid: number): Promise<string | undefined> {
    try {
        return await readlink(`/proc/${String(pid)}/fd/0`);
    } catch {
        return undefined;
    }
}

async function isReadingInput(pid: number, readSyscalls: ReadonlySet<number>): Promise<boolean> {
    let syscall: string;
    try {
        syscall = await readFile(`/proc/${String(pid)}/syscall`, "utf8");
    } catch {
        return false;
    }
    // "<number> <first argument> …" while blocked in a call; "running" or "-1 …" otherwise.
    const [number, descriptor] = syscall.trim().split(" ");
    return readSyscalls.has(Number(number)) && descriptor !== undefined && Number(descriptor) === 0;
}

async function readCommandLine(pid: number, name: string): Promise<string> {
    try {
        const commandLine = (await readFile(`/proc/${String(pid)}/cmdline`, "utf8"))
            .split("\0")
            .filter((part) => part.length > 0)
            .join(" ");
        return commandLine.length === 0 ? name : commandLine;
    } catch {
        return name;
    }
}
