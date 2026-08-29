import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentRequestProfile } from "@slopus/happy-agent-base";
import type { AgentProfile } from "@slopus/happy-agent-client";

/**
 * Opaque request profiles currently understood by the installed feature set.
 *
 * Add exact string literals when a feature needs a distinct provider context. Removing a literal
 * is safe because every boundary decodes values through {@link decodeRequestProfile}.
 */
export const requestProfileCodec = Type.Null();

/** The complete ordered request-profile catalog for one agent. */
export function requestProfilesForAgent(_agentId: string): readonly AgentProfile[] {
    return [];
}

/** Decode unsupported, omitted, and later-removed profiles to the safe default. */
export function decodeRequestProfile(profile: unknown): AgentRequestProfile {
    const candidate = profile === undefined ? null : profile;
    return Value.Check(requestProfileCodec, candidate) ? candidate : null;
}
