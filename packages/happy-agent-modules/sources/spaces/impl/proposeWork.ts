import { createId } from "@paralleldrive/cuid2";
import type { AgentProviders } from "@slopus/happy-agent-base";
import type { SessionReasoningEffort } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { withLifetime, type Context } from "@steve.kite/stdlib";

import { formatPrioritizingInstructions } from "./formatPrioritizingInstructions.js";
import { SPACE_ICON_SLUGS } from "./spaceIconSlugs.js";

/** A proposal is worth a minute or two; anything longer is stuck. */
const PROPOSE_TIMEOUT_MS = 3 * 60 * 1_000;

export const spaceWorkRowSchema = Type.Object(
    {
        title: Type.String({ minLength: 1, maxLength: 80 }),
        icon: Type.String({ minLength: 1, maxLength: 64 }),
        topic: Type.String({ minLength: 1, maxLength: 60 }),
        why: Type.String({ minLength: 1, maxLength: 160 }),
        firstMessage: Type.String({ minLength: 1, maxLength: 600 }),
        ongoing: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
);

const answerSchema = Type.Object(
    {
        intro: Type.String({ minLength: 1, maxLength: 400 }),
        rows: Type.Array(spaceWorkRowSchema, { minItems: 1, maxItems: 8 }),
    },
    { additionalProperties: false },
);

/** What Focus proposes the person's sidebar holds, most important first. */
export type SpaceWorkProposal = Static<typeof answerSchema>;

const TASK = `# This request

The person is being onboarded in Happy's chat, and has no work in the sidebar yet. Below is what Happy found about what they have been working on, or what they said themselves. Propose the final state of their sidebar as the pieces of work worth a chat each, most important first, organized by your rules: specific topics (never something generic like "Work" or one named for the project nearly everything belongs to), at most 8 rows and at most 4 topics.

For each row give its final name in a few words, a clay icon slug from the library above, its topic, a few words of why (where you saw it), and a short first message the new chat is sent. Every first message asks for a read-only plan and to wait for the person, and changes nothing. Mark a standing job, something they keep doing by hand, with "ongoing": true.

Answer with JSON only, no prose and no code fence:
{"intro": "one or two warm sentences introducing the proposal", "rows": [{"title": "…", "icon": "…", "topic": "…", "why": "…", "firstMessage": "…", "ongoing": false}]}

Never invent work the findings do not show.`;

/**
 * Focus proposes the person's work once, as a bounded side inference: its own instructions and
 * placement rules, the findings, one direct provider request, and no conversation. Rows whose icon
 * is not in the library get a plain one.
 */
export async function proposeWork(
    ctx: Context,
    providers: AgentProviders,
    route: {
        readonly providerId: string;
        readonly model: string;
        readonly effort: SessionReasoningEffort;
    },
    findings: string,
): Promise<SpaceWorkProposal> {
    const provider = await providers.resolve(route.providerId, route.model);
    if (provider === null) throw new Error(`Provider "${route.providerId}" is not configured.`);
    const instructions = `${formatPrioritizingInstructions()}\n\n${TASK}`;
    const session = await provider.session(`focus-proposal:${createId()}`, {
        inferenceMaxRetries: 0,
        instructions,
        tools: [],
    });
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(new Error("Focus took too long to propose.")),
        PROPOSE_TIMEOUT_MS,
    );
    timeout.unref();
    let text = "";
    try {
        for await (const event of session.run(withLifetime(ctx, controller.signal), {
            context: {
                instructions,
                messages: [{ role: "user", content: [{ type: "text", text: findings }] }],
            },
            effort: route.effort,
            model: route.model,
        })) {
            if (event.type === "text_delta") text += event.delta;
            if (event.type !== "done") continue;
            if (event.state === "error") throw new Error(event.message);
            if (event.state === "cancelled") throw new Error("Focus stopped before it answered.");
            break;
        }
    } finally {
        clearTimeout(timeout);
        await session.destroy();
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    let answer: unknown;
    try {
        answer = start === -1 ? undefined : JSON.parse(text.slice(start, end + 1));
    } catch {
        answer = undefined;
    }
    if (!Value.Check(answerSchema, answer)) {
        throw new Error("Focus answered with something other than a proposal.");
    }
    const icons = new Set<string>(SPACE_ICON_SLUGS);
    return {
        intro: answer.intro,
        rows: answer.rows.map((row) => (icons.has(row.icon) ? row : { ...row, icon: "wip" })),
    };
}
