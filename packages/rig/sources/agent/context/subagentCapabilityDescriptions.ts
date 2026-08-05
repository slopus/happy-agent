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

/**
 * Describes a capability grant for review, including how this conversation reaches the search.
 *
 * Approving a search Rig cannot see into is really a question about what the child can put in the
 * search box, and the answer is always "this conversation": a spawned subagent is given
 * `read_agent_history`, and that tool reaches the root of its own tree without asking anyone. What
 * the spawn arguments change is only whether the thread is already sitting in the child's context
 * or one tool call away. So the review says the conversation is reachable either way, and uses the
 * default the calling dialect actually has — Grok and Claude start a child on the task alone,
 * Codex forks the whole conversation unless told otherwise — to say which of the two it is.
 */
export function createSpawnCapabilityGrantDescriber(options: {
    inheritsConversationByDefault: boolean;
}) {
    return (
        args: {
            capabilities?: readonly string[];
            context?: string;
            description?: string;
            fork_turns?: string;
        },
        _context: AgentContext,
    ): string => {
        const grant =
            describeHostedCapabilityGrant(parseHostedCapabilities(args.capabilities ?? [])) ??
            "Start a subagent.";
        const task = args.description?.trim();
        const inherits = spawnInheritsConversation(args, options.inheritsConversationByDefault);
        return `${grant}${task === undefined || task.length === 0 ? "" : ` Task: ${task}.`} It ${
            inherits ? "starts with this conversation" : "can read this conversation"
        }, so anything in it can reach the search. Access: network access outside Rig's shell sandbox`;
    };
}

function spawnInheritsConversation(
    args: { context?: string; fork_turns?: string },
    byDefault: boolean,
): boolean {
    if (typeof args.fork_turns === "string") {
        return args.fork_turns.trim().toLowerCase() !== "none";
    }
    if (typeof args.context === "string") return args.context === "parent";
    return byDefault;
}
