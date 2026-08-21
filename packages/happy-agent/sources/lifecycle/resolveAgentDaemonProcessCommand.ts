declare const HAPPY_AGENT_STANDALONE: boolean | undefined;

export interface AgentDaemonProcessCommand {
    readonly arguments: readonly string[];
    readonly executable: string;
}

interface AgentDaemonProcessRuntime {
    readonly entrypoint: string | undefined;
    readonly executable: string;
    readonly execArguments: readonly string[];
    readonly standalone: boolean;
}

/** Resolves the child command without leaking runtime-specific branching into daemon lifecycle. */
export function resolveAgentDaemonProcessCommand(
    entrypoint: string | undefined,
    runtime: AgentDaemonProcessRuntime = currentRuntime(),
): AgentDaemonProcessCommand | undefined {
    if (runtime.standalone) {
        return { arguments: ["run"], executable: runtime.executable };
    }
    const script = entrypoint ?? runtime.entrypoint;
    if (script === undefined) return undefined;
    return {
        arguments: [...runtime.execArguments, script, "run"],
        executable: runtime.executable,
    };
}

function currentRuntime(): AgentDaemonProcessRuntime {
    return {
        entrypoint: process.argv[1],
        executable: process.execPath,
        execArguments: process.execArgv,
        standalone: typeof HAPPY_AGENT_STANDALONE === "boolean" && HAPPY_AGENT_STANDALONE === true,
    };
}
