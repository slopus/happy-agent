import { describe, expect, it } from "vitest";

import {
    HAPPY_MACHINE_RPC_TIMEOUT_MS,
    HAPPY_REMOTE_SESSION_WAIT_MS,
    HAPPY_SPAWN_PENDING_RETRY_AFTER_MS,
    HAPPY_WORKSPACE_READY_WAIT_MS,
    waitForHappyWorkspaceReady,
} from "../../happySpawnTiming.js";

describe("waitForHappyWorkspaceReady", () => {
    it("returns the published pending response before Happy's 30-second machine RPC timeout", async () => {
        let now = 0;
        const result = await waitForHappyWorkspaceReady({
            getWorkspace: () => ({
                id: "workspace-1",
                path: "/workspace/steady-river",
                status: "initializing",
            }),
            now: () => now,
            sleep: async (milliseconds) => {
                now += milliseconds;
            },
        });

        expect(result).toEqual({
            retryAfterMs: HAPPY_SPAWN_PENDING_RETRY_AFTER_MS,
            type: "pending",
        });
        expect(now).toBe(HAPPY_WORKSPACE_READY_WAIT_MS);
        expect(HAPPY_REMOTE_SESSION_WAIT_MS).toBe(15_000);
        expect(HAPPY_WORKSPACE_READY_WAIT_MS + HAPPY_REMOTE_SESSION_WAIT_MS).toBeLessThan(
            HAPPY_MACHINE_RPC_TIMEOUT_MS,
        );
    });
});
