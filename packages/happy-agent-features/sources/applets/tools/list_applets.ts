import { defineAgentTool } from "@slopus/happy-agent-base";

import { appletListPageSchema, appletListQuerySchema, type AppletListQuery } from "../Applet.js";
import type { AppletFeature } from "../AppletFeature.js";

/** List a bounded page of host-managed applets. */
export function listAppletsTool(applets: AppletFeature, _agentId: string) {
    return defineAgentTool({
        name: "list_applets",
        description: "List a bounded page of applets. Follow nextCursor to inspect later entries.",
        parameters: appletListQuerySchema,
        returnType: appletListPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: AppletListQuery) => await applets.listPage(ctx, query),
        toLLM: (page) => [
            {
                type: "text",
                text: applets.formatPageForModel(page),
            },
        ],
    });
}
