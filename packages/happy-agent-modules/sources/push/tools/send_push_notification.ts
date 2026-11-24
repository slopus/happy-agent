import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { characterCountedString } from "../impl/characterCountedString.js";

/**
 * The push program's guidance, byte for byte the text Happy Cloud gives its agents. A test pins
 * its digest to the cloud's, so change it only together with that contract.
 */
const DESCRIPTION = `Tell the person what happened, on their phone. Call it once, at the end of your turn, when you stop and there is something they would want to know now: you finished what they asked, you are blocked and need them, or something broke.

Do not call it for progress, for work you handed to a subtask that is still running, or for something you already told them that has not changed. On a scheduled or recurring run, call it only when something needs their attention: it broke, money or data is at risk, a limit was crossed, or you need a decision. A routine run with nothing new stays quiet.

title: what happened, in plain words, under 45 characters. Lead with the outcome, not the activity. Never your own name or the task's name.
subtitle: optional. The one fact that decides whether to open it: the number, the blocker, or the question.

Good:
- "Scratch volume down to 16 GB free" / "Switching to the 400 GB volume still needs your approval"
- "iOS preview 24 uploaded; prod is blocked" / "Prod needs build number 164 committed on main first"
- "Found why cloud replies show twice" / "Fix and test ready, uncommitted. Open a PR?"
- "All 4 droplets off but still billing $81/mo" / "Only deleting them stops the charges"

Bad:
- "Task complete": says nothing.
- "Disk Sweeper finished its run": names the agent, not the news.
- "Removed 4.43 GB as usual": routine, should not be sent.

Whether and where it is shown is decided for you. A later call replaces an earlier one.`;

const parametersSchema = Type.Object(
    {
        // Counted in characters, as Happy Cloud counts them, so both servers take the same text.
        title: characterCountedString(1, 80),
        subtitle: Type.Optional(characterCountedString(0, 160)),
    },
    { additionalProperties: false },
);
type SendPushNotificationInput = Static<typeof parametersSchema>;

const resultSchema = Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false });

/** What one call asked the person to be told, under the call's own identity. */
export interface SaidToThePerson {
    readonly callId: string;
    readonly title: string;
    readonly subtitle: string | undefined;
}

/**
 * The tool an agent tells its person something with. It only hands what was said to `say` and
 * answers `{ "ok": true }`: whether, where, and when anything is shown is never the agent's to
 * learn, so no outcome may reach the result.
 *
 * It runs in every permission mode and is never reviewed. It reaches only the person the agent
 * works for, with words its reply could carry, and a refusal would tell the model what happened.
 */
export function sendPushNotificationTool(
    say: (ctx: Context, said: SaidToThePerson) => Promise<void>,
) {
    return defineAgentTool({
        name: "send_push_notification",
        defer: false,
        capabilities: ["Send a push notification to the person you work for."],
        description: DESCRIPTION,
        parameters: parametersSchema,
        returnType: resultSchema,
        durable: true,
        // What was said and the answer commit together, so a repeated call after an interruption
        // finds neither or both.
        transactional: true,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, input: SendPushNotificationInput, call) => {
            await say(ctx, { callId: call.id, title: input.title, subtitle: input.subtitle });
            return { ok: true as const };
        },
        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    });
}
