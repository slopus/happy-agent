/**
 * Resolve Tailcat outside a standalone Happy Agent binary.
 *
 * Release binaries replace this resolver at bundle time with their embedded Tailcat v0.4.0
 * executable. Source and npm-package runs use PATH, with an explicit override for development.
 */
export function resolveTailcatExecutable(): string {
    const configured = process.env.HAPPY_AGENT_TAILCAT_PATH?.trim();
    return configured === undefined || configured.length === 0 ? "tailcat" : configured;
}
