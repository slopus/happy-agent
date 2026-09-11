import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

// Built-in Windows PowerShell performs the bootstrap before any embedded native
// library is loaded. Paths are data in the environment, never interpolated code.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:HAPPY_PRIVATE_ASSET_DIRECTORY
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$directory = [IO.DirectoryInfo]::new($path)
if (!$directory.Exists) {
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetOwner($user)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($user, $system, $administrators)) {
        $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow))
    }
    $directory.Create($security)
}
if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Happy executable cache cannot be a reparse point.'
}
$security = $directory.GetAccessControl()
if ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) {
    throw 'Happy executable cache has a different owner.'
}
$trusted = @($user.Value, $system.Value, $administrators.Value)
$readOnly = [int][Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
    [int][Security.AccessControl.FileSystemRights]::Synchronize
foreach ($rule in $security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $trusted -notcontains $rule.IdentityReference.Value -and
        (([int]$rule.FileSystemRights -band (-bnot $readOnly)) -ne 0)) {
        throw 'Happy executable cache permits another account to modify its files.'
    }
}
`;

/** Create an owner-controlled cache atomically, or reject an unsafe existing one. */
export function ensureWindowsPrivateDirectory(directory: string): void {
    if (!isAbsolute(directory)) throw new Error("Happy executable cache path must be absolute.");
    const windows = process.env.SystemRoot ?? "C:\\Windows";
    const result = spawnSync(
        join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            env: { ...process.env, HAPPY_PRIVATE_ASSET_DIRECTORY: directory },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Cannot secure Happy executable cache: ${result.stderr.trim()}`);
    }
}
