import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";
import { computeToolVendor } from "../../../sources/compute/ComputeToolVendor.js";
import { computeInstructionsForVendor } from "../../../sources/compute/impl/computeInstructionsForVendor.js";
import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("glm-compute-tools");
describe("GLM's explicit Claude-shaped text tool array", () => {
    it("selects GLM by model family and exposes Claude argument names", async () => {
        expect(computeToolVendor({ model: "zai/glm-5.3", providerKind: "bedrock" })).toBe("glm");
        const compute = new FakeCompute();
        const { tools, tool } = await computeToolset(ctx, compute, {
            model: "zai/glm-5.3",
            providerKind: "bedrock",
        });
        const shell = process.platform === "win32" ? "PowerShell" : "Bash";
        expect(tools.map((tool) => tool.name)).toEqual([
            `${shell}Output`,
            shell,
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            `${shell}Stop`,
            `${shell}Input`,
        ]);
        expect(tool("Read").parameters?.required).toEqual(["file_path"]);
        expect(computeInstructionsForVendor("glm", compute)).toContain("accepts text only");
    });

    it("returns text for images before reading bytes and still reads and edits text", async () => {
        const compute = new FakeCompute();
        const { tool } = await computeToolset(ctx, compute, { model: "zai/glm-5.3" });
        const imageBytes = vi.spyOn(compute.fs, "readFileBuffer");
        const image = await tool("Read").execute(ctx, { file_path: "/workspace/a.png" });
        expect(image.outcome).toBe("unsupported");
        expect(
            tool("Read")
                .toLLM(image)
                .every((block) => block.type === "text"),
        ).toBe(true);
        expect(imageBytes).not.toHaveBeenCalled();
        compute.write("/workspace/a.txt", "hello");
        const text = await tool("Read").execute(ctx, { file_path: "/workspace/a.txt" });
        expect(text.content).toBe("1\thello");
        await tool("Edit").execute(ctx, {
            file_path: "/workspace/a.txt",
            old_string: "hello",
            new_string: "world",
        });
        expect(compute.files.get("/workspace/a.txt")?.content).toBe("world");
    });
});
