import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Request profiles are compact opaque compatibility identities, never model input. */
export const MAX_AGENT_REQUEST_PROFILE_LENGTH = 512;

/** A nullable request profile; `null` is the default profile. */
export const agentRequestProfileSchema = Type.Union([
    Type.String({ maxLength: MAX_AGENT_REQUEST_PROFILE_LENGTH }),
    Type.Null(),
]);

/** The TypeScript type inferred from {@link agentRequestProfileSchema}. */
export type AgentRequestProfile = Static<typeof agentRequestProfileSchema>;

/** Normalize omission to the default profile and validate the value at the request boundary. */
export function ownAgentRequestProfile(profile: unknown): AgentRequestProfile {
    const normalized = profile === undefined ? null : profile;
    if (!Value.Check(agentRequestProfileSchema, normalized)) {
        throw new Error("The request profile is not valid.");
    }
    return normalized;
}
