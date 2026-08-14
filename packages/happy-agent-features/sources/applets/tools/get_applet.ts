import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { appletNameSchema, appletSchema } from "../Applet.js";
import type { AppletFeature } from "../AppletFeature.js";

const getAppletInputSchema = Type.Object(
    { name: appletNameSchema },
    { additionalProperties: false },
);

const getAppletResultSchema = Type.Object(
    { applet: Type.Union([appletSchema, Type.Undefined()]) },
    { additionalProperties: false },
);

/** Read one applet's bounded metadata and version list. */
export function getAppletTool(applets: AppletFeature, _agentId: string) {
    return defineAgentTool({
        name: "get_applet",
        description: "Read one applet's metadata, current version, and bounded version history.",
        parameters: getAppletInputSchema,
        returnType: getAppletResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { name }) => ({
            applet: await applets.get(ctx, name),
        }),
        toLLM: ({ applet }) => [
            {
                type: "text",
                text: applets.formatAppletForModel(applet),
            },
        ],
    });
}
