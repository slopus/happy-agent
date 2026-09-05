import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { happyTeamSchema } from "../../cloud/index.js";
import type { HappyTeamsModule } from "../HappyTeamsModule.js";

const HAPPY_TEAMS_PAGE_ITEMS = 10;
const happyTeamsOffsetSchema = Type.Integer({ minimum: 0, maximum: 10_000 });
const listHappyTeamsInputSchema = Type.Object(
    { offset: Type.Optional(happyTeamsOffsetSchema) },
    { additionalProperties: false },
);
type ListHappyTeamsInput = Static<typeof listHappyTeamsInputSchema>;

const listHappyTeamsResultSchema = Type.Object(
    {
        next_offset: Type.Union([Type.Null(), happyTeamsOffsetSchema]),
        teams: Type.Array(happyTeamSchema, { maxItems: HAPPY_TEAMS_PAGE_ITEMS }),
    },
    { additionalProperties: false },
);
type ListHappyTeamsResult = Static<typeof listHappyTeamsResultSchema>;

/** List the WorkOS organizations visible to the connected Happy Cloud user. */
export function listHappyTeamsTool(module: HappyTeamsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "list_happy_teams",
        defer: true,
        capabilities: ["List and manage Happy teams."],
        searchKeywords: ["Happy Cloud organizations", "team list", "WorkOS organizations"],
        description:
            "List a 10-item page of Happy teams the connected Happy Cloud user belongs to, including each WorkOS organization ID and its configured Happy Agent server endpoint. Follow next_offset until it is null to read every team.",
        parameters: listHappyTeamsInputSchema,
        returnType: listHappyTeamsResultSchema,
        durable: true,
        reloadable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: () =>
            "listing the connected Happy Cloud user's WorkOS organizations and their Happy Agent endpoints. Access: external Happy Cloud API",
        execute: async (
            ctx,
            { offset = 0 }: ListHappyTeamsInput,
        ): Promise<ListHappyTeamsResult> => {
            const all = await module.list(ctx, actingAgentId);
            const teams = all.slice(offset, offset + HAPPY_TEAMS_PAGE_ITEMS);
            const next = offset + teams.length;
            return {
                next_offset: next < all.length ? next : null,
                teams: [...teams],
            };
        },
        toLLM: ({ next_offset, teams }) => [
            {
                type: "text",
                text:
                    teams.length === 0
                        ? "The connected Happy Cloud user belongs to no Happy teams."
                        : [
                              ...teams.map(
                                  (team) =>
                                      `- ${team.name} — id ${team.id}, endpoint ${team.endpoint ?? "not configured"}`,
                              ),
                              ...(next_offset === null
                                  ? []
                                  : [`More teams are available at offset ${String(next_offset)}.`]),
                          ].join("\n"),
            },
        ],
    });
}

export { HAPPY_TEAMS_PAGE_ITEMS, listHappyTeamsInputSchema, listHappyTeamsResultSchema };
