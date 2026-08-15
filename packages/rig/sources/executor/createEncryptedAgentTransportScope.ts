import type { Model, Provider } from "@slopus/rig-execution";
import { isCodexEncryptedAgentTransportModel } from "./isCodexEncryptedAgentTransportModel.js";

export function createEncryptedAgentTransportScope(
    provider: Provider,
    model: Model,
): string | undefined {
    if (provider.type !== "codex" || !isCodexEncryptedAgentTransportModel(model.id)) {
        return undefined;
    }
    return provider.id;
}
