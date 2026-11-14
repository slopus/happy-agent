import { win32 } from "node:path";

import { resolveSystemShell } from "@slopus/happy-agent-compute";

import type { Compute } from "../../../Compute.js";

/**
 * The shell `exec_command` asks the machine for, or `undefined` for the machine's own.
 *
 * Native Windows commands always run in Windows PowerShell, and Codex models there name it in
 * `shell`. Compute runs a custom shell only in Full access, so passing that name through refused
 * every sandboxed command in Auto and Workspace write. Naming the shell the machine already uses
 * asks for nothing custom; any other shell is still passed through unchanged.
 */
export function codexCommandShell(compute: Compute, shell: string | undefined): string | undefined {
    if (shell === undefined || compute.kind !== "host" || process.platform !== "win32") {
        return shell;
    }
    const name = win32.basename(shell).toLowerCase();
    if (name !== "powershell" && name !== "powershell.exe") return shell;
    if (win32.dirname(shell) === ".") return undefined;
    return win32.normalize(shell).toLowerCase() ===
        win32.normalize(resolveSystemShell()).toLowerCase()
        ? undefined
        : shell;
}
