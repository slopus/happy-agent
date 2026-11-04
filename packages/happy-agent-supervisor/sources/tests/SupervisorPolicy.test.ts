import { describe, expect, it } from "vitest";

import { parseSupervisorPolicy } from "../SupervisorPolicy.js";

describe("parseSupervisorPolicy", () => {
    it("accepts the ComputePermissions shape", () => {
        expect(
            parseSupervisorPolicy({
                mode: "workspace_write",
                deniedWritePaths: ["/workspace/.git"],
                network: { egress: true, allowedHosts: [], localBinding: false },
            }),
        ).toEqual({
            mode: "workspace_write",
            deniedWritePaths: ["/workspace/.git"],
            network: { egress: true, allowedHosts: [], localBinding: false },
        });
    });

    it("accepts an outgoing proxy that names only its front-ends", () => {
        const policy = parseSupervisorPolicy({
            mode: "workspace_write",
            network: {
                egress: true,
                allowedHosts: ["example.com", "*.internal.example.com"],
                localBinding: false,
                outgoingProxy: { frontEnds: ["http", "socks5"] },
            },
        });

        expect(policy.network.outgoingProxy).toEqual({ frontEnds: ["http", "socks5"] });
    });

    it("accepts denied hosts and allowed ports beside a host list", () => {
        const network = {
            egress: true,
            allowedHosts: ["*.example.com"],
            deniedHosts: ["uploads.example.com"],
            allowedPorts: [443, 8443],
            localBinding: false,
            outgoingProxy: { frontEnds: ["http" as const] },
        };
        expect(parseSupervisorPolicy({ mode: "auto", network }).network).toEqual(network);
        for (const allowedPorts of [[], [0], [65_536], [44.3]]) {
            expect(() =>
                parseSupervisorPolicy({ mode: "auto", network: { ...network, allowedPorts } }),
            ).toThrow();
        }
    });

    it("rejects a proxy the supervisor could not act on", () => {
        for (const outgoingProxy of [
            { frontEnds: [] },
            { frontEnds: ["ftp"] },
            { frontEnds: ["http"], certificate: "/tmp/ca.pem" },
            // The supervisor provides the proxy itself, so it accepts neither of these any more.
            { upstreamFd: 3, frontEnds: ["http"] },
            { token: "command-scoped-token", frontEnds: ["http"] },
            { frontEnds: ["http"], tlsTermination: { certificateAuthorityFile: "/tmp/ca.pem" } },
        ]) {
            expect(() =>
                parseSupervisorPolicy({
                    mode: "workspace_write",
                    network: { egress: true, localBinding: false, outgoingProxy },
                }),
            ).toThrow();
        }
    });

    it("rejects unknown policy fields", () => {
        expect(() =>
            parseSupervisorPolicy({
                mode: "auto",
                command: "sh -lc 'unsafe'",
                network: { egress: false, localBinding: false },
            }),
        ).toThrow();
    });
});
