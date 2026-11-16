import {
    foreignAgentLaunch,
    foreignAgentModelName,
    foreignModelsWithEfforts,
    type ForeignAgent,
    type ForeignAgentModel,
} from "@/vendors/foreignAgents/ForeignAgent.js";
import { codexAppServerConnect } from "@/vendors/codexAppServer/codexAppServerConnect.js";
import { codexAppServerLaunch } from "@/vendors/codexAppServer/resolveCodexExecutable.js";
import { getCodexModelProperties } from "@/vendors/codex/impl/getCodexModelProperties.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
// Ultra is selectable only when Codex advertises it; keep the fallback catalog unchanged.
const CONFIG_EFFORTS = [...EFFORTS, "ultra"] as const;

const models: readonly ForeignAgentModel[] = [
    model("gpt-6.1-sol", "Codex · GPT-6.1 Sol", "high"),
    model("gpt-6.1-terra", "Codex · GPT-6.1 Terra", "low"),
    model("gpt-6-sol", "Codex · GPT-6 Sol", "high"),
    model("gpt-6-luna", "Codex · GPT-6 Luna", "medium"),
];

/**
 * Unmodified Codex through `codex app-server`, the typed API the Codex apps use: Codex's own
 * prompt, tools, sandbox and subagents, with Happy's tools bridged over MCP, real mid-turn
 * steering, and the models the signed-in account serves. It runs the pinned release installed with
 * Happy, else an installed `codex`; a configured `command` replaces both, and its `args` must start
 * the app-server.
 */
export const codexCliAgent: ForeignAgent = {
    type: "codex-cli",
    modelPrefix: "codex-cli",
    label: "Codex CLI",
    connect: (start) =>
        codexAppServerConnect(
            start.command === undefined
                ? codexAppServerLaunch(start.env)
                : foreignAgentLaunch(start, undefined),
            start.onAccountUsage,
        ),
    models,
    modelsFromSelector: (values) =>
        foreignModelsWithEfforts(
            "codex-cli",
            values,
            (value, name) => ({
                name: `Codex · ${name}`,
                contextWindow: getCodexModelProperties(value)?.contextWindow ?? 272_000,
            }),
            ["minimal", ...CONFIG_EFFORTS],
        ),
    profile: {
        modelOptions: (selected, effort) => {
            const name = foreignAgentModelName("codex-cli", selected);
            if (name === undefined) return [];
            return [
                { configId: "model", value: name },
                ...(effort === undefined || !(CONFIG_EFFORTS as readonly string[]).includes(effort)
                    ? []
                    : [{ configId: "reasoning_effort", value: effort }]),
            ];
        },
        // Codex's sandbox and who decides what it would block: the person in Workspace write,
        // Codex's own reviewer in Auto.
        permissionOptions: (mode) => [
            {
                configId: "mode",
                value:
                    mode === "read_only"
                        ? "read-only"
                        : mode === "full_access"
                          ? "danger-full-access"
                          : mode === "auto"
                            ? "auto"
                            : "workspace-write",
            },
        ],
    },
    credentialEnvironment: (credentials) => ({
        ...(credentials.apiKey === undefined ? {} : { OPENAI_API_KEY: credentials.apiKey }),
        ...(credentials.configDir === undefined ? {} : { CODEX_HOME: credentials.configDir }),
    }),
};

function model(
    name: string,
    label: string,
    defaultEffort: ForeignAgentModel["defaultEffort"],
): ForeignAgentModel {
    return {
        id: `codex-cli/${name}`,
        name: label,
        effortLevels: EFFORTS,
        defaultEffort,
        contextWindow: getCodexModelProperties(name)?.contextWindow ?? 272_000,
    };
}
