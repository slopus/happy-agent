import { describe, expect, it } from "vitest";

import { computePermissions } from "../../../sources/ComputePermissions.js";
import {
    createDockerSupervisorCommand,
    DOCKER_SUPERVISOR_PATH,
} from "../../../sources/docker/impl/createDockerSupervisorCommand.js";
import { createSupervisorPolicy } from "../../../sources/supervisor/createSupervisorPolicy.js";

describe("createDockerSupervisorCommand", () => {
    it("passes a command-scoped policy to the mounted supervisor as an argument", () => {
        const policy = createSupervisorPolicy({
            cwd: "/workspace",
            permissions: computePermissions("workspace_write", {
                network: {
                    egress: true,
                    allowedHosts: ["registry.npmjs.org"],
                    localBinding: false,
                },
            }),
        });
        const command = createDockerSupervisorCommand({
            command: "printf hello",
            policy,
            shell: "/bin/sh",
        });

        expect(command).toEqual({
            args: ["--policy", JSON.stringify(policy), "--", "/bin/sh", "-lc", "printf hello"],
            command: DOCKER_SUPERVISOR_PATH,
        });
    });
});
