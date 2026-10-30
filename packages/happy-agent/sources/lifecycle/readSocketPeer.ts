import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";

type Libc = Record<string, (...args: unknown[]) => number>;
interface BunFfi {
    FFIType: Record<"i32" | "u32" | "ptr", number>;
    dlopen(
        path: string,
        symbols: Record<string, { args: number[]; returns: number }>,
    ): {
        symbols: Libc;
        close(): void;
    };
}

/** Kernel peer credentials; unavailable on Node and Windows. */
export async function readSocketPeer(socketPath: string) {
    if (!("bun" in process.versions) || !["darwin", "linux"].includes(process.platform)) return;
    try {
        const ffi = (await import("bun:ffi" as string)) as BunFfi;
        const { i32, u32, ptr } = ffi.FFIType;
        const darwin = process.platform === "darwin";
        const library = ffi.dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
            socket: { args: [i32, i32, i32], returns: i32 },
            connect: { args: [i32, ptr, u32], returns: i32 },
            getsockopt: { args: [i32, i32, i32, ptr, ptr], returns: i32 },
            close: { args: [i32], returns: i32 },
            ...(darwin ? { getpeereid: { args: [i32, ptr, ptr], returns: i32 } } : {}),
        });
        const libc = library.symbols;
        const fd = libc.socket!(1, 1, 0);
        try {
            // sockaddr_un: macOS has length/family bytes; Linux has a u16 family.
            const address = Buffer.alloc(darwin ? 106 : 110);
            const path = Buffer.from(socketPath);
            if (fd < 0 || path.length + 3 > address.length) return;
            if (darwin) address.set([address.length, 1]);
            else address.writeUInt16LE(1);
            address.set(path, 2);
            if (libc.connect!(fd, address, address.length) !== 0) return;
            const credentials = new Uint32Array(3);
            // LOCAL_PEERPID + getpeereid, or SO_PEERCRED's pid/uid/gid.
            if (
                libc.getsockopt!(
                    fd,
                    darwin ? 0 : 1,
                    darwin ? 2 : 17,
                    credentials,
                    new Uint32Array([darwin ? 4 : 12]),
                ) !== 0
            )
                return;
            if (darwin && libc.getpeereid!(fd, credentials.subarray(1), new Uint32Array(1)) !== 0)
                return;
            if (credentials[0]! > 0) return { pid: credentials[0]!, uid: credentials[1]! };
        } finally {
            if (fd >= 0) libc.close!(fd);
            library.close();
        }
    } catch {
        /* Unidentified listeners are left running. */
    }
    return undefined;
}

/** The executable image, owner and parent; never trust the command-line process name. */
export async function describeLocalProcess(pid: number) {
    try {
        if (process.platform === "linux") {
            const [status, executable] = await Promise.all([
                readFile(`/proc/${String(pid)}/status`, "utf8"),
                readlink(`/proc/${String(pid)}/exe`),
            ]);
            const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
            const parentPid = /^PPid:\s+(\d+)/m.exec(status)?.[1];
            if (uid !== undefined && parentPid !== undefined)
                return {
                    uid: Number(uid),
                    parentPid: Number(parentPid),
                    executable: executable.replace(/ \(deleted\)$/, ""),
                };
        } else if (process.platform === "darwin" && "bun" in process.versions) {
            const ffi = (await import("bun:ffi" as string)) as BunFfi;
            const { i32, u32, ptr } = ffi.FFIType;
            const library = ffi.dlopen("libSystem.B.dylib", {
                proc_pidpath: { args: [i32, ptr, u32], returns: i32 },
            });
            try {
                const path = Buffer.alloc(4096);
                const length = library.symbols.proc_pidpath!(pid, path, path.length);
                const { stdout } = await promisify(execFile)(
                    "/bin/ps",
                    ["-p", String(pid), "-o", "uid=,ppid="],
                    { timeout: 2000 },
                );
                const match = /^(\d+)\s+(\d+)$/.exec(stdout.trim());
                if (length > 0 && match)
                    return {
                        uid: Number(match[1]),
                        parentPid: Number(match[2]),
                        executable: path.toString("utf8", 0, length),
                    };
            } finally {
                library.close();
            }
        }
    } catch {
        /* The process may already have exited. */
    }
    return undefined;
}

export function isHappyAgentProcess(candidate: { executable: string }): boolean {
    return /(?:^|[\\/])happy-agent(?:-[a-z0-9._-]+)?(?:\.exe)?$/i.test(candidate.executable);
}
