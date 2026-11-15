import { createHash } from "node:crypto";

import type { AgentNetworkKind } from "@slopus/happy-agent-client";

/** The network of this computer, shared by every agent working here. */
export const HOST_NETWORK_ID = "host";

/** A runner's network is this prefix and the runner's ID. */
export const RUNNER_NETWORK_PREFIX = "r-";

/**
 * The network an agent's machine leaves from, named from the environment the machine was built
 * in: this computer, its runner, or a container of its own. A container's name is derived from
 * the agent, its image, and the machine holding its folder, so it stays the same across restarts
 * and changes with any of them. The kind comes from the same environment, never from the name.
 */
export function agentNetworkId(
    agentId: string,
    environment: { readonly runnerId?: string; readonly docker?: { readonly image: string } },
): { readonly networkId: string; readonly kind: AgentNetworkKind } {
    if (environment.docker !== undefined) {
        const digest = createHash("sha256")
            .update(
                JSON.stringify([agentId, environment.docker.image, environment.runnerId ?? null]),
            )
            .digest("hex");
        return { networkId: `c-${digest.slice(0, 32)}`, kind: "container" };
    }
    return environment.runnerId === undefined
        ? { networkId: HOST_NETWORK_ID, kind: "host" }
        : { networkId: `${RUNNER_NETWORK_PREFIX}${environment.runnerId}`, kind: "runner" };
}
