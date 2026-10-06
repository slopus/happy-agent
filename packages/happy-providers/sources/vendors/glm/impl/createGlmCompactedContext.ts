import type { SessionContext, SessionMessage } from "@/core/SessionContext.js";
import { glmCompactionPrefix } from "../prompts/glm_compaction_instructions.js";

/** Claude Code 2.1.207's summary formatter ($Hg) and continuation text (w3r). */
export function createGlmCompactedContext(
    context: SessionContext,
    summary: string,
): {
    context: SessionContext;
    preservedMessages: readonly SessionMessage[];
} {
    const formatted = summary
        .replace(/<analysis>[\s\S]*?<\/analysis>/u, "")
        .replace(
            /<summary>([\s\S]*?)<\/summary>/u,
            (_match: string, content: string) => `Summary:\n${content.trim()}`,
        )
        .replace(/\n\n+/gu, "\n\n")
        .trim();
    return {
        preservedMessages: [],
        context: {
            instructions: context.instructions,
            messages: [
                {
                    role: "compaction",
                    content: `${glmCompactionPrefix}${formatted}\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`,
                    encryptedContent: null,
                    vendor: { type: "glm_summary" },
                },
            ],
        },
    };
}
