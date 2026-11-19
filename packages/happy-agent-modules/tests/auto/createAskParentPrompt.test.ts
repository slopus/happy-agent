import { describe, expect, it } from "vitest";

import {
    ASK_PARENT_NO_CONVERSATION,
    createAskParentPrompt,
} from "../../sources/auto/impl/createAskParentPrompt.js";

describe("createAskParentPrompt", () => {
    const options = {
        conversation: "[1] user: Push HEAD to main.",
        agentId: "parentagent",
        subagentId: "childagent",
        question: "Did the person ask for a push to main?",
    };

    it("asks the question in place of a proposed action", () => {
        expect(createAskParentPrompt({ ...options, canAskParent: false })).toBe(
            [
                "<conversation>",
                "[1] user: Push HEAD to main.",
                "</conversation>",
                "",
                "<reviewed_agent_id>parentagent</reviewed_agent_id>",
                "",
                "<subagent_id>childagent</subagent_id>",
                "",
                "<question>",
                "Did the person ask for a push to main?",
                "</question>",
                "",
                'There is no proposed action to judge. The permission reviewer of the agent in `<subagent_id>`, which the agent in `<reviewed_agent_id>` created, is judging an action that subagent wants to take and asks the question above. You are a temporary copy of the permission reviewer of the agent in `<reviewed_agent_id>`: you are discarded once you answer, and only the asking reviewer reads your answer. Answer truthfully and briefly from the conversation above and any history you can read. Quote the person\'s own words when they settle the question, and say whether they come from a user message. If the evidence does not establish the answer, say "unknown"; never invent or assume authorization. Answer in plain text, without a <review> block.',
            ].join("\n"),
        );
    });

    it("lets the fork ask further up only when it can", () => {
        const escalation =
            "If only the agent that created the agent in `<reviewed_agent_id>` can know, ask it with `ask_parent` before you answer. Answer in plain text";
        expect(createAskParentPrompt({ ...options, canAskParent: true })).toContain(escalation);
        expect(createAskParentPrompt({ ...options, canAskParent: false })).not.toContain(
            "ask_parent",
        );
    });

    it("says so when the parent has no recorded conversation", () => {
        expect(
            createAskParentPrompt({ ...options, conversation: "", canAskParent: false }),
        ).toContain(`<conversation>\n${ASK_PARENT_NO_CONVERSATION}\n</conversation>`);
    });
});
