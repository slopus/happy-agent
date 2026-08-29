import { inspect } from "node:util";

import {
    CollectString,
    MontyCrashedError,
    MontyError,
    MontyRuntimeError,
    MontySyntaxError,
    MontyTypingError,
    ProtocolError,
    type Monty,
} from "@pydantic/monty";
import { defineAgentTool, type AgentToolCall } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeModule, HostCompute } from "../../../../compute/index.js";
import {
    MAX_CODE_MODE_OUTPUT_CHARACTERS,
    codeModePythonInputSchema,
    codeModePythonResultSchema,
    type CodeModePythonResult,
} from "../MontyPython.js";
import { createCodeModeOs } from "../MontyOs.js";

const TRUNCATION_NOTICE = "\n[Output truncated.]";
const MAX_PRINT_COLLECT_BYTES = 64 * 1024;
const INTERRUPTED_RESULT = {
    output: "error:\nPython execution was interrupted.",
    isError: true,
} as const;

export type CodeModePythonCall = AgentToolCall<typeof codeModePythonResultSchema>;
export type CodeModePythonRun = (
    ctx: Context,
    code: string,
    call: CodeModePythonCall,
) => Promise<CodeModePythonResult>;

export type CodeModePythonRunOutcome =
    | {
          readonly kind: "completed";
          readonly result: CodeModePythonResult;
          readonly snapshot: Uint8Array;
      }
    | {
          readonly kind: "invalid-snapshot";
          readonly error: unknown;
      }
    | {
          readonly kind: "retained";
          readonly result: CodeModePythonResult;
      };

/** One isolated, one-shot Python execution through the owning module's subprocess pool. */
export function createCodeModePythonTool(run: CodeModePythonRun) {
    return defineAgentTool({
        name: "python",
        defer: false,
        capabilities: ["Run continuous sandboxed Python with durable interpreter state."],
        description:
            "Run Python in this agent's continuous isolated interpreter. Variables, imports, and functions survive later calls. Current date, time, and the agent filesystem are available; the environment is empty. Filesystem operations obey the current permission mode. Network, shell, mounts, external functions, and other host access do not exist.",
        parameters: codeModePythonInputSchema,
        returnType: codeModePythonResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: (ctx, { code }, call) => run(ctx, code, call),
        isError: ({ isError }) => isError,
        toLLM: ({ output }) => [{ type: "text", text: output }],
    });
}

export type CodeModePythonTool = ReturnType<typeof createCodeModePythonTool>;

/**
 * Execute through one fresh checked-out session. The module tracks any cleanup that outlives an
 * interrupted caller so the shared pool remains owned by the module rather than by a tool turn.
 */
export async function runCodeModePython(
    pool: Monty,
    ctx: Context,
    code: string,
    snapshot: Uint8Array | undefined,
    trackCleanup: (cleanup: Promise<void>) => void,
    files: { readonly module: ComputeModule; readonly compute: HostCompute },
): Promise<CodeModePythonRunOutcome> {
    const checkedOut = pool.checkout({
        scriptName: "code-mode.py",
        limits: {
            maxMemory: 32 * 1024 * 1024,
            maxRecursionDepth: 200,
        },
    });
    const checkout = await untilAborted(
        checkedOut.then(
            (session) => ({ session }) as const,
            (error: unknown) => ({ error }) as const,
        ),
        ctx.lifetime,
    );
    if (checkout.aborted) {
        trackCleanup(
            checkedOut.then(
                async (session) => await session.close(),
                () => undefined,
            ),
        );
        return { kind: "retained", result: INTERRUPTED_RESULT };
    }
    if ("error" in checkout.value) {
        return { kind: "retained", result: failureResult(checkout.value.error) };
    }

    const session = checkout.value.session;
    if (snapshot !== undefined) {
        const loaded = await untilAborted(
            session.loadSession(snapshot).then(
                () => ({ loaded: true }) as const,
                (error: unknown) => ({ loaded: false, error }) as const,
            ),
            ctx.lifetime,
        );
        if (loaded.aborted) {
            trackCleanup(session.close());
            return { kind: "retained", result: INTERRUPTED_RESULT };
        }
        if (!loaded.value.loaded) {
            await session.close().catch(() => undefined);
            if (isTransientWorkerFailure(loaded.value.error)) {
                return { kind: "retained", result: failureResult(loaded.value.error) };
            }
            return { kind: "invalid-snapshot", error: loaded.value.error };
        }
    }

    const printed = new CollectString(MAX_PRINT_COLLECT_BYTES);
    const completed = session
        .feedRun(code, {
            os: createCodeModeOs(undefined, { ...files, ctx }),
            printCallback: printed,
        })
        .then(
            (result: unknown) => ({ result: successResult(printed.output, result) }) as const,
            (error: unknown) => ({ error, result: failureResult(error, printed.output) }) as const,
        );
    const outcome = await untilAborted(completed, ctx.lifetime);
    if (outcome.aborted) {
        const closing = session.close();
        trackCleanup(Promise.allSettled([completed, closing]).then(() => undefined));
        return { kind: "retained", result: INTERRUPTED_RESULT };
    }
    if ("error" in outcome.value && isTransientWorkerFailure(outcome.value.error)) {
        await session.close().catch(() => undefined);
        return { kind: "retained", result: outcome.value.result };
    }

    let nextSnapshot: Uint8Array;
    try {
        nextSnapshot = await session.dump();
    } catch (error) {
        await session.close().catch(() => undefined);
        return { kind: "retained", result: failureResult(error, printed.output) };
    }
    try {
        await session.close();
    } catch (error) {
        return {
            kind: "completed",
            result: failureResult(error, printed.output),
            snapshot: nextSnapshot,
        };
    }
    return { kind: "completed", result: outcome.value.result, snapshot: nextSnapshot };
}

function isTransientWorkerFailure(error: unknown): boolean {
    return error instanceof MontyCrashedError || error instanceof ProtocolError;
}

function successResult(stdout: string, result: unknown): CodeModePythonResult {
    const rendered = inspect(result, {
        breakLength: 100,
        compact: false,
        depth: 10,
        maxArrayLength: 200,
        maxStringLength: MAX_CODE_MODE_OUTPUT_CHARACTERS,
    });
    return { output: renderSections(stdout, "result", rendered), isError: false };
}

function failureResult(error: unknown, stdout = ""): CodeModePythonResult {
    return {
        output: renderSections(stdout, "error", describeError(error)),
        isError: true,
    };
}

/** Render a module-level snapshot or persistence failure through the tool's bounded envelope. */
export function codeModePythonFailureResult(error: unknown): CodeModePythonResult {
    return failureResult(error);
}

function describeError(error: unknown): string {
    if (error instanceof MontyRuntimeError || error instanceof MontySyntaxError) {
        return error.display("traceback");
    }
    if (error instanceof MontyTypingError) return error.display();
    if (error instanceof MontyError) return error.display("type-msg");
    if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
    return String(error);
}

function renderSections(stdout: string, label: "error" | "result", value: string): string {
    const cleanStdout = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    const finalSection = truncateWithNotice(`${label}:\n${value}`, MAX_CODE_MODE_OUTPUT_CHARACTERS);
    if (cleanStdout.length === 0) return finalSection;

    const separator = "\n\n";
    const stdoutPrefix = "stdout:\n";
    const stdoutBudget = MAX_CODE_MODE_OUTPUT_CHARACTERS - finalSection.length - separator.length;
    if (stdoutBudget <= stdoutPrefix.length + TRUNCATION_NOTICE.length) return finalSection;
    const stdoutSection = truncateWithNotice(`${stdoutPrefix}${cleanStdout}`, stdoutBudget);
    return `${stdoutSection}${separator}${finalSection}`;
}

function truncateWithNotice(value: string, maximum: number): string {
    if (value.length <= maximum) return value;
    if (TRUNCATION_NOTICE.length >= maximum) return TRUNCATION_NOTICE.slice(0, maximum);
    return `${value.slice(0, maximum - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}

async function untilAborted<Value>(
    work: Promise<Value>,
    lifetime: AbortSignal | undefined,
): Promise<{ readonly aborted: true } | { readonly aborted: false; readonly value: Value }> {
    if (lifetime === undefined) return { aborted: false, value: await work };
    if (lifetime.aborted) return { aborted: true };

    return await new Promise((resolve) => {
        let settled = false;
        const finish = (
            result: { readonly aborted: true } | { readonly aborted: false; readonly value: Value },
        ) => {
            if (settled) return;
            settled = true;
            lifetime.removeEventListener("abort", onAbort);
            resolve(result);
        };
        const onAbort = () => finish({ aborted: true });
        lifetime.addEventListener("abort", onAbort, { once: true });
        void work.then((value) => finish({ aborted: false, value }));
        if (lifetime.aborted) onAbort();
    });
}
