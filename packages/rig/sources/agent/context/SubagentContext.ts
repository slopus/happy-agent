import type { Message } from "../types.js";
import type { HostedCapability, ServiceTier } from "@slopus/rig-execution";

export type SubagentRunStatus = "aborted" | "completed" | "error" | "running" | "suspended";
export type SubagentContextMode = "parent" | "task";

export interface AvailableSubagentModel {
    defaultEffort: string;
    effortLevels: readonly string[];
    id: string;
    name: string;
    providerId: string;
}

export interface DisabledSubagentProvider {
    id: string;
    reason: "not_authenticated" | "not_enabled" | "no_models";
}

export interface ManagedSubagent {
    agentId: string;
    description: string;
    output?: string;
    path: string;
    status: SubagentRunStatus;
}

export interface SpawnSubagentRequest {
    background?: boolean;
    /**
     * Provider-executed searches to grant this child. Rig cannot review one of these once the
     * child holds it, so the spawn is where it is reviewed and the grant lasts the child's life.
     */
    capabilities?: readonly HostedCapability[];
    contextMode?: SubagentContextMode;
    contextMessages?: readonly Message[];
    description: string;
    effort?: string;
    encryptedPrompt?: string;
    modelId?: string;
    providerId?: string;
    serviceTier?: ServiceTier;
    parentToolCallId?: string;
    prompt: string;
    /** Restrict this child to read only instead of inheriting the parent mode. */
    readOnly?: boolean;
    taskName?: string;
    waitForSlot?: boolean;
    /** Rig-owned location override used by managed workspace agents. */
    cwd?: string;
    workspaceId?: string;
}

export interface SpawnSubagentResult {
    agentId: string;
    output: string;
    path: string;
    status: SubagentRunStatus;
}

export interface WaitForSubagentResult {
    agents: readonly ManagedSubagent[];
    timedOut: boolean;
}

export interface SubagentContext {
    availableModels?: readonly AvailableSubagentModel[];
    canSpawn: boolean;
    depth: number;
    /**
     * Provider-executed searches this agent may hand to a child. Empty unless the agent can
     * reach outside the sandbox itself, and always empty for an agent that already holds one:
     * a capability Rig cannot intercept goes one level deep and stops.
     */
    grantableCapabilities?: readonly HostedCapability[];
    disabledProviders?: readonly DisabledSubagentProvider[];
    encryptedMessages?: boolean;
    followUp(
        target: string,
        message: string,
        effort?: string,
        encryptedMessage?: string,
    ): ManagedSubagent;
    inspect?(target: string): ManagedSubagent;
    interrupt(target: string): ManagedSubagent;
    list(pathPrefix?: string): readonly ManagedSubagent[];
    maxActive?: number;
    maxDepth: number;
    sendMessage?(target: string, message: string, encryptedMessage?: string): ManagedSubagent;
    setReadOnly?(target: string, readOnly: boolean): Promise<ManagedSubagent>;
    spawn(request: SpawnSubagentRequest, signal?: AbortSignal): Promise<SpawnSubagentResult>;
    wait(timeoutMs?: number, signal?: AbortSignal): Promise<WaitForSubagentResult>;
}
