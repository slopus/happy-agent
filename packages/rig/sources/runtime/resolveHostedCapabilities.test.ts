import { describe, expect, it } from "vitest";

import { isHostedCapability } from "@slopus/rig-execution";
import { codex_hosted_tools, grok_hosted_tools } from "@slopus/rig-providers";
import {
    hostedSearchesFor,
    permissionModeAllowsProviderRunSearch,
} from "./resolveHostedCapabilities.js";

/**
 * What a provider's backend can run is a fact about the backend. It is not a preference, not a
 * grant, and not configurable: which searches Rig declares on a request is the same kind of
 * decision as which tools it sends.
 */
describe("hostedSearchesFor", () => {
    it("gives Grok both of the searches its backend runs", () => {
        expect(hostedSearchesFor("grok")).toEqual(["web_search", "x_search"]);
    });

    // OpenAI has no X search, so asking Grok's question of Codex must not invent one.
    it("gives Codex only the web search OpenAI runs", () => {
        expect(hostedSearchesFor("codex")).toEqual(["web_search"]);
    });

    it("gives nothing to a provider whose backend runs no search", () => {
        expect(hostedSearchesFor("claude")).toEqual([]);
        expect(hostedSearchesFor("bedrock")).toEqual([]);
        expect(hostedSearchesFor(undefined)).toEqual([]);
    });
});

describe("permissionModeAllowsProviderRunSearch", () => {
    it("allows the modes that may reach outside the sandbox", () => {
        expect(permissionModeAllowsProviderRunSearch("auto")).toBe(true);
        expect(permissionModeAllowsProviderRunSearch("full_access")).toBe(true);
    });

    // A search runs on someone else's machine, so a session that may not reach the network itself
    // must not reach it by asking a provider to.
    it("refuses the modes that may not", () => {
        expect(permissionModeAllowsProviderRunSearch("read_only")).toBe(false);
        expect(permissionModeAllowsProviderRunSearch("workspace_write")).toBe(false);
    });

    // Absent is not permissive: an unanswered question means nobody said yes.
    it("refuses when no permission mode was established", () => {
        expect(permissionModeAllowsProviderRunSearch(undefined)).toBe(false);
    });
});

/**
 * A capability names what may be searched and a request carries tools, and the only thing joining
 * them is that every hosted tool is named after the capability it satisfies. That convention is
 * load-bearing: nothing throws when it is broken, the filter simply matches nothing, and a
 * provider that may search is told about no search at all. So it is checked rather than remembered.
 */
describe("hosted tool names", () => {
    it("names every hosted tool after the capability it satisfies", () => {
        for (const tool of [...grok_hosted_tools, ...codex_hosted_tools]) {
            expect({ name: tool.name, isCapability: isHostedCapability(tool.name) }).toEqual({
                name: tool.name,
                isCapability: true,
            });
            // Only a tool the provider runs belongs here; a tool Rig executes is permitted where it
            // is called, not where the request is built.
            expect(tool.type).toBe("cloud");
        }
    });
});
