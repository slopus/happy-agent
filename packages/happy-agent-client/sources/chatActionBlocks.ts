/**
 * Inline actions: a `<menu>` of buttons an agent writes in its reply; see "Inline actions" in
 * API.md. The HTML is parsed by parse5, so entities and attributes read as a browser reads them.
 */

import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

import { splitChatActionBlocks, splitMediaLayoutBlocks } from "./mediaLayoutBlocks.js";

export type ChatActionButton = {
    label: string;
    /** What a press sends; absent when this build cannot press the button's action. */
    action?: { id: "reply"; params: Record<string, string>; text: string };
};

export type ChatActionBlock = { kind: "menu"; buttons: ChatActionButton[] };

/** A text's complete `<menu>` blocks in `blockIndex` order, outside layouts; null is drawn as text. */
export function chatActionBlocksOf(markdown: string): (ChatActionBlock | null)[] {
    return splitMediaLayoutBlocks(markdown).flatMap((part) =>
        part.type !== "markdown"
            ? []
            : splitChatActionBlocks(part.text).flatMap((block) =>
                  block.type === "action" && block.complete
                      ? [parseChatActionBlock(block.html)]
                      : [],
              ),
    );
}

/** The menu one block draws; null when it breaks the grammar and is drawn as text. */
export function parseChatActionBlock(html: string): ChatActionBlock | null {
    const [menu, ...rest] = elementsOf(parseFragment(html).childNodes) ?? [];
    const buttons = menu?.tagName === "menu" && rest.length === 0 && elementsOf(menu.childNodes);
    if (!buttons || buttons.length === 0) return null;
    const parsed = buttons.map((button): ChatActionButton | null => {
        const label = textOf(button.childNodes);
        if (button.tagName !== "button" || !label) return null;
        const attributes = new Map(button.attrs.map(({ name, value }) => [name, value]));
        const params = Object.fromEntries(
            [...attributes]
                .filter(([name]) => /^data-(?!(action|emphasis|mark|icon)$)/u.test(name))
                .map(([name, value]) => [name.slice(5), value]),
        );
        if (attributes.get("data-action") !== "reply") return { label };
        return { label, action: { id: "reply", params, text: params["text"] ?? label } };
    });
    return parsed.every((button) => button !== null) ? { kind: "menu", buttons: parsed } : null;
}

type Node = DefaultTreeAdapterTypes.ChildNode;

/** The elements among `nodes`; undefined when any other node is not blank text. */
function elementsOf(nodes: Node[]): DefaultTreeAdapterTypes.Element[] | undefined {
    const elements = nodes.filter((node) => "tagName" in node);
    const blank = nodes.filter((node) => textOf([node]) === "");
    return elements.length + blank.length === nodes.length ? elements : undefined;
}

/** Plain text with its whitespace collapsed; undefined when `nodes` hold anything but text. */
function textOf(nodes: Node[]): string | undefined {
    if (!nodes.every((node) => "value" in node && node.nodeName === "#text")) return undefined;
    return nodes
        .map((node) => ("value" in node ? node.value : ""))
        .join("")
        .replace(/\s+/gu, " ")
        .trim();
}
