import type { ProviderUsage } from "@/core/ProviderUsage.js";
import type { AcpConnect } from "@/protocol/acp/AcpConnection.js";
import type { AcpAgentLaunch, AcpAgentProfile } from "@/protocol/acp/AcpProvider.js";
import { acpConnectionSpawn } from "@/protocol/acp/impl/acpConnectionSpawn.js";
import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import type { AcpSelectValue } from "@/protocol/acp/impl/acpConfigOptions.js";

/**
 * The foreign agents Happy can drive, by harness type: Claude Code and Codex through their own
 * typed APIs; Antigravity, OpenCode, and any other agent through the Agent Client Protocol.
 */
export type ForeignAgentType = "claude-code" | "codex-cli" | "antigravity" | "opencode" | "acp";

export const FOREIGN_AGENT_TYPES: readonly ForeignAgentType[] = [
    "claude-code",
    "codex-cli",
    "antigravity",
    "opencode",
    "acp",
];

/**
 * One model a foreign agent serves, under Happy's `<prefix>/<the agent's model value>` ID. The
 * prefix is the agent's type, or `acp/<harness>` for a configured ACP agent.
 */
export interface ForeignAgentModel {
    readonly id: string;
    readonly name: string;
    readonly effortLevels: readonly SessionReasoningEffort[];
    readonly defaultEffort: SessionReasoningEffort;
    readonly contextWindow: number;
}

/** Credentials a foreign agent may be started with instead of its CLI's default login. */
export interface ForeignAgentCredentials {
    readonly apiKey?: string;
    readonly authToken?: string;
    readonly oauthToken?: string;
    /** The agent CLI's own configuration directory, such as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. */
    readonly configDir?: string;
}

/** What configuration says about starting one account's agent. */
export interface ForeignAgentStart {
    /** The program to start instead of the agent's default, when the agent starts one. */
    readonly command?: string;
    readonly args?: readonly string[];
    /** The credentials' environment and any configured extra variables. */
    readonly env: NodeJS.ProcessEnv;
    /** Told the account limits the agent reports while it works, under its vendor's provider key. */
    readonly onAccountUsage?: (usage: ProviderUsage) => void;
    /** The harness lets its agent send the agent's own telemetry. */
    readonly telemetry?: boolean;
}

/** Everything that differs between foreign agents, around one shared session implementation. */
export interface ForeignAgent {
    readonly type: ForeignAgentType;
    readonly label: string;
    /** The model ID prefix, without its trailing slash. */
    readonly modelPrefix: string;
    /**
     * How to reach the agent: a first-party driver over the vendor's own typed API, which takes
     * steering mid-turn, or an ACP adapter process. `start` carries the configured overrides.
     */
    connect(start: ForeignAgentStart): AcpConnect;
    /** The models assumed until the agent has been asked which it serves. */
    readonly models: readonly ForeignAgentModel[];
    /** Turn the values of the agent's own model selector into Happy models. */
    readonly modelsFromSelector: (
        values: readonly AcpSelectValue[],
    ) => readonly ForeignAgentModel[];
    readonly profile: AcpAgentProfile;
    /** Environment that hands the configured credentials to the agent's own CLI. */
    credentialEnvironment(credentials: ForeignAgentCredentials): NodeJS.ProcessEnv;
}

/** The agent's own model value for a Happy `<prefix>/<model>` ID. */
export function foreignAgentModelName(
    prefix: string,
    model: string | undefined,
): string | undefined {
    const head = `${prefix}/`;
    return model?.startsWith(head) === true ? model.slice(head.length) : undefined;
}

/** Whether a Happy model ID names a foreign agent's model. */
export function isForeignAgentModel(model: string): boolean {
    return FOREIGN_AGENT_TYPES.some((type) => model.startsWith(`${type}/`));
}

const HAPPY_EFFORTS: readonly SessionReasoningEffort[] = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];

/**
 * Happy models from a model selector whose values carry their efforts in `_meta`, as the
 * first-party drivers report them. Efforts Happy has no name for are left out, and a value with
 * none is offered at medium.
 */
export function foreignModelsWithEfforts(
    prefix: string,
    values: readonly AcpSelectValue[],
    shape: (
        value: string,
        name: string,
    ) => { readonly name: string; readonly contextWindow: number },
): readonly ForeignAgentModel[] {
    return values.map(({ value, name, meta }) => {
        const offered = Array.isArray(meta?.["efforts"]) ? (meta["efforts"] as unknown[]) : [];
        const efforts = HAPPY_EFFORTS.filter((effort) => offered.includes(effort));
        const effortLevels = efforts.length === 0 ? (["medium"] as const) : efforts;
        const preferred = meta?.["defaultEffort"];
        const defaultEffort =
            effortLevels.find((effort) => effort === preferred) ??
            (effortLevels.includes("medium") ? "medium" : effortLevels[0]!);
        return { id: `${prefix}/${value}`, ...shape(value, name), effortLevels, defaultEffort };
    });
}

/** The ACP adapter `start` names, or `fallback` when configuration names none. */
export function foreignAgentLaunch(
    start: ForeignAgentStart,
    fallback: AcpAgentLaunch | undefined,
): AcpAgentLaunch {
    const command = start.command ?? fallback?.command;
    if (command === undefined) throw new Error("The agent has no command to start.");
    const args = start.command === undefined ? (fallback?.args ?? []) : (start.args ?? []);
    return { command, args, env: start.env };
}

/** Speak ACP to an adapter process. */
export function acpSpawnConnect(launch: AcpAgentLaunch): AcpConnect {
    return (cwd, client) => acpConnectionSpawn(launch, cwd, client);
}
