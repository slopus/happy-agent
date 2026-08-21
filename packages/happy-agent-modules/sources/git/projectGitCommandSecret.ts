import type { GitCommandAuthentication } from "./GitCredentialBroker.js";

export const PROJECT_GIT_SECRET_ID = "project-git";

export interface ProjectGitCommandSecret {
    activate(): {
        environment: Readonly<Record<string, string>>;
        release(): void;
    };
    description: string;
    environment: Readonly<Record<string, string>>;
    environmentVariables: readonly string[];
    id: typeof PROJECT_GIT_SECRET_ID;
    trustedLoopbackPorts: readonly number[];
}

export function projectGitCommandSecret(
    authentication: GitCommandAuthentication,
): ProjectGitCommandSecret {
    return {
        activate: () => {
            const lease = authentication.activate();
            return { environment: lease.environment, release: lease.release };
        },
        description:
            "Git access for this managed project through Happy Agent's credential proxy. Select this only for commands that need the project origin.",
        environment: {},
        environmentVariables: [
            "GCM_INTERACTIVE",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_KEY_1",
            "GIT_CONFIG_VALUE_0",
            "GIT_CONFIG_VALUE_1",
            "GIT_TERMINAL_PROMPT",
        ],
        id: PROJECT_GIT_SECRET_ID,
        trustedLoopbackPorts: [authentication.loopbackPort],
    };
}
