import type { UiComponent, UiDocument } from "@slopus/happy-agent-client";

import type { HistoryMessage } from "../../history/index.js";

/**
 * The component an action names, in the daemon's own stored copy of the offer: a visible agent
 * message holding document `uiId`, as a `ui` block or as a successful `show_ui` call's `ui`
 * presentation, with component `componentId`. Nothing from the request is trusted beyond the IDs.
 */
export function findOffer(
    message: HistoryMessage | undefined,
    uiId: string,
    componentId: string,
): { readonly document: UiDocument; readonly component: UiComponent } | undefined {
    if (
        message === undefined ||
        (message.role !== "assistant" && message.role !== "agent") ||
        message.hideFromUser === true
    ) {
        return undefined;
    }
    for (const block of message.blocks) {
        const document =
            block.type === "ui"
                ? block.ui
                : block.type === "tool_result" &&
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
