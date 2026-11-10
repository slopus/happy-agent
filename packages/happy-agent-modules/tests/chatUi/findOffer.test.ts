import type { UiDocument } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import { findOffer } from "../../sources/chatUi/impl/findOffer.js";
import { findSuggestion } from "../../sources/chatUi/impl/findSuggestion.js";
import type { HistoryBlock, HistoryMessage } from "../../sources/history/index.js";

const document: UiDocument = {
    id: "documentone",
    components: [{ id: "tree", type: "file_tree", fallback: "a.txt", props: { paths: ["a.txt"] } }],
};

function agentMessage(
    blocks: HistoryBlock[],
    fields: Partial<HistoryMessage> = {},
): HistoryMessage {
    return { role: "assistant", recordId: "messageone", blocks, ...fields };
}

/** A completed tool call carrying a `ui` presentation. */
function uiResult(toolName: string, fields: { readonly isError?: boolean } = {}): HistoryBlock {
    return {
        type: "tool_result",
        callId: "callone",
        toolName,
        presentation: { type: "ui", ui: document, items: [] },
        ...fields,
    };
}

function repliesResult(
    toolName: string,
    fields: { readonly isError?: boolean } = {},
): HistoryBlock {
    return {
        type: "tool_result",
        callId: "callone",
        toolName,
        presentation: { type: "quick_replies", options: ["Yes", "No"] },
        ...fields,
    };
}

describe("findOffer", () => {
    it("finds a component in a ui block the daemon wrote and in a completed show_ui call", () => {
        const expected = { document, component: document.components[0] };
        expect(
            findOffer(agentMessage([{ type: "ui", ui: document }]), "documentone", "tree"),
        ).toEqual(expected);
        expect(findOffer(agentMessage([uiResult("show_ui")]), "documentone", "tree")).toEqual(
            expected,
        );
    });

    it("takes no other tool's result for an offer, whatever presentation it carries", () => {
        expect(
            findOffer(agentMessage([uiResult("present_files")]), "documentone", "tree"),
        ).toBeUndefined();
        expect(
            findOffer(agentMessage([uiResult("mcp__any__show_ui")]), "documentone", "tree"),
        ).toBeUndefined();
        expect(
            findOffer(
                agentMessage([uiResult("show_ui", { isError: true })]),
                "documentone",
                "tree",
            ),
        ).toBeUndefined();
    });

    it("finds nothing outside a visible agent message, or under another ID", () => {
        const blocks: HistoryBlock[] = [{ type: "ui", ui: document }];
        expect(findOffer(undefined, "documentone", "tree")).toBeUndefined();
        expect(
            findOffer(agentMessage(blocks, { role: "user" }), "documentone", "tree"),
        ).toBeUndefined();
        expect(
            findOffer(agentMessage(blocks, { role: "service" }), "documentone", "tree"),
        ).toBeUndefined();
        expect(
            findOffer(agentMessage(blocks, { hideFromUser: true }), "documentone", "tree"),
        ).toBeUndefined();
        expect(findOffer(agentMessage(blocks), "documenttwo", "tree")).toBeUndefined();
        expect(findOffer(agentMessage(blocks), "documentone", "leaf")).toBeUndefined();
    });
});

describe("findSuggestion", () => {
    it("finds the daemon's own quick_replies block, and a completed suggest_replies call by its ID", () => {
        expect(
            findSuggestion(agentMessage([{ type: "quick_replies", options: ["Go"] }]), undefined),
        ).toEqual(["Go"]);
        expect(findSuggestion(agentMessage([repliesResult("suggest_replies")]), "callone")).toEqual(
            ["Yes", "No"],
        );
    });

    it("takes no other tool's result, no failed call, and no other call's ID for a suggestion", () => {
        expect(
            findSuggestion(agentMessage([repliesResult("ask_anything")]), "callone"),
        ).toBeUndefined();
        expect(
            findSuggestion(
                agentMessage([repliesResult("suggest_replies", { isError: true })]),
                "callone",
            ),
        ).toBeUndefined();
        expect(
            findSuggestion(agentMessage([repliesResult("suggest_replies")]), "calltwo"),
        ).toBeUndefined();
        // A call's suggestion is named by its call; the message alone names only a block.
        expect(
            findSuggestion(agentMessage([repliesResult("suggest_replies")]), undefined),
        ).toBeUndefined();
    });

    it("finds nothing in a message the person is not shown or did not get from an agent", () => {
        const blocks: HistoryBlock[] = [{ type: "quick_replies", options: ["Go"] }];
        expect(findSuggestion(agentMessage(blocks, { role: "user" }), undefined)).toBeUndefined();
        expect(
            findSuggestion(agentMessage(blocks, { hideFromUser: true }), undefined),
        ).toBeUndefined();
    });
});
