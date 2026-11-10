import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import type { AcpSelectValue } from "@/protocol/acp/impl/acpConfigOptions.js";
import {
    acpSpawnConnect,
    foreignAgentLaunch,
    foreignAgentModelName,
    type ForeignAgent,
    type ForeignAgentModel,
} from "@/vendors/foreignAgents/ForeignAgent.js";

const THREE = ["low", "medium", "high"] as const;
/** Efforts Antigravity spells as a model-value suffix, in Happy's picker order. */
const EFFORT_SUFFIXES: readonly SessionReasoningEffort[] = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

/**
 * antigravity-acp answers a new session from the model list its last run cached, then asks
 * `agy models` (about five seconds) and sends the real list only if it differs.
 */
const MODEL_REVISION_MS = 20_000;

const models: readonly ForeignAgentModel[] = [
    model("gemini-4-carbon", "Gemini 4 Carbon", THREE, "medium"),
    model("gemini-4-argon", "Gemini 4 Argon", THREE, "medium"),
    model("gemini-3.8-flash", "Gemini 3.8 Flash", THREE, "high"),
    model("claude-opus-5-5", "Claude Opus 5.5 (Antigravity)", THREE, "medium"),
    model("claude-sonnet-5-5", "Claude Sonnet 5.5 (Antigravity)", THREE, "medium"),
    model("gpt-oss-120b", "GPT-OSS 120B (Antigravity)", ["medium"], "medium"),
];

/**
 * Google Antigravity through the community `antigravity-acp` adapter, which drives the signed-in
 * `agy` CLI and can resume its conversations.
 *
 * Antigravity names effort inside the model value (`gemini-3.8-flash-high`) and ignores ACP
 * `mcpServers`; it does read `.agents/mcp_config.json` from every workspace directory, so the
 * Happy bridge is placed in a private directory passed as an additional workspace root.
 */
export const antigravityAgent: ForeignAgent = {
    type: "antigravity",
    modelPrefix: "antigravity",
    label: "Antigravity",
    connect: (start) => {
        const connect = acpSpawnConnect(
            foreignAgentLaunch(start, { command: "npx", args: ["-y", "antigravity-acp@1.2.0"] }),
        );
        return async (cwd, client) => ({
            ...(await connect(cwd, client)),
            modelRevisionMs: MODEL_REVISION_MS,
        });
    },
    models,
    modelsFromSelector,
    profile: {
        modelOptions: (selected, effort) => {
            const name = foreignAgentModelName("antigravity", selected);
            if (name === undefined) return [];
            // The API only admits efforts the catalog lists for this model, so the suffix exists.
            const known = models.find((candidate) => candidate.id === selected);
            const level = effort ?? known?.defaultEffort ?? "medium";
            return [{ configId: "model", value: `${name}-${level}` }];
        },
        permissionOptions: (mode) => [
            { configId: "mode", value: mode === "read_only" ? "plan" : "default" },
            { configId: "sandbox", value: mode !== "full_access" },
        ],
        // antigravity-acp binds a new session to the next conversation database agy creates in
        // its shared store, so two new sessions started together can take each other's.
        serializeNewSessions: true,
        bridgeDirectoryFiles: (bridge) => [
            {
                path: ".agents/mcp_config.json",
                content: JSON.stringify({
                    mcpServers: {
                        [bridge.name]: { serverUrl: bridge.url, headers: bridge.headers },
                    },
                }),
            },
        ],
    },
    credentialEnvironment: (credentials) =>
        credentials.apiKey === undefined ? {} : { GEMINI_API_KEY: credentials.apiKey },
};

/**
 * Antigravity lists every model once per effort (`gemini-3.8-flash-high`). Each base name becomes
 * one Happy model whose efforts are its suffixes; a value without a known suffix is one model.
 */
function modelsFromSelector(values: readonly AcpSelectValue[]): readonly ForeignAgentModel[] {
    const grouped = new Map<string, { label: string; efforts: Set<SessionReasoningEffort> }>();
    for (const { value, name } of values) {
        const effort = EFFORT_SUFFIXES.find((level) => value.endsWith(`-${level}`));
        const base = effort === undefined ? value : value.slice(0, -(effort.length + 1));
        const entry = grouped.get(base) ?? {
            label: modelLabel(base, name, effort),
            efforts: new Set(),
        };
        if (effort !== undefined) entry.efforts.add(effort);
        grouped.set(base, entry);
    }
    return [...grouped].map(([base, { label, efforts }]) => {
        const levels = EFFORT_SUFFIXES.filter((level) => efforts.has(level));
        const effortLevels = levels.length === 0 ? (["medium"] as const) : levels;
        const curated = models.find((candidate) => candidate.id === `antigravity/${base}`);
        return model(
            base,
            curated?.name ?? label,
            effortLevels,
            effortLevels.includes("medium") ? "medium" : effortLevels[0]!,
        );
    });
}

/** The agent's label for a model, without the effort it appends to it. */
function modelLabel(
    base: string,
    name: string,
    effort: SessionReasoningEffort | undefined,
): string {
    if (effort === undefined) return name;
    const trimmed = name.replace(new RegExp(`[\\s(-]*${effort}\\)?$`, "i"), "").trim();
    return trimmed.length > 0 && trimmed !== name ? trimmed : base;
}

function model(
    name: string,
    label: string,
    effortLevels: ForeignAgentModel["effortLevels"],
    defaultEffort: ForeignAgentModel["defaultEffort"],
): ForeignAgentModel {
    return {
        id: `antigravity/${name}`,
        name: label,
        effortLevels,
        defaultEffort,
        contextWindow: 1_000_000,
    };
}
