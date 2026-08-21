import { describe, expect, it } from "vitest";

import { resolveAgentDaemonProcessCommand } from "../sources/lifecycle/resolveAgentDaemonProcessCommand.js";

describe("resolveAgentDaemonProcessCommand", () => {
    it("relaunches a standalone binary directly", () => {
        expect(
            resolveAgentDaemonProcessCommand(undefined, {
                entrypoint: "/$bunfs/root/happy-agent.js",
                executable: "/usr/local/bin/happy-agent",
                execArguments: [],
                standalone: true,
            }),
        ).toEqual({
            arguments: ["run"],
            executable: "/usr/local/bin/happy-agent",
        });
    });

    it("preserves the Node-compatible script command", () => {
        expect(
            resolveAgentDaemonProcessCommand("/opt/rig/agent.js", {
                entrypoint: "/opt/happy-agent/cli.js",
                executable: "/usr/local/bin/node",
                execArguments: ["--enable-source-maps"],
                standalone: false,
            }),
        ).toEqual({
            arguments: ["--enable-source-maps", "/opt/rig/agent.js", "run"],
            executable: "/usr/local/bin/node",
        });
    });
});
