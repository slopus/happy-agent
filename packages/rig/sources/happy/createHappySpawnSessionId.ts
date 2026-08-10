import { createHash } from "node:crypto";

export function createHappySpawnSessionId(machineId: string, clientRequestId: string): string {
    return `happy-rig-${createHash("sha256")
        .update(machineId)
        .update("\0")
        .update(clientRequestId)
        .digest("base64url")}`;
}

/**
 * A deterministic cuid2-shaped identity for the workspace owned by one Happy
 * spawn request. PersistentSessionStore uses a caller-supplied workspace ID as
 * its idempotency key, so a retried machine RPC returns the first workspace.
 */
export function createHappySpawnWorkspaceId(machineId: string, clientRequestId: string): string {
    return `w${createHash("sha256")
        .update("happy-workspace\0")
        .update(machineId)
        .update("\0")
        .update(clientRequestId)
        .digest("hex")
        .slice(0, 31)}`;
}
