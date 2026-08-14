import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    appletSchema,
    appletToolImportInputSchema,
    type AppletToolImportInput,
} from "../Applet.js";
import type { AppletFeature } from "../AppletFeature.js";

/** Alias for hosts that call applet creation an import. */
export function importAppletTool(applets: AppletFeature, agentId: string) {
    return defineAgentTool({
        name: "import_applet",
        description:
            "Import a source reference as a host-managed applet. The feature assigns a durable retry identity.",
        parameters: appletToolImportInputSchema,
        returnType: Type.Object({ applet: appletSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: AppletToolImportInput) => ({
            applet: await applets.importForAgent(ctx, agentId, input),
        }),
        toLLM: ({ applet }) => [
            {
                type: "text",
                text: applets.formatOperationForModel("Applet imported", applet),
            },
        ],
    });
}
