import { homedir, hostname, platform } from "node:os";

import type { ModelCatalog } from "../protocol/index.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { HAPPY_SPAWN_PENDING_RETRY_AFTER_MS } from "../happySpawnTiming.js";
import { createHappyCatalogMetadata } from "./createHappyCatalogMetadata.js";
import { HAPPY_PERMISSION_MODES } from "./happyPermissionModes.js";
import type { HappyConnectionConfiguration, HappyMachineMetadata } from "./types.js";

export function createHappyMachineMetadata(options: {
    configuration: HappyConnectionConfiguration;
    modelCatalog: ModelCatalog;
    now?: () => number;
    /** Advertised only when the daemon can actually create workspaces. */
    supportsWorktrees?: boolean;
}): HappyMachineMetadata {
    const { models, providers } = createHappyCatalogMetadata(options.modelCatalog);
    const defaultModel = models.find(
        (model) =>
            model.id === options.modelCatalog.defaultModelId &&
            model.providerId === options.modelCatalog.defaultProviderId,
    );
    if (defaultModel === undefined) throw new Error("Rig's default model is unavailable.");
    const version = readPackageVersion();
    const host = hostname();
    const detectedAt = (options.now ?? Date.now)();
    return {
        capabilities: {
            newSession: true,
            resume: false,
            worktrees: options.supportsWorktrees === true,
        },
        cliAvailability: {
            agy: false,
            claude: false,
            codex: false,
            detectedAt,
            gemini: false,
            openclaw: false,
            rig: true,
        },
        client: { id: "rig", name: "Rig", version },
        defaults: {
            effort: defaultModel.defaultThinkingLevel,
            modelId: defaultModel.id,
            permissionMode: "auto",
            providerId: defaultModel.providerId,
        },
        displayName: `${host} — Rig`,
        happyCliVersion: version,
        happyHomeDir: options.configuration.happyHome,
        happyLibDir: options.configuration.happyHome,
        homeDir: homedir(),
        host,
        machineKind: "rig",
        models,
        operatingModes: HAPPY_PERMISSION_MODES.map((mode) => ({ ...mode })),
        platform: platform(),
        providers,
        resumeSupport: {
            detectedAt,
            happyAgentAuthenticated: false,
            requiresHappyAgentAuth: false,
            requiresSameMachine: true,
            rpcAvailable: false,
        },
        sessionCreation: {
            idempotencyKey: "clientRequestId",
            pendingRetryAfterMs: HAPPY_SPAWN_PENDING_RETRY_AFTER_MS,
            resultKinds: ["success", "pending", "requestToApproveDirectoryCreation", "error"],
        },
        rigMetadataVersion: 1,
        rigOnly: true,
    };
}
