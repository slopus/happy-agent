import { basename } from "node:path";

/** Shell syntax is selected from the executable; arguments remain an argv vector. */
export function shellCommandArgs(shell: string, command: string): string[] {
    const name = basename(shell).toLowerCase();
    if (name === "cmd.exe" || name === "cmd") return ["/d", "/s", "/c", command];
    if (["powershell.exe", "powershell", "pwsh.exe", "pwsh"].includes(name))
        return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
    return ["-lc", command];
}
