import { homedir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { handleHappyListWorkspaces } from "../handleHappyListWorkspaces.js";

describe("handleHappyListWorkspaces", () => {
    it("normalizes the project directory and returns its managed workspaces", async () => {
        const listWorkspaces = vi.fn(() => [
            {
                id: "workspace-1",
                name: "Steady River",
                path: `${homedir()}/project/.rig/workspaces/steady-river`,
                status: "ready",
            },
        ]);

        await expect(
            handleHappyListWorkspaces({
                listWorkspaces,
                params: { directory: "~/project" },
            }),
        ).resolves.toEqual({
            type: "success",
            workspaces: [
                {
                    id: "workspace-1",
                    name: "Steady River",
                    path: `${homedir()}/project/.rig/workspaces/steady-river`,
                    status: "ready",
                },
            ],
        });
        expect(listWorkspaces).toHaveBeenCalledWith(`${homedir()}/project`);
    });

    it("rejects relative and malformed requests before querying the store", async () => {
        const listWorkspaces = vi.fn();

        await expect(
            handleHappyListWorkspaces({
                listWorkspaces,
                params: { directory: "relative/project" },
            }),
        ).resolves.toEqual({
            errorMessage: "The directory must be absolute.",
            type: "error",
        });
        await expect(
            handleHappyListWorkspaces({ listWorkspaces, params: { directory: "   " } }),
        ).resolves.toEqual({
            errorMessage: "Happy must provide a directory.",
            type: "error",
        });
        expect(listWorkspaces).not.toHaveBeenCalled();
    });
});
