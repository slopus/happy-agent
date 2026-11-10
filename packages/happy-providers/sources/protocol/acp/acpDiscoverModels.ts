import type * as acp from "@agentclientprotocol/sdk";

import type { AcpConnect } from "@/protocol/acp/AcpConnection.js";
import type { AcpAgentLaunch } from "@/protocol/acp/AcpProvider.js";
import { acpConnectionSpawn } from "@/protocol/acp/impl/acpConnectionSpawn.js";
import { acpSelectValues, type AcpSelectValue } from "@/protocol/acp/impl/acpConfigOptions.js";

const DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Ask a foreign agent which models it serves right now: start it, open a throwaway session in
 * `cwd`, and read the values of its model selector. The session is never prompted, so nothing
 * runs and no conversation is created. An agent without a model selector reports none.
 *
 * An agent that declares {@link AcpConnection.modelRevisionMs} answers from a cache first, so the
 * session stays open that long for a `config_option_update` carrying a different list, which
 * replaces the first answer. Leaving earlier would also end the agent before it renews its cache.
 */
export async function acpDiscoverModels(
    agent: AcpAgentLaunch | AcpConnect,
    cwd: string,
): Promise<readonly AcpSelectValue[]> {
    let updated: readonly AcpSelectValue[] | undefined;
    let onUpdated = (): void => undefined;
    const client: acp.Client = {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        // Discovery opens one session on this connection, so every update is about it.
        sessionUpdate: async ({ update }) => {
            if (update.sessionUpdate !== "config_option_update") return;
            const values = selectorModels(update.configOptions);
            if (values.length === 0) return;
            updated = values;
            onUpdated();
        },
    };
    const connection =
        typeof agent === "function"
            ? await agent(cwd, client)
            : await acpConnectionSpawn(agent, cwd, client);
    try {
        const session = await Promise.race([
            connection.conn.newSession({ cwd, mcpServers: [] }),
            new Promise<never>((_, reject) => {
                setTimeout(
                    () => reject(new Error("The agent did not open a session.")),
                    DISCOVERY_TIMEOUT_MS,
                ).unref();
            }),
        ]);
        const first = selectorModels(session.configOptions);
        const revisionMs = connection.modelRevisionMs;
        if (revisionMs === undefined) return first;
        // Agents repeat the list they already gave once the session is open; only a different
        // one is a revision.
        const revised = (): boolean =>
            updated !== undefined && JSON.stringify(updated) !== JSON.stringify(first);
        if (!revised()) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, revisionMs);
                const settle = (): void => {
                    clearTimeout(timer);
                    resolve();
                };
                onUpdated = () => {
                    if (revised()) settle();
                };
                void connection.exited.then(settle);
            });
        }
        return revised() ? updated! : first;
    } finally {
        connection.terminate();
    }
}

function selectorModels(
    options: readonly acp.SessionConfigOption[] | null | undefined,
): readonly AcpSelectValue[] {
    const selector = options?.find(
        (option) => option.category === "model" || option.id === "model",
    );
    return selector === undefined ? [] : acpSelectValues(selector);
}
