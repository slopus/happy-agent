import { execFileHidden } from "@/core/hiddenChildProcess.js";

import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import type { AcpAgentLaunch } from "@/protocol/acp/AcpProvider.js";
import type { AcpSelectValue } from "@/protocol/acp/impl/acpConfigOptions.js";
import { antigravityHappyOnly } from "@/vendors/foreignAgents/antigravityHappyOnly.js";
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

/** The first `agy` known to run Happy's custom agent: no tools of its own, Happy's MCP allowed. */
const MIN_AGY_VERSION = [1, 5, 15] as const;
const VERSION_TIMEOUT_MS = 15_000;

const models: readonly ForeignAgentModel[] = [
    model("gemini-4-carbon", "Gemini 4 Carbon", THREE, "medium"),
    model("gemini-4-argon", "Gemini 4 Argon", THREE, "medium"),
    model("gemini-3.8-flash", "Gemini 3.8 Flash", THREE, "high"),
    model("claude-opus-5-5", "Claude Opus 5.5 (Antigravity)", THREE, "medium"),
    model("claude-sonnet-5-5", "Claude Sonnet 5.5 (Antigravity)", THREE, "medium"),
    model("gpt-oss-120b", "GPT-OSS 120B (Antigravity)", ["medium"], "medium"),
];

/**
 * Google Antigravity through its own ACP server, `agy acp`, with the signed-in `agy` CLI.
 *
 * Happy starts agy as a custom agent with none of agy's own tools but web search (see
 * {@link antigravityHappyOnly}), so it reads, writes, runs commands and starts sub-agents only
 * through Happy's bridged tools, under Happy's one sandbox and reviewer. agy asks before every
 * MCP call; those asks are approved, because Happy decides each call when it runs. Happy's
 * instructions and a guide to its tools become the end of agy's system prompt.
 */
export const antigravityAgent: ForeignAgent = {
    type: "antigravity",
    modelPrefix: "antigravity",
    label: "Antigravity",
    connect: (start) => {
        const launch = foreignAgentLaunch(start, { command: "agy", args: ["acp"] });
        // A configured command may be any adapter, run as it is; only Happy's own launch is known
        // to take a custom agent, and only it is version-checked, until it passes once.
        if (start.command !== undefined) return acpSpawnConnect(launch);
        const connect = antigravityHappyOnly(launch);
        let checked: Promise<void> | undefined;
        return async (cwd, client) => {
            checked ??= requireAgyVersion(launch).catch((error: unknown) => {
                checked = undefined;
                throw error;
            });
            await checked;
            const connection = await connect(cwd, client);
            const capabilities = connection.init.agentCapabilities;
            return {
                ...connection,
                init: {
                    ...connection.init,
                    agentCapabilities: {
                        ...capabilities,
                        mcpCapabilities: { ...capabilities?.mcpCapabilities, http: true },
                    },
                },
            };
        };
    },
    models,
    modelsFromSelector,
    profile: {
        modelOptions: (selected, effort) => {
            const name = foreignAgentModelName("antigravity", selected);
            if (name === undefined) return [];
            const known = models.find((candidate) => candidate.id === selected);
            const level = effort ?? known?.defaultEffort ?? "medium";
            // agy names most models plainly and takes the effort as its thinking level; a model
            // it serves at one effort only carries that effort in its name. Only the value agy
            // offers is set.
            return [
                { configId: "model", value: name },
                { configId: "model", value: `${name}-${level}` },
                { configId: "thought_level", value: level },
            ];
        },
        // agy 1.5.10 declared about 60 KB of MCP tools to its model and dropped the rest without a
        // way to call them; the margin leaves room for its own schema additions. 1.5.15 shows its
        // model only the tools' names, and call_tool describes them.
        toolDeclarationBudget: 48_000,
        // One mode for every Happy mode: agy's `default` asks before each MCP call, and before any
        // edit or command of its own should it ever have tools again. Happy's own mode decides
        // what its tools may do.
        permissionOptions: () => [{ configId: "mode", value: "default" }],
        systemPromptMeta: (prompt) => ({ antigravity: { systemPrompt: { append: prompt } } }),
    },
    credentialEnvironment: (credentials) =>
        credentials.apiKey === undefined ? {} : { GEMINI_API_KEY: credentials.apiKey },
};

/**
 * agy lists most models by name and takes their effort as a separate thinking level, and names a
 * model it serves at one effort only with that effort (`gpt-oss-120b-medium`). Each base name
 * becomes one Happy model: a suffixed one at its suffixes, a plain one at the thinking levels.
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
        const curated = models.find((candidate) => candidate.id === `antigravity/${base}`);
        const effortLevels = levels.length > 0 ? levels : (curated?.effortLevels ?? THREE);
        const defaultEffort =
            curated !== undefined && effortLevels.includes(curated.defaultEffort)
                ? curated.defaultEffort
                : effortLevels.includes("medium")
                  ? "medium"
                  : effortLevels[0]!;
        return model(base, curated?.name ?? label, effortLevels, defaultEffort);
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

/** Fail with a clear message when the installed `agy` is missing or older than Happy needs. */
async function requireAgyVersion(launch: AcpAgentLaunch): Promise<void> {
    const required = MIN_AGY_VERSION.join(".");
    const output = await new Promise<string>((resolve, reject) => {
        execFileHidden(
            launch.command,
            ["--version"],
            { env: { ...process.env, ...launch.env }, timeout: VERSION_TIMEOUT_MS },
            (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
        );
    }).catch((error: unknown) => {
        throw new Error(
            (error as NodeJS.ErrnoException).code === "ENOENT"
                ? `Antigravity's agy command was not found. Install Antigravity ${required} or newer and sign in to agy.`
                : `Could not read the version of Antigravity's agy: ${String(error)}`,
        );
    });
    const found = /(\d+)\.(\d+)\.(\d+)/u.exec(output);
    if (found === null) {
        throw new Error(`Could not read the version of Antigravity's agy from "${output.trim()}".`);
    }
    const version = found.slice(1, 4).map(Number);
    for (const [index, part] of version.entries()) {
        const minimum = MIN_AGY_VERSION[index]!;
        if (part > minimum) return;
        if (part < minimum) {
            throw new Error(
                `Happy needs Antigravity's agy ${required} or newer, but ${found[0]} is installed. Update Antigravity and try again.`,
            );
        }
    }
}
