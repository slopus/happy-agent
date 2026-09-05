import { cloudOrganizationSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const HAPPY_TEAM_ENDPOINT_MAX_INPUT_CHARACTERS = 2_048;
const HAPPY_TEAM_ENDPOINT_MAX_CHARACTERS = 600;
const allowedHappyTeamEndpointProtocols = new Set(["http:", "https:", "tailcat:", "ws:", "wss:"]);

export const happyTeamEndpointSchema = Type.String({
    minLength: 1,
    maxLength: HAPPY_TEAM_ENDPOINT_MAX_CHARACTERS,
    pattern: "^(?:http|https|tailcat|ws|wss)://[\\x20-\\x7e]+$",
});

/** One Happy Cloud WorkOS organization and the Happy Agent server it advertises. */
export const happyTeamSchema = Type.Object(
    {
        endpoint: Type.Union([Type.Null(), happyTeamEndpointSchema]),
        id: cloudOrganizationSchema.properties.id,
        name: cloudOrganizationSchema.properties.name,
    },
    { additionalProperties: false },
);
export type HappyTeam = Static<typeof happyTeamSchema>;

export const happyTeamEndpointInputSchema = Type.String({
    minLength: 1,
    maxLength: HAPPY_TEAM_ENDPOINT_MAX_INPUT_CHARACTERS,
    pattern: "^[\\x20-\\x7e]+$",
});

/** Normalize exactly the URL forms Happy Cloud accepts for an organization endpoint. */
export function normalizeHappyTeamEndpoint(value: string): string | undefined {
    if (!Value.Check(happyTeamEndpointInputSchema, value)) return undefined;
    try {
        const url = new URL(value);
        if (
            !allowedHappyTeamEndpointProtocols.has(url.protocol) ||
            url.hostname.length === 0 ||
            url.username.length !== 0 ||
            url.password.length !== 0 ||
            url.hash.length !== 0 ||
            url.href.length > HAPPY_TEAM_ENDPOINT_MAX_CHARACTERS ||
            !Value.Check(happyTeamEndpointSchema, url.href)
        ) {
            return undefined;
        }
        return url.href;
    } catch {
        return undefined;
    }
}
