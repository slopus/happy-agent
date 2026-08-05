/**
 * A fixed model and effort for every subagent this process spawns.
 *
 * Rig normally makes the orchestrating model choose a child's model and effort
 * on every spawn, deliberately: an inherited choice is how a whole tree quietly
 * ends up running at the parent's effort. That is the right default when a
 * person is driving.
 *
 * It is the wrong behaviour in two cases. Benchmarking a *named* configuration
 * -- "Sol orchestrator, Luna children" -- is not measurable if the orchestrator
 * picks something different on each spawn, because the arm is then a
 * distribution rather than a configuration. And a user who wants every child on
 * a cheap model for cost reasons currently has no way to say so.
 *
 * This policy makes that expressible. It is off unless set, and when it is set
 * it overrides the model's choice rather than defaulting it, because a default
 * the model can silently override would not pin an arm.
 */

export interface SubagentModelPolicy {
    readonly effort?: string | undefined;
    readonly modelId?: string | undefined;
    readonly providerId?: string | undefined;
}

/**
 * Read the policy from the environment.
 *
 * Environment rather than config file: this has to survive into a fresh
 * container that a harness starts, where there is no user config to edit and
 * the daemon is spawned by `rig exec` rather than by a person.
 *
 *   RIG_SUBAGENT_MODEL=openai/gpt-5.6-luna
 *   RIG_SUBAGENT_EFFORT=max
 *   RIG_SUBAGENT_PROVIDER=codex   # optional; normally inferred
 */
export function subagentModelPolicyFromEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
): SubagentModelPolicy | undefined {
    const read = (name: string): string | undefined => {
        const value = environment[name]?.trim();
        return value === undefined || value === "" ? undefined : value;
    };
    const effort = read("RIG_SUBAGENT_EFFORT");
    const modelId = read("RIG_SUBAGENT_MODEL");
    const providerId = read("RIG_SUBAGENT_PROVIDER");
    if (effort === undefined && modelId === undefined && providerId === undefined) {
        return undefined;
    }
    return { effort, modelId, providerId };
}

/**
 * Read a maximum subagent depth from the environment.
 *
 *   RIG_SUBAGENT_MAX_DEPTH=0   # no subagents at all
 *
 * Zero turns delegation off properly rather than by taking the tools away and
 * leaving the instructions in place: `canSpawn` is derived from this depth, and
 * it already gates the spawn tools, the workflow tool, and the parts of the
 * system prompt that describe delegating. A model told how to delegate but
 * unable to do it would waste calls discovering that, which would land on the
 * harness being measured rather than on the configuration.
 *
 * Measuring a harness against one that has no subagents at all needs this: on
 * deep-swe, Rig spawns children unprompted, so "same model, same effort" is not
 * the same configuration unless delegation is off on both sides.
 */
export function subagentMaxDepthFromEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
): number | undefined {
    const raw = environment.RIG_SUBAGENT_MAX_DEPTH?.trim();
    if (raw === undefined || raw === "") return undefined;
    const depth = Number(raw);
    return Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

/**
 * Apply the policy to one spawn request.
 *
 * A pinned model without a pinned effort would leave the child on whatever
 * effort the orchestrator asked for, which is meaningless against a model it
 * did not choose -- the levels differ per model, and validation downstream
 * would reject the mismatch. So pinning the model clears an unpinned effort and
 * lets the child fall back to that model's default.
 */
export function applySubagentModelPolicy<
    T extends {
        effort?: string | undefined;
        modelId?: string | undefined;
        providerId?: string | undefined;
    },
>(request: T, policy: SubagentModelPolicy | undefined): T {
    if (policy === undefined) return request;

    const modelChanged = policy.modelId !== undefined && policy.modelId !== request.modelId;
    const effort = policy.effort ?? (modelChanged ? undefined : request.effort);
    // Drop the key rather than set it undefined, so a cleared effort reads as
    // "not asked for" downstream instead of as an explicit empty choice.
    const { effort: _replaced, ...rest } = request;

    return {
        ...(rest as T),
        ...(effort === undefined ? {} : { effort }),
        ...(policy.modelId === undefined ? {} : { modelId: policy.modelId }),
        ...(policy.providerId === undefined ? {} : { providerId: policy.providerId }),
    };
}
