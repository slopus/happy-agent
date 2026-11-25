import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { computeToolVendor } from "../../../sources/compute/ComputeToolVendor.js";
import { computeInstructionsForVendor } from "../../../sources/compute/impl/computeInstructionsForVendor.js";
import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("antigravity-compute-tools");

describe("Antigravity's Claude-shaped tool array", () => {
    it("hands an Antigravity model Happy's shell and file tools, unlike other foreign harnesses", async () => {
        expect(
            computeToolVendor({ model: "antigravity/gemini-4-carbon", providerKind: "foreign" }),
        ).toBe("antigravity");
        expect(computeToolVendor({ model: "claude-code/opus", providerKind: "claude" })).toBe(
            "foreign",
        );
        const compute = new FakeCompute();
        const { tools, tool } = await computeToolset(ctx, compute, {
            model: "antigravity/gemini-4-carbon",
        });
        const shell = process.platform === "win32" ? "PowerShell" : "Bash";
        expect(tools.map((candidate) => candidate.name)).toEqual([
            shell,
            `${shell}Output`,
            `${shell}Input`,
            `${shell}Stop`,
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep",
        ]);
        expect(Object.keys(tool(shell).parameters?.properties ?? {})).toContain(
            "dangerouslyDisableSandbox",
        );
        expect(computeInstructionsForVendor("antigravity", compute)).toContain(`${shell}Output`);
    });
});
