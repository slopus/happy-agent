import type { AgentMetadata, AgentSystemRef } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

/** The mark Subtasks leaves on an agent a person talks to although another agent created it. */
const subtaskMetadataSchema = Type.Object({ subtask: Type.Literal(true) });

/**
 * Whether a person can answer this agent through the API: it has no parent, or it is a subtask.
 * Any other agent is managed by the agent that created it, so `send` and `/actions` answer `409`
 * for it, and a control or a suggested reply shown there could never be pressed.
 *
 * The subtask mark is read here rather than asked of Subtasks, which is built on Compute, which
 * contributes a component to chat UI.
 */
export async function personAnswersAgent(
    ctx: Context,
    agents: AgentSystemRef,
    agent: { readonly id: string; readonly metadata: AgentMetadata | undefined },
): Promise<boolean> {
    if (Value.Check(subtaskMetadataSchema, agent.metadata)) return true;
    return (await agents.parentOf(ctx, agent.id)) === null;
}
