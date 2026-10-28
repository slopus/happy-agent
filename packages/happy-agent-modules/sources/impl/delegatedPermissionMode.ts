import { agentPermissionModeLabel, type AgentPermissionMode } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

/**
 * How much of the machine an agent may hand on to an agent it starts.
 *
 * An agent that creates another, or speaks first to a conversation that has never run, decides
 * what that conversation may touch. Without a bound, delegation is a way out of the mode a person
 * chose: a Read only agent could create a Full access collaborator and have it do the writing. So
 * an agent-created agent runs in its creator's own mode. `read_only` is the one way to hand on
 * less, and `full_mode` asks for Full access, which only a creator already in Full access may do; any
 * other request is refused rather than quietly adjusted, so the model learns it cannot have it.
 *
 * The creator's mode is its persistent one. An Auto review may lend one action Full access, and
 * that loan belongs to the reviewed action alone, so callers read the mode from the agent's
 * module scope rather than from the context a tool happens to be executing on.
 */

/** Modes from narrowest to widest. */
const PERMISSION_MODE_RANK: Readonly<Record<AgentPermissionMode, number>> = {
    read_only: 0,
    workspace_write: 1,
    auto: 2,
    full_access: 3,
};

/** The flags a model may set on an agent it creates. */
export const delegatedPermissionFlagSchemas = {
    read_only: Type.Optional(
        Type.Boolean({
            description:
                "Run the new agent in Read only. Omit both read_only and full_mode to use your own current permission mode.",
        }),
    ),
    full_mode: Type.Optional(
        Type.Boolean({
            description:
                "Run the new agent in Full access. Allowed only while you are in Full access yourself.",
        }),
    ),
};

/** What a creation request says about the new agent's permission mode. */
export interface DelegatedPermissionFlags {
    readonly read_only?: boolean | undefined;
    readonly full_mode?: boolean | undefined;
}

/** The narrower of two modes. */
export function narrowerPermissionMode(
    first: AgentPermissionMode,
    second: AgentPermissionMode,
): AgentPermissionMode {
    return PERMISSION_MODE_RANK[first] <= PERMISSION_MODE_RANK[second] ? first : second;
}

/**
 * The mode an agent-created agent runs in: Read only when asked, Full access when asked by a
 * creator in Full access, and otherwise its creator's own. Anything else throws before anything is
 * created.
 */
export function delegatedPermissionMode(
    creatorMode: AgentPermissionMode,
    flags: DelegatedPermissionFlags,
): AgentPermissionMode {
    if (flags.read_only === true && flags.full_mode === true) {
        throw new Error("Set read_only or full_mode, not both.");
    }
    if (flags.read_only === true) return "read_only";
    if (flags.full_mode === true) {
        if (creatorMode !== "full_access") {
            throw new Error(
                `full_mode is allowed only while you are in Full access yourself, and you are in ${agentPermissionModeLabel(creatorMode)}. Omit it to give the new agent your own permission mode, or set read_only to give it less.`,
            );
        }
        return "full_access";
    }
    return creatorMode;
}
