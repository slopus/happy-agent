import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-codex-apply-patch");

/** A machine and the Codex tools of one agent working on it. */
async function machine() {
    const compute = new FakeCompute();
    return { compute, ...(await computeToolset(ctx, compute)) };
}

/** Codex's patch envelope around whichever file sections a test is about. */
function patch(...body: readonly string[]): string {
    return ["*** Begin Patch", ...body, "*** End Patch", ""].join("\n");
}

/** Put a file on the machine through a patch for tests that build on an earlier change. */
async function addFile(
    toolset: Awaited<ReturnType<typeof machine>>,
    path: string,
    lines: readonly string[],
): Promise<void> {
    await toolset
        .tool("apply_patch")
        .execute(
            ctx,
            { patch: patch(`*** Add File: ${path}`, ...lines.map((line) => `+${line}`)) },
            toolset.call,
        );
}

describe("codex apply_patch", () => {
    it("adds a file and reports it in Codex's own summary", async () => {
        const toolset = await machine();
        const { compute, tool, call } = toolset;

        const result = await tool("apply_patch").execute(
            ctx,
            {
                patch: patch(
                    "*** Add File: sources/greet.ts",
                    "+export function greet() {",
                    '+    return "hello";',
                    "+}",
                ),
            },
            call,
        );

        expect(compute.files.get("/workspace/sources/greet.ts")?.content).toBe(
            'export function greet() {\n    return "hello";\n}',
        );
        expect(result.changes).toEqual([{ kind: "add", path: "/workspace/sources/greet.ts" }]);
        expect(result.summary).toBe("Success. Updated the following files:\nA sources/greet.ts");
        expect(result.presentation).toEqual({
            type: "file_diff",
            files: [
                {
                    path: "sources/greet.ts",
                    kind: "add",
                    added: 3,
                    deleted: 0,
                    hunks: [
                        {
                            oldStart: 0,
                            newStart: 1,
                            lines: [
                                { kind: "add", text: "export function greet() {" },
                                { kind: "add", text: '    return "hello";' },
                                { kind: "add", text: "}" },
                            ],
                        },
                    ],
                },
            ],
        });
        expect(tool("apply_patch").toLLM(result)).toEqual([{ type: "text", text: result.summary }]);
    });

    it("reports how many changed files were omitted from a bounded presentation", async () => {
        const toolset = await machine();
        const sections = Array.from({ length: 21 }, (_value, index) => [
            `*** Add File: file-${String(index)}.txt`,
            `+line ${String(index)}`,
        ]).flat();

        const result = await toolset
            .tool("apply_patch")
            .execute(ctx, { patch: patch(...sections) }, toolset.call);

        expect(result.changes).toHaveLength(21);
        expect(result.presentation.files).toHaveLength(20);
        expect(result.presentation.omittedFiles).toBe(1);
    });

    it("refuses to add a file that is already there", async () => {
        const toolset = await machine();
        toolset.compute.write("/workspace/notes.md", "already here\n");

        await expect(
            toolset
                .tool("apply_patch")
                .execute(ctx, { patch: patch("*** Add File: notes.md", "+new") }, toolset.call),
        ).rejects.toThrow(/adds a file that already exists/);
    });

    it("updates a file through its surrounding context", async () => {
        const toolset = await machine();
        await addFile(toolset, "sources/count.ts", [
            "export function count() {",
            "    return 1;",
            "}",
        ]);

        const result = await toolset.tool("apply_patch").execute(
            ctx,
            {
                patch: patch(
                    "*** Update File: sources/count.ts",
                    "@@ export function count() {",
                    "-    return 1;",
                    "+    return 2;",
                ),
            },
            toolset.call,
        );

        expect(toolset.compute.files.get("/workspace/sources/count.ts")?.content).toBe(
            "export function count() {\n    return 2;\n}",
        );
        expect(result.changes).toEqual([{ kind: "update", path: "/workspace/sources/count.ts" }]);
        expect(result.summary).toContain("M sources/count.ts");
        expect(result.presentation).toEqual({
            type: "file_diff",
            files: [
                {
                    path: "sources/count.ts",
                    kind: "update",
                    added: 1,
                    deleted: 1,
                    hunks: [
                        {
                            oldStart: 2,
                            newStart: 2,
                            lines: [
                                { kind: "delete", text: "    return 1;" },
                                { kind: "add", text: "    return 2;" },
                            ],
                        },
                    ],
                },
            ],
        });
    });

    it("keeps unchanged context lines exactly where they were", async () => {
        const toolset = await machine();
        await addFile(toolset, "app.ts", ["one", "two", "three", "four"]);

        await toolset.tool("apply_patch").execute(
            ctx,
            {
                patch: patch("*** Update File: app.ts", "@@", " two", "-three", "+THREE", " four"),
            },
            toolset.call,
        );

        expect(toolset.compute.files.get("/workspace/app.ts")?.content).toBe(
            "one\ntwo\nTHREE\nfour",
        );
    });

    it("appends at the end of a file when a hunk is marked as the end of it", async () => {
        const toolset = await machine();
        await addFile(toolset, "log.txt", ["first", "second"]);

        await toolset.tool("apply_patch").execute(
            ctx,
            {
                patch: patch(
                    "*** Update File: log.txt",
                    "@@",
                    " second",
                    "+third",
                    "*** End of File",
                ),
            },
            toolset.call,
        );

        expect(toolset.compute.files.get("/workspace/log.txt")?.content).toBe(
            "first\nsecond\nthird",
        );
    });

    it("deletes a file created by an earlier patch", async () => {
        const toolset = await machine();
        await addFile(toolset, "old.ts", ["gone soon"]);

        const result = await toolset
            .tool("apply_patch")
            .execute(ctx, { patch: patch("*** Delete File: old.ts") }, toolset.call);

        expect(toolset.compute.files.has("/workspace/old.ts")).toBe(false);
        expect(result.changes).toEqual([{ kind: "delete", path: "/workspace/old.ts" }]);
        expect(result.summary).toContain("D old.ts");
        expect(result.presentation).toEqual({
            type: "file_diff",
            files: [
                {
                    path: "old.ts",
                    kind: "delete",
                    added: 0,
                    deleted: 1,
                    hunks: [
                        {
                            oldStart: 1,
                            newStart: 0,
                            lines: [{ kind: "delete", text: "gone soon" }],
                        },
                    ],
                },
            ],
        });
    });

    it("moves a file and applies the change it carries", async () => {
        const toolset = await machine();
        await addFile(toolset, "sources/util.ts", ["export const NAME = 'old';"]);

        const result = await toolset.tool("apply_patch").execute(
            ctx,
            {
                patch: patch(
                    "*** Update File: sources/util.ts",
                    "*** Move to: sources/renamed.ts",
                    "@@",
                    "-export const NAME = 'old';",
                    "+export const NAME = 'new';",
                ),
            },
            toolset.call,
        );

        expect(toolset.compute.files.has("/workspace/sources/util.ts")).toBe(false);
        expect(toolset.compute.files.get("/workspace/sources/renamed.ts")?.content).toBe(
            "export const NAME = 'new';",
        );
        expect(result.changes).toEqual([
            {
                kind: "move",
                path: "/workspace/sources/util.ts",
                moved_to: "/workspace/sources/renamed.ts",
            },
        ]);
        expect(result.presentation).toEqual({
            type: "file_diff",
            files: [
                {
                    path: "sources/util.ts",
                    kind: "delete",
                    added: 0,
                    deleted: 1,
                    hunks: [
                        {
                            oldStart: 1,
                            newStart: 0,
                            lines: [{ kind: "delete", text: "export const NAME = 'old';" }],
                        },
                    ],
                },
                {
                    path: "sources/renamed.ts",
                    kind: "add",
                    added: 1,
                    deleted: 0,
                    hunks: [
                        {
                            oldStart: 0,
                            newStart: 1,
                            lines: [{ kind: "add", text: "export const NAME = 'new';" }],
                        },
                    ],
                },
            ],
        });
    });

    it("refuses a move onto a file that already exists", async () => {
        const toolset = await machine();
        await addFile(toolset, "sources/util.ts", ["one"]);
        toolset.compute.write("/workspace/sources/taken.ts", "in the way\n");

        await expect(
            toolset.tool("apply_patch").execute(
                ctx,
                {
                    patch: patch(
                        "*** Update File: sources/util.ts",
                        "*** Move to: sources/taken.ts",
                        "@@",
                        "-one",
                        "+two",
                    ),
                },
                toolset.call,
            ),
        ).rejects.toThrow(/moves a file onto one that already exists/);
        expect(toolset.compute.files.has("/workspace/sources/util.ts")).toBe(true);
    });

    it("refuses a hunk that does not match, and changes nothing at all", async () => {
        const toolset = await machine();
        await addFile(toolset, "app.ts", ["one", "two"]);

        await expect(
            toolset.tool("apply_patch").execute(
                ctx,
                {
                    patch: patch(
                        "*** Add File: fresh.ts",
                        "+brand new",
                        "*** Update File: app.ts",
                        "@@",
                        "-a line that is not there",
                        "+replacement",
                    ),
                },
                toolset.call,
            ),
        ).rejects.toThrow(/does not match anything in \/workspace\/app\.ts/);
        // The whole patch is simulated before anything is written, so the earlier section of a
        // patch that fails later never reaches the machine.
        expect(toolset.compute.files.has("/workspace/fresh.ts")).toBe(false);
        expect(toolset.compute.files.get("/workspace/app.ts")?.content).toBe("one\ntwo");
    });

    it("changes a file it never read when the patch quotes what it is changing", async () => {
        // The quoted lines are checked against the current file before the patch is applied.
        const toolset = await machine();
        toolset.compute.write("/workspace/sources/util.ts", "export const NAME = 'old';\n");

        await toolset.tool("apply_patch").execute(
            ctx,
            {
                patch: patch(
                    "*** Update File: sources/util.ts",
                    "@@",
                    "-export const NAME = 'old';",
                    "+export const NAME = 'new';",
                ),
            },
            toolset.call,
        );

        expect(toolset.compute.files.get("/workspace/sources/util.ts")?.content).toBe(
            "export const NAME = 'new';\n",
        );
    });

    it("appends to a file without a prior read", async () => {
        const toolset = await machine();
        toolset.compute.write("/workspace/sources/util.ts", "export const NAME = 'old';\n");

        await toolset.tool("apply_patch").execute(
            ctx,
            {
                patch: patch("*** Update File: sources/util.ts", "@@", "+export const EXTRA = 1;"),
            },
            toolset.call,
        );

        expect(toolset.compute.files.get("/workspace/sources/util.ts")?.content).toBe(
            "export const NAME = 'old';\nexport const EXTRA = 1;\n",
        );
    });

    it("deletes a file without a prior read", async () => {
        const toolset = await machine();
        toolset.compute.write("/workspace/old.ts", "somebody's work\n");

        const result = await toolset
            .tool("apply_patch")
            .execute(ctx, { patch: patch("*** Delete File: old.ts") }, toolset.call);

        expect(result.changes).toEqual([{ kind: "delete", path: "/workspace/old.ts" }]);
        expect(toolset.compute.files.has("/workspace/old.ts")).toBe(false);
    });

    it("refuses a change whose lines somebody else has already taken away", async () => {
        // What the patch quotes is checked against the file as it is now, so an outside change
        // that removed those lines stops the patch — the same work the timestamp check does, done
        // against the content itself.
        const toolset = await machine();
        await addFile(toolset, "app.ts", ["one"]);
        toolset.compute.write("/workspace/app.ts", "something else entirely\n");

        await expect(
            toolset
                .tool("apply_patch")
                .execute(
                    ctx,
                    { patch: patch("*** Update File: app.ts", "@@", "-one", "+ONE") },
                    toolset.call,
                ),
        ).rejects.toThrow(/does not match anything in \/workspace\/app\.ts/);
        expect(toolset.compute.files.get("/workspace/app.ts")?.content).toBe(
            "something else entirely\n",
        );
    });

    it("applies over an outside change that left the quoted lines alone", async () => {
        const toolset = await machine();
        await addFile(toolset, "app.ts", ["one"]);
        toolset.compute.write("/workspace/app.ts", "one\ntwo\n");

        await toolset
            .tool("apply_patch")
            .execute(
                ctx,
                { patch: patch("*** Update File: app.ts", "@@", "-one", "+ONE") },
                toolset.call,
            );

        expect(toolset.compute.files.get("/workspace/app.ts")?.content).toBe("ONE\ntwo\n");
    });

    it("refuses to update or delete a file that is not there", async () => {
        const toolset = await machine();

        await expect(
            toolset
                .tool("apply_patch")
                .execute(
                    ctx,
                    { patch: patch("*** Update File: missing.ts", "@@", "-a", "+b") },
                    toolset.call,
                ),
        ).rejects.toThrow(/updates a file that does not exist/);
        await expect(
            toolset
                .tool("apply_patch")
                .execute(ctx, { patch: patch("*** Delete File: missing.ts") }, toolset.call),
        ).rejects.toThrow(/deletes a file that does not exist/);
    });

    it("refuses a patch that is not written in Codex's format", async () => {
        const toolset = await machine();

        await expect(
            toolset.tool("apply_patch").execute(ctx, { patch: "just some prose\n" }, toolset.call),
        ).rejects.toThrow(/missing its `\*\*\* Begin Patch` first line/);
        await expect(
            toolset
                .tool("apply_patch")
                .execute(
                    ctx,
                    { patch: "*** Begin Patch\n*** Add File: a.ts\n+one\n" },
                    toolset.call,
                ),
        ).rejects.toThrow(/missing its `\*\*\* End Patch` last line/);
        await expect(
            toolset
                .tool("apply_patch")
                .execute(ctx, { patch: patch("*** Nonsense: a.ts") }, toolset.call),
        ).rejects.toThrow(/not a patch directive/);
    });

    it("applies relative paths against the working directory it was given", async () => {
        const toolset = await machine();

        await toolset.tool("apply_patch").execute(
            ctx,
            {
                patch: patch("*** Add File: nested.ts", "+inside"),
                workdir: "/workspace/sources",
            },
            toolset.call,
        );

        expect(toolset.compute.files.has("/workspace/sources/nested.ts")).toBe(true);
    });

    it("reviews a patch when any path it names crosses the workspace boundary", async () => {
        const { tool } = await machine();
        const applyPatch = tool("apply_patch");

        const inside = { patch: patch("*** Add File: sources/new.ts", "+one") };
        expect(await applyPatch.shouldReviewInAutoMode(inside, ctx)).toBe(false);
        expect(await applyPatch.shouldRunInFullAccessInAutoMode?.(inside, ctx)).toBe(false);

        const outside = {
            patch: patch("*** Add File: sources/new.ts", "+one", "*** Delete File: /etc/hosts"),
        };
        expect(await applyPatch.shouldReviewInAutoMode(outside, ctx)).toBe(true);
        expect(await applyPatch.shouldRunInFullAccessInAutoMode?.(outside, ctx)).toBe(true);
        expect(applyPatch.describeAutoPermissionAction?.(outside, ctx)).toBe(
            'applying a patch. Affected paths: "/workspace/sources/new.ts", "/etc/hosts". Working directory: "/workspace". Access: unrestricted filesystem access outside the workspace sandbox',
        );
    });

    it("reviews a patch it cannot read a single path out of", async () => {
        const { tool } = await machine();

        expect(
            await tool("apply_patch").shouldReviewInAutoMode({ patch: "not a patch" }, ctx),
        ).toBe(true);
    });
});
