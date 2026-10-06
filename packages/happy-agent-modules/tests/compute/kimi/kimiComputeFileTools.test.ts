import { createRootContext } from "@steve.kite/stdlib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { FakeCompute } from "../support/FakeCompute.js";
import { computeToolset } from "../support/computeTools.js";

const ctx = createRootContext().named("kimi-compute-files");
async function machine() {
    const compute = new FakeCompute();
    return {
        compute,
        ...(await computeToolset(ctx, compute, {
            model: "moonshotai/kimi-k3",
            providerKind: "bedrock",
        })),
    };
}

describe("Kimi file tools", () => {
    it("paginates long Unicode lines without gaps and keeps status inside the character budget", async () => {
        const { compute, tool } = await machine();
        const content = "a".repeat(509) + "😀" + "b".repeat(1200);
        compute.write("/workspace/long.txt", content);
        let args: Record<string, unknown> = { path: "long.txt", max_chars: 1024 };
        let collected = "";
        for (let page = 0; page < 10; page++) {
            const result = await tool("Read").execute(ctx, args);
            expect(result.text.length).toBeLessThanOrEqual(1024);
            const text = result.text.split("\n<system>")[0];
            collected += text.slice(text.indexOf("\t") + 1);
            if (!result.truncated) break;
            const next = /Next Read: (\{.*\})<\/system>/.exec(result.text);
            expect(next).not.toBeNull();
            args = { path: "long.txt", ...JSON.parse(next![1]!) };
        }
        expect(collected).toBe(content);
    });

    it("reads a tail, applies n_lines, and rejects tail column offsets", async () => {
        const { compute, tool } = await machine();
        compute.write("/workspace/a.txt", "one\ntwo\nthree\nfour\n");
        expect(
            (await tool("Read").execute(ctx, { path: "a.txt", line_offset: -2, n_lines: 1 })).text,
        ).toContain("3\tthree");
        await expect(
            tool("Read").execute(ctx, { path: "a.txt", line_offset: -2, column_offset: 1 }),
        ).rejects.toThrow("forward reads");
    });

    it("preserves CRLF while editing the LF Read view and retains structured diffs", async () => {
        const { compute, tool } = await machine();
        compute.write("/workspace/a.txt", "one\r\ntwo\r\n");
        expect((await tool("Read").execute(ctx, { path: "a.txt" })).text).toContain(
            "1\tone\n2\ttwo",
        );
        const edited = await tool("Edit").execute(ctx, {
            path: "a.txt",
            old_string: "one\ntwo\n",
            new_string: "one\nthree\n",
        });
        expect(compute.files.get("/workspace/a.txt")?.content).toBe("one\r\nthree\r\n");
        expect(edited.presentation.type).toBe("file_diff");
    });

    it("appends without adding a newline and refuses stale remembered changes", async () => {
        const { compute, tool } = await machine();
        await tool("Write").execute(ctx, { path: "nested/a.txt", content: "one" });
        await tool("Write").execute(ctx, { path: "nested/a.txt", content: "two", mode: "append" });
        expect(compute.files.get("/workspace/nested/a.txt")?.content).toBe("onetwo");
        compute.write("/workspace/nested/a.txt", "external");
        await expect(
            tool("Edit").execute(ctx, {
                path: "nested/a.txt",
                old_string: "external",
                new_string: "changed",
            }),
        ).rejects.toThrow("changed since it was last read");
        await expect(
            tool("Write").execute(ctx, { path: "nested/a.txt", content: "changed" }),
        ).rejects.toThrow("changed since it was last read");
        await tool("Read").execute(ctx, { path: "nested/a.txt" });
        await tool("Edit").execute(ctx, {
            path: "nested/a.txt",
            old_string: "external",
            new_string: "changed",
        });
        expect(compute.files.get("/workspace/nested/a.txt")?.content).toBe("changed");
    });

    it("refuses ambiguous edits and non-text or oversized sources before decoding", async () => {
        const { compute, tool } = await machine();
        compute.write("/workspace/a.txt", "same same");
        await expect(
            tool("Edit").execute(ctx, { path: "a.txt", old_string: "same", new_string: "other" }),
        ).rejects.toThrow("appears 2 times");
        await tool("Edit").execute(ctx, {
            path: "a.txt",
            old_string: "same",
            new_string: "other",
            replace_all: true,
        });
        expect(compute.files.get("/workspace/a.txt")?.content).toBe("other other");
        compute.write("/workspace/binary.txt", "a\0b");
        await expect(tool("Read").execute(ctx, { path: "binary.txt" })).rejects.toThrow(
            "binary file",
        );
        compute.writeBuffer("/workspace/invalid.txt", new Uint8Array([0xff]));
        await expect(tool("Read").execute(ctx, { path: "invalid.txt" })).rejects.toThrow(
            "valid UTF-8",
        );
        const stat = compute.fs.stat.bind(compute.fs);
        vi.spyOn(compute.fs, "stat").mockImplementation(async (permissions, path) => ({
            ...(await stat(permissions, path)),
            size: 9 * 1024 * 1024,
        }));
        const bytes = vi.spyOn(compute.fs, "readFileBuffer");
        await expect(tool("Read").execute(ctx, { path: "a.txt" })).rejects.toThrow("8 MiB");
        expect(bytes).not.toHaveBeenCalled();
    });

    it("paginates nested glob matches and maps count_matches to per-file counts", async () => {
        const { compute, tool } = await machine();
        compute.write("/workspace/a.ts", "token token\n");
        compute.write("/workspace/nested/b.ts", "token\n");
        const first = await tool("Glob").execute(ctx, { pattern: "*.ts", head_limit: 1 });
        expect(first.files).toEqual(["/workspace/nested/b.ts"]);
        expect(first.next_offset).toBe(1);
        expect(
            (await tool("Glob").execute(ctx, { pattern: "*.ts", offset: first.next_offset })).files,
        ).toEqual(["/workspace/a.ts"]);
        const counts = await tool("Grep").execute(ctx, {
            pattern: "token",
            glob: "*.ts",
            output_mode: "count_matches",
        });
        expect(counts.text).toContain("/workspace/a.ts:2");
        expect(counts.text).toContain("/workspace/nested/b.ts:1");
        expect(counts.match_count).toBe(3);
    });

    it.each(["Write", "Edit"])(
        "bounds the actual %s mutation read when a file grows after inspection",
        async (name) => {
            const { compute, tool } = await machine();
            compute.write("/workspace/a.txt", "original");
            const readBuffer = compute.fs.readFileBuffer.bind(compute.fs);
            let reads = 0;
            vi.spyOn(compute.fs, "readFileBuffer").mockImplementation(
                async (permissions, path, options) => {
                    if (++reads === 2) compute.write(path, "x".repeat(9 * 1024 * 1024));
                    return await readBuffer(permissions, path, options);
                },
            );
            const unbounded = vi.spyOn(compute.fs, "readFile");
            const writes = vi.spyOn(compute.fs, "writeFile");
            await expect(
                tool(name).execute(
                    ctx,
                    name === "Write"
                        ? { path: "a.txt", content: "appended", mode: "append" }
                        : { path: "a.txt", old_string: "original", new_string: "changed" },
                ),
            ).rejects.toThrow("byte limit");
            expect(unbounded).not.toHaveBeenCalled();
            expect(writes).not.toHaveBeenCalled();
        },
    );

    it("refuses append when the inspected content changes even with an unchanged timestamp", async () => {
        const { compute, tool } = await machine();
        compute.write("/workspace/a.txt", "original");
        const mtime = compute.files.get("/workspace/a.txt")!.mtimeMs;
        const readBuffer = compute.fs.readFileBuffer.bind(compute.fs);
        let reads = 0;
        vi.spyOn(compute.fs, "readFileBuffer").mockImplementation(
            async (permissions, path, options) => {
                if (++reads === 2) {
                    compute.write(path, "external");
                    compute.files.get(path)!.mtimeMs = mtime;
                }
                return await readBuffer(permissions, path, options);
            },
        );
        await expect(
            tool("Write").execute(ctx, { path: "a.txt", content: "appended", mode: "append" }),
        ).rejects.toThrow("changed before the modification");
        expect(compute.files.get("/workspace/a.txt")!.content).toBe("external");
    });

    it("bounds replacement expansion using the actual file contents", async () => {
        const { compute, tool } = await machine();
        compute.write("/workspace/a.txt", "a".repeat(10000));
        await expect(
            tool("Edit").execute(ctx, {
                path: "a.txt",
                old_string: "a",
                new_string: "b".repeat(1000),
                replace_all: true,
            }),
        ).rejects.toThrow("8 MiB");
        expect(compute.files.get("/workspace/a.txt")!.content).toBe("a".repeat(10000));
    });

    it("delivers bounded images and native-resolution regions, and rejects video", async () => {
        const { compute, tool } = await machine();
        const image = await sharp({
            create: { width: 2200, height: 30, channels: 3, background: "red" },
        })
            .png()
            .toBuffer();
        compute.writeBuffer("/workspace/a.png", image);
        const whole = await tool("ReadMediaFile").execute(ctx, { path: "a.png" });
        expect(whole.original_width).toBe(2200);
        expect(whole.width).toBe(2048);
        const full = await tool("ReadMediaFile").execute(ctx, {
            path: "a.png",
            full_resolution: true,
        });
        expect(full.width).toBe(2200);
        const crop = await tool("ReadMediaFile").execute(ctx, {
            path: "a.png",
            region: { x: 10, y: 5, width: 200, height: 20 },
        });
        expect(crop).toMatchObject({ width: 200, height: 20, region_x: 10, region_y: 5 });
        expect(tool("ReadMediaFile").toLLM(crop).at(-1)?.type).toBe("image");
        await expect(tool("ReadMediaFile").execute(ctx, { path: "a.mp4" })).rejects.toThrow(
            "Only PNG",
        );
        await expect(
            tool("ReadMediaFile").execute(ctx, {
                path: "a.png",
                region: { x: 2199, y: 0, width: 2, height: 1 },
            }),
        ).rejects.toThrow("outside the original image");
    });
});
