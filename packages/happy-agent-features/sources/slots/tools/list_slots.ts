import { defineAgentTool } from "@slopus/happy-agent-base";

import { slotPageQuerySchema, slotPageSchema, type SlotPageQuery } from "../SlotPage.js";
import type { SlotsFeature } from "../SlotsFeature.js";

/** Read one bounded page of slot entries. */
export function listSlotsTool(slots: SlotsFeature, agentId: string) {
    return defineAgentTool({
        name: "list_slots",
        description:
            "List a bounded page of persistent Happy UI slot entries. Use nextCursor to continue reading a large catalog.",
        parameters: slotPageQuerySchema,
        returnType: slotPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: SlotPageQuery) => await slots.listPage(ctx, agentId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: slots.formatPageForModel(page),
            },
        ],
    });
}
