/** The process that listens on a Unix socket, as the kernel reports it to a connected client. */
export interface SocketPeer {
    readonly pid: number;
    readonly uid: number;
}

type Libc = Record<string, (...args: unknown[]) => number>;

export interface BunFfi {
    readonly FFIType: Record<"i32" | "u32" | "ptr", number>;
    dlopen(
        path: string,
        symbols: Record<string, { readonly args: readonly number[]; readonly returns: number }>,
    ): { readonly symbols: Libc; close(): void };
}

const AF_UNIX = 1;
const SOCK_STREAM = 1;

/**
 * Asks the kernel which process listens on a Unix socket, by connecting to it and reading the
 * peer's credentials: `LOCAL_PEERPID` and `getpeereid` on macOS, `SO_PEERCRED` on Linux. Both
 * name the process that called `listen`, so the listener cannot forge the answer.
 *
 * Neither Node nor Bun exposes these options, so this calls libc through Bun's FFI. It answers
 * undefined when it cannot tell: under Node, on Windows, or when nothing accepts the connection.
 */
export async function readSocketPeer(socketPath: string): Promise<SocketPeer | undefined> {
    const platform = process.platform;
    if (!("bun" in process.versions) || (platform !== "darwin" && platform !== "linux")) {
        return undefined;
    }
    try {
        const ffi = (await import("bun:ffi" as string)) as BunFfi;
        const { i32, u32, ptr } = ffi.FFIType;
        const darwin = platform === "darwin";
        const library = ffi.dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
            socket: { args: [i32, i32, i32], returns: i32 },
            connect: { args: [i32, ptr, u32], returns: i32 },
            getsockopt: { args: [i32, i32, i32, ptr, ptr], returns: i32 },
            close: { args: [i32], returns: i32 },
            ...(darwin ? { getpeereid: { args: [i32, ptr, ptr], returns: i32 } } : {}),
        });
        const libc = library.symbols;
        const fd = libc.socket!(AF_UNIX, SOCK_STREAM, 0);
        try {
            const address = socketAddress(darwin, socketPath);
            if (fd < 0 || address === undefined) return undefined;
            if (libc.connect!(fd, address, address.byteLength) !== 0) return undefined;
            const peer = darwin ? darwinPeer(libc, fd) : linuxPeer(libc, fd);
            return (peer?.pid ?? 0) > 0 ? peer : undefined;
        } finally {
            if (fd >= 0) libc.close!(fd);
            library.close();
        }
    } catch {
        return undefined;
    }
}

/** `struct sockaddr_un`: macOS leads with a length byte and a family byte, Linux with a u16. */
function socketAddress(darwin: boolean, socketPath: string): Uint8Array | undefined {
    const path = Buffer.from(socketPath, "utf8");
    const size = darwin ? 106 : 110;
    if (path.byteLength + 3 > size) return undefined;
    const address = new Uint8Array(size);
    if (darwin) address.set([size, AF_UNIX]);
    else new DataView(address.buffer).setUint16(0, AF_UNIX, true);
    address.set(path, 2);
    return address;
}

/** `getsockopt(SOL_LOCAL, LOCAL_PEERPID)` names the process; `getpeereid` its user. */
function darwinPeer(libc: Libc, fd: number): SocketPeer | undefined {
    const pid = new Int32Array(1);
    const uid = new Uint32Array(1);
    if (libc.getsockopt!(fd, 0, 2, pid, new Uint32Array([4])) !== 0) return undefined;
    if (libc.getpeereid!(fd, uid, new Uint32Array(1)) !== 0) return undefined;
    return { pid: pid[0]!, uid: uid[0]! };
}

/** `getsockopt(SOL_SOCKET, SO_PEERCRED)` fills `struct ucred { pid_t pid; uid_t uid; gid_t gid; }`. */
function linuxPeer(libc: Libc, fd: number): SocketPeer | undefined {
    const credentials = new Int32Array(3);
    if (libc.getsockopt!(fd, 1, 17, credentials, new Uint32Array([12])) !== 0) return undefined;
    return { pid: credentials[0]!, uid: new Uint32Array(credentials.buffer)[1]! };
}
