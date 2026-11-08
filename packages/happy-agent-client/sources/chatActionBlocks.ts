/**
 * Inline actions: the small, closed subset of HTML an agent writes in its reply for the person to
 * answer with a click; see "Inline actions" in API.md. This finds the blocks, reads each one into
 * the structure clients draw, numbers them, and drops them for surfaces that cannot press them.
 * Every function here is total: a block it cannot read is `undefined` and stays the inert text it
 * was written as.
 *
 * ```html
 * <menu>
 *   <button data-action="reply" data-emphasis>Push it</button>
 *   <button data-action="reply" data-text="Not yet, run the tests first">Not yet</button>
 * </menu>
 * ```
 */

import {
    hasForbiddenCharacter,
    tokenizeChatActionHtml,
    type ChatActionHtmlElement,
    type ChatActionHtmlNode,
} from "./chatActionHtml.js";
import { CHAT_ACTION_PARAMETER_NAME, chatActionOf, type ChatAction } from "./chatActionRegistry.js";
import { splitHtmlBlocks, stripHtmlBlocks, type HtmlBlockSegment } from "./htmlBlocks.js";
import { splitMediaLayoutBlocks } from "./mediaLayoutBlocks.js";

/** A product mark drawn before a label: the subscription it names. */
export type ChatActionMark = "claude" | "openai" | "grok" | "gemini";
export const CHAT_ACTION_MARKS: readonly ChatActionMark[] = ["claude", "openai", "grok", "gemini"];

export interface ChatActionButton {
    readonly label: string;
    readonly mark?: ChatActionMark;
    /** What it names is connected already (`data-connected`). */
    readonly connected?: true;
    /** The one emphasized control of its block, if any. */
    readonly emphasized: boolean;
    /** What pressing it runs; absent when it cannot be pressed. */
    readonly action?: ChatAction;
}

export interface ChatChecklistOption {
    readonly value: string;
    readonly label: string;
    /** The option's sub-line; in a table, under its label in the item column. */
    readonly detail?: string;
    /** In a table, the cells after the item column, one per remaining heading. */
    readonly cells?: readonly string[];
    readonly mark?: ChatActionMark;
    /** Ticked when the block is first drawn. */
    readonly checked: boolean;
    /** Shown but cannot be changed. */
    readonly disabled: boolean;
}

export type ChatStepStatus = "pending" | "running" | "done" | "failed";
export type ChatStatusTone = "info" | "running" | "done" | "failed";

/** One place in a tree block: a folder or file name, and what is inside it. */
export interface ChatTreeNode {
    readonly name: string;
    readonly children: readonly ChatTreeNode[];
}

/** What a figure shows, drawn live by the client from the server's own state. */
export type ChatFigure =
    | { readonly type: "providerCli"; readonly cliId: string; readonly target?: "team" | "private" }
    | { readonly type: "setting"; readonly setting: "default-model" }
    | { readonly type: "phoneApp" }
    | { readonly type: "phonePair" }
    | { readonly type: "invite"; readonly role?: string }
    | { readonly type: "members" }
    | { readonly type: "providers"; readonly scope?: "team" | "private" }
    | { readonly type: "computeJoin"; readonly pool?: string }
    | { readonly type: "serverLink" };

export type ChatActionBlock =
    | { readonly kind: "menu"; readonly buttons: readonly ChatActionButton[] }
    | {
          readonly kind: "checklist";
          /** Drawn as a table under these headings: the checkbox's, the item's, then one per cell. */
          readonly table?: { readonly columns: readonly string[] };
          readonly options: readonly ChatChecklistOption[];
          readonly submit: {
              readonly label: string;
              /** The submit's label while nothing is ticked. */
              readonly emptyLabel?: string;
              readonly emphasized: boolean;
          };
          /** Buttons after the submit, `controlIndex` 1, 2, … in order. */
          readonly others: readonly ChatActionButton[];
          /** What submitting runs with the ticked values; absent when it cannot be pressed. */
          readonly action?: ChatAction;
      }
    | {
          /** One single-line field and its submit. What is typed goes to the action only. */
          readonly kind: "code";
          readonly placeholder: string;
          readonly submit: { readonly label: string; readonly emphasized: boolean };
          readonly action?: ChatAction;
      }
    | {
          readonly kind: "steps";
          readonly steps: readonly {
              readonly status: ChatStepStatus;
              readonly label: string;
              readonly detail?: string;
              readonly mark?: ChatActionMark;
          }[];
      }
    | {
          readonly kind: "status";
          readonly status: ChatStatusTone;
          readonly text: string;
          readonly detail?: string;
      }
    | { readonly kind: "tree"; readonly nodes: readonly ChatTreeNode[] }
    | { readonly kind: "figure"; readonly figure: ChatFigure };

/**
 * Markdown split around its inline action blocks; the segments' text joined in order is the
 * input. An `action` segment that is not `complete` is always the last.
 */
export type ChatActionBlockSegment =
    | { type: "markdown"; text: string }
    | { type: "action"; html: string; complete: boolean };

/** Only this many blocks of one message are read; later ones are counted but unreadable. */
export const MAX_CHAT_ACTION_BLOCKS = 32;

const ROOTS = ["menu", "form", "output", "ol", "ul", "figure"];
const PLAIN_START = /^ {0,3}<(menu|form|output)(?=[\t\n\f\r />]|$)/u;
const DATA_START = /^ {0,3}<(ol|ul|figure)(?:[\t ][^>\n]*)?[\t ]data-[a-z]/u;
const MAX_LABEL = 200;
const MAX_DETAIL = 1_000;
const MAX_VALUE = 256;
const MAX_BUTTONS = 16;
const MAX_OPTIONS = 64;
const MAX_OTHERS = 4;
const MAX_STEPS = 32;
const MAX_PARAMS = 8;
const STEP_STATUSES: readonly ChatStepStatus[] = ["pending", "running", "done", "failed"];
const STATUS_TONES: readonly ChatStatusTone[] = ["info", "running", "done", "failed"];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
/** Attributes the grammar reads itself, which are never an action's parameters. */
const RESERVED_DATA = new Set([
    "data-action",
    "data-emphasis",
    "data-mark",
    "data-connected",
    "data-empty-label",
    "data-table",
    "data-columns",
]);

/**
 * Splits Markdown into Markdown and the inline action blocks in it. Run it on the Markdown that
 * `splitMediaLayoutBlocks` leaves outside its layouts, as `chatActionBlocksOf` does.
 */
export function splitChatActionBlocks(markdown: string): ChatActionBlockSegment[] {
    return splitHtmlBlocks(markdown, {
        start: (line) => (PLAIN_START.exec(line) ?? DATA_START.exec(line))?.[1],
        partial: (name) => ROOTS.some((root) => root.startsWith(name)),
        keep: () => true,
    }).map((segment) =>
        segment.type === "markdown"
            ? segment
            : { type: "action", html: segment.html, complete: segment.complete },
    );
}

/** The complete action blocks of one text in `blockIndex` order, outside media layouts. */
function completeBlocksOf(markdown: string): string[] {
    const blocks: string[] = [];
    for (const part of splitMediaLayoutBlocks(markdown)) {
        if (part.type !== "markdown") continue;
        for (const segment of splitChatActionBlocks(part.text)) {
            if (segment.type === "action" && segment.complete) blocks.push(segment.html);
        }
    }
    return blocks;
}

/**
 * Every complete block of a message's text blocks, in order, read or `undefined`: the array's
 * index is the block's `blockIndex`. Only the first `MAX_CHAT_ACTION_BLOCKS` are read.
 */
export function messageChatActionBlocks(texts: readonly string[]): (ChatActionBlock | undefined)[] {
    return texts
        .flatMap(completeBlocksOf)
        .map((html, index) =>
            index < MAX_CHAT_ACTION_BLOCKS ? parseChatActionBlock(html) : undefined,
        );
}

/** The blocks of one text, as `messageChatActionBlocks` numbers a message holding only it. */
export function chatActionBlocksOf(markdown: string): (ChatActionBlock | undefined)[] {
    return messageChatActionBlocks([markdown]);
}

/**
 * Markdown without its complete inline action blocks, for a surface that cannot press them, such
 * as a chat service a reply is relayed to. Media layouts stay; the blank lines around a removed
 * block close up to one; an incomplete block stays as written.
 */
export function stripChatActionBlocks(markdown: string): string {
    const segments: HtmlBlockSegment[] = [];
    for (const part of splitMediaLayoutBlocks(markdown)) {
        if (part.type !== "markdown") {
            segments.push({ type: "markdown", text: part.html });
            continue;
        }
        for (const segment of splitChatActionBlocks(part.text)) {
            segments.push(
                segment.type === "markdown"
                    ? segment
                    : { type: "block", html: segment.html, complete: segment.complete },
            );
        }
    }
    return stripHtmlBlocks(segments);
}

/**
 * Whether a message's blocks can still be pressed in a conversation: no person's message is
 * recorded after it. `history` is the conversation's recorded messages in order; pending messages
 * are not recorded yet, and roles other than `user` never count. A block also needs no choice.
 */
export function chatActionBlockLive(
    history: readonly { readonly id: string; readonly role: string }[],
    messageId: string,
): boolean {
    const at = history.findIndex((message) => message.id === messageId);
    return at !== -1 && !history.slice(at + 1).some((message) => message.role === "user");
}

/** The block one HTML fragment draws; undefined when it breaks the grammar. */
export function parseChatActionBlock(html: string): ChatActionBlock | undefined {
    const nodes = tokenizeChatActionHtml(html);
    const roots = nodes && elementsOf(nodes);
    if (roots?.length !== 1) return undefined;
    const root = roots[0]!;
    switch (root.name) {
        case "menu":
            return menuOf(root);
        case "form": {
            const first = elementsOf(root.children)?.[0];
            return first?.name === "input" && first.attributes.get("type") === "text"
                ? codeFieldOf(root)
                : checklistOf(root);
        }
        case "ol":
            return stepsOf(root);
        case "ul":
            return treeOf(root);
        case "output":
            return statusOf(root);
        case "figure":
            return figureOf(root);
        default:
            return undefined;
    }
}

function menuOf(root: ChatActionHtmlElement): ChatActionBlock | undefined {
    if (root.attributes.size > 0) return undefined;
    const children = elementsOf(root.children);
    if (!children || children.length === 0 || children.length > MAX_BUTTONS) return undefined;
    const emphasis = { taken: false };
    const buttons: ChatActionButton[] = [];
    for (const child of children) {
        if (child.name !== "button") return undefined;
        const button = buttonOf(child, emphasis, ["data-connected", "data-mark"]);
        if (button === undefined) return undefined;
        buttons.push(button);
    }
    return { kind: "menu", buttons };
}

/**
 * One button that names its own action: its label, presentation, and parameters. `allowed` are
 * the presentation attributes it may carry beyond `data-action` and `data-emphasis`.
 */
function buttonOf(
    element: ChatActionHtmlElement,
    emphasis: { taken: boolean },
    allowed: readonly string[],
    type?: "button",
): ChatActionButton | undefined {
    const label = plainText(element.children, MAX_LABEL);
    if (!label) return undefined;
    const params: Record<string, string> = {};
    let count = 0;
    for (const [name, value] of element.attributes) {
        if (name === "type" && type !== undefined) {
            if (value !== type) return undefined;
            continue;
        }
        if (name === "data-action" || name === "data-emphasis" || allowed.includes(name)) continue;
        const param = parameterName(name);
        if (param === undefined) return undefined;
        params[param] = value;
        count += 1;
        if (count > MAX_PARAMS) return undefined;
    }
    if (type !== undefined && element.attributes.get("type") !== type) return undefined;
    const id = element.attributes.get("data-action");
    const action = id === undefined ? undefined : chatActionOf(id, params, "button");
    const emphasized = !emphasis.taken && element.attributes.has("data-emphasis");
    if (emphasized) emphasis.taken = true;
    return {
        label,
        ...markOf(element.attributes),
        ...(element.attributes.has("data-connected") ? { connected: true as const } : {}),
        emphasized,
        ...(action === undefined ? {} : { action }),
    };
}

function checklistOf(root: ChatActionHtmlElement): ChatActionBlock | undefined {
    const form = formOf(root, ["data-table", "data-columns"]);
    const children = elementsOf(root.children);
    if (form === undefined || !children) return undefined;
    const table = root.attributes.has("data-table");
    const columns = columnsOf(root.attributes.get("data-columns"));
    if (table !== root.attributes.has("data-columns") || (table && columns === undefined)) {
        return undefined;
    }
    const emphasis = { taken: false };
    const options: ChatChecklistOption[] = [];
    const others: ChatActionButton[] = [];
    let submit: Extract<ChatActionBlock, { kind: "checklist" }>["submit"] | undefined;
    for (const child of children) {
        if (child.name === "label") {
            if (submit !== undefined || options.length >= MAX_OPTIONS) return undefined;
            const option = optionOf(child, columns);
            if (option === undefined || options.some((other) => other.value === option.value)) {
                return undefined;
            }
            options.push(option);
            continue;
        }
        if (child.name !== "button") return undefined;
        if (submit === undefined) {
            if (!onlyAttributes(child, ["type", "data-emphasis", "data-empty-label"])) {
                return undefined;
            }
            const label = plainText(child.children, MAX_LABEL);
            if (!label || child.attributes.get("type") !== "submit") return undefined;
            const empty = child.attributes.get("data-empty-label");
            const emptyLabel = empty === undefined ? undefined : collapsed(empty, MAX_LABEL);
            if (empty !== undefined && !emptyLabel) return undefined;
            const emphasized = child.attributes.has("data-emphasis");
            if (emphasized) emphasis.taken = true;
            submit = { label, ...(emptyLabel ? { emptyLabel } : {}), emphasized };
            continue;
        }
        if (others.length >= MAX_OTHERS || !child.attributes.has("data-action")) return undefined;
        const other = buttonOf(child, emphasis, [], "button");
        if (other === undefined) return undefined;
        others.push(other);
    }
    if (submit === undefined || options.length === 0) return undefined;
    const action = chatActionOf(form.id, form.params, "checklist");
    return {
        kind: "checklist",
        ...(columns === undefined ? {} : { table: { columns } }),
        options,
        submit,
        others,
        ...(action === undefined ? {} : { action }),
    };
}

/** One checklist row: its checkbox first, then its label and its details or cells. */
function optionOf(
    label: ChatActionHtmlElement,
    columns: readonly string[] | undefined,
): ChatChecklistOption | undefined {
    if (!onlyAttributes(label, ["data-mark"])) return undefined;
    const first = label.children.findIndex((node) => node.type === "element");
    const input = label.children[first];
    if (
        input?.type !== "element" ||
        input.name !== "input" ||
        plainText(label.children.slice(0, first), Infinity) !== "" ||
        !onlyAttributes(input, ["type", "value", "checked", "disabled"]) ||
        input.attributes.get("type") !== "checkbox"
    ) {
        return undefined;
    }
    const value = input.attributes.get("value");
    if (!value || value.length > MAX_VALUE) return undefined;
    const rest = label.children.slice(first + 1);
    const state = {
        ...markOf(label.attributes),
        checked: input.attributes.has("checked"),
        disabled: input.attributes.has("disabled"),
    };
    if (columns === undefined) {
        const text = labelled(rest, MAX_LABEL);
        return text === undefined ? undefined : { value, ...text, ...state };
    }
    const row = textThenSmalls(rest);
    if (row === undefined) return undefined;
    const count = columns.length - 2;
    if (row.smalls.length !== count && row.smalls.length !== count + 1) return undefined;
    const detail = row.smalls.length > count ? row.smalls[0] : undefined;
    return {
        value,
        label: row.label,
        ...(detail ? { detail } : {}),
        cells: row.smalls.slice(row.smalls.length - count),
        ...state,
    };
}

function codeFieldOf(root: ChatActionHtmlElement): ChatActionBlock | undefined {
    const form = formOf(root, []);
    const children = elementsOf(root.children);
    if (form === undefined || children?.length !== 2) return undefined;
    const [field, button] = children as [ChatActionHtmlElement, ChatActionHtmlElement];
    if (
        field.name !== "input" ||
        !onlyAttributes(field, ["type", "placeholder"]) ||
        field.attributes.get("type") !== "text" ||
        button.name !== "button" ||
        !onlyAttributes(button, ["type", "data-emphasis"]) ||
        button.attributes.get("type") !== "submit"
    ) {
        return undefined;
    }
    const placeholder = collapsed(field.attributes.get("placeholder") ?? "", MAX_LABEL);
    const label = plainText(button.children, MAX_LABEL);
    if (placeholder === undefined || !label) return undefined;
    const action = chatActionOf(form.id, form.params, "code");
    return {
        kind: "code",
        placeholder,
        submit: { label, emphasized: button.attributes.has("data-emphasis") },
        ...(action === undefined ? {} : { action }),
    };
}

/** A form's action ID and parameters; `allowed` are the presentation attributes it may carry. */
function formOf(
    root: ChatActionHtmlElement,
    allowed: readonly string[],
): { id: string; params: Record<string, string> } | undefined {
    const id = root.attributes.get("data-action");
    if (!id) return undefined;
    const params: Record<string, string> = {};
    let count = 0;
    for (const [name, value] of root.attributes) {
        if (name === "data-action" || allowed.includes(name)) continue;
        const param = parameterName(name);
        if (param === undefined) return undefined;
        params[param] = value;
        count += 1;
        if (count > MAX_PARAMS) return undefined;
    }
    return { id, params };
}

function stepsOf(root: ChatActionHtmlElement): ChatActionBlock | undefined {
    if (!onlyAttributes(root, ["data-steps"]) || !root.attributes.has("data-steps")) {
        return undefined;
    }
    const children = elementsOf(root.children);
    if (!children || children.length === 0 || children.length > MAX_STEPS) return undefined;
    const steps: Extract<ChatActionBlock, { kind: "steps" }>["steps"][number][] = [];
    for (const child of children) {
        const status = STEP_STATUSES.find((value) => value === child.attributes.get("data-status"));
        if (child.name !== "li" || !onlyAttributes(child, ["data-status", "data-mark"])) {
            return undefined;
        }
        const text = labelled(child.children, MAX_LABEL);
        if (status === undefined || text === undefined) return undefined;
        steps.push({ status, ...text, ...markOf(child.attributes) });
    }
    return { kind: "steps", steps };
}

function statusOf(root: ChatActionHtmlElement): ChatActionBlock | undefined {
    if (!onlyAttributes(root, ["data-status"])) return undefined;
    const status = STATUS_TONES.find(
        (value) => value === (root.attributes.get("data-status") ?? "info"),
    );
    const text = labelled(root.children, MAX_DETAIL);
    if (status === undefined || text === undefined) return undefined;
    return {
        kind: "status",
        status,
        text: text.label,
        ...(text.detail === undefined ? {} : { detail: text.detail }),
    };
}

function treeOf(root: ChatActionHtmlElement): ChatActionBlock | undefined {
    if (!onlyAttributes(root, ["data-tree"]) || !root.attributes.has("data-tree")) {
        return undefined;
    }
    const nodes = treeNodesOf(root);
    return nodes !== undefined && nodes.length > 0 ? { kind: "tree", nodes } : undefined;
}

/** A list's places: each `<li>` its name, then at most one `<ul>` of what is inside it. */
function treeNodesOf(list: ChatActionHtmlElement): ChatTreeNode[] | undefined {
    const items = elementsOf(list.children);
    if (!items) return undefined;
    const nodes: ChatTreeNode[] = [];
    for (const item of items) {
        if (item.name !== "li" || item.attributes.size > 0) return undefined;
        const nested = item.children.findIndex((node) => node.type === "element");
        const inner = item.children[nested];
        const name = plainText(
            nested === -1 ? item.children : item.children.slice(0, nested),
            MAX_LABEL,
        );
        if (!name) return undefined;
        if (inner === undefined) {
            nodes.push({ name, children: [] });
            continue;
        }
        if (
            inner.type !== "element" ||
            inner.name !== "ul" ||
            inner.attributes.size > 0 ||
            plainText(item.children.slice(nested + 1), Infinity) !== ""
        ) {
            return undefined;
        }
        const children = treeNodesOf(inner);
        if (children === undefined || children.length === 0) return undefined;
        nodes.push({ name, children });
    }
    return nodes;
}

function figureOf(root: ChatActionHtmlElement): ChatActionBlock | undefined {
    if (elementsOf(root.children)?.length !== 0) return undefined;
    const attributes = root.attributes;
    const flag = (name: string, optional: readonly string[]): boolean =>
        attributes.get(name) === "" && onlyAttributes(root, [name, ...optional]);
    const optional = (name: string): string | undefined | null => {
        const value = attributes.get(name);
        if (value === undefined) return undefined;
        return IDENTIFIER.test(value) ? value : null;
    };
    const scope = (name: string): "team" | "private" | undefined | null => {
        const value = attributes.get(name);
        if (value === undefined) return undefined;
        return value === "team" || value === "private" ? value : null;
    };
    const figure = (value: ChatFigure): ChatActionBlock => ({ kind: "figure", figure: value });
    if (attributes.has("data-provider-cli")) {
        const cliId = attributes.get("data-provider-cli")!;
        const target = scope("data-target");
        if (!onlyAttributes(root, ["data-provider-cli", "data-target"])) return undefined;
        if (!IDENTIFIER.test(cliId) || target === null) return undefined;
        return figure({ type: "providerCli", cliId, ...(target ? { target } : {}) });
    }
    if (attributes.has("data-setting")) {
        if (!onlyAttributes(root, ["data-setting"])) return undefined;
        return attributes.get("data-setting") === "default-model"
            ? figure({ type: "setting", setting: "default-model" })
            : undefined;
    }
    if (flag("data-phone-app", [])) return figure({ type: "phoneApp" });
    if (flag("data-phone-pair", [])) return figure({ type: "phonePair" });
    if (flag("data-members", [])) return figure({ type: "members" });
    if (flag("data-server-link", [])) return figure({ type: "serverLink" });
    if (flag("data-invite", ["data-role"])) {
        const role = optional("data-role");
        return role === null ? undefined : figure({ type: "invite", ...(role ? { role } : {}) });
    }
    if (flag("data-providers", ["data-scope"])) {
        const value = scope("data-scope");
        return value === null
            ? undefined
            : figure({ type: "providers", ...(value ? { scope: value } : {}) });
    }
    if (flag("data-compute-join", ["data-pool"])) {
        const pool = optional("data-pool");
        return pool === null
            ? undefined
            : figure({ type: "computeJoin", ...(pool ? { pool } : {}) });
    }
    return undefined;
}

/** `data-X` as the action parameter `X`, or undefined for any attribute that is not one. */
function parameterName(attribute: string): string | undefined {
    if (!attribute.startsWith("data-") || RESERVED_DATA.has(attribute)) return undefined;
    const name = attribute.slice(5);
    return CHAT_ACTION_PARAMETER_NAME.test(name) ? name : undefined;
}

function onlyAttributes(element: ChatActionHtmlElement, allowed: readonly string[]): boolean {
    for (const name of element.attributes.keys()) if (!allowed.includes(name)) return false;
    return true;
}

function markOf(attributes: ReadonlyMap<string, string>): { mark?: ChatActionMark } {
    const mark = CHAT_ACTION_MARKS.find((value) => value === attributes.get("data-mark"));
    return mark === undefined ? {} : { mark };
}

/** `data-columns`: 3–6 headings separated by `|`, each 1–40 characters. */
function columnsOf(value: string | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    const columns = value.split("|").map((column) => collapsed(column, 40));
    if (columns.length < 3 || columns.length > 6) return undefined;
    return columns.every((column) => column) ? (columns as string[]) : undefined;
}

/** The elements among `nodes`; undefined when any other node is not blank text. */
function elementsOf(nodes: readonly ChatActionHtmlNode[]): ChatActionHtmlElement[] | undefined {
    const elements: ChatActionHtmlElement[] = [];
    for (const node of nodes) {
        if (node.type === "element") elements.push(node);
        else if (collapsed(node.text, Infinity) !== "") return undefined;
    }
    return elements;
}

/** Text with its whitespace collapsed the way HTML collapses it; undefined when too long. */
function collapsed(text: string, max: number): string | undefined {
    const value = text.replace(/[ \t\n\r]+/gu, " ").trim();
    return value.length > max || hasForbiddenCharacter(value) ? undefined : value;
}

/** The collapsed text of nodes that are only text; undefined when any is an element. */
function plainText(nodes: readonly ChatActionHtmlNode[], max: number): string | undefined {
    let text = "";
    for (const node of nodes) {
        if (node.type !== "text") return undefined;
        text += node.text;
    }
    return collapsed(text, max);
}

/** A label, then any number of `<small>` details with only blank text between them. */
function textThenSmalls(
    nodes: readonly ChatActionHtmlNode[],
): { label: string; smalls: string[] } | undefined {
    const first = nodes.findIndex((node) => node.type === "element");
    const label = plainText(first === -1 ? nodes : nodes.slice(0, first), MAX_LABEL);
    if (!label) return undefined;
    const smalls: string[] = [];
    for (const node of first === -1 ? [] : nodes.slice(first)) {
        if (node.type === "text") {
            if (collapsed(node.text, Infinity) !== "") return undefined;
            continue;
        }
        if (node.name !== "small" || node.attributes.size > 0) return undefined;
        const cell = plainText(node.children, MAX_LABEL);
        if (cell === undefined) return undefined;
        smalls.push(cell);
    }
    return { label, smalls };
}

/** A label of at most `max` characters followed, optionally, by one `<small>` detail. */
function labelled(
    nodes: readonly ChatActionHtmlNode[],
    max: number,
): { label: string; detail?: string } | undefined {
    const first = nodes.findIndex((node) => node.type === "element");
    const label = plainText(first === -1 ? nodes : nodes.slice(0, first), max);
    if (!label) return undefined;
    if (first === -1) return { label };
    const small = nodes[first] as ChatActionHtmlElement;
    if (small.name !== "small" || small.attributes.size > 0) return undefined;
    const detail = plainText(small.children, MAX_DETAIL);
    if (detail === undefined || plainText(nodes.slice(first + 1), Infinity) !== "") {
        return undefined;
    }
    return detail ? { label, detail } : { label };
}
