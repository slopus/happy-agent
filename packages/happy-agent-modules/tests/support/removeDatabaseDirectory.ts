import { rm } from "node:fs/promises";

/**
 * Removes a test directory that held a libSQL database. The unpatched binding releases its file
 * handles only on garbage collection, and Windows refuses to delete an open file, so collect first.
 */
export async function removeDatabaseDirectory(path: string): Promise<void> {
    globalThis.gc?.();
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
