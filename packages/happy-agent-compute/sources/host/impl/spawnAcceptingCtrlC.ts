import { createRequire } from "node:module";

interface CtrlCFlag {
    ignored(): boolean;
    set(ignored: boolean): void;
}

let flag: CtrlCFlag | undefined;

/**
 * Start a terminal's program so it answers Ctrl+C, even from a process that ignores it.
 *
 * Windows passes a process's "ignore Ctrl+C" flag on to every program it starts, and a detached
 * daemon carries it, because a detached process starts in its own process group. A terminal's
 * shell that inherits it never sees the Ctrl+C its console raises for `\x03`, and neither does
 * `ping -t` or anything else a person runs there. node-pty clears the flag for its child; Bun's
 * terminal does not. So this process accepts Ctrl+C for the one synchronous spawn and then goes
 * back to what it was, leaving every other program it starts as before.
 */
export function spawnAcceptingCtrlC<Result>(spawn: () => Result): Result {
    if (process.platform !== "win32") return spawn();
    flag ??= loadCtrlCFlag();
    const ignored = flag.ignored();
    if (!ignored) return spawn();
    flag.set(false);
    try {
        return spawn();
    } finally {
        flag.set(true);
    }
}

/**
 * The flag lives in the process parameters, bit 0 of `ConsoleFlags`: Windows sets it but offers
 * no call that reads it back, and `SetConsoleCtrlHandler(NULL, …)` is the documented way to change it.
 */
function loadCtrlCFlag(): CtrlCFlag {
    const ffi = createRequire(import.meta.url)("bun:ffi") as BunFfi;
    const kernel32 = ffi.dlopen("kernel32.dll", {
        GetCurrentProcess: { args: [], returns: "ptr" },
        SetConsoleCtrlHandler: { args: ["ptr", "bool"], returns: "bool" },
    });
    const ntdll = ffi.dlopen("ntdll.dll", {
        NtQueryInformationProcess: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    });
    return {
        ignored() {
            // PROCESS_BASIC_INFORMATION: the PEB's address is its second field.
            const basic = new BigUint64Array(6);
            const status = ntdll.symbols.NtQueryInformationProcess(
                kernel32.symbols.GetCurrentProcess(),
                0,
                basic,
                basic.byteLength,
                null,
            ) as number;
            if (status !== 0) return false;
            const parameters = ffi.read.ptr(Number(basic[1]), 0x20);
            return (ffi.read.u32(parameters, 0x18) & 1) === 1;
        },
        set(ignored) {
            kernel32.symbols.SetConsoleCtrlHandler(null, ignored);
        },
    };
}

interface BunFfi {
    dlopen<Name extends string>(
        path: string,
        symbols: Record<Name, { args: string[]; returns: string }>,
    ): { symbols: Record<Name, (...args: unknown[]) => unknown> };
    read: {
        ptr(pointer: number, byteOffset: number): number;
        u32(pointer: number, byteOffset: number): number;
    };
}
