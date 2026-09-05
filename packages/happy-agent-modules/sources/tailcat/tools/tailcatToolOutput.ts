import type { TailcatStatus } from "../Tailcat.js";

/** One bounded, human-readable rendering shared by the mutation and status tools. */
export function formatTailcatStatus(status: TailcatStatus): string {
    if (status.state === "open" && status.address !== undefined) {
        return `Tailcat internet exposure is open at ${status.address}.`;
    }
    if (status.state === "failed") {
        return `Tailcat internet exposure is enabled but could not open: ${status.error ?? "unknown error"}`;
    }
    if (status.state === "starting") return "Tailcat internet exposure is starting.";
    if (status.state === "stopping") return "Tailcat internet exposure is stopping.";
    return "Tailcat internet exposure is disabled.";
}
