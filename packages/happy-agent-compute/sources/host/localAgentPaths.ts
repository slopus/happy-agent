/// <reference types="node" />
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One local endpoint shared by the daemon, launchers, and native clients. */
export function localAgentSocketPath(
    agentDirectory: string,
    platform: NodeJS.Platform = process.platform,
): string {
    if (platform !== "win32") return join(agentDirectory, "server.sock");
    const identity = createHash("sha256")
        .update(win32.resolve(agentDirectory).toLowerCase())
        .digest("hex");
    return `\\\\.\\pipe\\happy-agent-${identity}`;
}

/** A private application directory must protect credentials on Windows as well as Unix. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
    await mkdir(directory, { mode: 0o700, recursive: true });
    if (process.platform !== "win32") {
        await chmod(directory, 0o700);
        return;
    }
    // The path is data in an environment variable, never interpolated into shell code.
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$target = Get-Item -LiteralPath $env:HAPPY_PRIVATE_DIRECTORY -Force",
        "if (($target.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private state cannot be a reparse point.' }",
        "$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User",
        "$acl = [Security.AccessControl.DirectorySecurity]::new()",
        "$acl.SetOwner($identity)",
        "$acl.SetAccessRuleProtection($true, $false)",
        "foreach ($sid in @($identity, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }",
        "$target.SetAccessControl($acl)",
    ].join("\n");
    await execFileAsync(
        join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
        ),
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
            env: { ...process.env, HAPPY_PRIVATE_DIRECTORY: directory },
            windowsHide: true,
            timeout: 15_000,
            maxBuffer: 16_384,
        },
    );
}
