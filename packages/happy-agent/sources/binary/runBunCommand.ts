import { spawnHidden } from "../utils/hiddenChildProcess.js";
import { constants } from "node:os";

import { AgentDaemonError } from "../lifecycle/AgentDaemonError.js";

declare const HAPPY_AGENT_STANDALONE: boolean | undefined;

export interface BunCommandRuntime {
    readonly environment: NodeJS.ProcessEnv;
    readonly executable: string;
    readonly standalone: boolean;
}

const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

/**
 * Runs the Bun runtime embedded in the standalone binary, as `bun <arguments>` would.
 *
 * The binary's own path changes with every installed version, so `happy-agent bun` is the stable
 * way for scripts and agents to reach it. A compiled Bun executable becomes the Bun CLI when
 * `BUN_BE_BUN=1` is set, so this starts the same executable again with that variable and waits
 * for it, reporting its exit status as its own.
 */
export async function runBunCommand(
    commandArguments: readonly string[],
    runtime: BunCommandRuntime = currentRuntime(),
): Promise<number> {
    if (!runtime.standalone) {
        throw new AgentDaemonError(
            "happy-agent bun is available only in the standalone Happy Agent binary.",
            { hint: "Run the installed happy-agent binary, or use your own bun instead." },
        );
    }
    const child = spawnHidden(runtime.executable, [...commandArguments], {
        env: { ...runtime.environment, BUN_BE_BUN: "1" },
        stdio: "inherit",
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    try {
        const { code, signal } = await new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        if (code !== null) return code;
        return 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0));
    } finally {
        for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
    }
}

function currentRuntime(): BunCommandRuntime {
    return {
        environment: process.env,
        executable: process.execPath,
        standalone: typeof HAPPY_AGENT_STANDALONE === "boolean" && HAPPY_AGENT_STANDALONE === true,
    };
}
