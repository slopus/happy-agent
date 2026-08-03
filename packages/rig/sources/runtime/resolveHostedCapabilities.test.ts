import { describe, expect, it } from "vitest";

import { resolveHostedCapabilities } from "./resolveHostedCapabilities.js";
import type { ConfigGrokProvider } from "../config/types.js";

const grok = (hostedSearch?: ConfigGrokProvider["hostedSearch"]): ConfigGrokProvider => ({
    enabled: true,
    type: "grok",
    ...(hostedSearch === undefined ? {} : { hostedSearch }),
});

describe("resolveHostedCapabilities", () => {
    it("gives a root agent nothing by default", () => {
        expect(
            resolveHostedCapabilities({
                isSubagent: false,
                permissionMode: "full_access",
                providerConfig: grok(),
            }),
        ).toEqual([]);
    });

    it("gives a root agent what configuration turned on", () => {
        expect(
            resolveHostedCapabilities({
                isSubagent: false,
                permissionMode: "auto",
                providerConfig: grok(["x_search"]),
            }),
        ).toEqual(["x_search"]);
    });

    it("withholds a configured capability from a mode that cannot reach outside the sandbox", () => {
        for (const permissionMode of ["read_only", "workspace_write"] as const) {
            expect(
                resolveHostedCapabilities({
                    isSubagent: false,
                    permissionMode,
                    providerConfig: grok(["x_search"]),
                }),
            ).toEqual([]);
        }
    });

    it("ignores configuration for a non-Grok root agent", () => {
        expect(
            resolveHostedCapabilities({
                isSubagent: false,
                permissionMode: "auto",
                providerConfig: { enabled: true, type: "claude" },
            }),
        ).toEqual([]);
    });

    it("gives a subagent exactly what its spawn granted", () => {
        expect(
            resolveHostedCapabilities({
                granted: ["x_search"],
                isSubagent: true,
                permissionMode: "auto",
                providerConfig: grok(),
            }),
        ).toEqual(["x_search"]);
    });

    it("does not let configuration widen a subagent past its grant", () => {
        expect(
            resolveHostedCapabilities({
                isSubagent: true,
                permissionMode: "full_access",
                providerConfig: grok(["web_search", "x_search"]),
            }),
        ).toEqual([]);
    });
});
