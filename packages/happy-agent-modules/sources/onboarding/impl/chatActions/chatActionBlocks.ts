// Copied from happy-desktop `happy-desktop-state/src/chatActions` (chat-onboarding, 9da732b7). The
// daemon validates presses with the same grammar clients draw; both move into
// @slopus/happy-agent-client with its next release. Keep the copies identical until then.
import { chatActionParse, type ChatAction } from "./chatAction.js";

/**
 * Inline UI an agent writes into its reply: a small, closed subset of HTML with
 * no scripts and no styles, drawn by Happy where it was written. It is the same
 * approach as a reply's image layouts — plain HTML, found as blocks at the start
 * of a line, and checked again before anything is drawn — with four blocks of
 * its own:
 *
 * ```html
 * <menu>
 *   <button data-action="onboarding.provider" data-provider="claude">Claude</button>
 *   <button data-action="reply" data-text="Not now">Not now</button>
 * </menu>
 *
 * <form data-action="onboarding.workAccept">
 *   <label><input type="checkbox" value="t1" checked>Ship onboarding <small>12 commits</small></label>
 *   <button type="submit" data-emphasis>Looks right</button>
 * </form>
 *
 * <ol data-steps>
 *   <li data-status="done">Install Claude Code <small>v2.1</small></li>
 *   <li data-status="running">Sign in</li>
 * </ol>
 *
 * <output data-status="info">Nothing is connected yet.</output>
 *
 * <ul data-tree>
 *   <li>~<ul><li>.codex<ul><li>sessions</li></ul></li></ul></li>
 * </ul>
 *
 * <figure data-phone-app></figure>
 * <figure data-provider-cli="codex"></figure>
 * <figure data-setting="default-model"></figure>
 * <figure data-sidebar-proposal="ARTIFACT_ID"></figure>
 * ```
 *
 * A tree is the places something will be read, drawn as the app's file tree.
 * A figure carries nothing but what it names: the codes that download Happy's
 * phone app, the phone pairing, one provider CLI's install and sign-in, or one
 * setting, each drawn live by the app from the daemon's own state.
 *
 * A checklist marked `data-table` is drawn as a table whose column headings
 * belong to its action (`CHAT_TABLE_COLUMNS`), never to the markup: each label
 * is a row, its text the item column, and its `<small>`s the cells after it,
 * the first one the item's own sub-line when there is one more than the
 * columns hold. A form whose one field is `<input type="text">` is a code
 * field: what is typed goes to its action and is never written into the chat.
 *
 * A button carries an explicit action and its parameters (`chatActionParse`).
 * At most one control in a block is emphasized: the first `data-emphasis`
 * counts and any other is drawn plain. A block that breaks the grammar is not
 * drawn as UI; it stays the inert HTML it was written as.
 */

/** A product mark a button or step may carry before its label: the subscription it names. */
export type ChatActionMark = "claude" | "openai" | "grok" | "gemini";
export const CHAT_ACTION_MARKS: readonly ChatActionMark[] = ["claude", "openai", "grok", "gemini"];

function markOf(attributes: ReadonlyMap<string, string>): { readonly mark?: ChatActionMark } {
    const mark = CHAT_ACTION_MARKS.find((value) => value === attributes.get("data-mark"));
    return mark ? { mark } : {};
}

export type ChatActionButton = {
    readonly label: string;
    readonly mark?: ChatActionMark;
    /** What it names is connected already (`data-connected`): a green check rides its corner. */
    readonly connected?: true;
    /** What pressing it runs; absent for an action this build does not know. */
    readonly action?: ChatAction;
    readonly emphasized: boolean;
};

/**
 * The column headings of each action's checklist table, after the checkbox's
 * own column: the item, then one per cell. Typed with the action, so a
 * heading is never read out of the reply's prose.
 */
export const CHAT_TABLE_COLUMNS: Readonly<Partial<Record<ChatAction["id"], readonly string[]>>> = {
    "onboarding.providersUse": ["Use", "AI", "Account", "Route"],
    "onboarding.routesUse": ["Use", "AI", "How", "Account"],
    "onboarding.workAccept": ["Keep", "Work", "Topic", "First message"],
};

export type ChatChecklistOption = {
    readonly value: string;
    readonly label: string;
    readonly mark?: ChatActionMark;
    /** The clay icon the item wears, by library slug (`data-icon`). */
    readonly icon?: string;
    /** Work with a standing job rather than a one-off (`data-ongoing`). */
    readonly ongoing?: true;
    /** The item's sub-line; in a table, under its label in the item column. */
    readonly detail?: string;
    /** In a table, the cells after the item column, one per heading. */
    readonly cells?: readonly string[];
    /** Ticked when the block is first drawn. */
    readonly checked: boolean;
    /** Shown but cannot be changed. */
    readonly disabled: boolean;
};

export type ChatStepStatus = "pending" | "running" | "done" | "failed";
export type ChatStatusTone = "info" | "running" | "done" | "failed";

export type ChatActionBlock =
    | { readonly kind: "buttons"; readonly buttons: readonly ChatActionButton[] }
    | {
          readonly kind: "checklist";
          /** Drawn as a table under these headings: the checkbox's, the item's, then one per cell. */
          readonly table?: { readonly columns: readonly string[] };
          readonly options: readonly ChatChecklistOption[];
          readonly submit: {
              readonly label: string;
              /** The submit's label while nothing is ticked (`data-empty-label`). */
              readonly emptyLabel?: string;
              readonly emphasized: boolean;
              /** Whether the form names an action this build runs. */
              readonly available: boolean;
          };
          /** Plain buttons after the submit, such as Adjust: pressing one locks the list too. */
          readonly others: readonly ChatActionButton[];
          /** The form's own action id and parameters, completed by the ticked values. */
          readonly actionId: string;
          readonly attributes: ReadonlyMap<string, string>;
      }
    | {
          readonly kind: "steps";
          readonly steps: readonly {
              readonly status: ChatStepStatus;
              readonly mark?: ChatActionMark;
              readonly label: string;
              readonly detail?: string;
          }[];
      }
    | {
          readonly kind: "status";
          readonly status: ChatStatusTone;
          readonly text: string;
          readonly detail?: string;
      }
    | { readonly kind: "tree"; readonly nodes: readonly ChatTreeNode[] }
    | { readonly kind: "phoneApp" }
    /** The caller's current phone pairing, drawn live; the block itself carries nothing. */
    | { readonly kind: "phonePair" }
    /** One provider CLI by its ID, drawn live with its own install and sign-in controls. */
    | { readonly kind: "providerCli"; readonly cliId: string }
    /** One setting by its name, such as `default-model`, drawn live with a way to change it. */
    | { readonly kind: "setting"; readonly setting: string }
    /** A sidebar proposal, by its artifact ID, drawn live as a read-only preview. */
    | { readonly kind: "sidebarProposal"; readonly artifactId: string }
    | {
          /** One single-line field and its submit. The text goes to the action only. */
          readonly kind: "code";
          readonly placeholder: string;
          readonly submit: { readonly label: string };
          readonly actionId: string;
          readonly attributes: ReadonlyMap<string, string>;
      };

/** One place in a tree block: a folder or file name, and what is inside it. */
export type ChatTreeNode = {
    readonly name: string;
    readonly children: readonly ChatTreeNode[];
};

/**
 * What the person did with one block, held by whoever owns the conversation:
 * the button pressed, or the values a checklist was submitted with. A block
 * with a choice is locked.
 */
export type ChatActionChoice =
    | { readonly kind: "button"; readonly index: number }
    | { readonly kind: "checklist"; readonly values: readonly string[] };

/** One press or submit, as the block that took it reports it. */
export type ChatActionInvocation = {
    readonly blockKey: string;
    /** The message the block was written in. */
    readonly messageId: string;
    readonly choice: ChatActionChoice;
    readonly action: ChatAction;
    /** The words on the control pressed, as the person read them. */
    readonly label: string;
};

/** The action a checklist runs with these values ticked, or a code field with its text. */
export function chatChecklistAction(
    block: Extract<ChatActionBlock, { kind: "checklist" | "code" }>,
    values: readonly string[],
): ChatAction | undefined {
    return chatActionParse(block.actionId, block.attributes, values);
}

/** One stretch of a reply: Markdown, or an action block. Joined, they are the text exactly. */
export type ChatActionSegment =
    | { readonly type: "markdown"; readonly text: string }
    | {
          readonly type: "actions";
          readonly html: string;
          /** False for a block still open at the end of the text. */
          readonly complete: boolean;
          /** The block, when it is complete and keeps to the grammar. */
          readonly block?: ChatActionBlock;
      };

const BLOCK_START = /^ {0,3}<(menu|form|output|ol|ul|figure)(?=[\t\n\f\r />]|$)/iu;
const STEPS_START = /^ {0,3}<ol[\t\n\f\r ][^>]*\bdata-steps\b/iu;
const TREE_START = /^ {0,3}<ul[\t\n\f\r ][^>]*\bdata-tree\b/iu;
const FIGURE_START =
    /^ {0,3}<figure[\t\n\f\r ][^>]*\bdata-(?:phone-app|phone-pair|provider-cli|setting|sidebar-proposal)\b/iu;
const PARTIAL_START = /^ {0,3}<([a-z]*)$/iu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const ROOTS = ["menu", "form", "output", "ol", "ul", "figure"];

/** A reply's text cut into Markdown and the action blocks in it. */
export function chatActionSegments(text: string): readonly ChatActionSegment[] {
    if (!text.includes("<")) return [{ type: "markdown", text }];
    const segments: ChatActionSegment[] = [];
    const pushMarkdown = (part: string) => {
        if (part === "") return;
        const last = segments[segments.length - 1];
        if (last?.type === "markdown")
            segments[segments.length - 1] = { type: "markdown", text: last.text + part };
        else segments.push({ type: "markdown", text: part });
    };
    let markdownStart = 0;
    let lineStart = 0;
    let fence: string | undefined;
    while (lineStart < text.length) {
        const newline = text.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? text.length : newline + 1;
        const line = text.slice(lineStart, newline === -1 ? text.length : newline);
        const fenceOpen = FENCE.exec(line)?.[1];
        if (fence !== undefined) {
            if (
                fenceOpen !== undefined &&
                fenceOpen[0] === fence[0] &&
                fenceOpen.length >= fence.length
            )
                fence = undefined;
            lineStart = lineEnd;
            continue;
        }
        if (fenceOpen !== undefined) {
            fence = fenceOpen;
            lineStart = lineEnd;
            continue;
        }
        const start = BLOCK_START.exec(line);
        const tag = start?.[1]?.toLowerCase();
        const rest = text.slice(lineStart);
        if (
            tag !== undefined &&
            (tag !== "ol" || STEPS_START.test(rest)) &&
            (tag !== "ul" || TREE_START.test(rest)) &&
            (tag !== "figure" || FIGURE_START.test(rest))
        ) {
            pushMarkdown(text.slice(markdownStart, lineStart));
            const end = blockEnd(text, lineStart, tag);
            if (end === undefined) {
                segments.push({ type: "actions", html: text.slice(lineStart), complete: false });
                return segments;
            }
            const html = text.slice(lineStart, end);
            const block = chatActionBlockParse(html);
            segments.push(
                block
                    ? { type: "actions", html, complete: true, block }
                    : { type: "actions", html, complete: true },
            );
            markdownStart = end;
            lineStart = end;
            continue;
        }
        if (newline === -1) {
            const name = PARTIAL_START.exec(line)?.[1]?.toLowerCase();
            if (name !== undefined && name !== "" && ROOTS.some((root) => root.startsWith(name))) {
                pushMarkdown(text.slice(markdownStart, lineStart));
                segments.push({ type: "actions", html: line, complete: false });
                return segments;
            }
        }
        lineStart = lineEnd;
    }
    pushMarkdown(text.slice(markdownStart));
    return segments;
}

/** Where the block whose root `tag` opens at `start` ends: after the line its root closes on. */
function blockEnd(text: string, start: number, tag: string): number | undefined {
    const open = new RegExp(`<(/?)${tag}(?=[\\t\\n\\f\\r />])`, "giu");
    open.lastIndex = start;
    let depth = 0;
    for (let match = open.exec(text); match !== null; match = open.exec(text)) {
        const close = text.indexOf(">", match.index);
        if (close === -1) return undefined;
        depth += match[1] === "/" ? -1 : 1;
        open.lastIndex = close + 1;
        if (depth > 0) continue;
        const newline = text.indexOf("\n", close);
        return newline === -1 ? text.length : newline + 1;
    }
    return undefined;
}

type Node =
    | { readonly type: "text"; readonly text: string }
    | {
          readonly type: "element";
          readonly name: string;
          readonly attributes: ReadonlyMap<string, string>;
          readonly children: Node[];
      };

const VOID = new Set(["input", "br"]);
const ALLOWED = new Set([
    "menu",
    "form",
    "output",
    "ol",
    "ul",
    "figure",
    "li",
    "button",
    "label",
    "input",
    "small",
    "br",
]);
const ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
    middot: "·",
    hellip: "…",
    mdash: "—",
    ndash: "–",
};

function decode(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, name: string) => {
        if (name.startsWith("#x") || name.startsWith("#X"))
            return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
        if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
        return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

/** The block's element tree; nothing when it uses a tag outside the subset or does not nest. */
function tree(html: string): Node[] | undefined {
    const root: Node[] = [];
    const stack: { name: string; children: Node[] }[] = [{ name: "", children: root }];
    const tag = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gu;
    let at = 0;
    for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
        const top = stack[stack.length - 1]!;
        if (match.index > at)
            top.children.push({ type: "text", text: decode(html.slice(at, match.index)) });
        at = match.index + match[0].length;
        if (match[0].startsWith("<!--")) continue;
        const name = match[2]!.toLowerCase();
        if (!ALLOWED.has(name)) return undefined;
        if (match[1] === "/") {
            if (top.name !== name) return undefined;
            stack.pop();
            continue;
        }
        const attributes = new Map<string, string>();
        for (const attribute of (match[3] ?? "").matchAll(ATTRIBUTE)) {
            const key = attribute[1]!.toLowerCase();
            if (key.startsWith("on") || key === "style") return undefined;
            attributes.set(key, decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""));
        }
        const element: Node = { type: "element", name, attributes, children: [] };
        top.children.push(element);
        if (!VOID.has(name) && !(match[3] ?? "").trimEnd().endsWith("/"))
            stack.push({ name, children: element.children });
    }
    if (stack.length !== 1) return undefined;
    const rest = html.slice(at);
    if (rest.trim() !== "") root.push({ type: "text", text: decode(rest) });
    return root;
}

type Element = Extract<Node, { type: "element" }>;

function elements(nodes: readonly Node[]): Element[] | undefined {
    const found: Element[] = [];
    for (const node of nodes) {
        if (node.type === "element") found.push(node);
        else if (node.text.trim() !== "") return undefined;
    }
    return found;
}

/** Plain text of a run of text and line breaks, collapsed the way HTML collapses it. */
function plain(nodes: readonly Node[]): string | undefined {
    let text = "";
    for (const node of nodes) {
        if (node.type === "text") text += node.text;
        else if (node.name === "br") text += " ";
        else return undefined;
    }
    return text.replace(/\s+/gu, " ").trim();
}

/** A label followed, optionally, by one `<small>` detail. */
function labelled(nodes: readonly Node[]): { label: string; detail?: string } | undefined {
    const smallAt = nodes.findIndex((node) => node.type === "element" && node.name === "small");
    const head = smallAt === -1 ? nodes : nodes.slice(0, smallAt);
    const label = plain(head);
    if (!label) return undefined;
    if (smallAt === -1) return { label };
    const small = nodes[smallAt] as Element;
    const detail = plain(small.children);
    if (detail === undefined || plain(nodes.slice(smallAt + 1)) !== "") return undefined;
    return detail ? { label, detail } : { label };
}

/** A table row's label: its text, then its `<small>` cells; nothing else. */
function cellsOf(nodes: readonly Node[]): { label: string; smalls: string[] } | undefined {
    const smallAt = nodes.findIndex((node) => node.type === "element" && node.name === "small");
    const label = plain(smallAt === -1 ? nodes : nodes.slice(0, smallAt));
    if (!label) return undefined;
    const smalls: string[] = [];
    for (const node of smallAt === -1 ? [] : nodes.slice(smallAt)) {
        if (node.type === "text") {
            if (node.text.trim() !== "") return undefined;
            continue;
        }
        if (node.name !== "small") return undefined;
        const cell = plain(node.children);
        if (cell === undefined) return undefined;
        smalls.push(cell);
    }
    return { label, smalls };
}

function data(attributes: ReadonlyMap<string, string>): Map<string, string> {
    const params = new Map<string, string>();
    for (const [key, value] of attributes)
        if (
            key.startsWith("data-") &&
            key !== "data-action" &&
            key !== "data-emphasis" &&
            key !== "data-empty-label"
        )
            params.set(key.slice(5), value);
    return params;
}

const STEP_STATUSES: readonly ChatStepStatus[] = ["pending", "running", "done", "failed"];
const STATUS_TONES: readonly ChatStatusTone[] = ["info", "running", "done", "failed"];

/** The block one HTML fragment draws; nothing when it breaks the grammar. */
export function chatActionBlockParse(html: string): ChatActionBlock | undefined {
    const nodes = tree(html);
    const roots = nodes && elements(nodes);
    if (!roots || roots.length !== 1) return undefined;
    const root = roots[0]!;
    switch (root.name) {
        case "menu": {
            const children = elements(root.children);
            if (
                !children ||
                children.length === 0 ||
                children.some((child) => child.name !== "button")
            )
                return undefined;
            let emphasis = false;
            const buttons: ChatActionButton[] = [];
            for (const child of children) {
                const label = plain(child.children);
                if (!label) return undefined;
                const id = child.attributes.get("data-action");
                const action =
                    id === undefined ? undefined : chatActionParse(id, data(child.attributes));
                const emphasized: boolean = !emphasis && child.attributes.has("data-emphasis");
                emphasis ||= emphasized;
                buttons.push({
                    label,
                    ...markOf(child.attributes),
                    ...(child.attributes.has("data-connected") ? { connected: true as const } : {}),
                    ...(action ? { action } : {}),
                    emphasized,
                });
            }
            return { kind: "buttons", buttons };
        }
        case "form": {
            const actionId = root.attributes.get("data-action");
            const children = elements(root.children);
            if (actionId === undefined || !children) return undefined;
            const field = children[0];
            if (field?.name === "input" && field.attributes.get("type") === "text") {
                const button = children[1];
                const label = button && plain(button.children);
                if (
                    children.length !== 2 ||
                    button?.name !== "button" ||
                    button.attributes.get("type") !== "submit"
                )
                    return undefined;
                if (!label) return undefined;
                return {
                    kind: "code",
                    placeholder: field.attributes.get("placeholder") ?? "",
                    submit: { label },
                    actionId,
                    attributes: data(root.attributes),
                };
            }
            const columns = root.attributes.has("data-table")
                ? CHAT_TABLE_COLUMNS[actionId as ChatAction["id"]]
                : undefined;
            if (root.attributes.has("data-table") && !columns) return undefined;
            const options: ChatChecklistOption[] = [];
            const others: ChatActionButton[] = [];
            let submit: Extract<ChatActionBlock, { kind: "checklist" }>["submit"] | undefined;
            for (const child of children) {
                if (child.name === "button" && child.attributes.get("type") === "button") {
                    const label = plain(child.children);
                    const id = child.attributes.get("data-action");
                    if (!submit || !label || id === undefined) return undefined;
                    const action = chatActionParse(id, data(child.attributes));
                    others.push({ label, ...(action ? { action } : {}), emphasized: false });
                    continue;
                }
                if (child.name === "button") {
                    const label = plain(child.children);
                    if (submit || !label || child.attributes.get("type") !== "submit")
                        return undefined;
                    const emptyLabel = child.attributes.get("data-empty-label")?.trim();
                    submit = {
                        label,
                        ...(emptyLabel ? { emptyLabel } : {}),
                        emphasized: child.attributes.has("data-emphasis"),
                        available:
                            chatActionParse(actionId, data(root.attributes), []) !== undefined,
                    };
                    continue;
                }
                if (child.name !== "label" || submit) return undefined;
                const input = child.children.find(
                    (node): node is Element => node.type === "element" && node.name === "input",
                );
                const value = input?.attributes.get("value");
                if (!input || input.attributes.get("type") !== "checkbox" || !value)
                    return undefined;
                if (
                    child.children.indexOf(input) !==
                    child.children.findIndex((node) => node.type === "element")
                )
                    return undefined;
                const rest = child.children.filter((node) => node !== input);
                const icon = child.attributes.get("data-icon");
                const state = {
                    checked: input.attributes.has("checked"),
                    disabled: input.attributes.has("disabled"),
                    ...markOf(child.attributes),
                    ...(icon ? { icon } : {}),
                    ...(child.attributes.has("data-ongoing") ? { ongoing: true as const } : {}),
                };
                if (columns) {
                    /* The checkbox and item columns, then one cell per heading;
                       one more `<small>` than that is the item's sub-line. */
                    const row = cellsOf(rest);
                    const count = columns.length - 2;
                    if (!row || (row.smalls.length !== count && row.smalls.length !== count + 1))
                        return undefined;
                    const detail = row.smalls.length > count ? row.smalls[0] : undefined;
                    options.push({
                        value,
                        label: row.label,
                        ...(detail ? { detail } : {}),
                        cells: row.smalls.slice(row.smalls.length - count),
                        ...state,
                    });
                    continue;
                }
                const text = labelled(rest);
                if (!text) return undefined;
                options.push({ value, ...text, ...state });
            }
            if (!submit || options.length === 0) return undefined;
            return {
                kind: "checklist",
                ...(columns ? { table: { columns } } : {}),
                options,
                submit,
                others,
                actionId,
                attributes: data(root.attributes),
            };
        }
        case "ol": {
            const children = elements(root.children);
            if (!children || children.length === 0) return undefined;
            const steps = [];
            for (const child of children) {
                const status = STEP_STATUSES.find(
                    (value) => value === child.attributes.get("data-status"),
                );
                const text = child.name === "li" ? labelled(child.children) : undefined;
                if (!status || !text) return undefined;
                steps.push({ status, ...markOf(child.attributes), ...text });
            }
            return { kind: "steps", steps };
        }
        case "ul": {
            if (!root.attributes.has("data-tree")) return undefined;
            const nodes = treeNodes(root);
            return nodes && nodes.length > 0 ? { kind: "tree", nodes } : undefined;
        }
        case "figure": {
            if (elements(root.children)?.length !== 0) return undefined;
            if (root.attributes.has("data-phone-app")) return { kind: "phoneApp" };
            if (root.attributes.has("data-phone-pair")) return { kind: "phonePair" };
            const cliId = root.attributes.get("data-provider-cli")?.trim();
            if (cliId) return { kind: "providerCli", cliId };
            const artifactId = root.attributes.get("data-sidebar-proposal")?.trim();
            if (artifactId) return { kind: "sidebarProposal", artifactId };
            const setting = root.attributes.get("data-setting")?.trim();
            return setting ? { kind: "setting", setting } : undefined;
        }
        case "output": {
            const status = STATUS_TONES.find(
                (value) => value === (root.attributes.get("data-status") ?? "info"),
            );
            const text = labelled(root.children);
            if (!status || !text) return undefined;
            return {
                kind: "status",
                status,
                text: text.label,
                ...(text.detail ? { detail: text.detail } : {}),
            };
        }
        default:
            return undefined;
    }
}

/** A `<ul>`'s places: each `<li>` its name, then at most one `<ul>` of what is inside it. */
function treeNodes(list: Element): ChatTreeNode[] | undefined {
    const items = elements(list.children);
    if (!items) return undefined;
    const nodes: ChatTreeNode[] = [];
    for (const item of items) {
        if (item.name !== "li") return undefined;
        const nested = item.children.filter(
            (node): node is Element => node.type === "element" && node.name === "ul",
        );
        if (nested.length > 1) return undefined;
        const name = plain(item.children.filter((node) => node !== nested[0]))?.trim();
        if (!name) return undefined;
        const children = nested[0] ? treeNodes(nested[0]) : [];
        if (!children) return undefined;
        nodes.push({ name, children });
    }
    return nodes;
}

/** Text safe inside an attribute value or element of a block, for code that writes blocks. */
export function chatActionEscape(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}
