import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The machine Happy CLI registered from this same Happy home, if it registered one.
 *
 * Two daemons run on one computer, this one and Happy CLI's, and Happy gives each its own machine.
 * Naming the other one is what lets the phone put them back together and show the single computer
 * a person actually has.
 */
export async function readHappyCliMachineId(happyHome: string): Promise<string | undefined> {
    try {
        const stored: unknown = JSON.parse(
            await readFile(join(happyHome, "settings.json"), "utf8"),
        );
        if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
            return undefined;
        }
        const id = (stored as { machineId?: unknown }).machineId;
        return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
    } catch {
        // No Happy CLI beside this daemon, or nothing readable where it keeps its identity.
        // Standing alone is a normal way to run, so there is nothing to report.
        return undefined;
    }
}
