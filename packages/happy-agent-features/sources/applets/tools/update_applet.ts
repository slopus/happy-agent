import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    appletChangeDescriptionSchema,
    appletDescriptionSchema,
    appletNameSchema,
    appletPurposeSchema,
    appletSchema,
    appletSourcePathSchema,
    appletScopeRefSchema,
    type AppletToolUpdateInput,
} from "../Applet.js";
import type { AppletFeature } from "../AppletFeature.js";

const updateAppletInputSchema = Type.Object(
    {
        name: appletNameSchema,
        path: appletSourcePathSchema,
        changeDescription: appletChangeDescriptionSchema,
        allowedScopes: Type.Optional(
            Type.Array(appletScopeRefSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
        ),
        description: Type.Optional(appletDescriptionSchema),
        purpose: Type.Optional(appletPurposeSchema),
        sourceDescription: Type.Optional(Type.String({ maxLength: 2_000 })),
        iconPath: Type.Optional(appletSourcePathSchema),
    },
    { additionalProperties: false },
);

/** Import a new source version and update host-owned metadata. */
export function updateAppletTool(applets: AppletFeature, _agentId: string) {
    return defineAgentTool({
        name: "update_applet",
        description:
            "Import a new source version for an applet and optionally update its metadata.",
        parameters: updateAppletInputSchema,
        returnType: Type.Object({ applet: appletSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { name, ...input }: { name: string } & AppletToolUpdateInput) => ({
            applet: await applets.updateForAgent(ctx, _agentId, name, input),
        }),
        toLLM: ({ applet }) => [
            {
                type: "text",
                text: applets.formatOperationForModel("Applet updated", applet),
            },
        ],
    });
}
