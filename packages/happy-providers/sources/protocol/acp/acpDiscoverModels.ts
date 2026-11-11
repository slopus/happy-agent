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
 */
export async function acpDiscoverModels(
    agent: AcpAgentLaunch | AcpConnect,
    cwd: string,
): Promise<readonly AcpSelectValue[]> {
    const client: acp.Client = {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => undefined,
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
        return selectorModels(session.configOptions);
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
