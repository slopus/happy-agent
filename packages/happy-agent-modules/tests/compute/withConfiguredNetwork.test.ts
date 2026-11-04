import { computePermissions } from "@slopus/happy-agent-compute";
import { describe, expect, it } from "vitest";

import { withConfiguredNetwork } from "../../sources/compute/impl/withConfiguredNetwork.js";

describe("withConfiguredNetwork", () => {
    it("sends Auto and Workspace write egress through the configured allowlist on port 443", () => {
        for (const mode of ["auto", "workspace_write"] as const) {
            expect(
                withConfiguredNetwork(computePermissions(mode), {
                    allowedDomains: ["*.example.com"],
                    deniedDomains: ["uploads.example.com"],
                }).network,
            ).toEqual({
                egress: true,
                localBinding: false,
                allowedHosts: ["*.example.com"],
                allowedPorts: [443],
                deniedHosts: ["uploads.example.com"],
            });
        }
    });

    it("leaves Read only and Full access as their modes define them", () => {
        const policy = { allowedDomains: ["example.com"], allowLocalBinding: true };
        expect(withConfiguredNetwork(computePermissions("read_only"), policy).network).toEqual({
            egress: false,
            localBinding: false,
        });
        expect(withConfiguredNetwork(computePermissions("full_access"), policy).network).toEqual({
            egress: true,
            localBinding: true,
        });
    });

    it("grants nothing for no domains or no ports, and local binding on its own", () => {
        const auto = computePermissions("auto");
        expect(withConfiguredNetwork(auto, { allowedDomains: [] }).network).toEqual(auto.network);
        expect(
            withConfiguredNetwork(auto, { allowedDomains: ["example.com"], allowedPorts: [] })
                .network,
        ).toEqual(auto.network);
        expect(withConfiguredNetwork(auto, { allowLocalBinding: true }).network).toEqual({
            egress: false,
            localBinding: true,
        });
    });
});
