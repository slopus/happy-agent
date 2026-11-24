import { nodeToBlock } from "@blocknote/core";
import { _blocksToProsemirrorNode } from "@blocknote/core/yjs";
import type { Mark, Node as ProseMirrorNode, Schema } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import { blockSignature, type DocumentBlock } from "./blocksToMarkdown.js";
import { DOCUMENT_FRAGMENT, documentEditor } from "./documentEditor.js";
import { markdownToBlocks } from "./markdownToBlocks.js";

/** Formatting Markdown cannot write, kept on the unchanged start and end of an edited block. */
const CARRIED_MARKS = new Set(["comment", "underline", "textColor", "backgroundColor"]);
/** Block properties Markdown cannot write, kept when an edited block keeps its type. */
const CARRIED_PROPS = [
    "textColor",
    "backgroundColor",
    "textAlignment",
    "isToggleable",
    "previewWidth",
    "showPreview",
    "caption",
];
const LIST_TYPES = new Set([
    "bulletListItem",
    "numberedListItem",
    "checkListItem",
    "toggleListItem",
]);
/** Beyond this many comparisons the changed middle is replaced without alignment. */
const MAX_ALIGNMENT_CELLS = 1_000_000;

type Unit = {
    container: ProseMirrorNode;
    content: ProseMirrorNode;
    depth: number;
    /** How deep Markdown shows this block: list-item ancestors only. */
    markdownDepth: number;
    signature: string;
};
type Placed = {
    attrs: ProseMirrorNode["attrs"];
    content: ProseMirrorNode;
    depth: number;
    /**
     * An empty paragraph. One the old version had also says how deep it was there, and the least
     * depth it may keep: its own when it had blocks beneath it, which may stay there.
     */
    blank?: { was?: number; least?: number };
};

/**
 * The change that turns `base`, the version an agent read, into the agent's Markdown, as one Yjs
 * update to apply to the current document. Blocks are aligned by their Markdown, so blocks the
 * agent left alone are untouched, and an edited block keeps its identity and, on its unchanged
 * text, the comments and formatting Markdown cannot show. Applied to a newer document, the update
 * merges with whatever people wrote since `base`. Returns undefined when nothing changes.
 */
export function agentDocumentChange(
    base: Y.Doc,
    root: ProseMirrorNode,
    markdown: string,
): Uint8Array | undefined {
    const editor = documentEditor();
    const schema = editor.pmSchema;
    const old = units(root.firstChild, schema);
    const freshRoot = _blocksToProsemirrorNode(editor, markdownToBlocks(markdown) as never);
    const fresh = units(freshRoot.firstChild, schema);
    const placed: Placed[] = [];
    let previousOld = 0;
    let previousFresh = 0;
    for (const [oldIndex, freshIndex] of [
        ...align(old, fresh),
        [old.length, fresh.length] as const,
    ]) {
        const queue = fresh.slice(previousFresh, freshIndex);
        for (const unit of old.slice(previousOld, oldIndex)) {
            // Only an empty paragraph shows in Markdown as blank lines the agent can take out.
            // Any other block that shows as nothing cannot have been removed.
            if (unit.signature === "" && !emptyParagraph(unit))
                placed.push({
                    attrs: unit.container.attrs,
                    content: unit.content,
                    depth: unit.depth,
                });
            else {
                const replacement = queue.shift();
                if (replacement !== undefined)
                    placed.push({
                        attrs: unit.container.attrs,
                        content: carry(unit.content, replacement.content),
                        depth: depth(unit, replacement),
                    });
            }
        }
        for (const unit of queue)
            placed.push({
                attrs: unit.container.attrs,
                content: unit.content,
                depth: unit.depth,
                ...(emptyParagraph(unit) ? { blank: {} } : {}),
            });
        const kept = old[oldIndex];
        if (kept !== undefined)
            placed.push({
                attrs: kept.container.attrs,
                content: kept.content,
                depth: depth(kept, fresh[freshIndex]!),
                ...(emptyParagraph(kept)
                    ? {
                          blank: {
                              was: kept.depth,
                              ...(kept.container.childCount > 1 ? { least: kept.depth } : {}),
                          },
                      }
                    : {}),
            });
        previousOld = oldIndex + 1;
        previousFresh = freshIndex + 1;
    }
    settleBlanks(placed);
    // BlockNote always holds at least one block. An empty paragraph the old version already had
    // is that block, so clearing a document that is already clear changes nothing.
    const spare = old.find(emptyParagraph);
    if (placed.length === 0 && spare !== undefined)
        placed.push({ attrs: spare.container.attrs, content: spare.content, depth: 0 });
    let children = build(placed, schema);
    if (children.length === 0)
        children = [
            _blocksToProsemirrorNode(editor, [{ type: "paragraph" }]).firstChild!.firstChild!,
        ];
    const group = root.firstChild ?? schema.nodes["blockGroup"]!.create();
    const next = root.type.create(root.attrs, [group.type.create(group.attrs, children)]);
    const updates: Uint8Array[] = [];
    const record = (update: Uint8Array) => updates.push(update);
    base.on("update", record);
    try {
        updateYFragment(base, base.getXmlFragment(DOCUMENT_FRAGMENT), next, {
            mapping: new Map(),
            isOMark: new Map(),
        } as never);
    } finally {
        base.off("update", record);
    }
    return updates.length === 0 ? undefined : Y.mergeUpdates(updates);
}

function units(group: ProseMirrorNode | null, schema: Schema): Unit[] {
    const out: Unit[] = [];
    const visit = (node: ProseMirrorNode | null, depth: number, markdownDepth: number) => {
        node?.forEach((container) => {
            const content = container.firstChild!;
            const block = nodeToBlock(container, schema) as DocumentBlock;
            out.push({
                container,
                content,
                depth,
                markdownDepth,
                signature: blockSignature({ ...block, children: [] }),
            });
            if (container.childCount > 1)
                visit(
                    container.child(1),
                    depth + 1,
                    markdownDepth + (LIST_TYPES.has(content.type.name) ? 1 : 0),
                );
        });
    };
    visit(group, 0, 0);
    return out;
}

/** A paragraph Markdown shows as blank lines alone. */
function emptyParagraph(unit: Unit): boolean {
    return unit.signature === "" && unit.content.type.name === "paragraph";
}

/** Matching index pairs: the common start and end, and the longest common run between them. */
function align(old: readonly Unit[], fresh: readonly Unit[]): [number, number][] {
    let start = 0;
    while (
        start < old.length &&
        start < fresh.length &&
        old[start]!.signature === fresh[start]!.signature
    )
        start += 1;
    let end = 0;
    while (
        end < old.length - start &&
        end < fresh.length - start &&
        old[old.length - 1 - end]!.signature === fresh[fresh.length - 1 - end]!.signature
    )
        end += 1;
    const pairs: [number, number][] = [];
    for (let index = 0; index < start; index += 1) pairs.push([index, index]);
    const a = old.slice(start, old.length - end).map((unit) => unit.signature);
    const b = fresh.slice(start, fresh.length - end).map((unit) => unit.signature);
    if (a.length * b.length <= MAX_ALIGNMENT_CELLS) {
        const width = b.length + 1;
        const table = new Uint32Array((a.length + 1) * width);
        for (let i = a.length - 1; i >= 0; i -= 1)
            for (let j = b.length - 1; j >= 0; j -= 1)
                table[i * width + j] =
                    a[i] === b[j]
                        ? table[(i + 1) * width + j + 1]! + 1
                        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
        for (let i = 0, j = 0; i < a.length && j < b.length; )
            if (a[i] === b[j]) pairs.push([start + i++, start + j++]);
            else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i += 1;
            else j += 1;
    }
    for (let index = end; index > 0; index -= 1)
        pairs.push([old.length - index, fresh.length - index]);
    return pairs;
}

/** Keep nesting Markdown could not show unless the agent visibly changed it. */
function depth(old: Unit, fresh: Unit): number {
    return fresh.markdownDepth === old.markdownDepth ? old.depth : fresh.depth;
}

/**
 * Blank lines never show how deep their empty paragraph is. One that stays keeps its nesting
 * while the blocks around it still allow that. Any other is at least as deep as the block after
 * it, which would otherwise become its child.
 */
function settleBlanks(placed: Placed[]): void {
    // Backwards, so each one sees where the block after it settled.
    for (let index = placed.length - 1; index >= 0; index -= 1) {
        const item = placed[index]!;
        if (item.blank === undefined) continue;
        const after = placed[index + 1]?.depth ?? 0;
        const before = placed[index - 1];
        const most = (before?.blank?.was ?? before?.depth ?? -1) + 1;
        const { was, least = after } = item.blank;
        item.depth =
            was !== undefined && was >= least && was <= most ? was : Math.max(after, item.depth);
    }
}

/** Rebuild the block tree from blocks in document order and their depths. */
function build(placed: readonly Placed[], schema: Schema): ProseMirrorNode[] {
    type Branch = { placed: Placed; children: Branch[] };
    const roots: Branch[] = [];
    const stack: { depth: number; branch: Branch }[] = [];
    for (const item of placed) {
        const depth = Math.min(item.depth, (stack.at(-1)?.depth ?? -1) + 1);
        while (stack.length > 0 && stack.at(-1)!.depth >= depth) stack.pop();
        const branch: Branch = { placed: item, children: [] };
        (stack.at(-1)?.branch.children ?? roots).push(branch);
        stack.push({ depth, branch });
    }
    const container = schema.nodes["blockContainer"]!;
    const group = schema.nodes["blockGroup"]!;
    const node = (branch: Branch): ProseMirrorNode =>
        container.create(branch.placed.attrs, [
            branch.placed.content,
            ...(branch.children.length === 0
                ? []
                : [group.create(null, branch.children.map(node))]),
        ]);
    return roots.map(node);
}

/**
 * The agent's version of a block, keeping the old block's Markdown-invisible properties and, on
 * the text before and after the edit, its Markdown-invisible marks.
 */
function carry(old: ProseMirrorNode, fresh: ProseMirrorNode): ProseMirrorNode {
    if (old.type !== fresh.type) return fresh;
    const attrs = { ...fresh.attrs };
    for (const key of CARRIED_PROPS)
        if (key in old.attrs && key in attrs) attrs[key] = old.attrs[key];
    if (!old.isTextblock) return fresh.type.create(attrs, fresh.content, fresh.marks);
    const a = flat(old);
    const b = flat(fresh);
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    )
        suffix += 1;
    const transform = new Transform(fresh.type.create(attrs, fresh.content, fresh.marks));
    const shift = b.length - a.length;
    old.forEach((child, offset) => {
        for (const mark of child.marks) {
            if (!CARRIED_MARKS.has(mark.type.name)) continue;
            const from = offset;
            const to = offset + child.nodeSize;
            add(transform, mark, from, Math.min(to, prefix));
            add(transform, mark, Math.max(from, a.length - suffix) + shift, to + shift);
        }
    });
    return transform.doc;
}

function add(transform: Transform, mark: Mark, from: number, to: number): void {
    if (to > from) transform.addMark(from, to, mark);
}

/** A textblock's content with one character per position, so offsets are positions. */
function flat(node: ProseMirrorNode): string {
    return node.textBetween(0, node.content.size, "", () => "\uFFFC");
}
