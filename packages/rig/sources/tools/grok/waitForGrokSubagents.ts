import type { AgentContext } from "../../agent/index.js";
import type { GrokSubagentResult } from "./grokSubagentResultSchema.js";
import { readGrokSubagent } from "./read_grok_subagent.js";

export async function waitForGrokSubagents(options: {
    context: AgentContext;
    mode: "wait_any" | "wait_all";
    signal?: AbortSignal;
    targets: readonly string[];
    timeoutMs: number;
}): Promise<GrokSubagentResult[]> {
    const deadline = Date.now() + Math.max(0, options.timeoutMs);
    const poll = () =>
        options.targets.map((target) => readGrokSubagent({ context: options.context, target }));
    let results = await poll();
    if (results.length === 0) return results;

    const isSatisfied = () =>
        options.mode === "wait_any"
            ? results.some((result) => result.status !== "running")
            : results.every((result) => result.status !== "running");
    while (!isSatisfied() && Date.now() < deadline) {
        await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", onAbort);
                reject(new Error("Waiting for subagents was cancelled."));
            };
            const timer = setTimeout(
                () => {
                    options.signal?.removeEventListener("abort", onAbort);
                    resolve();
                },
                Math.min(50, deadline - Date.now()),
            );
            options.signal?.addEventListener("abort", onAbort, { once: true });
            if (options.signal?.aborted) onAbort();
        });
        results = await poll();
    }
    return poll();
}
