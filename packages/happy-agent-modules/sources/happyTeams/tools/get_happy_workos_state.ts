import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import type { HappyTeamsModule } from "../HappyTeamsModule.js";

const getHappyWorkOSStateInputSchema = Type.Object({}, { additionalProperties: false });
const getHappyWorkOSStateResultSchema = Type.Object(
    {
        workos_client_id: Type.String({
            maxLength: 160,
            minLength: 9,
            pattern: "^client_[A-Za-z0-9]+$",
        }),
        workos_user_id: Type.String({
            maxLength: 160,
            minLength: 7,
            pattern: "^user_[A-Za-z0-9]+$",
        }),
    },
    { additionalProperties: false },
);

/** Read the WorkOS deployment identifiers represented by this installation's Cloud session. */
export function getHappyWorkOSStateTool(module: HappyTeamsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "get_happy_workos_state",
        defer: true,
        capabilities: ["List and manage Happy teams."],
        searchKeywords: [
            "WorkOS user ID",
            "WorkOS client ID",
            "team configuration",
            "Happy Cloud identity",
        ],
        description:
            "Return the WorkOS user ID and client ID of the connected Happy Cloud setup. Copy these exact values into feature.team.owner_workos_user_id and feature.team.workos_client_id when deploying a Happy Agent team server. This tool is available only to an active admin bot.",
        parameters: getHappyWorkOSStateInputSchema,
        returnType: getHappyWorkOSStateResultSchema,
        durable: true,
        reloadable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: () =>
            "reading the WorkOS user and client IDs of the connected Happy Cloud setup. Access: external WorkOS authentication and Happy Cloud verification",
        execute: async (ctx) => {
            const state = await module.getWorkOSState(ctx, actingAgentId);
            return {
                workos_client_id: state.workosClientId,
                workos_user_id: state.workosUserId,
            };
        },
        toLLM: ({ workos_client_id, workos_user_id }) => [
            {
                type: "text",
                text: [
                    "Connected Happy Cloud WorkOS configuration:",
                    `- User ID: ${workos_user_id}`,
                    `- Client ID: ${workos_client_id}`,
                ].join("\n"),
            },
        ],
    });
}

export { getHappyWorkOSStateInputSchema, getHappyWorkOSStateResultSchema };
