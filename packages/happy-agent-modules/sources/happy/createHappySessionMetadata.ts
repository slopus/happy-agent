import { homedir, hostname, platform, release } from "node:os";

import { describeHappyProvider, type HappyProviderDescriptor } from "./describeHappyProvider.js";
import { HAPPY_PERMISSION_MODES, type HappyPermissionModeKind } from "./happyPermissionModes.js";
import { HAPPY_SESSION_RPC_METHODS } from "./handleHappySessionRpc.js";
import type { HappyConnectionConfiguration } from "./HappyCredentials.js";
import type { HappyModel, HappySessionSnapshot } from "./HappySession.js";

/** How large an attachment Happy may send. */
export const MAX_HAPPY_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** One model as Happy publishes it. */
export interface HappyPublishedModel {
    code: string;
    contextWindow?: number;
    defaultThinkingLevel: string;
    id: string;
    name: string;
    provider: HappyProviderDescriptor;
    providerId: string;
    providerKind: string;
    providerName: string;
    serviceTiers: readonly string[];
    thinkingLevels: readonly string[];
    value: string;
}

/** Everything the phone needs to draw a session before a single message arrives. */
export interface HappySessionMetadata {
    activity: { session: { kind: string; since?: number } };
    capabilities: {
        abort: boolean;
        attachments: { enabled: boolean; maxBytes: number; mediaTypes: readonly string[] };
        files: { browse: boolean; read: boolean; search: boolean; write: boolean };
        modelSelection: boolean;
        permissionModeSelection: boolean;
        reasoningSelection: boolean;
        resume: boolean;
        rpcMethods: readonly string[];
        shell: boolean;
        steering: boolean;
    };
    client: { id: "rig"; name: "Happy Agent"; version: string };
    currentModelCode: string;
    currentModelProviderId: string;
    currentOperatingModeCode: string;
    currentThoughtLevelCode?: string;
    flavor: string;
    happyHomeDir: string;
    homeDir: string;
    host: string;
    hostPid: number;
    machineId?: string;
    model: { id: string; providerId: string };
    models: readonly HappyPublishedModel[];
    name: string;
    operatingModes: readonly {
        code: string;
        description: string;
        kind: HappyPermissionModeKind;
        value: string;
    }[];
    os: string;
    path: string;
    permissionMode: string;
    project: { id: string; kind: "regular"; name: string };
    provider: HappyProviderDescriptor;
    providers: readonly HappyProviderDescriptor[];
    reasoning: { current: string | null; levels: readonly string[] };
    rigMetadataVersion: 1;
    session: { modelLocked: false; permissionMode: string; serviceTier?: string; status: string };
    startedBy: "daemon";
    startedFromDaemon: true;
    summary: { text: string; updatedAt: number };
    thoughtLevels: readonly { code: string; value: string }[];
    tools: readonly string[];
}

/**
 * Describes one Happy Agent session in Happy's own terms.
 *
 * This is what makes the phone useful before anything is said: which model is
 * running, what else it could run, what the session may touch, and what Happy Agent can
 * be asked to do for it. It is republished whenever any of that changes.
 */
export function createHappySessionMetadata(options: {
    configuration: HappyConnectionConfiguration;
    models: readonly HappyModel[];
    session: HappySessionSnapshot;
    summaryUpdatedAt: number;
    version: string;
}): HappySessionMetadata {
    const { configuration, models, session } = options;
    const selected = models.find(
        (model) => model.id === session.modelId && model.providerId === session.providerId,
    );
    const providerIds = [...new Set(models.map((model) => model.providerId))];
    const providers = (providerIds.length === 0 ? [session.providerId] : providerIds).map(
        describeHappyProvider,
    );
    const provider = describeHappyProvider(session.providerId);
    const efforts = selected?.effortLevels ?? [];
    return {
        activity: {
            session: session.working
                ? { kind: "thinking" }
                : { kind: session.archived ? "archived" : "idle" },
        },
        capabilities: {
            abort: true,
            attachments: {
                enabled: true,
                maxBytes: MAX_HAPPY_ATTACHMENT_BYTES,
                mediaTypes: ["image/*"],
            },
            files: {
                browse: false,
                read: false,
                search: false,
                write: false,
            },
            modelSelection: true,
            permissionModeSelection: true,
            reasoningSelection: efforts.length > 0,
            resume: false,
            rpcMethods: [...HAPPY_SESSION_RPC_METHODS],
            shell: false,
            steering: true,
        },
        client: { id: "rig", name: "Happy Agent", version: options.version },
        currentModelCode: session.modelId,
        currentModelProviderId: session.providerId,
        currentOperatingModeCode: session.permissionMode,
        ...(session.effort === undefined ? {} : { currentThoughtLevelCode: session.effort }),
        flavor: session.providerId,
        happyHomeDir: configuration.happyHome,
        homeDir: homedir(),
        host: hostname(),
        hostPid: process.pid,
        ...(configuration.machineId === undefined ? {} : { machineId: configuration.machineId }),
        model: { id: session.modelId, providerId: session.providerId },
        models: models.map(publishModel),
        name: session.title,
        operatingModes: HAPPY_PERMISSION_MODES.map((mode) => ({ ...mode })),
        os: `${platform()} ${release()}`,
        path: session.cwd,
        permissionMode: session.permissionMode,
        project: { id: `rig:${session.sessionId}`, kind: "regular", name: session.projectName },
        provider,
        providers,
        reasoning: { current: session.effort ?? null, levels: [...efforts] },
        rigMetadataVersion: 1,
        session: {
            modelLocked: false,
            permissionMode: session.permissionMode,
            ...(session.serviceTier === undefined ? {} : { serviceTier: session.serviceTier }),
            status: session.status,
        },
        startedBy: "daemon",
        startedFromDaemon: true,
        summary: { text: session.title, updatedAt: options.summaryUpdatedAt },
        thoughtLevels: efforts.map((level) => ({ code: level, value: level })),
        tools: [...session.tools],
    };
}

function publishModel(model: HappyModel): HappyPublishedModel {
    const provider = describeHappyProvider(model.providerId);
    return {
        code: model.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
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
}
