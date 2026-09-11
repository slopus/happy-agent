import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { computePermissions } from "../../sources/ComputePermissions.js";
import { createSupervisorPolicy } from "../../sources/supervisor/createSupervisorPolicy.js";

describe("createSupervisorPolicy", () => {
    it("resolves relative paths and gives allow-listed egress to the supervisor proxy", () => {
        expect(
            createSupervisorPolicy({
                cwd: "/workspace",
                permissions: computePermissions("workspace_write", {
                    allowedWritePaths: ["../cache"],
                    network: {
                        egress: true,
                        allowedHosts: ["example.com"],
                        localBinding: false,
                    },
                }),
                deniedReadPaths: ["secrets"],
            }),
        ).toEqual({
            mode: "workspace_write",
            deniedReadPaths: [resolve("/workspace", "secrets")],
            allowedWritePaths: [resolve("/workspace", "../cache")],
            network: {
                egress: true,
                allowedHosts: ["example.com"],
                localBinding: false,
                outgoingProxy: { frontEnds: ["http", "socks5"] },
            },
        });
    });

    it("can represent an explicit deny-all egress proxy", () => {
        expect(
            createSupervisorPolicy({
                cwd: "/workspace",
                permissions: computePermissions("workspace_write", {
                    network: { egress: true, localBinding: false },
                }),
                network: { egress: true, localBinding: false },
                networkProxy: true,
            }).network,
        ).toEqual({
            egress: true,
            localBinding: false,
            outgoingProxy: { frontEnds: ["http", "socks5"] },
        });
    });

    it("rejects a bare wildcard instead of passing invalid host policy to the supervisor", () => {
        expect(() =>
            createSupervisorPolicy({
                cwd: "/workspace",
                permissions: computePermissions("workspace_write", {
                    network: { egress: true, allowedHosts: ["*"], localBinding: false },
                }),
            }),
        ).toThrow("bare '*'");
    });

    it("does not turn a read-only action's write grant into a writable supervisor root", () => {
        expect(
            createSupervisorPolicy({
                cwd: "/workspace",
                permissions: computePermissions("read_only", {
                    allowedWritePaths: ["/cache"],
                }),
            }),
        ).not.toHaveProperty("allowedWritePaths");
    });
});
