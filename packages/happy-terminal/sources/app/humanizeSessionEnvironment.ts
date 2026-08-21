import type { SessionExecutionEnvironment } from "../protocol/SessionProtocol.js";

export function humanizeSessionEnvironment(
    environment: SessionExecutionEnvironment | undefined,
): string {
    if (environment === undefined || environment.type === "local") return "Local";
    return environment.kind === "image"
        ? `Docker image ${environment.reference}`
        : `Docker container ${environment.reference}`;
}
