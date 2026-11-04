import {
    foreignAgentModelName,
    foreignModelsWithEfforts,
    type ForeignAgent,
    type ForeignAgentModel,
} from "@/vendors/foreignAgents/ForeignAgent.js";
import { claudeAgentConnect } from "@/vendors/claudeAgent/claudeAgentConnect.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const models: readonly ForeignAgentModel[] = [
    model("opus", "Claude Code · Opus"),
    model("sonnet", "Claude Code · Sonnet"),
    model("haiku", "Claude Code · Haiku"),
];

/**
 * Unmodified Claude Code through the Claude Agent SDK: Claude's own prompt, tools, settings,
 * subagents and compaction, with Happy's tools bridged over MCP, real mid-turn steering, and the
 * models the signed-in account serves. The SDK starts the Claude Code build Happy ships with.
 */
export const claudeCodeAgent: ForeignAgent = {
    type: "claude-code",
    modelPrefix: "claude-code",
    label: "Claude Code",
    connect: (start) => claudeAgentConnect(start.env, start.onAccountUsage),
    models,
    modelsFromSelector: (values) =>
        foreignModelsWithEfforts("claude-code", values, (value, name) => ({
            name: `Claude Code · ${name}`,
            contextWindow: value === "haiku" ? 200_000 : 1_000_000,
        })),
    profile: {
        modelOptions: (selected, effort) => {
            const name = foreignAgentModelName("claude-code", selected);
            if (name === undefined) return [];
            return [
                { configId: "model", value: name },
                ...(effort === undefined || !(EFFORTS as readonly string[]).includes(effort)
                    ? []
                    : [{ configId: "effort", value: effort }]),
            ];
        },
        permissionOptions: (mode) => [
            {
                configId: "mode",
                value:
                    mode === "read_only"
                        ? "plan"
                        : mode === "workspace_write"
                          ? "acceptEdits"
                          : mode === "auto"
                            ? "auto"
                            : "bypassPermissions",
            },
        ],
    },
    credentialEnvironment: (credentials) => ({
        ...(credentials.oauthToken === undefined
            ? {}
            : { CLAUDE_CODE_OAUTH_TOKEN: credentials.oauthToken }),
        ...(credentials.apiKey === undefined ? {} : { ANTHROPIC_API_KEY: credentials.apiKey }),
        ...(credentials.authToken === undefined
            ? {}
            : { ANTHROPIC_AUTH_TOKEN: credentials.authToken }),
        ...(credentials.configDir === undefined
            ? {}
            : { CLAUDE_CONFIG_DIR: credentials.configDir }),
    }),
};

function model(name: string, label: string): ForeignAgentModel {
    return {
        id: `claude-code/${name}`,
        name: label,
        effortLevels: EFFORTS,
        defaultEffort: "high",
        contextWindow: name === "haiku" ? 200_000 : 1_000_000,
    };
}
