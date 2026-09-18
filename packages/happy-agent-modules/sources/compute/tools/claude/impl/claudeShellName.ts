import type { Compute } from "../../../Compute.js";

/** WSL runs the Linux agent; a Windows host must not rename a Linux compute's tools. */
export function claudeShellName(compute: Compute): "Bash" | "PowerShell" {
    return compute.kind === "host" && process.platform === "win32" ? "PowerShell" : "Bash";
}
