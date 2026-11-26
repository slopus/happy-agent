import type * as acp from "@agentclientprotocol/sdk";

import type { AcpConnect } from "@/protocol/acp/AcpConnection.js";
import type { AcpAgentLaunch } from "@/protocol/acp/AcpProvider.js";
import { acpConnectionSpawn } from "@/protocol/acp/impl/acpConnectionSpawn.js";
import { acpSelectValues, type AcpSelectValue } from "@/protocol/acp/impl/acpConfigOptions.js";

const DISCOVERY_TIMEOUT_MS = 30_000;
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface SessionAvailableModel {
    readonly modelId?: unknown;
    readonly name?: unknown;
}

interface SessionModelsResponse {
    readonly models?: {
        readonly availableModels?: readonly SessionAvailableModel[] | null;
    } | null;
}

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
        return selectorModels(session);
    } finally {
        connection.terminate();
    }
}

function selectorModels(session: acp.NewSessionResponse): readonly AcpSelectValue[] {
    const options = session.configOptions;
    const selector = options?.find(
        (option) => option.category === "model" || option.id === "model",
    );
    const available = availableModelsOf(session);
    if (selector === undefined) {
        return available.map((model) => ({ value: model.modelId, name: model.name }));
    }
    const values = acpSelectValues(selector);
    if (available.length === 0 && !hasThoughtLevel(options)) return values;
    const availableIds = new Set(available.map((model) => model.modelId));
    const currentThoughtLevels =
        selector.type === "select" ? thoughtLevelsForCurrent(options) : undefined;
    return values.map((entry) => {
        if (entry.meta?.["efforts"] !== undefined) return entry;
        const fromAvailable = EFFORT_LEVELS.filter((level) =>
            availableIds.has(`${entry.value}-${level}`),
        );
        const efforts =
            fromAvailable.length > 0
                ? fromAvailable
                : selector.type === "select" &&
                    selector.currentValue === entry.value &&
                    currentThoughtLevels !== undefined &&
                    currentThoughtLevels.length > 0
                  ? currentThoughtLevels
                  : undefined;
        return efforts === undefined ? entry : { ...entry, meta: { ...entry.meta, efforts } };
    });
}

function availableModelsOf(
    session: acp.NewSessionResponse,
): readonly { readonly modelId: string; readonly name: string }[] {
    const raw = (session as acp.NewSessionResponse & SessionModelsResponse).models?.availableModels;
    if (!Array.isArray(raw)) return [];
    const result: { readonly modelId: string; readonly name: string }[] = [];
    for (const entry of raw) {
        if (typeof entry?.modelId !== "string" || entry.modelId.length === 0) continue;
        result.push({
            modelId: entry.modelId,
            name:
                typeof entry.name === "string" && entry.name.length > 0
                    ? entry.name
                    : entry.modelId,
        });
    }
    return result;
}

function hasThoughtLevel(options: readonly acp.SessionConfigOption[] | null | undefined): boolean {
    return (
        options?.some(
            (option) =>
                (option.category === "thought_level" || option.id === "thought_level") &&
                option.type === "select",
        ) === true
    );
}

function thoughtLevelsForCurrent(
    options: readonly acp.SessionConfigOption[] | null | undefined,
): readonly string[] | undefined {
    const option = options?.find(
        (candidate) =>
            (candidate.category === "thought_level" || candidate.id === "thought_level") &&
            candidate.type === "select",
    );
    if (option === undefined) return undefined;
    return acpSelectValues(option)
        .map((entry) => entry.value)
        .filter((value) => (EFFORT_LEVELS as readonly string[]).includes(value));
}
