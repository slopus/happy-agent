import type * as acp from "@agentclientprotocol/sdk";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { execFileHidden } from "@/core/hiddenChildProcess.js";

import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import { ACP_SANDBOXED_META, type AcpConnect } from "@/protocol/acp/AcpConnection.js";
import type { AcpAgentLaunch } from "@/protocol/acp/AcpProvider.js";
import { acpSelectValues, type AcpSelectValue } from "@/protocol/acp/impl/acpConfigOptions.js";
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

/** The first `agy` whose ACP server asks before acting and takes ACP `mcpServers`. */
const MIN_AGY_VERSION = [1, 5, 5] as const;
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
 * agy keeps its own permission system: it asks before what its mode does not allow, and those
 * asks reach Happy. In `accept-edits` and `auto` it asks before every MCP call too, naming the
 * function `mcp_happy_<tool>`; Happy answers those for its own tools by each tool's rule. It takes
 * Happy's bridge as an ACP `mcpServers` entry without advertising that it does.
 *
 * Happy starts it with `--sandbox`, so in `accept-edits` every command runs in agy's terminal
 * sandbox unless the model asks to leave it, and agy asks before each command either way. Happy
 * goes ahead with the sandboxed ones itself and reviews the rest. agy's own `auto` would instead
 * let its own review model clear commands that leave the sandbox without asking anyone.
 */
export const antigravityAgent: ForeignAgent = {
    type: "antigravity",
    modelPrefix: "antigravity",
    label: "Antigravity",
    connect: (start) => {
        const launch = foreignAgentLaunch(start, { command: "agy", args: ["acp", "--sandbox"] });
        // Only Happy's own launch is known to keep the sandbox on.
        const connect =
            start.command === undefined
                ? withSandboxedAsks(acpSpawnConnect(launch))
                : acpSpawnConnect(launch);
        // A configured command may be any adapter; only Happy's own choice is version-checked, and
        // only until it passes once.
        const own = start.command === undefined;
        let checked: Promise<void> | undefined;
        return async (cwd, client) => {
            if (own) {
                checked ??= requireAgyVersion(launch).catch((error: unknown) => {
                    checked = undefined;
                    throw error;
                });
                await checked;
            }
            const connection = await connect(cwd, client);
            if (!own) return connection;
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
        // agy 1.5.10 declares about 60 KB of MCP tools to its model and drops the rest without a
        // way to call them; the margin leaves room for its own schema additions.
        toolDeclarationBudget: 48_000,
        // Happy answers agy's asks by mode. Auto is `accept-edits`, which asks before anything
        // that leaves the project or the sandbox; Full access is agy's Auto with every ask allowed.
        permissionOptions: (mode) => [
            {
                configId: "mode",
                value:
                    mode === "read_only"
                        ? "plan"
                        : mode === "full_access"
                          ? "auto"
                          : "accept-edits",
            },
        ],
    },
    credentialEnvironment: (credentials) =>
        credentials.apiKey === undefined ? {} : { GEMINI_API_KEY: credentials.apiKey },
};

/** agy's `run_command` input when the model keeps the terminal sandbox on, as it does by default. */
const sandboxedCommand = Type.Object({
    CommandLine: Type.String(),
    BypassSandbox: Type.Optional(Type.Literal(false)),
});

/**
 * Mark agy's asks to run a command inside its terminal sandbox, so Happy goes ahead with them
 * itself. Where the sandbox cannot run, agy turns it off and asks before running commands
 * unsandboxed; it offers its Auto mode only where the sandbox works, so without Auto among the
 * session's modes nothing is marked and every command ask is reviewed.
 */
export function withSandboxedAsks(connect: AcpConnect): AcpConnect {
    return async (cwd, client) => {
        let sandboxWorks = false;
        const observe = <T extends { configOptions?: acp.SessionConfigOption[] | null }>(
            response: T,
        ): T => {
            const mode = response.configOptions?.find((option) => option.id === "mode");
            sandboxWorks =
                mode !== undefined && acpSelectValues(mode).some(({ value }) => value === "auto");
            return response;
        };
        const connection = await connect(cwd, {
            ...client,
            requestPermission: (params) =>
                client.requestPermission(
                    sandboxWorks &&
                        params.toolCall.kind === "execute" &&
                        Value.Check(sandboxedCommand, params.toolCall.rawInput)
                        ? {
                              ...params,
                              toolCall: {
                                  ...params.toolCall,
                                  _meta: { ...params.toolCall._meta, [ACP_SANDBOXED_META]: true },
                              },
                          }
                        : params,
                ),
        });
        const conn = connection.conn;
        return {
            ...connection,
            conn: Object.assign(Object.create(conn) as typeof conn, {
                newSession: async (params: acp.NewSessionRequest) =>
                    observe(await conn.newSession(params)),
                loadSession: async (params: acp.LoadSessionRequest) =>
                    observe(await conn.loadSession(params)),
                resumeSession: async (params: acp.ResumeSessionRequest) =>
                    observe(await conn.resumeSession(params)),
            }),
        };
    };
}

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
