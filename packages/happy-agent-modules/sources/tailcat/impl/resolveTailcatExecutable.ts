/**
 * Resolve Tailcat outside a standalone Happy Agent binary.
 *
 * Release binaries replace this resolver at bundle time with one that falls back to their embedded
 * Tailcat v0.7.0 executable instead of PATH. Both honour HAPPY_AGENT_TAILCAT_PATH first.
 */
export function resolveTailcatExecutable(): string {
    const configured = process.env.HAPPY_AGENT_TAILCAT_PATH?.trim();
    return configured === undefined || configured.length === 0 ? "tailcat" : configured;
}
