import { describe, expect, it } from "vitest";

import {
    allowEverything,
    assertComputePermissions,
    computePermissions,
    type ComputePermissions,
} from "../sources/index.js";

const CONTRADICTION = /Full access cannot be combined with a restriction/u;

describe("allowEverything", () => {
    it("removes every restriction", () => {
        expect(allowEverything()).toEqual({
            mode: "full_access",
            network: { egress: true, localBinding: true },
        });
    });

    it("is a permission the boundary accepts", () => {
        expect(() => assertComputePermissions(allowEverything())).not.toThrow();
    });
});

describe("full access cannot be narrowed", () => {
    // Each of these is a caller who believes they restricted something. Silently ignoring any of
    // them would leave the caller confident in a boundary that was never applied.
    const contradictions: [string, Partial<Omit<ComputePermissions, "mode">>][] = [
        ["a denied read path", { deniedReadPaths: ["/etc/shadow"] }],
        ["a denied write path", { deniedWritePaths: ["/workspace/.git"] }],
        [
            "a host allow list",
            { network: { egress: true, allowedHosts: ["example.com"], localBinding: true } },
        ],
        [
            "a host deny list",
            {
                network: {
                    egress: true,
                    allowedHosts: ["*.example.com"],
                    deniedHosts: ["uploads.example.com"],
                    localBinding: true,
                },
            },
        ],
        ["withheld egress", { network: { egress: false, localBinding: true } }],
        ["withheld local binding", { network: { egress: true, localBinding: false } }],
    ];

    for (const [description, overrides] of contradictions) {
        it(`refuses full access with ${description}`, () => {
            expect(() => computePermissions("full_access", overrides)).toThrow(CONTRADICTION);
        });
    }

    it("names every offending field so the caller can see the whole conflict", () => {
        expect(() =>
            computePermissions("full_access", {
                deniedReadPaths: ["/secrets"],
                deniedWritePaths: ["/workspace/.git"],
                network: { egress: false, localBinding: false },
            }),
        ).toThrow(
            /deniedReadPaths, deniedWritePaths, network\.egress: false, network\.localBinding: false/u,
        );
    });

    it("points the caller at the mode that can express what they wanted", () => {
        expect(() => computePermissions("full_access", { deniedReadPaths: ["/secrets"] })).toThrow(
            /use auto or workspace_write/u,
        );
    });

    it("still allows grants, which widen rather than narrow", () => {
        expect(() =>
            computePermissions("full_access", {
                allowedReadPaths: ["/opt/skills"],
                allowedWritePaths: ["/var/cache"],
            }),
        ).not.toThrow();
    });

    it("accepts an empty denial list, which restricts nothing", () => {
        expect(() =>
            computePermissions("full_access", { deniedReadPaths: [], deniedWritePaths: [] }),
        ).not.toThrow();
    });
});

describe("restricted modes carry restrictions freely", () => {
    for (const mode of ["read_only", "workspace_write", "auto"] as const) {
        it(`allows ${mode} to deny and grant at once`, () => {
            const permissions = computePermissions(mode, {
                allowedReadPaths: ["/opt/skills"],
                deniedReadPaths: ["/secrets"],
                allowedWritePaths: ["/var/cache"],
                deniedWritePaths: ["/workspace/.git"],
                network: { egress: true, allowedHosts: ["example.com"], localBinding: false },
            });
            expect(() => assertComputePermissions(permissions)).not.toThrow();
        });
    }

    it("refuses denied hosts or allowed ports without a host list to narrow", () => {
        for (const network of [
            { egress: true, deniedHosts: ["uploads.example.com"], localBinding: false },
            { egress: true, allowedHosts: [], allowedPorts: [443], localBinding: false },
        ]) {
            expect(() => computePermissions("auto", { network })).toThrow(
                /need a non-empty allowedHosts/u,
            );
        }
        expect(() =>
            computePermissions("auto", {
                network: {
                    egress: true,
                    allowedHosts: ["*.example.com"],
                    deniedHosts: ["uploads.example.com"],
                    allowedPorts: [443],
                    localBinding: false,
                },
            }),
        ).not.toThrow();
    });

    it("gives a mode its own network defaults when the caller says nothing", () => {
        expect(computePermissions("workspace_write").network).toEqual({
            egress: false,
            localBinding: false,
        });
        expect(computePermissions("full_access").network).toEqual({
            egress: true,
            localBinding: true,
        });
    });
});
