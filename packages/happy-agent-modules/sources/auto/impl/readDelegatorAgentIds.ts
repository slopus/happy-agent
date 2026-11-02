import type { Context } from "@steve.kite/stdlib";

import type { HistoryModule } from "../../history/index.js";

/** How many agent-role messages each end of the reviewed agent's history contributes. */
const END_PAGE_SIZE = 50;
/** The most delegators one review names, so following them fits the review budget. */
const MAX_DELEGATORS = 8;

/**
 * The agents that sent the reviewed agent messages, by Agent ID only.
 *
 * The evidence archive keeps agent deliveries out of the transcript, so without this the reviewer
 * would have to read the reviewed agent's whole history just to learn who delegated its work. Only
 * the sender ID History recorded from the delivery's metadata is taken, never the text; the ID is
 * where to look for the person's words, not authorization. Both ends of the history are read
 * because a delegation usually opens it, and a later sender is the one most likely still driving
 * the work. A goal continuation names the agent driving itself, so the reviewed agent is left out.
 */
export async function readDelegatorAgentIds(
    history: HistoryModule,
    ctx: Context,
    agentId: string,
): Promise<string[]> {
    const ids = new Set<string>();
    for (const from of ["start", "end"] as const) {
        const page = await history.read(ctx, agentId, {
            from,
            limit: END_PAGE_SIZE,
            roles: ["agent"],
        });
        for (const { message } of page.messages) {
            const sender = message.senderAgentId;
            if (sender !== undefined && sender !== agentId) ids.add(sender);
        }
    }
    return [...ids].slice(0, MAX_DELEGATORS);
}
