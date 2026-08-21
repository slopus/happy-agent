import { join } from "node:path";

import { getDebugRootDirectory } from "./getDebugRootDirectory.js";

export function createRequestDebugDirectory(cwd: string, runId: string, createdAt: number): string {
    const timestamp = new Date(createdAt).toISOString().replaceAll(":", "-");
    const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/gu, "-");
    return join(getDebugRootDirectory(cwd), `${timestamp}_${safeRunId}`);
}
