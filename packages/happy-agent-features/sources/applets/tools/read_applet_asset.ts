import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    appletAssetReadInputSchema,
    appletAssetResultSchema,
    type AppletAssetReadInput,
} from "../Applet.js";
import type { AppletFeature } from "../AppletFeature.js";

/** Read one bounded applet source asset through the host reader. */
export function readAppletAssetTool(applets: AppletFeature, _agentId: string) {
    return defineAgentTool({
        name: "read_applet_asset",
        description:
            "Read one applet asset through the host reader. Content is bounded and may be returned as UTF-8 or base64.",
        parameters: appletAssetReadInputSchema,
        returnType: appletAssetResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: AppletAssetReadInput) => await applets.readAsset(ctx, input),
        toLLM: (asset) => [
            {
                type: "text",
                text: applets.formatAssetForModel(asset ?? undefined),
            },
        ],
    });
}
