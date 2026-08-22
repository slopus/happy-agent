import { homedir, hostname, platform } from "node:os";

import { describeHappyProvider, type HappyProviderDescriptor } from "./describeHappyProvider.js";
import { HAPPY_PERMISSION_MODES, type HappyPermissionModeKind } from "./happyPermissionModes.js";
import { HAPPY_SPAWN_RETRY_MS } from "./handleHappySpawnSession.js";
import type { HappyConnectionConfiguration } from "./HappyCredentials.js";
import type { HappyModel } from "./HappySession.js";
import type { HappyPublishedModel } from "./createHappySessionMetadata.js";

/** What the phone knows about this computer before it opens any session on it. */
export interface HappyMachineMetadata {
    capabilities: { newSession: boolean; resume: false; worktrees: false };
    client: { id: "rig"; name: "Happy Agent"; version: string };
    defaults: { effort: string; modelId: string; permissionMode: "auto"; providerId: string };
    displayName: string;
    happyHomeDir: string;
    homeDir: string;
    host: string;
    machineKind: "rig";
    models: readonly HappyPublishedModel[];
    operatingModes: readonly {
        code: string;
        description: string;
        kind: HappyPermissionModeKind;
        value: string;
    }[];
    platform: string;
    providers: readonly HappyProviderDescriptor[];
    rigMetadataVersion: 1;
    rigOnly: true;
    /**
     * The machine Happy CLI registered for this same computer.
     *
     * Happy gives each daemon its own machine, so one computer with both arrives as two. This
     * names the other half of the pair, so the phone can offer the computer once and choose the
     * daemon underneath by itself. Absent when this daemon is the only one here.
     */
    siblingMachineId?: string;
    sessionCreation: {
        idempotencyKey: "clientRequestId";
        pendingRetryAfterMs: number;
        resultKinds: readonly string[];
    };
}

/**
 * Describes this computer to Happy.
 *
 * This is what a person sees before any session exists: which machine this is,
 * what it can run, and that it can be asked to start something new. Without it
 * the phone has a daemon it cannot do anything with.
 */
export function createHappyMachineMetadata(options: {
    configuration: HappyConnectionConfiguration;
    models: readonly HappyModel[];
    siblingMachineId?: string;
    version: string;
}): HappyMachineMetadata {
    const defaultModel = options.models[0];
    if (defaultModel === undefined)
        throw new Error("This Happy Agent has no model to offer Happy.");
    const host = hostname();
    return {
        capabilities: { newSession: true, resume: false, worktrees: false },
        client: { id: "rig", name: "Happy Agent", version: options.version },
        defaults: {
            effort: defaultModel.defaultEffort,
            modelId: defaultModel.id,
            permissionMode: "auto",
            providerId: defaultModel.providerId,
        },
        displayName: `${host} — Happy Agent`,
        happyHomeDir: options.configuration.happyHome,
        homeDir: homedir(),
        host,
        machineKind: "rig",
        models: options.models.map((model) => {
            const provider = describeHappyProvider(model.providerId);
            return {
                code: model.id,
                ...(model.contextWindow === undefined
                    ? {}
                    : { contextWindow: model.contextWindow }),
                defaultThinkingLevel: model.defaultEffort,
                id: model.id,
                name: model.name,
                provider,
                providerId: model.providerId,
                providerKind: provider.kind,
                providerName: provider.name,
                serviceTiers: [...model.serviceTiers],
                thinkingLevels: [...model.effortLevels],
                value: model.name,
            };
        }),
        operatingModes: HAPPY_PERMISSION_MODES.map((mode) => ({ ...mode })),
        platform: platform(),
        providers: [...new Set(options.models.map((model) => model.providerId))].map(
            describeHappyProvider,
        ),
        rigMetadataVersion: 1,
        rigOnly: true,
        ...(options.siblingMachineId === undefined
            ? {}
            : { siblingMachineId: options.siblingMachineId }),
        sessionCreation: {
            idempotencyKey: "clientRequestId",
            pendingRetryAfterMs: HAPPY_SPAWN_RETRY_MS,
            resultKinds: ["success", "pending", "requestToApproveDirectoryCreation", "error"],
        },
    };
}
