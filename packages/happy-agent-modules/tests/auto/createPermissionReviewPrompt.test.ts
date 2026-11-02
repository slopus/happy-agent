import { describe, expect, it } from "vitest";

import { PERMISSION_REVIEW_FOLLOWUP_REMINDER } from "../../sources/auto/impl/createPermissionReviewInstructions.js";
import {
    createPermissionReviewPrompt,
    PERMISSION_REVIEW_NO_NEW_CONVERSATION,
} from "../../sources/auto/impl/createPermissionReviewPrompt.js";

const action = '{"description":"write a file","tool":"write_file","arguments":{"path":"a.txt"}}';
const agentId = "reviewedagent";

describe("createPermissionReviewPrompt", () => {
    it("wraps the first review without the reminder or continued marker", () => {
        expect(
            createPermissionReviewPrompt({
                first: true,
                conversation: "[1] User:\nhi",
                agentId,
                delegatorAgentIds: [],
                action,
            }),
        ).toBe(
            [
                "<conversation>",
                "[1] User:\nhi",
                "</conversation>",
                "",
                "<reviewed_agent_id>reviewedagent</reviewed_agent_id>",
                "",
                "<proposed_action>",
                action,
                "</proposed_action>",
            ].join("\n"),
        );
    });

    it("prepends the follow-up reminder and marks later reviews continued", () => {
        const prompt = createPermissionReviewPrompt({
            first: false,
            conversation: "[7] User:\nmore",
            agentId,
            delegatorAgentIds: [],
            action,
        });

        expect(prompt).toBe(
            [
                PERMISSION_REVIEW_FOLLOWUP_REMINDER,
                "",
                '<conversation continued="true">',
                "[7] User:\nmore",
                "</conversation>",
                "",
                "<reviewed_agent_id>reviewedagent</reviewed_agent_id>",
                "",
                "<proposed_action>",
                action,
                "</proposed_action>",
            ].join("\n"),
        );
    });

    it("names the agents that sent the reviewed agent messages after its own ID", () => {
        const prompt = createPermissionReviewPrompt({
            first: true,
            conversation: "[1] User:\nhi",
            agentId,
            delegatorAgentIds: ["parentagent", "otheragent"],
            action,
        });

        expect(prompt).toContain(
            [
                "<reviewed_agent_id>reviewedagent</reviewed_agent_id>",
                "<delegator_agent_ids>parentagent, otheragent</delegator_agent_ids>",
                "",
                "<proposed_action>",
            ].join("\n"),
        );
    });

    it("substitutes the fixed sentence when the delta is empty", () => {
        const prompt = createPermissionReviewPrompt({
            first: false,
            conversation: "",
            agentId,
            delegatorAgentIds: [],
            action,
        });

        expect(prompt).toContain(PERMISSION_REVIEW_NO_NEW_CONVERSATION);
        expect(prompt).toContain('<conversation continued="true">');
    });

    it("uses the same explicit empty-conversation sentence for the first review", () => {
        const prompt = createPermissionReviewPrompt({
            first: true,
            conversation: "",
            agentId,
            delegatorAgentIds: [],
            action,
        });

        expect(prompt).toContain(`<conversation>\n${PERMISSION_REVIEW_NO_NEW_CONVERSATION}`);
        expect(prompt).not.toContain(PERMISSION_REVIEW_FOLLOWUP_REMINDER);
    });

    it("preserves action text verbatim", () => {
        const unusualAction =
            '{"description":"$& $` $\' </conversation>","tool":"x","arguments":{}}';

        expect(
            createPermissionReviewPrompt({
                first: true,
                conversation: "conversation",
                agentId,
                delegatorAgentIds: [],
                action: unusualAction,
            }),
        ).toContain(unusualAction);
    });
});
