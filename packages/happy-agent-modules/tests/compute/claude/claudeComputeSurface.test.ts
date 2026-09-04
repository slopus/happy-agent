import { Value } from "@sinclair/typebox/value";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-compute-claude-surface");

/** A Claude model, so the module hands this agent Claude's own tools. */
const CLAUDE_MODEL = "anthropic/opus-5";

/**
 * The argument names of each vendor descriptor in
 * `packages/happy-providers/sources/vendors/claude/tools/`, transcribed.
 *
 * The descriptors are not exported from the published package, so they are restated here rather
 * than imported across the package boundary. This is the guard that stops the schemas drifting
 * back toward one shared shape: a field renamed to match another vendor fails here.
 */
const VENDOR_ARGUMENTS: Readonly<
    Record<string, { readonly required: readonly string[]; readonly optional: readonly string[] }>
> = {
    Read: { required: ["file_path"], optional: ["offset", "limit"] },
    Write: { required: ["file_path", "content"], optional: [] },
    Edit: {
        required: ["file_path", "old_string", "new_string"],
        optional: ["replace_all"],
    },
    Glob: { required: ["pattern"], optional: ["path"] },
    Grep: {
        required: ["pattern"],
        optional: [
            "path",
            "glob",
            "output_mode",
            "-B",
            "-A",
            "-C",
            "context",
            "-n",
            "-i",
            "type",
            "head_limit",
            "offset",
            "multiline",
        ],
    },
    // Every Bash argument is the vendor's, plus Happy Agent's own terminal, elevation, and
    // host-owned secret-environment extensions.
    Bash: {
        required: ["command"],
        optional: [
            "timeout",
            "description",
            "run_in_background",
            "tty",
            "dangerouslyDisableSandbox",
            "secrets",
        ],
    },
    BashOutput: { required: ["bash_id"], optional: ["block", "timeout"] },
    BashInput: { required: ["bash_id", "input"], optional: ["timeout"] },
    BashStop: { required: ["bash_id"], optional: [] },
};

async function claudeTools() {
    const compute = new FakeCompute();
    return { compute, ...(await computeToolset(ctx, compute, { model: CLAUDE_MODEL })) };
}

describe("Claude compute surface", () => {
    it("offers exactly Claude's own tools, in Claude's own order", async () => {
        const { tools } = await claudeTools();

        expect(tools.map((tool) => tool.name)).toEqual([
            "BashOutput",
            "Bash",
            "Read",
            "Edit",
            "Write",
            "Glob",
            "Grep",
            "BashStop",
            "BashInput",
        ]);
    });

    it("gives every tool a description the model can act on", async () => {
        const { tools } = await claudeTools();

        for (const tool of tools) {
            expect(tool.description, tool.name).toBeTypeOf("string");
            expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(0);
        }
    });

    it("tells Claude that each Bash call starts from the primary working directory", async () => {
        const { tool } = await claudeTools();

        expect(tool("Bash").description).toContain(
            "Every Bash call starts in the primary working directory. A directory change affects only that call.",
        );
    });

    it("matches the vendor descriptors' argument names and required split", async () => {
        const { tool } = await claudeTools();

        for (const [name, expected] of Object.entries(VENDOR_ARGUMENTS)) {
            const parameters = tool(name).parameters as {
                properties: Record<string, unknown>;
                required?: readonly string[];
            };
            expect(Object.keys(parameters.properties).sort(), name).toEqual(
                [...expected.required, ...expected.optional].sort(),
            );
            expect([...(parameters.required ?? [])].sort(), name).toEqual(
                [...expected.required].sort(),
            );
        }
    });

    it("rejects arguments another vendor would have used", async () => {
        const { tool } = await claudeTools();

        // Codex and Grok escalate with `sandbox_permissions`; on Claude's surface that is simply
        // not an argument, and the schema is what says so.
        expect(
            Value.Check(tool("Bash").parameters!, {
                command: "ls",
                sandbox_permissions: "require_escalated",
            }),
        ).toBe(false);
        expect(Value.Check(tool("Bash").parameters!, { command: "ls", secrets: [] })).toBe(true);
        // Grok reads with `target_file`, Claude with `file_path`.
        expect(Value.Check(tool("Read").parameters!, { target_file: "a.ts" })).toBe(false);
        expect(Value.Check(tool("Read").parameters!, { file_path: "a.ts" })).toBe(true);
    });

    it("declares an Auto decision on every tool", async () => {
        const { tools } = await claudeTools();

        for (const tool of tools) {
            expect(tool.shouldReviewInAutoMode, tool.name).toBeTypeOf("function");
            // Review and elevation are separate decisions, and no compute tool escapes the local
            // sandbox by default.
            expect(tool.requiresAutoOrFullAccess, tool.name).toBeUndefined();
        }
    });

    it("describes the action wherever a review can happen", async () => {
        const { tool, tools } = await claudeTools();
        const reviewable = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "BashInput"];

        for (const candidate of tools) {
            if (reviewable.includes(candidate.name)) {
                expect(candidate.describeAutoPermissionAction, candidate.name).toBeTypeOf(
                    "function",
                );
            }
        }
        // Reading and stopping work Happy Agent itself started is never reviewed, so neither needs one.
        expect(tool("BashOutput").describeAutoPermissionAction).toBeUndefined();
        expect(tool("BashStop").describeAutoPermissionAction).toBeUndefined();
    });

    it("marks only the pure reads durable, and commits a recorded read with its result", async () => {
        const { tool } = await claudeTools();

        // Reading the same file, names, or contents again finds the same thing.
        expect(tool("Read").durable).toBe(true);
        expect(tool("Read").reloadable).toBe(true);
        expect(tool("Read").transactional).toBe(true);
        expect(tool("Glob").durable).toBe(true);
        expect(tool("Glob").reloadable).toBe(true);
        expect(tool("Grep").durable).toBe(true);
        expect(tool("Grep").reloadable).toBe(true);
        // Everything that changes the machine or consumes command output cannot simply be replayed.
        for (const name of ["Write", "Edit", "Bash", "BashOutput", "BashInput", "BashStop"]) {
            expect(tool(name).durable, name).toBe(false);
            expect(tool(name).reloadable, name).not.toBe(true);
        }
    });
});
