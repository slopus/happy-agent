import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { ChatMediaModule, type ChatMediaItem } from "../../chatMedia/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { Compute } from "../Compute.js";
import { computePermissionsForContext } from "../impl/computePermissionsForContext.js";
import { basenameComputePath, resolveComputePath } from "../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../impl/shouldReviewComputePath.js";

const presentFilesArgumentsSchema = Type.Object(
    {
        filepaths: Type.Array(
            Type.String({
                minLength: 1,
                maxLength: 4096,
                description:
                    "A file on your machine, absolute or relative to your working directory",
            }),
            {
                minItems: 1,
                maxItems: ChatMediaModule.maxItems,
                description: "The files to show, in the order the user should see them",
            },
        ),
        layout: Type.Optional(
            Type.String({
                maxLength: 1024 * 1024,
                description:
                    "Legacy: a small HTML fragment arranging the files. Leave it out; arrange images with show_ui instead",
            }),
        ),
    },
    { additionalProperties: false },
);

const presentFilesResultSchema = Type.Object(
    {
        presentation: ChatMediaModule.presentationSchema,
        /** What of the layout was left out, and the files it did not place. */
        layout_notes: Type.Optional(
            Type.Object(
                {
                    ignored: Type.Array(Type.String()),
                    appended: Type.Array(Type.String()),
                },
                { additionalProperties: false },
            ),
        ),
    },
    { additionalProperties: false },
);

const PRESENT_FILES_DESCRIPTION = `Show files from your machine to the user, inline in this chat: images appear as pictures, videos as players, PDFs as documents, and any other file as a file the user can open or download.

Use it when the user should see or receive a file you made or found, such as a chart, a screenshot, a rendered video, a PDF report, or an exported spreadsheet, including when the reader is not on this machine. Do not present text, code, or Markdown files; link them instead, because a link opens the live file in the viewer. Generated images, images you read with your file-reading tool, and artifacts are already shown when you make or read them, so do not present them again in the same chat.

The files are copied when you call this, so later changes to them do not change what the user sees. An image may be at most 32 MiB, a video 256 MiB, and a document or other file 64 MiB, with at most 256 MiB per call.

To show several images together, in a grid or with captions, use the images component of show_ui instead.`;

/** Show files from the agent's machine to the user, inline in this chat. */
export function presentFilesTool(compute: Compute, chatMedia: ChatMediaModule) {
    return defineAgentTool({
        name: "present_files",
        defer: true,
        capabilities: [
            "Show images, videos, PDFs, and downloadable files to the user inline in the chat.",
        ],
        searchKeywords: ["show file", "present image", "share video", "display pdf", "send file"],
        description: PRESENT_FILES_DESCRIPTION,
        parameters: presentFilesArgumentsSchema,
        returnType: presentFilesResultSchema,
        // A repeated call reads the same files again and shows the same items.
        durable: true,
        shouldReviewInAutoMode: ({ filepaths }, ctx) => shouldReviewPaths(ctx, compute, filepaths),
        shouldRunInFullAccessInAutoMode: ({ filepaths }, ctx) =>
            shouldReviewPaths(ctx, compute, filepaths),
        describeAutoPermissionAction: ({ filepaths }) =>
            `showing ${filepaths.map(quoteVisibleExact).join(", ")} from this machine to the user in this chat. Access: local file read (outside-workspace or symlink targets require full access) and a copy into this installation's private chat media`,
        execute: async (ctx, { filepaths, layout }) => {
            const hasLayout = layout !== undefined && layout.trim() !== "";
            if (hasLayout && new Set(filepaths).size !== filepaths.length) {
                throw new Error(
                    "With a layout, list each file in filepaths once; the layout places each one with <img src>.",
                );
            }
            const items = await presentComputeFiles(ctx, compute, chatMedia, filepaths);
            if (!hasLayout) return { presentation: chatMedia.presentation(items) };
            const parsed = chatMedia.parseLayout(layout, filepaths);
            const presentation = chatMedia.presentation(items, parsed.layout);
            if (parsed.ignored.length === 0 && parsed.appended.length === 0)
                return { presentation };
            const ignored: string[] = [...parsed.ignored];
            const appended: string[] = [...parsed.appended];
            return { presentation, layout_notes: { ignored, appended } };
        },
        toLLM: ({ presentation: { items }, layout_notes }) => [
            {
                type: "text",
                text: [
                    `Presented ${String(items.length)} ${items.length === 1 ? "file" : "files"} to the user in this chat: ${items.map(describeItem).join(", ")}.`,
                    "The user sees them inline now, so do not repeat their paths or describe them as if the user cannot see them.",
                    "They appear only in this chat's history, not in any parent or child chat; the agent in another chat should link text files and present only media there.",
                    ...(layout_notes === undefined ? [] : describeLayoutNotes(layout_notes)),
                ].join(" "),
            },
        ],
    });
}

/**
 * Read files from the agent's machine under the call's permissions and snapshot each. Every file
 * is measured before it is read, so a directory, an empty file, or one over its limit is refused
 * without reading it.
 */
export async function presentComputeFiles(
    ctx: Context,
    compute: Compute,
    chatMedia: ChatMediaModule,
    filepaths: readonly string[],
): Promise<readonly ChatMediaItem[]> {
    const permissions = computePermissionsForContext(ctx);
    const sources: {
        readonly filepath: string;
        readonly path: string;
        readonly name: string;
        readonly maxBytes: number;
    }[] = [];
    let total = 0;
    for (const filepath of filepaths) {
        const path = resolveComputePath(filepath, compute.cwd, compute.fs.home);
        const name = basenameComputePath(path);
        const facts = await compute.fs.stat(permissions, path);
        if (!facts.isFile) throw new Error(`${quoteVisibleExact(filepath)} is not a file.`);
        if (facts.size === 0) throw new Error(`${quoteVisibleExact(filepath)} is empty.`);
        const limit = chatMedia.limit(name);
        if (facts.size > limit.maxBytes) {
            throw new Error(
                `${quoteVisibleExact(filepath)} is larger than the ${formatMiB(limit.maxBytes)} a presented ${limit.kind} may be.`,
            );
        }
        total += facts.size;
        if (total > ChatMediaModule.maxCallBytes) {
            throw new Error(
                `One call may present at most ${formatMiB(ChatMediaModule.maxCallBytes)} in all.`,
            );
        }
        sources.push({ filepath, path, name, maxBytes: limit.maxBytes });
    }
    const items: ChatMediaItem[] = [];
    for (const source of sources) {
        const bytes = await compute.fs.readFileBuffer(permissions, source.path, {
            maxBytes: source.maxBytes,
        });
        if (bytes.byteLength === 0) {
            throw new Error(`${quoteVisibleExact(source.name)} is empty.`);
        }
        items.push(
            await chatMedia.snapshot(bytes, source.name, {
                path: source.filepath,
                absolutePath: source.path,
            }),
        );
    }
    return items;
}

/** Whether reading any of these files crosses the agent's filesystem boundary. */
export async function shouldReviewPaths(
    ctx: Context,
    compute: Compute,
    paths: readonly string[],
): Promise<boolean> {
    for (const path of paths) {
        if (await shouldReviewComputePath(compute, path, { write: false }, ctx)) return true;
    }
    return false;
}

/** One short sentence each for what the layout left out and the files shown after it. */
function describeLayoutNotes(notes: {
    readonly ignored: readonly string[];
    readonly appended: readonly string[];
}): string[] {
    const sentences: string[] = [];
    if (notes.ignored.length > 0) {
        const shown = notes.ignored.slice(0, 12);
        const more = notes.ignored.length - shown.length;
        sentences.push(
            `Layout ignored: ${shown.join("; ")}${more > 0 ? `; and ${String(more)} more` : ""}.`,
        );
    }
    if (notes.appended.length > 0) {
        sentences.push(
            `The layout did not place ${notes.appended.map(quoteVisibleExact).join(", ")}, so ${notes.appended.length === 1 ? "it is" : "they are"} shown after it.`,
        );
    }
    return sentences;
}

function describeItem(item: ChatMediaItem): string {
    const size = formatSize(item.size);
    return item.kind === "image"
        ? `${JSON.stringify(item.name)} (image, ${String(item.width)}×${String(item.height)}, ${size})`
        : `${JSON.stringify(item.name)} (${item.kind}, ${item.mimeType}, ${size})`;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${String(bytes)} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatMiB(bytes: number): string {
    return `${String(bytes / (1024 * 1024))} MiB`;
}
