import type { SessionEvent } from "../protocol/index.js";
import type { DaemonLog } from "./DaemonLog.js";

export function recordProviderFailure(log: DaemonLog, event: SessionEvent): void {
    if (event.type !== "run_finished" && event.type !== "run_error") return;
    if (event.type === "run_finished" && event.data.stopReason !== "error") return;
    const providerError = event.data.providerError;
    if (providerError === undefined) return;
    const diagnostics = providerError.diagnostics;
    const failure =
        event.data.errorMessage ?? diagnostics?.upstreamMessage ?? "Provider inference failed.";
    const message = [
        "provider:inference-failed",
        `sessionId=${event.sessionId}`,
        `runId=${event.data.runId}`,
        ...(event.data.providerId === undefined ? [] : [`providerId=${event.data.providerId}`]),
        ...(event.data.requestedModelId === undefined
            ? []
            : [`modelId=${event.data.requestedModelId}`]),
        `category=${providerError.type}`,
        ...(diagnostics?.status === undefined ? [] : [`status=${String(diagnostics.status)}`]),
        ...(diagnostics?.code === undefined ? [] : [`code=${diagnostics.code}`]),
        ...(diagnostics?.requestId === undefined ? [] : [`requestId=${diagnostics.requestId}`]),
        `reason=${JSON.stringify(failure)}`,
    ].join(" ");
    log.record("error", "provider_inference_failed", message, {
        attempts: diagnostics?.attempts,
        category: providerError.type,
        code: diagnostics?.code,
        errorType: diagnostics?.errorType,
        providerId: event.data.providerId,
        requestId: diagnostics?.requestId,
        requestedModelId: event.data.requestedModelId,
        responseId: diagnostics?.responseId,
        retryDirective: diagnostics?.retryDirective,
        runId: event.data.runId,
        sessionId: event.sessionId,
        status: diagnostics?.status,
        upstreamMessage: diagnostics?.upstreamMessage,
    });
}
