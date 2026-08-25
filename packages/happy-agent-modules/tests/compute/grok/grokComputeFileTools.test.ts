import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";
import { llmText } from "./support/llmText.js";

const ctx = createRootContext().named("happy-agent-modules-compute-grok-files");

/** A model ID that selects Grok's own surface. */
const GROK_MODEL = "xai/grok-4.5";

/** A machine holding a small project, and the tools a Grok model is handed over it. */
async function project() {
    const compute = new FakeCompute();
    compute.write("/workspace/readme.md", "# Project\n\nIt does a thing.\n");
    compute.write("/workspace/sources/main.ts", "export function main() {\n    return 1;\n}\n");
    compute.write("/workspace/sources/util.ts", "export const NAME = 'util';\n");
    return { compute, ...(await computeToolset(ctx, compute, { model: GROK_MODEL })) };
}

describe("Grok's compute file tools", () => {
    it("reads a file numbered the way Grok numbers it", async () => {
        const { tool } = await project();

        const read = await tool("read_file").execute(ctx, { target_file: "sources/main.ts" });

        expect(read.path).toBe("/workspace/sources/main.ts");
        expect(read.content).toBe("1→export function main() {\n2→    return 1;\n3→}\n4→");
        expect(read.start_line).toBe(1);
        expect(read.total_lines).toBe(4);
        expect(read.truncated).toBe(false);
    });

    it("pages a long file honestly", async () => {
        const { compute, tool } = await project();
        compute.write(
            "/workspace/long.txt",
            Array.from({ length: 40 }, (_value, index) => `line ${String(index + 1)}`).join("\n"),
        );

        const read = await tool("read_file").execute(ctx, {
            target_file: "long.txt",
            offset: 10,
            limit: 5,
        });

        expect(read.start_line).toBe(10);
        expect(read.returned_lines).toBe(5);
        expect(read.total_lines).toBe(40);
        expect(read.truncated).toBe(true);
        expect(read.content).toBe("10→line 10\n11→line 11\n12→line 12\n13→line 13\n14→line 14");
    });

    it("renders an empty file as an empty file rather than as nothing", async () => {
        const { compute, tool } = await project();
        compute.write("/workspace/empty.txt", "");

        const read = await tool("read_file").execute(ctx, { target_file: "empty.txt" });

        expect(tool("read_file").toLLM(read)).toEqual([{ type: "text", text: "(empty file)" }]);
    });

    it("creates a new file without a prior read, and lets the next edit through", async () => {
        const { compute, tool } = await project();

        const written = await tool("write").execute(ctx, {
            file_path: "sources/new.ts",
            content: "export const A = 1;\n",
        });

        expect(written).toEqual({
            path: "/workspace/sources/new.ts",
            created: true,
            characters: 20,
            presentation: {
                type: "file_diff",
                files: [
                    {
                        path: "/workspace/sources/new.ts",
                        kind: "add",
                        added: 1,
                        deleted: 0,
                        hunks: [
                            {
                                oldStart: 0,
                                newStart: 1,
                                lines: [{ kind: "add", text: "export const A = 1;" }],
                            },
                        ],
                    },
                ],
            },
        });
        // Writing counts as reading: the agent now knows exactly what the file holds.
        const edited = await tool("search_replace").execute(ctx, {
            file_path: "sources/new.ts",
            old_string: "A = 1",
            new_string: "A = 2",
        });

        expect(edited).toEqual({
            path: "/workspace/sources/new.ts",
            replacements: 1,
            presentation: {
                type: "file_diff",
                files: [
                    {
                        path: "/workspace/sources/new.ts",
                        kind: "update",
                        added: 1,
                        deleted: 1,
                        hunks: [
                            {
                                oldStart: 1,
                                newStart: 1,
                                lines: [
                                    { kind: "delete", text: "A = 1" },
                                    { kind: "add", text: "A = 2" },
                                ],
                            },
                        ],
                    },
                ],
            },
        });
        expect(compute.files.get("/workspace/sources/new.ts")?.content).toContain("A = 2");
    });

    it("overwrites a file without a prior read", async () => {
        const { compute, tool } = await project();

        const result = await tool("write").execute(ctx, {
            file_path: "readme.md",
            content: "gone\n",
        });

        expect(result.created).toBe(false);
        expect(compute.files.get("/workspace/readme.md")?.content).toBe("gone\n");
    });

    it("replaces matching text without a prior read", async () => {
        const { compute, tool } = await project();

        const result = await tool("search_replace").execute(ctx, {
            file_path: "sources/main.ts",
            old_string: "return 1;",
            new_string: "return 2;",
        });

        expect(result.replacements).toBe(1);
        expect(compute.files.get("/workspace/sources/main.ts")?.content).toContain("return 2;");
    });

    it("refuses to change a file that moved on after it was read", async () => {
        const { compute, tool } = await project();
        await tool("read_file").execute(ctx, { target_file: "sources/util.ts" });

        // Somebody else changed the file in the meantime.
        compute.write("/workspace/sources/util.ts", "export const NAME = 'other';\n");

        await expect(
            tool("search_replace").execute(ctx, {
                file_path: "sources/util.ts",
                old_string: "NAME",
                new_string: "TITLE",
            }),
        ).rejects.toThrow(/changed since it was last read/u);
    });

    it("insists that ambiguous text be made unique", async () => {
        const { compute, tool } = await project();
        compute.write("/workspace/twice.ts", "const a = 1;\nconst a = 1;\n");
        await tool("read_file").execute(ctx, { target_file: "twice.ts" });

        await expect(
            tool("search_replace").execute(ctx, {
                file_path: "twice.ts",
                old_string: "const a = 1;",
                new_string: "const b = 1;",
            }),
        ).rejects.toThrow(/appears 2 times/u);

        const edited = await tool("search_replace").execute(ctx, {
            file_path: "twice.ts",
            old_string: "const a = 1;",
            new_string: "const b = 1;",
            replace_all: true,
        });

        expect(edited.replacements).toBe(2);
    });

    it("lists a directory, marking what can be descended into", async () => {
        const { tool } = await project();

        const listing = await tool("list_dir").execute(ctx, { target_directory: "." });

        expect(listing.path).toBe("/workspace");
        expect(listing.entries).toEqual(["readme.md", "sources/"]);
        expect(listing.truncated).toBe(false);
    });

    it("searches file contents and says when the answer was capped", async () => {
        const { tool } = await project();

        const found = await tool("grep").execute(ctx, { pattern: "export", path: "sources" });

        expect(found.matched_files).toBe(2);
        expect(found.match_count).toBe(2);
        expect(found.text).toContain("/workspace/sources/main.ts:1: export function main() {");
        expect(found.truncated).toBe(false);

        const capped = await tool("grep").execute(ctx, {
            pattern: "export",
            path: "sources",
            head_limit: 1,
        });

        expect(capped.truncated).toBe(true);
        expect(llmText(tool("grep").toLLM(capped))).toContain("Capped.");
    });

    it("says plainly when nothing matched", async () => {
        const { tool } = await project();

        const found = await tool("grep").execute(ctx, { pattern: "nowhere-at-all" });

        expect(tool("grep").toLLM(found)).toEqual([{ type: "text", text: "No matches found" }]);
    });

    it("reviews a path that leaves the workspace, and lets workspace paths through", async () => {
        const { tool } = await project();

        await expect(
            tool("read_file").shouldReviewInAutoMode({ target_file: "sources/util.ts" }, ctx),
        ).resolves.toBe(false);
        await expect(
            tool("read_file").shouldReviewInAutoMode({ target_file: "/etc/hosts" }, ctx),
        ).resolves.toBe(true);
        await expect(
            tool("read_file").shouldRunInFullAccessInAutoMode!({ target_file: "/etc/hosts" }, ctx),
        ).resolves.toBe(true);
        await expect(
            tool("write").shouldReviewInAutoMode({ file_path: "/etc/hosts", content: "" }, ctx),
        ).resolves.toBe(true);
        await expect(
            tool("list_dir").shouldReviewInAutoMode({ target_directory: "sources" }, ctx),
        ).resolves.toBe(false);
        await expect(tool("grep").shouldReviewInAutoMode({ pattern: "x" }, ctx)).resolves.toBe(
            false,
        );
    });

    it("tells a reviewer exactly which path and which boundary", async () => {
        const { tool } = await project();

        expect(
            tool("write").describeAutoPermissionAction!(
                { file_path: "/etc/hosts", content: "" },
                ctx,
            ),
        ).toBe(
            'writing "/etc/hosts". Access: unrestricted filesystem access outside the workspace sandbox',
        );
        expect(
            tool("read_file").describeAutoPermissionAction!({ target_file: "readme.md" }, ctx),
        ).toContain('reading "/workspace/readme.md"');
    });

    it("is durable only where reading twice reads the same thing", async () => {
        const { tool } = await project();

        expect(tool("read_file").durable).toBe(true);
        expect(tool("read_file").reloadable).toBe(true);
        expect(tool("read_file").transactional).toBe(true);
        expect(tool("list_dir").durable).toBe(true);
        expect(tool("list_dir").reloadable).toBe(true);
        expect(tool("grep").durable).toBe(true);
        expect(tool("grep").reloadable).toBe(true);
        expect(tool("write").durable).toBe(false);
        expect(tool("write").reloadable).not.toBe(true);
        expect(tool("search_replace").durable).toBe(false);
        expect(tool("search_replace").reloadable).not.toBe(true);
    });
});
