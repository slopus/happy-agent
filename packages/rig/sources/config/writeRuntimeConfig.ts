import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "smol-toml";

import type { PartialRigConfig } from "./types.js";
import { serializeProviders } from "./serializeProviders.js";
import { runWithRuntimeConfigLock } from "./runtimeConfigLock.js";

export async function writeRuntimeConfig(path: string, config: PartialRigConfig): Promise<void> {
    await runWithRuntimeConfigLock(() => writeRuntimeConfigInsideLock(path, config));
}

/** Writes while the caller holds the shared runtime config lock. */
export async function writeRuntimeConfigInsideLock(
    path: string,
    config: PartialRigConfig,
): Promise<void> {
    const defaults = config.defaults;
    const settings = config.settings;
    const presence = config.presence;
    const providers = config.providers;
    const p2p = config.p2p;
    const theme = config.theme;
    const workspace = config.workspace;
    const document: {
        defaults?: {
            effort?: string;
            instructions?: string;
            model?: string;
            provider?: string;
            permission_mode?: string;
            service_tier?: string;
        };
        theme?: Record<string, string>;
        settings?: {
            inference_max_retries?: number;
            inference_fatal_retries?: number;
            compact_completed_turns?: boolean;
            completion_chime?: boolean;
            daemon_heap_snapshots?: boolean;
            durable_global_event_queue?: boolean;
            happy_integration?: boolean;
            show_reasoning?: boolean;
            show_usage?: boolean;
            tool_result_retention_days?: number;
        };
        presence?: {
            current?: string;
            fallback?: string;
            states?: Record<string, Record<string, string>>;
            until?: string;
        };
        providers?: Record<string, unknown>;
        p2p?: {
            name?: string;
            primary_id?: string;
            role?: string;
        };
        workspace?: {
            sync?: readonly string[];
            protected_sync?: readonly string[];
            setup_commands?: readonly string[];
        };
    } = {};

    if (defaults !== undefined) {
        document.defaults = {};
        if (defaults.modelId !== undefined) {
            document.defaults.model = defaults.modelId;
        }
        if (defaults.providerId !== undefined) {
            document.defaults.provider = defaults.providerId;
        }
        if (defaults.effort !== undefined) {
            document.defaults.effort = defaults.effort;
        }
        if (defaults.instructions !== undefined) {
            document.defaults.instructions = defaults.instructions;
        }
        if (defaults.permissionMode !== undefined) {
            document.defaults.permission_mode = defaults.permissionMode;
        }
        if (defaults.serviceTier !== undefined) {
            document.defaults.service_tier = defaults.serviceTier ?? "default";
        }
    }

    if (settings !== undefined) {
        document.settings = {};
        if (settings.inferenceMaxRetries !== undefined) {
            document.settings.inference_max_retries = settings.inferenceMaxRetries;
        }
        if (settings.inferenceFatalRetries !== undefined) {
            document.settings.inference_fatal_retries = settings.inferenceFatalRetries;
        }
        if (settings.compactCompletedTurns !== undefined) {
            document.settings.compact_completed_turns = settings.compactCompletedTurns;
        }
        if (settings.completionChime !== undefined) {
            document.settings.completion_chime = settings.completionChime;
        }
        if (settings.daemonHeapSnapshots !== undefined) {
            document.settings.daemon_heap_snapshots = settings.daemonHeapSnapshots;
        }
        if (settings.durableGlobalEventQueue !== undefined) {
            document.settings.durable_global_event_queue = settings.durableGlobalEventQueue;
        }
        if (settings.happyIntegration !== undefined) {
            document.settings.happy_integration = settings.happyIntegration;
        }
        if (settings.showReasoning !== undefined) {
            document.settings.show_reasoning = settings.showReasoning;
        }
        if (settings.showUsage !== undefined) document.settings.show_usage = settings.showUsage;
        if (settings.toolResultRetentionDays !== undefined) {
            document.settings.tool_result_retention_days = settings.toolResultRetentionDays;
        }
    }

    if (presence !== undefined) {
        document.presence = {};
        if (presence.current !== undefined) document.presence.current = presence.current;
        if (presence.fallback !== undefined) document.presence.fallback = presence.fallback;
        if (presence.until !== undefined) {
            document.presence.until = new Date(presence.until).toISOString();
        }
        if (presence.states !== undefined && Object.keys(presence.states).length > 0) {
            document.presence.states = Object.fromEntries(
                Object.entries(presence.states).map(([id, state]) => [
                    id,
                    {
                        ...(state.answerWaitMs === undefined
                            ? {}
                            : { answer_wait: serializeAnswerWait(state.answerWaitMs) }),
                        ...(state.emoji === undefined ? {} : { emoji: state.emoji }),
                        ...(state.prompt === undefined ? {} : { prompt: state.prompt }),
                        ...(state.title === undefined ? {} : { title: state.title }),
                    },
                ]),
            );
        }
    }

    if (providers !== undefined || config.providerDefaultEnable !== undefined) {
        document.providers = serializeProviders(providers ?? {}, config.providerDefaultEnable);
    }

    if (p2p?.role !== undefined || p2p?.primaryId !== undefined || p2p?.name !== undefined) {
        document.p2p = {
            ...(p2p.name === undefined ? {} : { name: p2p.name }),
            ...(p2p.primaryId === undefined ? {} : { primary_id: p2p.primaryId }),
            ...(p2p.role === undefined ? {} : { role: p2p.role }),
        };
    }

    if (theme !== undefined) {
        document.theme = { ...theme };
    }

    if (workspace !== undefined) {
        document.workspace = {};
        if (workspace.sync !== undefined) {
            document.workspace.sync = workspace.sync;
        }
        if (workspace.protectedSync !== undefined) {
            document.workspace.protected_sync = workspace.protectedSync;
        }
        if (workspace.setupCommands !== undefined) {
            document.workspace.setup_commands = workspace.setupCommands;
        }
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stringify(document), "utf8");
}

function serializeAnswerWait(answerWaitMs: number | null): string {
    if (answerWaitMs === null) return "unlimited";
    if (answerWaitMs === 0) return "none";
    return `${String(Math.round(answerWaitMs / 1_000))} seconds`;
}
