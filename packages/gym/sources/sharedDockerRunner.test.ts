import { describe, expect, it } from "vitest";

import { dockerSandboxArguments } from "./sharedDockerRunner.js";

describe("dockerSandboxArguments", () => {
    it("hides the shared fixture and state pools from each sandbox", () => {
        expect(
            dockerSandboxArguments("/gyms/fixture", "/gym-state/fixture", ["node", "rig.js"]),
        ).toEqual([
            "bwrap",
            "--unshare-user",
            "--unshare-ipc",
            "--unshare-uts",
            "--bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--bind",
            "/gyms/fixture/workspace",
            "/workspace",
            "--bind",
            "/gyms/fixture/home",
            "/home/happy-terminal",
            "--bind",
            "/gym-state/fixture/tmp",
            "/tmp",
            // The fixture home cannot hold the daemon's Unix socket, so the daemon's private
            // directory is bound from container-local state instead.
            "--bind",
            "/gym-state/fixture/agent",
            "/home/happy-terminal/.happy/agent",
            "--tmpfs",
            "/gyms",
            "--tmpfs",
            "/gym-state",
            "--chdir",
            "/workspace",
            "--",
            "node",
            "rig.js",
        ]);
    });
});
