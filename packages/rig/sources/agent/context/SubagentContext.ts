import type { Message } from "../types.js";
import type { ServiceTier } from "../../protocol/index.js";

export type SubagentRunStatus = "aborted" | "completed" | "error" | "running" | "suspended";
export type SubagentContextMode = "parent" | "task";

export interface AvailableSubagentModel {
    defaultEffort: string;
    effortLevels: readonly string[];
    id: string;
    name: string;
    providerId: string;
    /**
     * The backend behind this model, which is what decides the searches it can run itself.
     *
     * Unlike the id, this does not change for a named account, so it is what a prompt can say
     * capabilities from. Absent when the catalog does not know it.
     */
    providerType?: string;
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
    disabledProviders?: readonly DisabledSubagentProvider[];
    encryptedMessages?: boolean;
    followUp(
        target: string,
        message: string,
        effort?: string,
        encryptedMessage?: string,
    ): Promise<ManagedSubagent>;
    inspect?(target: string): ManagedSubagent;
    interrupt(target: string): Promise<ManagedSubagent>;
    list(pathPrefix?: string): readonly ManagedSubagent[];
    maxActive?: number;
    maxDepth: number;
    sendMessage?(target: string, message: string, encryptedMessage?: string): ManagedSubagent;
    setReadOnly?(target: string, readOnly: boolean): Promise<ManagedSubagent>;
    spawn(request: SpawnSubagentRequest, signal?: AbortSignal): Promise<SpawnSubagentResult>;
    wait(timeoutMs?: number, signal?: AbortSignal): Promise<WaitForSubagentResult>;
}
