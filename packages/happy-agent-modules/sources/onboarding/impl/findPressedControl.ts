import { isDeepStrictEqual } from "node:util";

import type { HistoryActionChoice, HistoryMessage } from "../../history/index.js";
import { chatActionParse, type ChatAction } from "./chatActions/chatAction.js";
import {
    chatActionSegments,
    chatChecklistAction,
    type ChatActionBlock,
} from "./chatActions/chatActionBlocks.js";

/** One press, as the client describes the control it pressed. */
export interface ControlPress {
    readonly blockIndex: number;
    readonly action: { readonly id: string; readonly params: Readonly<Record<string, string>> };
    readonly values: readonly string[];
}

export type PressedControl =
    | { readonly kind: "found"; readonly action: ChatAction; readonly choice: HistoryActionChoice }
    | { readonly kind: "no_block" }
    | { readonly kind: "mismatch" };

/**
 * The control a press names, read from the daemon's own copy of the message: the block at
 * `blockIndex` among the valid action blocks of its text blocks in order, and the control in it
 * whose action and parameters are exactly the pressed ones. A label is never trusted.
 */
export function findPressedControl(message: HistoryMessage, press: ControlPress): PressedControl {
    const block = actionBlocks(message)[press.blockIndex];
    if (block === undefined) return { kind: "no_block" };
    const requested = chatActionParse(
        press.action.id,
        new Map(Object.entries(press.action.params)),
        press.values,
    );
    // Parameters the action does not read are not ignored: the press must name them exactly.
    if (requested === undefined || !isDeepStrictEqual(press.action.params, paramsOf(requested))) {
        return { kind: "mismatch" };
    }
    switch (block.kind) {
        case "buttons": {
            const index = block.buttons.findIndex((button) =>
                isDeepStrictEqual(button.action, requested),
            );
            return index === -1
                ? { kind: "mismatch" }
                : { kind: "found", action: requested, choice: { kind: "button", index } };
        }
        case "checklist": {
            const other = block.others.findIndex((button) =>
                isDeepStrictEqual(button.action, requested),
            );
            if (other !== -1 && press.values.length === 0) {
                return {
                    kind: "found",
                    action: requested,
                    choice: { kind: "button", index: 1 + other },
                };
            }
            // A ticked value must be one the list offers and the person could change, or one it
            // shows ticked and fixed.
            const allowed = new Set(
                block.options
                    .filter((option) => !option.disabled || option.checked)
                    .map((option) => option.value),
            );
            const values = [...new Set(press.values)];
            if (values.some((value) => !allowed.has(value))) return { kind: "mismatch" };
            const submitted = chatChecklistAction(block, values);
            return submitted !== undefined && isDeepStrictEqual(submitted, requested)
                ? { kind: "found", action: submitted, choice: { kind: "checklist", values } }
                : { kind: "mismatch" };
        }
        case "code": {
            const submitted = chatChecklistAction(block, press.values);
            return press.values.length === 1 &&
                submitted !== undefined &&
                isDeepStrictEqual(submitted, requested)
                ? { kind: "found", action: submitted, choice: { kind: "submitted" } }
                : { kind: "mismatch" };
        }
        default:
            return { kind: "mismatch" };
    }
}

/** The valid action blocks of a message's text blocks, in order: what `blockIndex` counts. */
export function actionBlocks(message: HistoryMessage): ChatActionBlock[] {
    return message.blocks.flatMap((block) =>
        block.type === "text"
            ? chatActionSegments(block.text).flatMap((segment) =>
                  segment.type === "actions" && segment.block !== undefined ? [segment.block] : [],
              )
            : [],
    );
}

/** The parameters a control writes for an action: its fields, less what a submit carries. */
function paramsOf(action: ChatAction): Record<string, string> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(action)) {
        if (key === "id" || key === "values") continue;
        if (key === "code" && action.id === "onboarding.codeEntry") continue;
        params[key] = String(value);
    }
    return params;
}
