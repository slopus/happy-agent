import { quoteShellArgument } from "@slopus/happy-agent-compute";

/** Carries Git's binary output through the shared shell's UTF-8 result channel. */
export function createScanGitCommand(argv: readonly string[]): string {
    if (process.platform !== "win32") {
        return [
            "set -o pipefail",
            `${argv.map(quoteShellArgument).join(" ")} | /usr/bin/base64`,
        ].join("\n");
    }
    const executable = argv[0];
    if (executable === undefined) throw new Error("A Git executable is required.");
    // Windows PowerShell decodes native pipelines as text. Stream the process's
    // raw stdout through the system Base64 encoder instead, without buffering
    // the entire result. Buffer the encoder's four-byte writes into bounded pipe
    // chunks. Git remains a child of the restricted shell and job.
    return [
        "$ErrorActionPreference = 'Stop'",
        "$scanProcess = [System.Diagnostics.Process]::new()",
        "$scanEncoder = $null",
        "$scanEncodedOutput = $null",
        "$scanStdoutBuffer = $null",
        "try {",
        `    $scanProcess.StartInfo.FileName = ${powershellLiteral(executable)}`,
        `    $scanProcess.StartInfo.Arguments = ${powershellLiteral(argv.slice(1).map(windowsArgument).join(" "))}`,
        "    $scanProcess.StartInfo.UseShellExecute = $false",
        "    $scanProcess.StartInfo.CreateNoWindow = $true",
        "    $scanProcess.StartInfo.RedirectStandardInput = $true",
        "    $scanProcess.StartInfo.RedirectStandardOutput = $true",
        "    $scanProcess.StartInfo.RedirectStandardError = $true",
        "    if (-not $scanProcess.Start()) { throw 'Git could not be started.' }",
        "    $scanProcess.StandardInput.Close()",
        "    $scanErrorCopy = $scanProcess.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())",
        "    $scanEncoder = [System.Security.Cryptography.ToBase64Transform]::new()",
        "    $scanStdoutBuffer = [System.IO.BufferedStream]::new([Console]::OpenStandardOutput(), 65536)",
        "    $scanEncodedOutput = [System.Security.Cryptography.CryptoStream]::new($scanStdoutBuffer, $scanEncoder, [System.Security.Cryptography.CryptoStreamMode]::Write, $true)",
        "    $scanProcess.StandardOutput.BaseStream.CopyTo($scanEncodedOutput)",
        "    $scanEncodedOutput.FlushFinalBlock()",
        "    $scanStdoutBuffer.Flush()",
        "    $null = $scanErrorCopy.GetAwaiter().GetResult()",
        "    $scanProcess.WaitForExit()",
        "    exit $scanProcess.ExitCode",
        "} catch {",
        "    [Console]::Error.WriteLine($_.Exception.Message)",
        "    exit 1",
        "} finally {",
        "    if ($null -ne $scanEncodedOutput) { $scanEncodedOutput.Dispose() }",
        "    if ($null -ne $scanEncoder) { $scanEncoder.Dispose() }",
        "    if ($null -ne $scanStdoutBuffer) { $scanStdoutBuffer.Dispose() }",
        "    $scanProcess.Dispose()",
        "}",
    ].join("\n");
}

function powershellLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

/** Quote one argument for the Windows C runtime used by Git for Windows. */
function windowsArgument(value: string): string {
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
