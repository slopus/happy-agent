export function resolveSystemShell(environment: NodeJS.ProcessEnv = process.env): string {
    if (process.platform === "win32") return environment.ComSpec ?? "cmd.exe";
    return environment.SHELL ?? "/bin/sh";
}
