import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Named pipes have a kernel lifetime and must never be treated as filesystem entries. */
export function isWindowsNamedPipe(path: string): boolean {
    return process.platform === "win32" && path.startsWith("\\\\.\\pipe\\");
}

/** Windows AF_UNIX reparse points can return EACCES to both Node and Bun lstat. */
export async function readAgentSocketInformation(path: string): Promise<{
    isSocket(): boolean;
    readonly uid?: number;
}> {
    try {
        return await lstat(path);
    } catch (error) {
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EACCES") {
            throw error;
        }
        // Query the exact reparse tag. Never interpret a generic access failure or an
        // ordinary symbolic link as a socket that Happy may remove. fsutil is an OS
        // component; this read-only query does not require administrator elevation.
        try {
            const { stdout } = await execFileAsync(
                join(process.env.SystemRoot ?? "C:\\Windows", "System32", "fsutil.exe"),
                ["reparsepoint", "query", path],
                { windowsHide: true, timeout: 5_000, maxBuffer: 16_384 },
            );
            if (/\b0x80000023\b/i.test(stdout.split(/\r?\n/, 1)[0] ?? "")) {
                return { isSocket: () => true };
            }
        } catch {
            // Preserve the original filesystem failure when the tag cannot be proven.
        }
        throw error;
    }
}
