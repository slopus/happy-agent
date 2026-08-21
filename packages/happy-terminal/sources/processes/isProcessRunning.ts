import { readFile } from "node:fs/promises";

export async function isProcessRunning(processId: number): Promise<boolean> {
    if (!Number.isSafeInteger(processId) || processId <= 0) return false;

    try {
        process.kill(processId, 0);
    } catch (error) {
        return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: unknown }).code === "EPERM"
        );
    }

    if (process.platform !== "linux") return true;

    try {
        const stat = await readFile(`/proc/${processId}/stat`, "utf8");
        const commandEnd = stat.lastIndexOf(")");
        const state = commandEnd < 0 ? undefined : stat.slice(commandEnd + 2).split(" ", 1)[0];
        return state !== "Z";
    } catch (error) {
        const code =
            typeof error === "object" && error !== null && "code" in error
                ? (error as { code?: unknown }).code
                : undefined;
        return code !== "ENOENT" && code !== "ESRCH";
    }
}
