import type { SecretApiTarget } from "../../secrets/index.js";

/** Where an agent's command may draw attached secrets from: the agent, its workspace, its project. */
export function secretCommandTargets(
    agentId: string,
    scope: { readonly projectId?: string; readonly workspaceId?: string } | undefined,
): SecretApiTarget[] {
    return [
        { type: "agent", id: agentId },
        ...(scope?.workspaceId === undefined
            ? []
            : [{ type: "workspace" as const, id: scope.workspaceId }]),
        ...(scope?.projectId === undefined
            ? []
            : [{ type: "project" as const, id: scope.projectId }]),
    ];
}
