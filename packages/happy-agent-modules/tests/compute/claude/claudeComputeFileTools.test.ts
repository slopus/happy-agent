import { createRootContext } from "@steve.kite/stdlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

/** A Claude model, so the module hands this agent Claude's own tools. */
const CLAUDE_MODEL = "anthropic/opus-5";

const ctx = createRootContext().named("happy-agent-modules-claude-compute-files");

/** A machine with a few files on it, and Claude's tools over it. */
async function machine() {
    const compute = new FakeCompute();
    return { compute, ...(await computeToolset(ctx, compute, { model: CLAUDE_MODEL })) };
}

/** A real PNG of the given size, like a screenshot. */
async function png(width: number, height: number): Promise<Buffer> {
    return await sharp({
        create: { width, height, channels: 3, background: { r: 208, g: 208, b: 208 } },
    })
        .png()
        .toBuffer();
}

/** The text the model would actually see for one result. */
function modelText(tool: { toLLM: (result: any) => readonly any[] }, result: unknown): string {
    return tool
        .toLLM(result)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

describe("Claude's Read", () => {
    it("numbers the lines it returns", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/app.ts", "const a = 1;\nconst b = 2;");

        const result = await tool("Read").execute(ctx, { file_path: "/workspace/app.ts" }, call);

        expect(result.outcome).toBe("text");
        expect(result.content).toBe("1\tconst a = 1;\n2\tconst b = 2;");
        expect(result.total_lines).toBe(2);
        expect(result.truncated).toBe(false);
    });

    it("returns an empty file as `(empty file)`", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/blank.txt", "");

        const result = await tool("Read").execute(ctx, { file_path: "/workspace/blank.txt" }, call);

        expect(result.returned_lines).toBe(0);
        expect(modelText(tool("Read"), result)).toBe("(empty file)");
    });

    it("says a page was cut short and how to read on", async () => {
        const { compute, tool, call } = await machine();
        compute.write(
            "/workspace/long.txt",
            Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"),
        );

        const result = await tool("Read").execute(
            ctx,
            { file_path: "/workspace/long.txt", offset: 1, limit: 10 },
            call,
        );

        expect(result.returned_lines).toBe(10);
        expect(result.truncated).toBe(true);
        expect(modelText(tool("Read"), result)).toContain(
            "[Showing lines 1 to 10 of 40. Read on with offset.]",
        );
    });

    it("shows a PNG as an image rather than as text", async () => {
        const { compute, tool, call } = await machine();
        const shot = await png(1280, 800);
        compute.writeBuffer("/workspace/shot.png", shot);

        const result = await tool("Read").execute(ctx, { file_path: "/workspace/shot.png" }, call);

        expect(result.outcome).toBe("image");
        expect(result.image.mime_type).toBe("image/png");
        expect(result.image.resized).toBeUndefined();
        expect(Buffer.from(result.image.data, "base64").equals(shot)).toBe(true);
        expect(tool("Read").toLLM(result)).toEqual([
            { type: "text", text: "Image: /workspace/shot.png" },
            { type: "image", data: result.image.data, mimeType: "image/png" },
        ]);
    });

    it("scales a screenshot larger than 2000 pixels down to fit, and says so", async () => {
        const { compute, tool, call } = await machine();
        compute.writeBuffer("/workspace/retina.png", await png(2400, 1350));

        const result = await tool("Read").execute(
            ctx,
            { file_path: "/workspace/retina.png" },
            call,
        );

        expect(result.outcome).toBe("image");
        expect(result.image.resized).toEqual({
            original_width: 2400,
            original_height: 1350,
            width: 2000,
            height: 1125,
        });
        const shown = await sharp(Buffer.from(result.image.data, "base64")).metadata();
        expect({ format: shown.format, width: shown.width, height: shown.height }).toEqual({
            format: "png",
            width: 2000,
            height: 1125,
        });
        expect(result.image.bytes).toBe(Buffer.from(result.image.data, "base64").byteLength);
        expect(modelText(tool("Read"), result)).toBe(
            "Image: /workspace/retina.png (original 2400×1350, shown at 2000×1125)",
        );
    });

    it("bounds the longer side of a tall image too", async () => {
        const { compute, tool, call } = await machine();
        compute.writeBuffer("/workspace/page.png", await png(1000, 5000));

        const result = await tool("Read").execute(ctx, { file_path: "/workspace/page.png" }, call);

        expect(result.outcome).toBe("image");
        expect(result.image.resized).toMatchObject({ width: 400, height: 2000 });
    });

    it("refuses a file that is not really an image instead of sending it to the model", async () => {
        const { compute, tool, call } = await machine();
        compute.writeBuffer("/workspace/fake.png", new Uint8Array([1, 2, 3, 4]));

        await expect(
            tool("Read").execute(ctx, { file_path: "/workspace/fake.png" }, call),
        ).rejects.toThrow("Image /workspace/fake.png cannot be shown.");
    });

    it("explains a notebook and a PDF instead of failing on them", async () => {
        const { tool, call } = await machine();

        const notebook = await tool("Read").execute(
            ctx,
            { file_path: "/workspace/analysis.ipynb" },
            call,
        );
        const pdf = await tool("Read").execute(ctx, { file_path: "/workspace/spec.pdf" }, call);

        expect(notebook.outcome).toBe("unsupported");
        expect(modelText(tool("Read"), notebook)).toContain("Jupyter notebooks are not supported");
        expect(pdf.outcome).toBe("unsupported");
        expect(modelText(tool("Read"), pdf)).toContain("PDF rendering is not supported");
    });

    it("reviews a path outside the workspace, and leaves one inside it alone", async () => {
        const { compute, tool } = await machine();
        compute.write("/workspace/app.ts", "const a = 1;");
        const read = tool("Read");

        expect(await read.shouldReviewInAutoMode({ file_path: "/workspace/app.ts" }, ctx)).toBe(
            false,
        );
        expect(
            await read.shouldRunInFullAccessInAutoMode?.({ file_path: "/workspace/app.ts" }, ctx),
        ).toBe(false);
        expect(await read.shouldReviewInAutoMode({ file_path: "/etc/hosts" }, ctx)).toBe(true);
        expect(await read.shouldRunInFullAccessInAutoMode?.({ file_path: "/etc/hosts" }, ctx)).toBe(
            true,
        );
        expect(read.describeAutoPermissionAction?.({ file_path: "/etc/hosts" }, ctx)).toContain(
            "outside the workspace sandbox",
        );
    });
});

describe("Claude's Write and Edit", () => {
    it("overwrites a file without a prior read", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/app.ts", "const a = 1;\nconst b = 2;\n");

        const result = await tool("Write").execute(
            ctx,
            { file_path: "/workspace/app.ts", content: "const a = 2;\n" },
            call,
        );

        expect(result.created).toBe(false);
        expect(compute.files.get("/workspace/app.ts")?.content).toBe("const a = 2;\n");
        expect(result.presentation).toEqual({
            type: "file_diff",
            files: [
                {
                    path: "/workspace/app.ts",
                    kind: "update",
                    added: 1,
                    deleted: 2,
                    hunks: [
                        {
                            oldStart: 1,
                            newStart: 1,
                            lines: [
                                { kind: "delete", text: "const a = 1;" },
                                { kind: "delete", text: "const b = 2;" },
                                { kind: "add", text: "const a = 2;" },
                            ],
                        },
                    ],
                },
            ],
        });
    });

    it("edits a file without a prior read when the exact text matches", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/app.ts", "first\nconst a = 1;\nlast\n");

        const result = await tool("Edit").execute(
            ctx,
            {
                file_path: "/workspace/app.ts",
                old_string: "const a = 1;",
                new_string: "const a = 2;\nconst b = 3;",
            },
            call,
        );

        expect(result.replacements).toBe(1);
        expect(compute.files.get("/workspace/app.ts")?.content).toBe(
            "first\nconst a = 2;\nconst b = 3;\nlast\n",
        );
        expect(result.presentation).toEqual({
            type: "file_diff",
            files: [
                {
                    path: "/workspace/app.ts",
                    kind: "update",
                    added: 2,
                    deleted: 1,
                    hunks: [
                        {
                            oldStart: 2,
                            newStart: 2,
                            lines: [
                                { kind: "delete", text: "const a = 1;" },
                                { kind: "add", text: "const a = 2;" },
                                { kind: "add", text: "const b = 3;" },
                            ],
                        },
                    ],
                },
            ],
        });
    });

    it("keeps exact totals when a replace-all diff exceeds the presentation line budget", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/large.txt", Array.from({ length: 600 }, () => "old").join("\n"));

        const result = await tool("Edit").execute(
            ctx,
            {
                file_path: "/workspace/large.txt",
                old_string: "old",
                new_string: "new",
                replace_all: true,
            },
            call,
        );

        const [diff] = result.presentation.files;
        expect(diff).toMatchObject({ added: 600, deleted: 600, omittedLines: 700 });
        expect(diff.hunks.flatMap((hunk: { lines: unknown[] }) => hunk.lines)).toHaveLength(500);
    });

    it("creates a new file without any prior read", async () => {
        const { compute, tool, call } = await machine();

        const result = await tool("Write").execute(
            ctx,
            { file_path: "/workspace/new.ts", content: "export const x = 1;" },
            call,
        );

        expect(result.created).toBe(true);
        expect(compute.files.get("/workspace/new.ts")?.content).toBe("export const x = 1;");
        expect(result.presentation).toEqual({
            type: "file_diff",
            files: [
                {
                    path: "/workspace/new.ts",
                    kind: "add",
                    added: 1,
                    deleted: 0,
                    hunks: [
                        {
                            oldStart: 0,
                            newStart: 1,
                            lines: [{ kind: "add", text: "export const x = 1;" }],
                        },
                    ],
                },
            ],
        });
        expect(modelText(tool("Write"), result)).toBe(
            "File created successfully at: /workspace/new.ts",
        );
    });

    it("lets a written file be edited straight away, because writing is knowing", async () => {
        const { tool, call } = await machine();
        await tool("Write").execute(
            ctx,
            { file_path: "/workspace/new.ts", content: "export const x = 1;" },
            call,
        );

        const edited = await tool("Edit").execute(
            ctx,
            { file_path: "/workspace/new.ts", old_string: "1", new_string: "2" },
            call,
        );

        expect(edited.replacements).toBe(1);
        expect(modelText(tool("Edit"), edited)).toBe(
            "The file /workspace/new.ts has been updated.",
        );
    });

    it("refuses an edit to a file that changed after it was read when its text no longer applies", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/app.ts", "const a = 1;");
        await tool("Read").execute(ctx, { file_path: "/workspace/app.ts" }, call);
        // Somebody else got there first.
        compute.write("/workspace/app.ts", "const a = 99;");

        await expect(
            tool("Edit").execute(
                ctx,
                { file_path: "/workspace/app.ts", old_string: "= 1;", new_string: "= 3;" },
                call,
            ),
        ).rejects.toThrow(/changed since it was last read/);
        expect(compute.files.get("/workspace/app.ts")?.content).toBe("const a = 99;");
    });

    it("applies an edit whose text still matches a file changed after it was read, and says so", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/app.ts", "const a = 1;\nconst b = 2;");
        await tool("Read").execute(ctx, { file_path: "/workspace/app.ts" }, call);
        // The model's own shell command, for example, changed another line.
        compute.write("/workspace/app.ts", "const a = 1;\nconst b = 20;");

        const edited = await tool("Edit").execute(
            ctx,
            {
                file_path: "/workspace/app.ts",
                old_string: "const a = 1;",
                new_string: "const a = 3;",
            },
            call,
        );

        expect(compute.files.get("/workspace/app.ts")?.content).toBe("const a = 3;\nconst b = 20;");
        expect(edited.staleRecovered).toBe(true);
        expect(modelText(tool("Edit"), edited)).toContain(
            "the file had been modified on disk since you last read it",
        );
    });

    it("applies every edit in one batch to the same file, as if made one after another", async () => {
        const { compute, tool, call } = await machine();
        const lines = Array.from({ length: 6 }, (_, i) => `const v${i} = ${i};`);
        compute.write("/workspace/app.ts", lines.join("\n"));
        await tool("Read").execute(ctx, { file_path: "/workspace/app.ts" }, call);

        const results = await Promise.allSettled(
            lines.map((line, i) =>
                tool("Edit").execute(
                    ctx,
                    {
                        file_path: "/workspace/app.ts",
                        old_string: line,
                        new_string: `const v${i} = ${i + 100};`,
                    },
                    call,
                ),
            ),
        );

        expect(results.map((result) => result.status)).toEqual(lines.map(() => "fulfilled"));
        expect(compute.files.get("/workspace/app.ts")?.content).toBe(
            lines.map((_, i) => `const v${i} = ${i + 100};`).join("\n"),
        );
        for (const result of results) {
            expect(result.status === "fulfilled" && result.value.staleRecovered).toBeUndefined();
        }
    });

    it("applies a Write and the Edits after it to one file in a single batch", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/app.ts", "old");
        await tool("Read").execute(ctx, { file_path: "/workspace/app.ts" }, call);

        const results = await Promise.allSettled([
            tool("Write").execute(
                ctx,
                { file_path: "/workspace/app.ts", content: "const a = 1;\nconst b = 2;" },
                call,
            ),
            tool("Edit").execute(
                ctx,
                { file_path: "/workspace/app.ts", old_string: "a = 1", new_string: "a = 10" },
                call,
            ),
            tool("Edit").execute(
                ctx,
                { file_path: "/workspace/app.ts", old_string: "b = 2", new_string: "b = 20" },
                call,
            ),
        ]);

        expect(results.map((result) => result.status)).toEqual([
            "fulfilled",
            "fulfilled",
            "fulfilled",
        ]);
        expect(compute.files.get("/workspace/app.ts")?.content).toBe(
            "const a = 10;\nconst b = 20;",
        );
    });

    it("creates and then edits several files in a single batch", async () => {
        const { compute, tool, call } = await machine();

        const results = await Promise.allSettled([
            tool("Write").execute(ctx, { file_path: "/workspace/a.ts", content: "a = 1;" }, call),
            tool("Write").execute(ctx, { file_path: "/workspace/b.ts", content: "b = 1;" }, call),
            tool("Edit").execute(
                ctx,
                { file_path: "/workspace/a.ts", old_string: "a = 1", new_string: "a = 2" },
                call,
            ),
            tool("Edit").execute(
                ctx,
                { file_path: "/workspace/b.ts", old_string: "b = 1", new_string: "b = 2" },
                call,
            ),
        ]);

        expect(results.map((result) => result.status)).toEqual(results.map(() => "fulfilled"));
        expect(compute.files.get("/workspace/a.ts")?.content).toBe("a = 2;");
        expect(compute.files.get("/workspace/b.ts")?.content).toBe("b = 2;");
    });

    it("lets an Edit follow the agent's own Write without reading the file again", async () => {
        const { compute, tool, call } = await machine();
        await tool("Write").execute(
            ctx,
            { file_path: "/workspace/app.ts", content: "x = 1;" },
            call,
        );
        await tool("Edit").execute(
            ctx,
            { file_path: "/workspace/app.ts", old_string: "x = 1", new_string: "x = 2" },
            call,
        );

        const second = await tool("Edit").execute(
            ctx,
            { file_path: "/workspace/app.ts", old_string: "x = 2", new_string: "x = 3" },
            call,
        );

        expect(second.staleRecovered).toBeUndefined();
        expect(compute.files.get("/workspace/app.ts")?.content).toBe("x = 3;");
    });

    it("keeps both agents' edits when a parent and its child change one file at once", async () => {
        const compute = new FakeCompute();
        const parent = await computeToolset(ctx, compute, {
            agentId: "parent",
            model: CLAUDE_MODEL,
        });
        const child = await computeToolset(ctx, compute, {
            agentId: "child",
            model: CLAUDE_MODEL,
            sharedWith: parent,
        });
        const lines = Array.from({ length: 4 }, (_, i) => `const v${i} = ${i};`);
        compute.write("/workspace/app.ts", lines.join("\n"));
        for (const agent of [parent, child]) {
            await agent.tool("Read").execute(ctx, { file_path: "/workspace/app.ts" }, agent.call);
        }

        const results = await Promise.allSettled(
            lines.map((line, i) => {
                const agent = i % 2 === 0 ? parent : child;
                return agent.tool("Edit").execute(
                    ctx,
                    {
                        file_path: "/workspace/app.ts",
                        old_string: line,
                        new_string: `const v${i} = ${i + 100};`,
                    },
                    agent.call,
                );
            }),
        );

        // Each agent sees the other's change as a real one it has not read, so its edit applies
        // because the text it names is still there, and says the file holds unseen changes.
        expect(results.map((result) => result.status)).toEqual(lines.map(() => "fulfilled"));
        expect(compute.files.get("/workspace/app.ts")?.content).toBe(
            lines.map((_, i) => `const v${i} = ${i + 100};`).join("\n"),
        );
    });

    it("refuses an ambiguous edit unless every occurrence was asked for", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/app.ts", "let x = 1;\nlet x = 1;");
        await tool("Read").execute(ctx, { file_path: "/workspace/app.ts" }, call);

        await expect(
            tool("Edit").execute(
                ctx,
                {
                    file_path: "/workspace/app.ts",
                    old_string: "let x = 1;",
                    new_string: "let y = 1;",
                },
                call,
            ),
        ).rejects.toThrow(/appears 2 times/);

        const all = await tool("Edit").execute(
            ctx,
            {
                file_path: "/workspace/app.ts",
                old_string: "let x = 1;",
                new_string: "let y = 1;",
                replace_all: true,
            },
            call,
        );
        expect(all.replacements).toBe(2);
    });

    it("asks about a write that leaves the workspace, and elevates that one write", async () => {
        const { tool } = await machine();
        const write = tool("Write");

        expect(
            await write.shouldReviewInAutoMode({ file_path: "/workspace/x.ts", content: "" }, ctx),
        ).toBe(false);
        expect(
            await write.shouldReviewInAutoMode({ file_path: "/etc/passwd", content: "" }, ctx),
        ).toBe(true);
        expect(
            await write.shouldRunInFullAccessInAutoMode?.(
                { file_path: "/etc/passwd", content: "" },
                ctx,
            ),
        ).toBe(true);
    });
});

describe("Claude's Glob and Grep", () => {
    it("finds files by name pattern", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/src/a.ts", "a");
        compute.write("/workspace/src/b.ts", "b");
        compute.write("/workspace/src/notes.md", "n");

        const result = await tool("Glob").execute(ctx, { pattern: "**/*.ts" }, call);

        expect(result.numFiles).toBe(2);
        expect(result.truncated).toBe(false);
        expect(result.text.split("\n").sort()).toEqual([
            "/workspace/src/a.ts",
            "/workspace/src/b.ts",
        ]);
    });

    it("says plainly when there is nothing to find", async () => {
        const { tool, call } = await machine();

        const result = await tool("Glob").execute(ctx, { pattern: "**/*.rs" }, call);

        expect(result.numFiles).toBe(0);
        expect(result.text).toBe("No files found");
    });

    it("caps itself at a hundred paths and says the rest are missing", async () => {
        const { compute, tool, call } = await machine();
        for (let index = 0; index < 130; index += 1) {
            compute.write(`/workspace/src/file${String(index)}.ts`, "x");
        }

        const result = await tool("Glob").execute(ctx, { pattern: "**/*.ts" }, call);

        expect(result.numFiles).toBe(100);
        expect(result.truncated).toBe(true);
        expect(result.text).toContain("(Results are truncated.");
    });

    it("searches contents, defaulting to the files that matched", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/src/a.ts", "const needle = 1;");
        compute.write("/workspace/src/b.ts", "const other = 2;");

        const result = await tool("Grep").execute(ctx, { pattern: "needle" }, call);

        expect(result.matched_files).toBe(1);
        expect(result.text).toBe("/workspace/src/a.ts");
    });

    it("shows matching lines with their numbers when asked for content", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/src/a.ts", "one\nneedle here\nthree");

        const result = await tool("Grep").execute(
            ctx,
            { pattern: "needle", output_mode: "content", "-n": true },
            call,
        );

        expect(result.match_count).toBe(1);
        expect(result.text).toBe("/workspace/src/a.ts:2: needle here");
    });

    it("treats -C as context on both sides", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/src/a.ts", "one\ntwo\nneedle\nfour\nfive");

        const result = await tool("Grep").execute(
            ctx,
            { pattern: "needle", output_mode: "content", "-C": 1, "-n": false },
            call,
        );

        expect(result.text.split("\n")).toEqual([
            "/workspace/src/a.ts- two",
            "/workspace/src/a.ts: needle",
            "/workspace/src/a.ts- four",
        ]);
    });

    it("searches a single file when the path names one", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/src/a.ts", "one\nneedle here\nthree");

        const result = await tool("Grep").execute(
            ctx,
            { pattern: "needle", path: "/workspace/src/a.ts", output_mode: "content" },
            call,
        );

        expect(result.match_count).toBe(1);
        expect(result.text).toBe("/workspace/src/a.ts:2: needle here");
    });

    it("says plainly when nothing matched", async () => {
        const { compute, tool, call } = await machine();
        compute.write("/workspace/src/a.ts", "nothing of interest");

        const result = await tool("Grep").execute(ctx, { pattern: "needle" }, call);

        expect(result.text).toBe("No matches found");
        expect(result.matched_files).toBe(0);
    });
});
