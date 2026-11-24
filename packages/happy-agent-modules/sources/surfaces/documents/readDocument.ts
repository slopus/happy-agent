import { docToBlocks } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { blocksToMarkdown, type DocumentBlock, type OmittedContent } from "./blocksToMarkdown.js";
import { DOCUMENT_FRAGMENT, DOCUMENT_THREADS, documentEditor } from "./documentEditor.js";
import { markdownToBlocks } from "./markdownToBlocks.js";

export type DocumentReading = {
    /** Normalized Markdown of everything Markdown can show. */
    text: string;
    /** What the document holds that the Markdown leaves out, in reading order. */
    omitted: (OmittedContent | "comments")[];
    /** True when the document holds blocks, inline content, or marks outside the content model. */
    outsideModel: boolean;
    /** The ProseMirror document, for callers that go on to edit it. */
    root: ProseMirrorNode;
};

/**
 * Read a document's state as the content model sees it. Conversion runs on a private copy because
 * y-prosemirror deletes anything outside the schema from the Yjs document it converts; that
 * deletion is how content outside the model is detected.
 */
export function readDocument(state: Uint8Array): DocumentReading {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    let outsideModel = false;
    doc.on("afterTransaction", (transaction: Y.Transaction) => {
        if (transaction.deleteSet.clients.size > 0) outsideModel = true;
    });
    const editor = documentEditor();
    const root = yXmlFragmentToProseMirrorRootNode(
        doc.getXmlFragment(DOCUMENT_FRAGMENT),
        editor.pmSchema,
    );
    // A document nobody has written to holds no blocks at all. That is the empty document, not
    // content outside the model: anything that had to be dropped was already seen above.
    if (root.childCount > 0)
        try {
            root.check();
        } catch {
            outsideModel = true;
        }
    const blocks = root.childCount === 0 ? [] : (docToBlocks(root) as DocumentBlock[]);
    const { text, omitted } = blocksToMarkdown(blocks);
    let comments = doc.getMap(DOCUMENT_THREADS).size > 0;
    root.descendants((node) => {
        if (node.marks.some((mark) => mark.type.name === "comment")) comments = true;
        return !comments;
    });
    doc.destroy();
    return {
        text,
        omitted: [...omitted, ...(comments ? (["comments"] as const) : [])],
        outsideModel,
        root,
    };
}

/**
 * A new document holding Markdown's blocks, as one Yjs update. Markdown without any block, such
 * as empty or whitespace-only text, has no content and yields no update.
 */
export function markdownToUpdate(markdown: string): Uint8Array | undefined {
    const blocks = markdownToBlocks(markdown);
    if (blocks.length === 0) return undefined;
    const doc = new Y.Doc();
    blocksToYXmlFragment(documentEditor(), blocks as never, doc.getXmlFragment(DOCUMENT_FRAGMENT));
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return update;
}

/**
 * An upper bound on the Markdown length of a document, from its text, attribute values, and
 * structure, cheap enough to check on every change. Escaping at most doubles text, and each
 * element adds at most a marker, indentation, and a line break per level of nesting.
 */
export function markdownLengthBound(doc: Y.Doc): number {
    let bound = 0;
    const visit = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment, depth: number) => {
        if (node instanceof Y.XmlText) {
            bound += 2 * node.length;
            for (const op of node.toDelta() as { attributes?: Record<string, unknown> }[])
                for (const value of Object.values(op.attributes ?? {}))
                    bound += JSON.stringify(value).length;
            return;
        }
        if (node instanceof Y.XmlElement) {
            bound += 16 + 4 * depth;
            for (const value of Object.values(node.getAttributes()))
                bound += 2 * String(value).length;
        }
        for (const child of node.toArray()) visit(child as Y.XmlElement | Y.XmlText, depth + 1);
    };
    visit(doc.getXmlFragment(DOCUMENT_FRAGMENT), 0);
    return bound;
}
