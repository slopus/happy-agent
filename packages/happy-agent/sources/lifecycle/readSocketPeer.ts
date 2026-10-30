/** The process that listens on a Unix socket, as the kernel reports it to a connected client. */
export interface SocketPeer {
    readonly pid: number;
    readonly uid: number;
}

const AF_UNIX = 1;
const SOCK_STREAM = 1;

/**
 * Asks the kernel which process listens on a Unix socket, by connecting to it and reading the
 * peer's credentials: `LOCAL_PEERPID` and `getpeereid` on macOS, `SO_PEERCRED` on Linux. Both
 * report the process that called `listen`, so the answer cannot be forged by the listener.
 *
 * Neither Node nor Bun exposes these options, so this calls libc through Bun's FFI. It answers
 * undefined when it cannot tell: under Node, on Windows, or when nothing accepts the connection.
 */
export async function readSocketPeer(socketPath: string): Promise<SocketPeer | undefined> {
    if (!("bun" in process.versions)) return undefined;
    if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
    try {
        const ffi = (await import("bun:ffi" as string)) as BunFfi;
        return readPeer(ffi, process.platform, socketPath);
    } catch {
        return undefined;
    }
}

interface BunFfi {
    readonly FFIType: Record<"i32" | "u32" | "ptr", number>;
    dlopen(
        path: string,
        symbols: Record<string, { readonly args: readonly number[]; readonly returns: number }>,
    ): { readonly symbols: Record<string, (...args: unknown[]) => number>; close(): void };
}

function readPeer(
    ffi: BunFfi,
    platform: "darwin" | "linux",
    socketPath: string,
): SocketPeer | undefined {
    const { i32, u32, ptr } = ffi.FFIType;
    const library = ffi.dlopen(platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
        socket: { args: [i32, i32, i32], returns: i32 },
        connect: { args: [i32, ptr, u32], returns: i32 },
        getsockopt: { args: [i32, i32, i32, ptr, ptr], returns: i32 },
        ...(platform === "darwin" ? { getpeereid: { args: [i32, ptr, ptr], returns: i32 } } : {}),
        close: { args: [i32], returns: i32 },
    });
    const libc = library.symbols as Record<string, (...args: unknown[]) => number>;
    const fd = libc.socket!(AF_UNIX, SOCK_STREAM, 0);
    try {
        if (fd < 0) return undefined;
        const address = socketAddress(platform, socketPath);
        if (address === undefined) return undefined;
        if (libc.connect!(fd, address, address.byteLength) !== 0) return undefined;
        return platform === "darwin" ? darwinPeer(libc, fd) : linuxPeer(libc, fd);
    } finally {
        if (fd >= 0) libc.close!(fd);
        library.close();
    }
}

/** `struct sockaddr_un`: macOS leads with a length byte and a family byte, Linux with a u16. */
function socketAddress(platform: "darwin" | "linux", socketPath: string): Uint8Array | undefined {
    const path = Buffer.from(socketPath, "utf8");
    const size = platform === "darwin" ? 106 : 110;
    if (path.byteLength + 3 > size) return undefined;
    const address = new Uint8Array(size);
    if (platform === "darwin") {
        address[0] = size;
        address[1] = AF_UNIX;
    } else {
        new DataView(address.buffer).setUint16(0, AF_UNIX, true);
    }
    address.set(path, 2);
    return address;
}

function darwinPeer(
    libc: Record<string, (...args: unknown[]) => number>,
    fd: number,
): SocketPeer | undefined {
    const SOL_LOCAL = 0;
    const LOCAL_PEERPID = 2;
    const pid = new Int32Array(1);
    const length = new Uint32Array([4]);
    if (libc.getsockopt!(fd, SOL_LOCAL, LOCAL_PEERPID, pid, length) !== 0) return undefined;
    const uid = new Uint32Array(1);
    const gid = new Uint32Array(1);
    if (libc.getpeereid!(fd, uid, gid) !== 0) return undefined;
    return validPeer(pid[0]!, uid[0]!);
}

/** `struct ucred { pid_t pid; uid_t uid; gid_t gid; }` */
function linuxPeer(
    libc: Record<string, (...args: unknown[]) => number>,
    fd: number,
): SocketPeer | undefined {
    const SOL_SOCKET = 1;
    const SO_PEERCRED = 17;
    const credentials = new Int32Array(3);
    const length = new Uint32Array([12]);
    if (libc.getsockopt!(fd, SOL_SOCKET, SO_PEERCRED, credentials, length) !== 0) {
        return undefined;
    }
    return validPeer(credentials[0]!, new Uint32Array(credentials.buffer)[1]!);
}

function validPeer(pid: number, uid: number): SocketPeer | undefined {
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, uid } : undefined;
}
