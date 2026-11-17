import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext } from "@steve.kite/stdlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ChatMediaModule } from "../../sources/chatMedia/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { computeToolset } from "../compute/support/computeTools.js";
import { testConfig } from "../support/computeModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("happy-agent-modules-chat-media");

function chatMedia() {
    return new ChatMediaModule(testConfig, new HistoryModule());
}

/** The present_files tool an agent on this machine receives. */
async function presentFilesOn(compute: FakeCompute, module = chatMedia()) {
    return (await computeToolset(ctx, compute, { agentId: "agent-one", chatMedia: module })).tool(
        "present_files",
    );
}

async function presentFiles(
    compute: FakeCompute,
    filepaths: readonly string[],
    layout?: string,
): Promise<{ readonly items: readonly any[]; readonly layout?: unknown }> {
    const tool = await presentFilesOn(compute);
    const result = await tool.execute(ctx, {
        filepaths,
        ...(layout === undefined ? {} : { layout }),
    });
    return result.presentation;
}

function place(compute: FakeCompute, path: string, bytes: Uint8Array): void {
    compute.files.set(path, { content: "", bytes, mtimeMs: 1 });
}

function digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

describe("ChatMediaModule", () => {
    it("measures images, classifies other files, and snapshots every item by digest", async () => {
        const compute = new FakeCompute();
        // EXIF orientation 6 turns the stored 8×4 picture into a displayed 4×8 one.
        const photo = await sharp({
            create: { width: 8, height: 4, channels: 3, background: { r: 20, g: 120, b: 200 } },
        })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer();
        // A PNG named .jpg is served as what it really is.
        const misnamed = await sharp({
            create: {
                width: 3,
                height: 2,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
        })
            .png()
            .toBuffer();
        const pdf = Buffer.from("%PDF-1.7\n%fake\n");
        const video = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]);
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
        const unknown = Buffer.from("plain bytes");
        place(compute, "/workspace/photo.jpeg", photo);
        place(compute, "/workspace/out/misnamed.jpg", misnamed);
        place(compute, "/workspace/report.pdf", pdf);
        place(compute, "/workspace/clip.mp4", video);
        place(compute, "/workspace/logo.svg", svg);
        place(compute, "/workspace/data", unknown);

        const { items, layout } = await presentFiles(compute, [
            "photo.jpeg",
            "/workspace/out/misnamed.jpg",
            "report.pdf",
            "clip.mp4",
            "logo.svg",
            "data",
        ]);

        expect(layout).toBeUndefined();
        expect(items).toEqual([
            {
                kind: "image",
                name: "photo.jpeg",
                mimeType: "image/jpeg",
                size: photo.byteLength,
                sha256: digest(photo),
                source: { path: "photo.jpeg", absolutePath: "/workspace/photo.jpeg" },
                width: 4,
                height: 8,
                thumbhash: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/),
            },
            {
                kind: "image",
                name: "misnamed.jpg",
                mimeType: "image/png",
                size: misnamed.byteLength,
                sha256: digest(misnamed),
                source: {
                    path: "/workspace/out/misnamed.jpg",
                    absolutePath: "/workspace/out/misnamed.jpg",
                },
                width: 3,
                height: 2,
                thumbhash: expect.any(String),
            },
            {
                kind: "document",
                name: "report.pdf",
                mimeType: "application/pdf",
                size: pdf.byteLength,
                sha256: digest(pdf),
                source: { path: "report.pdf", absolutePath: "/workspace/report.pdf" },
            },
            {
                kind: "video",
                name: "clip.mp4",
                mimeType: "video/mp4",
                size: video.byteLength,
                sha256: digest(video),
                source: { path: "clip.mp4", absolutePath: "/workspace/clip.mp4" },
            },
            {
                kind: "file",
                name: "logo.svg",
                mimeType: "image/svg+xml",
                size: svg.byteLength,
                sha256: digest(svg),
                source: { path: "logo.svg", absolutePath: "/workspace/logo.svg" },
            },
            {
                kind: "file",
                name: "data",
                mimeType: "application/octet-stream",
                size: unknown.byteLength,
                sha256: digest(unknown),
                source: { path: "data", absolutePath: "/workspace/data" },
            },
        ]);
        for (const [item, bytes] of [
            [items[0]!, photo],
            [items[2]!, pdf],
        ] as const) {
            expect(await readFile(testConfig.chatMediaContentPath(item.sha256))).toEqual(bytes);
        }
    });

    it("refuses directories, empty and oversized files, and calls beyond their bounds", async () => {
        const compute = new FakeCompute();
        compute.directories.add("/workspace/out");
        place(compute, "/workspace/empty.txt", new Uint8Array());
        place(compute, "/workspace/huge.png", new Uint8Array(32 * 1024 * 1024 + 1));
        place(compute, "/workspace/note.txt", Buffer.from("note"));

        await expect(presentFiles(compute, ["out"])).rejects.toThrow('"out" is not a file.');
        await expect(presentFiles(compute, ["empty.txt"])).rejects.toThrow('"empty.txt" is empty.');
        await expect(presentFiles(compute, ["huge.png"])).rejects.toThrow(
            "larger than the 32 MiB a presented image may be",
        );
        const tool = await presentFilesOn(compute);
        expect(Value.Check(tool.parameters, { filepaths: Array(11).fill("note.txt") })).toBe(false);
        // Without chat media, nothing on the machine can be shown in the chat.
        const without = await computeToolset(ctx, compute);
        expect(without.tools.map((each) => each.name)).not.toContain("present_files");
    });

    it("offers direct Gen UI alongside presented files and says where the user sees them", async () => {
        const compute = new FakeCompute();
        place(compute, "/workspace/note.txt", Buffer.from("note"));
        const module = chatMedia();
        const hooks = await resolveModuleHooks(ctx, module);
        const instructions = hooks.instructions?.(ctx, {} as AgentModuleScope);
        expect(instructions).toContain("not in any parent or child chat");
        expect(instructions).toContain(
            "An image you have read with a file-reading tool is already shown, so do not present it again.",
        );
        expect(instructions).toContain("Link text, code, and Markdown files instead");
        expect(instructions).toContain("the parent should link text files and present only media");
        expect(instructions).not.toContain("show_page");
        expect(
            (await hooks.tools?.(ctx, {} as AgentModuleScope))?.map((tool) => tool.name),
        ).toEqual(["gen_ui"]);
        expect(instructions).toContain("Use gen_ui");
        const tool = await presentFilesOn(compute, module);
        expect(tool.description).toContain(
            "images you read with your file-reading tool, and artifacts are already shown",
        );
        expect(tool.description).toContain("Do not present text, code, or Markdown files");
        expect(tool.durable).toBe(true);
        expect(await tool.shouldReviewInAutoMode({ filepaths: ["note.txt"] }, ctx)).toBe(false);
        expect(await tool.shouldReviewInAutoMode({ filepaths: ["/etc/passwd"] }, ctx)).toBe(true);
        expect(
            await tool.shouldRunInFullAccessInAutoMode!({ filepaths: ["/etc/passwd"] }, ctx),
        ).toBe(true);
        expect(tool.describeAutoPermissionAction!({ filepaths: ["/etc/passwd"] }, ctx)).toContain(
            '"/etc/passwd"',
        );

        const result = await tool.execute(ctx, { filepaths: ["note.txt"] }, {
            id: "callpresent",
        } as never);
        expect(result).toEqual({
            presentation: {
                type: "media",
                items: [
                    {
                        kind: "file",
                        name: "note.txt",
                        mimeType: "text/plain",
                        size: 4,
                        sha256: digest(Buffer.from("note")),
                        source: { path: "note.txt", absolutePath: "/workspace/note.txt" },
                    },
                ],
            },
        });
        expect(tool.toLLM(result)).toEqual([
            {
                type: "text",
                text: 'Presented 1 file to the user in this chat: "note.txt" (file, text/plain, 4 bytes). The user sees them inline now, so do not repeat their paths or describe them as if the user cannot see them. They appear only in this chat\'s history, not in any parent or child chat; the agent in another chat should link text files and present only media there.',
            },
        ]);
    });

    it("arranges presented files by the agent's layout and reports what it ignored", async () => {
        const compute = new FakeCompute();
        const wide = await sharp({
            create: { width: 8, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } },
        })
            .png()
            .toBuffer();
        place(compute, "/workspace/out/wide.png", wide);
        place(compute, "/workspace/out/notes.pdf", Buffer.from("%PDF-1.7\n"));
        place(compute, "/workspace/out/extra.pdf", Buffer.from("%PDF-1.7\n"));
        const tool = await presentFilesOn(compute);

        const result = await tool.execute(ctx, {
            filepaths: ["out/wide.png", "out/notes.pdf", "out/extra.pdf"],
            layout: `<figure style="margin: 0; position: absolute">
               <img src="out/wide.png" alt="Wide &amp; short">
               <figcaption style="tone: muted; font-size: small">Overview</figcaption>
             </figure>
             <script>alert(1)</script>
             <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px">
               <img src="out/notes.pdf" style="grid-column: span 2">
             </div>`,
        });

        expect(result.presentation.items.map((item: { name: string }) => item.name)).toEqual([
            "wide.png",
            "notes.pdf",
            "extra.pdf",
        ]);
        expect(result.presentation.layout).toEqual({
            type: "tree",
            root: [
                {
                    type: "element",
                    tag: "figure",
                    style: { margin: "0" },
                    children: [
                        { type: "item", index: 0, alt: "Wide & short" },
                        {
                            type: "element",
                            tag: "figcaption",
                            style: { tone: "muted", fontSize: "small" },
                            children: [{ type: "text", text: "Overview" }],
                        },
                    ],
                },
                {
                    type: "element",
                    tag: "div",
                    style: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px" },
                    children: [{ type: "item", index: 1, style: { gridColumn: "span 2" } }],
                },
                { type: "item", index: 2 },
            ],
        });
        expect(result.layout_notes).toEqual({
            ignored: ["position on <figure>", "<script> and its contents"],
            appended: ["out/extra.pdf"],
        });
        const [output] = tool.toLLM(result);
        expect(output?.type === "text" ? output.text : undefined).toContain(
            'Layout ignored: position on <figure>; <script> and its contents. The layout did not place "out/extra.pdf", so it is shown after it.',
        );

        // A layout that places nothing leaves the automatic layout, and the call still succeeds.
        const unusable = await tool.execute(ctx, {
            filepaths: ["out/wide.png"],
            layout: "<table>Nothing here</table>",
        });
        expect(unusable.presentation).not.toHaveProperty("layout");
        expect(unusable.layout_notes.ignored).toContain(
            "the whole layout, which placed none of the files",
        );

        // Listing a file twice is still an argument error when a layout names files.
        await expect(
            tool.execute(ctx, {
                filepaths: ["out/wide.png", "out/wide.png"],
                layout: '<img src="out/wide.png">',
            }),
        ).rejects.toThrow("list each file in filepaths once");
    });

    it("records a Retina screenshot's scale from its density", async () => {
        const compute = new FakeCompute();
        const retina = await sharp({
            create: { width: 40, height: 20, channels: 3, background: { r: 9, g: 9, b: 9 } },
        })
            .png()
            .withMetadata({ density: 144 })
            .toBuffer();
        const plain = await sharp({
            create: { width: 40, height: 20, channels: 3, background: { r: 9, g: 9, b: 9 } },
        })
            .png()
            .withMetadata({ density: 72 })
            .toBuffer();
        place(compute, "/workspace/retina.png", retina);
        place(compute, "/workspace/plain.png", plain);

        const { items } = await presentFiles(compute, ["retina.png", "plain.png"]);

        expect(items[0]).toMatchObject({ kind: "image", width: 40, height: 20, scale: 2 });
        expect(items[1]).not.toHaveProperty("scale");
    });
});
