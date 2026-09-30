import { spawn } from "node:child_process";

declare const HAPPY_AGENT_STANDALONE: boolean | undefined;

/** Start a fresh VM with JavaScript JIT tiers disabled, before loading the daemon. */
export async function ensureSafeBunRuntime(): Promise<void> {
    if (process.versions.bun === undefined) return;
    if (
        process.env.BUN_JSC_useBaselineJIT === "false" &&
        process.env.BUN_JSC_useDFGJIT === "false" &&
        process.env.BUN_JSC_useFTLJIT === "false"
    ) {
        return;
    }

    // Changing process.env in the existing VM is too late: JavaScriptCore reads
    // these options at startup. WebAssembly has separate tiers and stays available.
    const environment = {
        ...process.env,
        BUN_JSC_useBaselineJIT: "false",
        BUN_JSC_useDFGJIT: "false",
        BUN_JSC_useFTLJIT: "false",
    };
    const standalone =
        typeof HAPPY_AGENT_STANDALONE === "boolean" && HAPPY_AGENT_STANDALONE === true;
    const args = standalone
        ? process.argv.slice(2)
        : [...process.execArgv, ...process.argv.slice(1)];

    if (process.platform !== "win32") {
        // Replace this process, preserving its PID, standard streams, and signals.
        process.execve!(process.execPath, [process.execPath, ...args], environment);
        throw new Error("The Bun runtime could not be restarted safely.");
    }

    // Windows has no execve. Lifecycle commands pass these settings on to the
    // detached daemon, so only the short-lived launcher normally needs this shim.
    const child = spawn(process.execPath, args, { env: environment, stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
        const code = await new Promise<number>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (exitCode) => resolve(exitCode ?? 1));
        });
        process.exit(code);
    } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
    }
}
