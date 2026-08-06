import { describe, expect, it } from "vitest";

import type { ProjectWorkspace } from "../../protocol/index.js";
import { workspaceRunReadiness } from "../workspaceRunReadiness.js";

const workspace = {
    id: "workspace-1",
    path: "/workspaces/one",
    presence: "present",
    projectId: "project-1",
    status: "ready",
} as ProjectWorkspace;

const projects = {
    getWorkspace: () => workspace,
};

describe("workspaceRunReadiness", () => {
    it("keeps the run queued when checkout availability cannot be determined", () => {
        expect(
            workspaceRunReadiness(
                projects,
                {
                    cwd: workspace.path,
                    projectId: workspace.projectId,
                    workspaceId: workspace.id,
                },
                () => {
                    throw Object.assign(new Error("Interrupted system call."), { code: "EINTR" });
                },
            ),
        ).toEqual({ retryable: true, state: "waiting" });
    });

    it("fails only when the checkout is durably or demonstrably unavailable", () => {
        const target = {
            cwd: workspace.path,
            projectId: workspace.projectId,
            workspaceId: workspace.id,
        };
        expect(
            workspaceRunReadiness(projects, target, () => {
                throw Object.assign(new Error("Missing."), { code: "ENOENT" });
            }),
        ).toMatchObject({ state: "failed" });
        expect(
            workspaceRunReadiness(
                {
                    getWorkspace: () => ({ ...workspace, presence: "missing" }),
                },
                target,
                () => {
                    throw new Error("The durable missing state should short-circuit.");
                },
            ),
        ).toMatchObject({ state: "failed" });
    });
});
