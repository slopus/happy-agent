import { join } from "node:path";
export function resolveSystemShell(environment: NodeJS.ProcessEnv = process.env): string {
    if (process.platform === "win32")
        return join(
            environment.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
        );
    return environment.SHELL ?? "/bin/sh";
}
