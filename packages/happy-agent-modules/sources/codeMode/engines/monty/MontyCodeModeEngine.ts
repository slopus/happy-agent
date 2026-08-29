import { Monty } from "@pydantic/monty";
import type { AgentModuleHooks } from "@slopus/happy-agent-base";
import {
    detach,
    mapAsyncLock,
    semaphore,
    withLifetime,
    type Context,
    type MapAsyncLock,
    type Semaphore,
} from "@steve.kite/stdlib";

import type { ConfigModule } from "../../../config/index.js";
import type { ComputeModule, HostCompute } from "../../../compute/index.js";
import type { CodeModeEngine } from "../../CodeModeEngine.js";
import {
    InvalidCodeModeSnapshotError,
    preserveInvalidCodeModeSnapshot,
    readCodeModeCheckpoint,
    writeCodeModeCheckpoint,
    type CodeModeCheckpoint,
} from "./MontyCheckpointStore.js";
import {
    codeModePythonFailureResult,
    createCodeModePythonTool,
    runCodeModePython,
    type CodeModePythonCall,
} from "./tools/python.js";

/** The complete provider-facing prompt while the Monty Code Mode engine is active. */
export const MONTY_CODE_MODE_INSTRUCTIONS = `You are operating in Code Mode. The python tool is available when it is useful for the user's request; you may answer directly without calling it.

The python tool is a continuous, sandboxed interpreter for this agent. Variables, imports, functions, and mutations survive later calls and daemon restarts. Build on existing state instead of recreating it. Each call still runs through a fresh isolated subprocess checkout. Python can read the current date and time and use the agent filesystem through pathlib.Path and open(). Relative paths start at the agent working directory, and every filesystem operation obeys the current permission mode. The environment remains empty: os.getenv returns its default and os.environ is empty. Python has no network, shell, other host access, mounted directories, external functions, skills, or other integrations. Use only the Python functionality available inside that interpreter.

Return the useful result to the user.`;

/** The Monty-backed continuous Python implementation behind Code Mode's generic hook surface. */
export class MontyCodeModeEngine implements CodeModeEngine {
    readonly id = "monty";

    readonly #cleanups = new Set<Promise<void>>();
    readonly #config: ConfigModule;
    readonly #compute: ComputeModule;
    /** The pool and checkpoint memory can have at most the same four active owners. */
    readonly #capacity: Semaphore = semaphore(4);
    readonly #locks: MapAsyncLock<string> = mapAsyncLock<string>();
    readonly #operations = new Set<Promise<unknown>>();
    #closing: Promise<void> | undefined;
    #lifetime: AbortController | undefined;
    #owner: Context | undefined;
    #pool: Monty | undefined;

    constructor(config: ConfigModule, compute: ComputeModule) {
        this.#config = config;
        this.#compute = compute;
    }

    async start(ctx: Context): Promise<AgentModuleHooks> {
        if (this.#closing !== undefined) throw new Error("Monty Code Mode has already closed.");
        if (this.#pool !== undefined) throw new Error("Monty Code Mode has already started.");

        const lifetime = new AbortController();
        const owner = detach(ctx).named("code-mode-monty-pool");
        const pool = await Monty.create({
            checkoutTimeout: 5,
            maxCheckoutsPerWorker: 100,
            maxProcesses: 4,
            minProcesses: 0,
            requestTimeout: 6,
        });
        this.#lifetime = lifetime;
        this.#owner = owner;
        this.#pool = pool;
        return {
            afterTurn: async (hookCtx, scope) => {
                try {
                    await this.#compactCheckpoint(hookCtx, scope.agent.id);
                } catch (error) {
                    hookCtx.log.warn(
                        "Code Mode could not compact the agent's Python checkpoint journal.",
                        { agentId: scope.agent.id },
                        error,
                    );
                }
                return undefined;
            },
            overrideInstructions: () => MONTY_CODE_MODE_INSTRUCTIONS,
            overrideTools: async (hookCtx, scope) => {
                const compute = await this.#compute.resolve(hookCtx, scope.agent.id);
                if (compute === undefined) {
                    throw new Error("Code Mode requires an agent compute filesystem.");
                }
                return [
                    createCodeModePythonTool(async (toolCtx, code, call) => {
                        const operation = this.#run(
                            pool,
                            lifetime.signal,
                            compute,
                            toolCtx,
                            scope.agent.id,
                            code,
                            call,
                        );
                        return await this.#trackOperation(operation);
                    }),
                ];
            },
        };
    }

    /** Stop accepting Python work, close the subprocess pool, and settle interrupted sessions. */
    async close(): Promise<void> {
        if (this.#closing !== undefined) return await this.#closing;
        this.#closing = (async () => {
            this.#lifetime?.abort();
            const pool = this.#pool;
            this.#pool = undefined;
            await Promise.allSettled(this.#operations);
            while (this.#cleanups.size > 0) {
                await Promise.allSettled(this.#cleanups);
            }
            let poolFailure: unknown;
            try {
                await pool?.close();
            } catch (error) {
                poolFailure = error;
            }
            this.#owner = undefined;
            this.#lifetime = undefined;
            if (poolFailure !== undefined) throw poolFailure;
        })();
        return await this.#closing;
    }

    async #run(
        pool: Monty,
        moduleLifetime: AbortSignal,
        compute: HostCompute,
        ctx: Context,
        agentId: string,
        code: string,
        call: CodeModePythonCall,
    ) {
        if (this.#closing !== undefined) {
            return codeModePythonFailureResult(new Error("Code Mode is shutting down."));
        }
        const callerLifetime = ctx.lifetime;
        const combinedLifetime =
            callerLifetime === undefined
                ? moduleLifetime
                : AbortSignal.any([callerLifetime, moduleLifetime]);
        return await this.#locks.runInLock(
            ctx,
            agentId,
            async (lockCtx) =>
                await this.#capacity.run(lockCtx, async (capacityCtx) => {
                    const snapshotPath = this.#config.codeModeSnapshotPath(agentId);
                    let checkpoint = await this.#readCheckpoint(capacityCtx, agentId, snapshotPath);
                    const replay = checkpoint?.records.find((record) => record.callId === call.id);
                    if (replay !== undefined) {
                        return await this.#commit(call, capacityCtx, replay.result);
                    }

                    const runCtx = withLifetime(capacityCtx, combinedLifetime);
                    let outcome = await runCodeModePython(
                        pool,
                        runCtx,
                        code,
                        checkpoint?.snapshot,
                        this.#trackCleanup,
                        { module: this.#compute, compute },
                    );
                    if (outcome.kind === "invalid-snapshot") {
                        await this.#invalidateSnapshot(
                            capacityCtx,
                            agentId,
                            snapshotPath,
                            outcome.error,
                        );
                        checkpoint = undefined;
                        outcome = await runCodeModePython(
                            pool,
                            runCtx,
                            code,
                            undefined,
                            this.#trackCleanup,
                            { module: this.#compute, compute },
                        );
                    }
                    if (outcome.kind === "invalid-snapshot") throw outcome.error;

                    const result = outcome.result;
                    const next: CodeModeCheckpoint = {
                        records: [...(checkpoint?.records ?? []), { callId: call.id, result }],
                        ...(outcome.kind === "completed"
                            ? { snapshot: outcome.snapshot }
                            : checkpoint?.snapshot === undefined
                              ? {}
                              : { snapshot: checkpoint.snapshot }),
                        version: 1,
                    };
                    await writeCodeModeCheckpoint(snapshotPath, next);
                    return await this.#commit(call, capacityCtx, result);
                }),
        );
    }

    async #readCheckpoint(
        ctx: Context,
        agentId: string,
        path: string,
    ): Promise<CodeModeCheckpoint | undefined> {
        try {
            return await readCodeModeCheckpoint(path);
        } catch (error) {
            if (error instanceof InvalidCodeModeSnapshotError) {
                await this.#invalidateSnapshot(ctx, agentId, path, error);
                return undefined;
            }
            ctx.log.warn(
                "Code Mode could not read the agent's Python checkpoint; the last state was retained.",
                { agentId },
                error,
            );
            throw error;
        }
    }

    async #invalidateSnapshot(
        ctx: Context,
        agentId: string,
        path: string,
        error: unknown,
    ): Promise<void> {
        await preserveInvalidCodeModeSnapshot(path);
        ctx.log.warn(
            "Code Mode preserved an incompatible Python snapshot and started fresh.",
            { agentId },
            error,
        );
    }

    async #compactCheckpoint(ctx: Context, agentId: string): Promise<void> {
        await this.#locks.runInLock(
            ctx,
            agentId,
            async (lockCtx) =>
                await this.#capacity.run(lockCtx, async (capacityCtx) => {
                    const path = this.#config.codeModeSnapshotPath(agentId);
                    const checkpoint = await this.#readCheckpoint(capacityCtx, agentId, path);
                    if (checkpoint === undefined || checkpoint.records.length === 0) return;
                    await writeCodeModeCheckpoint(path, { ...checkpoint, records: [] });
                }),
        );
    }

    async #commit(
        call: CodeModePythonCall,
        ctx: Context,
        result: Awaited<ReturnType<CodeModePythonCall["commit"]>>,
    ) {
        let failure: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await call.commit(ctx, result);
            } catch (error) {
                failure = error;
                if (ctx.lifetime?.aborted === true) break;
            }
        }
        throw failure;
    }

    async #trackOperation<Value>(operation: Promise<Value>): Promise<Value> {
        this.#operations.add(operation);
        try {
            return await operation;
        } finally {
            this.#operations.delete(operation);
        }
    }

    readonly #trackCleanup = (cleanup: Promise<void>): void => {
        this.#cleanups.add(cleanup);
        void cleanup.then(
            () => this.#cleanups.delete(cleanup),
            (error: unknown) => {
                this.#cleanups.delete(cleanup);
                this.#owner?.log.warn("Monty Code Mode Python cleanup failed.", {}, error);
            },
        );
    };
}
