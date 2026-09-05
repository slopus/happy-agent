import { cloudOrganizationSchema } from "@slopus/happy-agent-client";
import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { happyTeamEndpointInputSchema, happyTeamEndpointSchema } from "../../cloud/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { HappyTeamsModule } from "../HappyTeamsModule.js";

const updateHappyTeamInputSchema = Type.Object(
    {
        endpoint: happyTeamEndpointInputSchema,
        team_id: cloudOrganizationSchema.properties.id,
    },
    { additionalProperties: false },
);
type UpdateHappyTeamInput = Static<typeof updateHappyTeamInputSchema>;

const updateHappyTeamResultSchema = Type.Object(
    {
        endpoint: happyTeamEndpointSchema,
        team_id: cloudOrganizationSchema.properties.id,
    },
    { additionalProperties: false },
);

/** Update the mutable Happy metadata stored on one WorkOS organization. */
export function updateHappyTeamTool(module: HappyTeamsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "update_happy_team",
        defer: true,
        capabilities: ["List and manage Happy teams."],
        searchKeywords: ["change team", "team server URL", "organization endpoint"],
        description:
            "Update one Happy team. For now, endpoint is the only mutable field and must be an absolute HTTP, HTTPS, Tailcat, WS, or WSS Happy Agent server endpoint. Happy Cloud permits the write only when the connected WorkOS user is an active administrator of that organization. Human-owned root agents and admin bots may call this tool; non-admin bots are refused.",
        parameters: updateHappyTeamInputSchema,
        returnType: updateHappyTeamResultSchema,
        // A remote metadata write may have committed before an interruption and is not replayed.
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ team_id, endpoint }: UpdateHappyTeamInput) =>
            `updating Happy team ${quoteVisibleExact(team_id)} endpoint to ${quoteVisibleExact(endpoint)}. Access: external Happy Cloud API and WorkOS organization metadata write`,
        execute: async (ctx, { team_id, endpoint }: UpdateHappyTeamInput) => ({
            endpoint: await module.update(ctx, actingAgentId, team_id, endpoint),
            team_id,
        }),
        toLLM: ({ team_id, endpoint }) => [
            {
                type: "text",
                text: `Happy team ${team_id} now advertises ${endpoint}.`,
            },
        ],
    });
}

export { updateHappyTeamInputSchema, updateHappyTeamResultSchema };
