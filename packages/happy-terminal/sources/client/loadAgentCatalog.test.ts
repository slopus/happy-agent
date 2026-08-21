import { describe, expect, it, vi } from "vitest";

import {
    HappyAgentApiError,
    type HappyAgentClient,
    type Workspace,
} from "@slopus/happy-agent-client";

import { waitForWorkspaceReady } from "./loadAgentCatalog.js";

describe("waitForWorkspaceReady", () => {
    it("waits through the public initialization conflict and returns the ready workspace", async () => {
        const workspace = { id: "workspace" } as Workspace;
        const getWorkspace = vi
            .fn<HappyAgentClient["getWorkspace"]>()
            .mockRejectedValueOnce(
                new HappyAgentApiError(
                    409,
                    "The workspace is still initializing.",
                    "not_initialized",
                    {
                        code: "not_initialized",
                        error: "The workspace is still initializing.",
                    },
                ),
            )
            .mockResolvedValueOnce({ workspace });

        await expect(waitForWorkspaceReady({ getWorkspace }, workspace.id)).resolves.toBe(
            workspace,
        );
        expect(getWorkspace).toHaveBeenCalledTimes(2);
    });

    it("does not retry a terminal workspace error", async () => {
        const failure = new HappyAgentApiError(409, "The workspace is not available.", "conflict", {
            code: "conflict",
            error: "The workspace is not available.",
        });
        const getWorkspace = vi.fn<HappyAgentClient["getWorkspace"]>().mockRejectedValue(failure);

        await expect(waitForWorkspaceReady({ getWorkspace }, "workspace")).rejects.toBe(failure);
        expect(getWorkspace).toHaveBeenCalledTimes(1);
    });
});
