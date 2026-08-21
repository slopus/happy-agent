const DEFAULT_HAPPY_SERVER_URL = "https://api.cluster-fluster.com";

/**
 * Chooses which Happy server to talk to.
 *
 * The environment wins, then this agent's own settings, then the settings of
 * the Happy CLI the credentials came from, then the public server.
 */
export function resolveHappyServerUrl(options: {
    environment: NodeJS.ProcessEnv;
    sourceServerUrl?: string;
    targetServerUrl?: string;
}): string {
    const configured =
        options.environment.HAPPY_AGENT_HAPPY_SERVER_URL?.trim() ||
        options.environment.HAPPY_SERVER_URL?.trim();
    return (
        configured ||
        options.targetServerUrl ||
        options.sourceServerUrl ||
        DEFAULT_HAPPY_SERVER_URL
    ).replace(/\/+$/u, "");
}
