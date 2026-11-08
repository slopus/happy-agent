/**
 * How a server resolves a press on an inline action against its own stored copy of the message;
 * see "Pressing an inline action" in API.md. Nothing in the press is trusted: the block, the
 * control, the action, its parameters, and every value are read from the stored message, and the
 * words stored for the press come from there too, never from the request.
 */

import { hasForbiddenCharacter } from "./chatActionHtml.js";
import type { ChatAction } from "./chatActionRegistry.js";
import { messageChatActionBlocks } from "./chatActionBlocks.js";
import type { ActionChoice } from "./protocol/messages.js";

/** One press, as the person's client describes the control it pressed. */
export interface ChatActionPress {
    readonly blockIndex: number;
    readonly controlIndex: number;
    readonly actionId: string;
    readonly params: Readonly<Record<string, string>>;
    readonly values?: readonly string[];
}

/** The pressed message, as the server stores it. */
export interface ChatActionPressedMessage {
    /** The message's text blocks, in order. */
    readonly texts: readonly string[];
    /** The choices already recorded on it, by `blockIndex`. */
    readonly choices?: Readonly<Record<string, ActionChoice>>;
    /** Whether no person's message is recorded after it; see `chatActionBlockLive`. */
    readonly live: boolean;
}

export type ChatActionPressResolution =
    | {
          readonly kind: "found";
          readonly action: ChatAction;
          /** The choice to record on the pressed message. */
          readonly choice: ActionChoice;
          /** The person's message the press is stored as. */
          readonly words: string;
          /** A submitted checklist's ticked values, in the order it shows them. */
          readonly values: readonly string[];
          /** What was typed into a code field; never stored, returned, or logged. */
          readonly code?: string;
      }
    | {
          readonly kind: "error";
          readonly code: "not_found" | "invalid_request" | "conflict";
          /** A short English reason for the error body. */
          readonly reason: string;
      };

const MAX_VALUES = 64;
const MAX_CODE = 2_048;

/** The press checked against the stored message, and what to record and store for it. */
export function resolveChatActionPress(
    message: ChatActionPressedMessage,
    press: ChatActionPress,
): ChatActionPressResolution {
    const error = (code: "not_found" | "invalid_request" | "conflict", reason: string) =>
        ({ kind: "error", code, reason }) as const;
    const blocks = messageChatActionBlocks(message.texts);
    if (!Number.isInteger(press.blockIndex) || press.blockIndex < 0) {
        return error("invalid_request", "That block index is not valid.");
    }
    if (press.blockIndex >= blocks.length)
        return error("not_found", "That message has no such block.");
    const block = blocks[press.blockIndex];
    if (block === undefined) return error("invalid_request", "That block cannot be pressed.");
    if (message.choices?.[String(press.blockIndex)] !== undefined) {
        return error("conflict", "That was already chosen.");
    }
    if (!message.live) return error("conflict", "That message has been answered already.");
    const values = press.values ?? [];
    const control = controlOf(block, press.controlIndex);
    if (control === undefined) return error("invalid_request", "That block has no such control.");
    const action = control.action;
    if (
        action === undefined ||
        action.id !== press.actionId ||
        !sameParams(action.params, press.params)
    ) {
        return error("invalid_request", "That control does not run that action.");
    }
    switch (control.kind) {
        case "button": {
            if (values.length > 0) return error("invalid_request", "A button takes no values.");
            const words =
                action.id === "reply" && action.text !== undefined ? action.text : control.label;
            return {
                kind: "found",
                action,
                choice: { kind: "button", index: press.controlIndex },
                words,
                values: [],
            };
        }
        case "submit": {
            if (block.kind !== "checklist") break;
            if (values.length > MAX_VALUES || new Set(values).size !== values.length) {
                return error("invalid_request", "Those values are not valid.");
            }
            const changeable = new Set(
                block.options
                    .filter((option) => !option.disabled || option.checked)
                    .map((option) => option.value),
            );
            if (values.some((value) => !changeable.has(value))) {
                return error("invalid_request", "That checklist does not offer those values.");
            }
            const ticked = block.options.filter((option) => values.includes(option.value));
            const words =
                ticked.length > 0
                    ? `${block.submit.label}: ${ticked.map((option) => option.label).join(", ")}`
                    : (block.submit.emptyLabel ?? block.submit.label);
            const ordered = ticked.map((option) => option.value);
            return {
                kind: "found",
                action,
                choice: { kind: "checklist", values: ordered },
                words,
                values: ordered,
            };
        }
        case "code": {
            if (block.kind !== "code") break;
            const code = values[0];
            if (
                values.length !== 1 ||
                code === undefined ||
                code.length === 0 ||
                code.length > MAX_CODE ||
                hasForbiddenCharacter(code) ||
                /[\t\n\r]/u.test(code)
            ) {
                return error("invalid_request", "A code field takes one line of text.");
            }
            return {
                kind: "found",
                action,
                choice: { kind: "submitted" },
                words: block.submit.label,
                values: [],
                code,
            };
        }
    }
    return error("invalid_request", "That block has no such control.");
}

/** The control at `controlIndex` in a block, with the action it runs. */
function controlOf(
    block: NonNullable<ReturnType<typeof messageChatActionBlocks>[number]>,
    index: number,
):
    | { readonly kind: "button"; readonly label: string; readonly action?: ChatAction }
    | { readonly kind: "submit" | "code"; readonly action?: ChatAction }
    | undefined {
    if (!Number.isInteger(index) || index < 0) return undefined;
    switch (block.kind) {
        case "menu": {
            const button = block.buttons[index];
            return button === undefined ? undefined : { kind: "button", ...button };
        }
        case "checklist": {
            if (index === 0)
                return { kind: "submit", ...(block.action ? { action: block.action } : {}) };
            const other = block.others[index - 1];
            return other === undefined ? undefined : { kind: "button", ...other };
        }
        case "code":
            return index === 0
                ? { kind: "code", ...(block.action ? { action: block.action } : {}) }
                : undefined;
        default:
            return undefined;
    }
}

function sameParams(
    written: Readonly<Record<string, string>>,
    pressed: Readonly<Record<string, string>>,
): boolean {
    const keys = Object.keys(written);
    return (
        keys.length === Object.keys(pressed).length &&
        keys.every((key) => Object.hasOwn(pressed, key) && pressed[key] === written[key])
    );
}
