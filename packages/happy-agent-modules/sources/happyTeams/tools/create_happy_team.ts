import { createCloudOrganizationRequestSchema } from "@slopus/happy-agent-client";
import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { happyTeamEndpointInputSchema, happyTeamSchema } from "../../cloud/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { HappyTeamsModule } from "../HappyTeamsModule.js";

const createHappyTeamInputSchema = Type.Object(
    {
        endpoint: happyTeamEndpointInputSchema,
        name: createCloudOrganizationRequestSchema.properties.name,
    },
    { additionalProperties: false },
);
type CreateHappyTeamInput = Static<typeof createHappyTeamInputSchema>;

/** Create one WorkOS organization and publish its Happy Agent endpoint. */
export function createHappyTeamTool(module: HappyTeamsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "create_happy_team",
        defer: true,
        capabilities: ["List and manage Happy teams."],
        searchKeywords: ["new team", "create organization", "Happy Cloud team"],
        description:
            "Create one Happy team as a WorkOS organization and publish its absolute HTTP, HTTPS, Tailcat, WS, or WSS Happy Agent server endpoint. The endpoint is required. The connected Happy Cloud user becomes its administrator. Human-owned root agents and admin bots may create teams; non-admin bots are refused.",
        parameters: createHappyTeamInputSchema,
        returnType: happyTeamSchema,
        // A remote creation may have committed before an interruption, so it cannot be replayed.
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ endpoint, name }: CreateHappyTeamInput) =>
            `creating Happy team ${quoteVisibleExact(name)} at ${quoteVisibleExact(endpoint)} for the connected Happy Cloud user. Access: external Happy Cloud API and WorkOS organization write`,
        execute: async (ctx, { endpoint, name }: CreateHappyTeamInput) =>
            await module.create(ctx, actingAgentId, name, endpoint),
        toLLM: (team) => [
            {
                type: "text",
                text: `Happy team created: ${team.name} — id ${team.id}, endpoint ${team.endpoint}.`,
            },
        ],
    });
}

export { createHappyTeamInputSchema };
