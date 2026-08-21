import type { Model } from "../protocol/index.js";
import type { ProtocolSession } from "../protocol/index.js";
import { humanizePermissionMode } from "./humanizePermissionMode.js";
import { humanizeProviderId } from "./humanizeProviderId.js";
import { humanizeReasoningLevel } from "./humanizeReasoningLevel.js";
import { humanizeSessionEnvironment } from "./humanizeSessionEnvironment.js";
import type { StartupStatusCardModel, StartupStatusCardUsage } from "./StartupStatusCardModel.js";

export function createStartupStatusCardModel(options: {
    engineVersion?: string;
    model: Model;
    resumed: boolean;
    session: ProtocolSession;
    usage?: StartupStatusCardUsage;
    version: string;
}): StartupStatusCardModel {
    const effort =
        options.session.effort ??
        options.session.snapshot.effort ??
        options.model.defaultThinkingLevel;
    const serviceTier = options.session.serviceTier ?? options.session.snapshot.serviceTier;
    return {
        access: humanizePermissionMode(options.session.permissionMode),
        ...(options.engineVersion === undefined ? {} : { engineVersion: options.engineVersion }),
        environment: humanizeSessionEnvironment(options.session.environment),
        fast: serviceTier === "fast",
        model: options.model.name,
        provider: humanizeProviderId(options.session.providerId),
        reasoning: humanizeReasoningLevel(effort),
        session: options.resumed ? "Resumed" : "New session",
        ...(options.usage === undefined ? {} : { usage: options.usage }),
        version: options.version,
        workspace: process.env.HAPPY_TERMINAL_GYM_DISPLAY_WORKSPACE?.trim() || options.session.cwd,
    };
}
