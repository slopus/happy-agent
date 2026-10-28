/**
 * How a vendor's documented install command runs without a terminal: a POSIX shell on macOS
 * and Linux, and a hidden PowerShell that may run the downloaded script on Windows.
 */
export function installerProcess(
    platform: NodeJS.Platform,
    command: string,
): { readonly command: string; readonly args: readonly string[] } {
    if (platform === "win32") {
        return {
            command: "powershell.exe",
            args: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ],
        };
    }
    return { command: "/bin/sh", args: ["-c", command] };
}
