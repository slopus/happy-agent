import type { UiDocument, UiWireComponent } from "@slopus/happy-agent-client";

import type { HistoryMessage } from "../../history/index.js";
import { visibleAgentMessage } from "./visibleAgentMessage.js";

/** The tool whose completed call is the only model-written offer. */
export const SHOW_UI_TOOL = "show_ui";

/**
 * The component an action names, in the daemon's own stored copy of the offer: a visible agent
 * message holding document `uiId`, as a `ui` block the daemon wrote or as the `ui` presentation of
 * a successful `show_ui` call, with component `componentId`. No other tool's result is an offer,
 * whatever presentation it carries, and nothing from the request is trusted beyond the IDs.
 */
export function findOffer(
    message: HistoryMessage | undefined,
    uiId: string,
    componentId: string,
): { readonly document: UiDocument; readonly component: UiWireComponent } | undefined {
    for (const block of visibleAgentMessage(message)?.blocks ?? []) {
        const document =
            block.type === "ui"
                ? block.ui
                : block.type === "tool_result" &&
                    block.toolName === SHOW_UI_TOOL &&
                    block.isError !== true &&
                    block.presentation?.type === "ui"
                  ? block.presentation.ui
                  : undefined;
        if (document?.id !== uiId) continue;
        const component = document.components.find((candidate) => candidate.id === componentId);
        return component === undefined ? undefined : { document, component };
    }
    return undefined;
}
