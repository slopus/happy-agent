import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { AgentModuleScope } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { ChatMediaModule } from "../../sources/chatMedia/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { scriptedComputeModule, testConfig } from "../support/computeModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("happy-agent-modules-chat-media");

function chatMedia(compute: FakeCompute | undefined) {
    return new ChatMediaModule(
        testConfig,
        scriptedComputeModule(async () => compute),
        new HistoryModule(),
    );
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

        const { items } = await chatMedia(compute).presentFiles(ctx, "agent-one", [
            "photo.jpeg",
            "/workspace/out/misnamed.jpg",
            "report.pdf",
            "clip.mp4",
            "logo.svg",
            "data",
        ]);

        expect(items).toEqual([
            {
                kind: "image",
                name: "photo.jpeg",
                mimeType: "image/jpeg",
                size: photo.byteLength,
                sha256: digest(photo),
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
            },
            {
                kind: "video",
                name: "clip.mp4",
                mimeType: "video/mp4",
                size: video.byteLength,
                sha256: digest(video),
            },
            {
                kind: "file",
                name: "logo.svg",
                mimeType: "image/svg+xml",
                size: svg.byteLength,
                sha256: digest(svg),
            },
            {
                kind: "file",
                name: "data",
                mimeType: "application/octet-stream",
                size: unknown.byteLength,
                sha256: digest(unknown),
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
        const module = chatMedia(compute);

        await expect(module.presentFiles(ctx, "agent-one", ["out"])).rejects.toThrow(
            '"out" is not a file.',
        );
        await expect(module.presentFiles(ctx, "agent-one", ["empty.txt"])).rejects.toThrow(
            '"empty.txt" is empty.',
        );
        await expect(module.presentFiles(ctx, "agent-one", ["huge.png"])).rejects.toThrow(
            "larger than the 32 MiB a presented image may be",
        );
        await expect(
            module.presentFiles(ctx, "agent-one", Array(11).fill("note.txt")),
        ).rejects.toThrow("Present one to 10 files at a time.");
        await expect(
            chatMedia(undefined).presentFiles(ctx, "agent-one", ["note.txt"]),
        ).rejects.toThrow("This conversation has no machine to present files from.");
    });

    it("offers present_files to every agent and says where the user sees the files", async () => {
        const compute = new FakeCompute();
        place(compute, "/workspace/note.txt", Buffer.from("note"));
        const module = chatMedia(compute);
        const hooks = await resolveModuleHooks(ctx, module);
        expect(hooks.instructions?.(ctx, {} as AgentModuleScope)).toContain(
            "not in any parent or child chat",
        );
        const tools = await hooks.tools!(ctx, { agent: { id: "agent-one" } } as AgentModuleScope);
        expect(tools.map((tool) => tool.name)).toEqual(["present_files", "show_page"]);
        const [tool] = tools;
        expect(tool!.durable).toBe(true);
        expect(await tool!.shouldReviewInAutoMode({ filepaths: ["note.txt"] }, ctx)).toBe(false);
        expect(await tool!.shouldReviewInAutoMode({ filepaths: ["/etc/passwd"] }, ctx)).toBe(true);
        expect(
            await tool!.shouldRunInFullAccessInAutoMode!({ filepaths: ["/etc/passwd"] }, ctx),
        ).toBe(true);
        expect(tool!.describeAutoPermissionAction!({ filepaths: ["/etc/passwd"] }, ctx)).toContain(
            '"/etc/passwd"',
        );

        const result = await tool!.execute(ctx, { filepaths: ["note.txt"] }, {
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
                    },
                ],
            },
        });
        expect(tool!.toLLM(result)).toEqual([
            {
                type: "text",
                text: 'Presented 1 file to the user in this chat: "note.txt" (file, text/plain, 4 bytes). The user sees them inline now, so do not repeat their paths or describe them as if the user cannot see them. They appear only in this chat\'s history, not in any parent or child chat; if a user should see them in another chat, the agent in that chat must present them there.',
            },
        ]);
    });

    it("shows a page by its URL, never fetching it, and refuses what is not a web page", async () => {
        const module = chatMedia(new FakeCompute());
        const hooks = await resolveModuleHooks(ctx, module);
        const tools = await hooks.tools!(ctx, { agent: { id: "agent-one" } } as AgentModuleScope);
        const tool = tools.find((candidate) => candidate.name === "show_page")!;
        expect(tool.durable).toBe(true);
        // Every page is reviewed in Auto, and the reviewer sees exactly which address and title.
        const page = { url: "http://localhost:5173/", title: "Checkout\u202e" };
        expect(await tool.shouldReviewInAutoMode(page, ctx)).toBe(true);
        expect(tool.shouldRunInFullAccessInAutoMode).toBeUndefined();
        const action = tool.describeAutoPermissionAction?.(page, ctx);
        expect(action).toContain('"http://localhost:5173/"');
        expect(action).toContain('titled "Checkout\\u{202e}"');
        expect(action).toContain("through this agent's network");

        const result = await tool.execute(
            ctx,
            { url: "http://localhost:5173", title: "Checkout", display: "inline_compact" },
            { id: "callpage" } as never,
        );
        expect(result).toEqual({
            presentation: {
                type: "page",
                url: "http://localhost:5173/",
                title: "Checkout",
                display: "inline_compact",
            },
        });
        expect(tool.toLLM(result)[0]).toMatchObject({
            text: expect.stringContaining('Showing "Checkout" (http://localhost:5173/)'),
        });
        await expect(
            tool.execute(ctx, { url: "https://example.com/", title: "Example" }, {} as never),
        ).resolves.toMatchObject({ presentation: { display: null } });
        await expect(
            tool.execute(ctx, { url: "file:///etc/passwd", title: "Secrets" }, {} as never),
        ).rejects.toThrow("Only http and https pages");
        await expect(
            tool.execute(ctx, { url: "https://me:pw@example.com/", title: "Login" }, {} as never),
        ).rejects.toThrow("cannot carry a user name or password");
        await expect(
            tool.execute(ctx, { url: "not a url", title: "Nope" }, {} as never),
        ).rejects.toThrow("is not a URL");
    });
});
