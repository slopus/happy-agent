import type {
    AgentTreeUsage,
    AgentTreeUsageSession,
} from "../agent/context/AgentTreeUsageContext.js";

/** Converts stored session relations into the canonical agent paths used by feature adapters. */
export function readAgentTreeUsage(result: AgentTreeUsage) {
    const bySessionId = new Map(result.sessions.map((session) => [session.sessionId, session]));
    const pathBySessionId = new Map<string, string>();
    return {
        sessions: result.sessions.map((session) => ({
            agentId: session.agentId,
            ...(session.description === undefined ? {} : { description: session.description }),
            modelId: session.modelId,
            ...(session.parentSessionId === undefined
                ? {}
                : {
                      parentAgentId: requiredParent(bySessionId, session.parentSessionId).agentId,
                  }),
            path: canonicalAgentPath(session, bySessionId, pathBySessionId),
            providerId: session.providerId,
            relation: session.relation,
            status: session.status,
            totalTokens: session.totalTokens,
        })),
        totalTokens: result.totalTokens,
    };
}

function canonicalAgentPath(
    session: AgentTreeUsageSession,
    bySessionId: ReadonlyMap<string, AgentTreeUsageSession>,
    cache: Map<string, string>,
): string {
    const cached = cache.get(session.sessionId);
    if (cached !== undefined) return cached;
    const path =
        session.relation !== "subagent"
            ? "/root"
            : `${subagentParentPath(session, bySessionId, cache)}/${session.taskName ?? session.agentId}`;
    cache.set(session.sessionId, path);
    return path;
}

function subagentParentPath(
    session: AgentTreeUsageSession,
    bySessionId: ReadonlyMap<string, AgentTreeUsageSession>,
    cache: Map<string, string>,
): string {
    if (session.parentSessionId === undefined) {
        throw new Error("A subagent usage row is missing its parent.");
    }
    const parent = requiredParent(bySessionId, session.parentSessionId);
    return parent.relation === "subagent"
        ? canonicalAgentPath(parent, bySessionId, cache)
        : "/root";
}

function requiredParent(
    bySessionId: ReadonlyMap<string, AgentTreeUsageSession>,
    parentSessionId: string,
): AgentTreeUsageSession {
    const parent = bySessionId.get(parentSessionId);
    if (parent === undefined) throw new Error("An agent usage row has an unavailable parent.");
    return parent;
}
