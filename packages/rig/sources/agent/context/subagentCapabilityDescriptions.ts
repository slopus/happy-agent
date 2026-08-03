import { Type } from "@sinclair/typebox";
import {
    HOSTED_CAPABILITIES,
    describeHostedCapabilityGrant,
    parseHostedCapabilities,
} from "@slopus/rig-execution";

import type { AgentContext } from "./AgentContext.js";

// Every spawn tool offers the capability grant in the same words, because it is the same decision
// each time: what this one child may reach that the agent making the call cannot.
export const SUBAGENT_CAPABILITIES_ARGUMENT_DESCRIPTION = [
    `Provider-executed searches to grant this subagent, from: ${HOSTED_CAPABILITIES.join(", ")}. Requires a Grok model.`,
    "",
    "These run inside the provider's own response rather than as a tool Rig executes, so once the child holds one, Rig cannot review an individual search and cannot see what it read. Granting it is the whole approval. Grant only what the delegated task needs, and give the child the narrowest task and context that let it do the job.",
    "",
    "Omit for an ordinary subagent. A subagent granted one of these cannot spawn subagents of its own.",
].join("\n");

export const subagentCapabilitiesArgumentSchema = Type.Optional(
    Type.Array(Type.Union(HOSTED_CAPABILITIES.map((capability) => Type.Literal(capability))), {
        description: SUBAGENT_CAPABILITIES_ARGUMENT_DESCRIPTION,
    }),
);

/**
 * A spawn is reviewed exactly when it hands out reach the parent's own tools would have to ask for.
 *
 * An ordinary spawn is not reviewed, because everything the child then does is reviewed in the
 * child. A capability grant is the one case where that is not true.
 */
export function spawnGrantsCapabilities(args: { capabilities?: readonly string[] }): boolean {
    return (args.capabilities?.length ?? 0) > 0;
}

export function describeSpawnCapabilityGrant(
    args: { capabilities?: readonly string[]; description?: string },
    _context: AgentContext,
): string {
    const grant =
        describeHostedCapabilityGrant(parseHostedCapabilities(args.capabilities ?? [])) ??
        "Start a subagent.";
    const task = args.description?.trim();
    return `${grant}${task === undefined || task.length === 0 ? "" : ` Task: ${task}.`} Access: network access outside Rig's shell sandbox`;
}
