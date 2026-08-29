import {
    FunctionSnapshot,
    Monty,
    MontyComplete,
    NameLookupSnapshot,
    type MontySession,
    type ResourceLimits,
    type Snapshot,
} from "@pydantic/monty";

/** Drives a Monty script to completion, dispatching external calls and checkpointing snapshots. */
export async function runMontyWithExternals(options: {
    code: string;
    externalFunctions: Record<string, (...args: unknown[]) => unknown>;
    inputs: Record<string, unknown>;
    limits: ResourceLimits;
    onPrint(text: string): void;
    onSnapshot(snapshot: Uint8Array): void | Promise<void>;
    signal: AbortSignal;
    snapshot?: Uint8Array;
    scriptName: string;
}): Promise<unknown> {
    const pool = await Monty.create({
        durationLimitGrace: 0.5,
        maxProcesses: 1,
        minProcesses: 1,
        requestTimeout: 31,
    });
    let session: MontySession | undefined;
    const printCallback = (_stream: "stderr" | "stdout", text: string) => options.onPrint(text);
    try {
        session = await pool.checkout({
            limits: options.limits,
            scriptName: options.scriptName,
        });
        let progress: Snapshot =
            options.snapshot === undefined
                ? await session.feedStart(options.code, {
                      inputs: options.inputs,
                      printCallback,
                  })
                : await session.loadSnapshot(options.snapshot, { printCallback });
        for (;;) {
            if (progress instanceof MontyComplete) return progress.output;
            if (options.signal.aborted) throw new Error("The workflow was stopped.");
            if (progress instanceof NameLookupSnapshot) {
                const external = options.externalFunctions[progress.variableName];
                progress = await progress.resume(
                    external === undefined ? undefined : progress.variableName,
                );
                continue;
            }
            if (!(progress instanceof FunctionSnapshot)) {
                throw new Error("The workflow reached an unsupported suspended state.");
            }
            const external = options.externalFunctions[progress.functionName];
            if (external === undefined || progress.isOsFunction) {
                throw new Error(`Workflow function '${progress.functionName}' is unavailable.`);
            }
            const args = progress.args;
            const kwargs = progress.kwargs;
            const snapshot = await progress.dump();
            await options.onSnapshot(snapshot);

            // A serialized checkpoint is the only interpreter state allowed to cross a host
            // await. Returning this session before host work and checking out a fresh one to load
            // the snapshot gives every Python segment a fresh runtime budget.
            await session.close();
            session = undefined;
            const value = await external(...args, kwargs);
            session = await pool.checkout();
            const restored = await session.loadSnapshot(snapshot, { printCallback });
            if (!(restored instanceof FunctionSnapshot)) {
                throw new Error("The workflow checkpoint did not restore its external call.");
            }
            progress = await restored.resume(value);
        }
    } finally {
        await session?.close().catch(() => undefined);
        await pool.close();
    }
}
