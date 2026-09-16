import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
    computeServicePathSchema,
    computeServiceStartSchema,
    type ComputeServiceStartOptions,
} from "../sources/ComputeServices.js";
import { allowEverything, computePermissions } from "../sources/ComputePermissions.js";
import { resolveServiceOutbound } from "../sources/services/resolveServiceOutbound.js";

function options(): ComputeServiceStartOptions {
    return {
        execution: {
            id: "s123456789012345678901234",
            directory: "/private/services/s123456789012345678901234",
        },
        command: "node server.js",
        cwd: ".",
        port: 4187,
        tty: false,
        permissions: allowEverything(),
        sandbox: {
            inputs: ["server.js"],
            scratch: [],
            outbound: [{ hostname: "example.com", port: 443 }],
            limits: { memoryMiB: 128, processes: 8 },
        },
        networkPolicy: { allowedDomains: [{ domain: "example.com", ports: [443] }] },
    };
}

describe("service boundary data", () => {
    it.each(["a", "src/server.js", "node_modules", "src/with\nnewline.js"])(
        "accepts a normalized relative path %j",
        (path) => {
            expect(Value.Check(computeServicePathSchema, path)).toBe(true);
        },
    );
    it.each([
        "",
        ".",
        "..",
        "/etc",
        "C:/private",
        "a/../b",
        "a/./b",
        "a//b",
        "a/",
        "a\\b",
        "a\0b",
        "a\n/../private",
        "a/..\n/../private",
    ])("refuses ambiguous or escaping path %j", (path) => {
        expect(Value.Check(computeServicePathSchema, path)).toBe(false);
    });
    it("validates the complete start value and refuses wider resource limits", () => {
        const start = options();
        expect(Value.Check(computeServiceStartSchema, start)).toBe(true);
        start.sandbox.limits.memoryMiB = 1025;
        expect(Value.Check(computeServiceStartSchema, start)).toBe(false);
        start.sandbox.limits.memoryMiB = 128;
        start.sandbox.limits.processes = 65;
        expect(Value.Check(computeServiceStartSchema, start)).toBe(false);
    });
});

describe("service outbound policy", () => {
    it("requires a user grant even in Full access", () => {
        const start = options();
        delete start.networkPolicy;
        expect(() => resolveServiceOutbound(start)).toThrow(/user's network policy/u);
    });
    it("retains the action's egress boundary", () => {
        const start = options();
        start.permissions = computePermissions("auto");
        expect(() => resolveServiceOutbound(start)).toThrow(/does not permit outbound/u);
    });
    it("permits an exact granted destination", () => {
        expect(resolveServiceOutbound(options())).toEqual([{ hostname: "example.com", port: 443 }]);
    });
    it("does not widen a grant to other ports", () => {
        const start = options();
        start.sandbox.outbound[0]!.port = 8443;
        expect(() => resolveServiceOutbound(start)).toThrow(/policy/u);
    });
    it("keeps denials above allowances", () => {
        const start = options();
        start.networkPolicy = {
            ...start.networkPolicy,
            deniedDomains: [{ domain: "example.com" }],
        };
        expect(() => resolveServiceOutbound(start)).toThrow(/policy/u);
    });
    it("does not treat a bare wildcard as permission to reach everything", () => {
        const start = options();
        start.networkPolicy = { allowedDomains: [{ domain: "*" }] };
        expect(() => resolveServiceOutbound(start)).toThrow(/policy/u);
    });
    it("matches configured subdomains without including their apex", () => {
        const start = options();
        start.networkPolicy = { allowedDomains: [{ domain: "*.example.com", ports: [443] }] };
        expect(() => resolveServiceOutbound(start)).toThrow(/policy/u);
        start.sandbox.outbound[0]!.hostname = "api.example.com";
        expect(resolveServiceOutbound(start)).toEqual([{ hostname: "api.example.com", port: 443 }]);
    });
    it("does not widen an action-scoped hostname restriction", () => {
        const start = options();
        start.permissions = computePermissions("auto", {
            network: { egress: true, localBinding: false, allowedHosts: ["other.example.com"] },
        });
        expect(() => resolveServiceOutbound(start)).toThrow(/policy/u);
    });
    it("normalizes and deduplicates exact grants", () => {
        const start = options();
        start.sandbox.outbound.push({ hostname: "EXAMPLE.COM.", port: 443 });
        expect(resolveServiceOutbound(start)).toEqual([{ hostname: "example.com", port: 443 }]);
    });
});
