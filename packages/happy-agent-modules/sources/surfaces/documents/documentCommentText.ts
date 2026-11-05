import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as Y from "yjs";

import { DOCUMENT_THREADS } from "./documentEditor.js";

/** Inline text, as BlockNote stores it in a comment's blocks. */
const textSchema = Type.Object({ text: Type.String() });
/** A block or a link: inline content, and for a block the blocks nested under it. */
const containerSchema = Type.Object({
    content: Type.Optional(Type.Unknown()),
    children: Type.Optional(Type.Array(Type.Unknown())),
});

/**
 * The text of a document's comments, a block to a line: every comment of every thread that is
 * not deleted, resolved threads included, in thread order. Deleted comments keep no body.
 */
export function documentCommentText(doc: Y.Doc): string {
    const lines: string[] = [];
    for (const thread of doc.getMap(DOCUMENT_THREADS).values()) {
        if (!(thread instanceof Y.Map) || thread.get("deletedAt") !== undefined) continue;
        const comments: unknown = thread.get("comments");
        if (!(comments instanceof Y.Array)) continue;
        for (const comment of comments.toArray())
            if (comment instanceof Y.Map && comment.get("deletedAt") === undefined)
                lines.push(...blockLines(comment.get("body")));
    }
    return lines.join("\n");
}

function blockLines(blocks: unknown): string[] {
    if (!Array.isArray(blocks)) return [];
    return blocks.flatMap((block) => {
        if (!Value.Check(containerSchema, block)) return [];
        const text = inlineText(block.content);
        return [...(text.trim().length === 0 ? [] : [text]), ...blockLines(block.children)];
    });
}

function inlineText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((item) => {
            if (Value.Check(textSchema, item)) return item.text;
            if (Value.Check(containerSchema, item)) return inlineText(item.content);
            return "";
        })
        .join("");
}
