import { describe, expect, it } from "vitest";

import { createClaudeWebSearchTool } from "../agent/tools/claude/WebSearch.js";
import { createGeminiSearchTool } from "../tools/webSearch/createGeminiSearchTool.js";
import { permissionModeAllowsProviderRunSearch } from "./resolveHostedCapabilities.js";
import { permissionModeAllowsWebSearch, networkToolPermission } from "./networkToolPermission.js";

/**
 * Rig can search four ways and they reach the same place. The rule is stated once; where it is
 * enforced differs, because a tool Rig executes can still be declined when it is called and a
 * search the provider runs cannot be declined at all once the request is sent.
 */
describe("the rule every search answers to", () => {
    it("allows only the modes that already reach outside the workspace", () => {
        expect(permissionModeAllowsWebSearch("auto")).toBe(true);
        expect(permissionModeAllowsWebSearch("full_access")).toBe(true);
        expect(permissionModeAllowsWebSearch("workspace_write")).toBe(false);
        expect(permissionModeAllowsWebSearch("read_only")).toBe(false);
    });

    // A caller with no permission model has established no authority to search, rather than
    // unrestricted authority.
    it("refuses when no permission mode was established", () => {
        expect(permissionModeAllowsWebSearch(undefined)).toBe(false);
    });

    // Two enforcement points, and they cannot answer differently.
    it("gives the hosted gate the same answer as the tools", () => {
        for (const mode of ["auto", "full_access", "workspace_write", "read_only"] as const) {
            expect(permissionModeAllowsProviderRunSearch(mode)).toBe(
                permissionModeAllowsWebSearch(mode),
            );
        }
        expect(permissionModeAllowsProviderRunSearch(undefined)).toBe(
            permissionModeAllowsWebSearch(undefined),
        );
    });

    // Restating the rule per tool is how two of them end up disagreeing, so neither restates it.
    it("is the rule both client search tools declare", () => {
        for (const tool of [createClaudeWebSearchTool(), createGeminiSearchTool("test-key")]) {
            expect(tool.requiresAutoOrFullAccess).toBe(
                networkToolPermission.requiresAutoOrFullAccess,
            );
            expect(tool.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(true);
        }
    });
});
