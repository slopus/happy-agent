import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ComputePermissions, HostCompute } from "../../../../compute/index.js";
import {
    MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS,
    codeModeJavaScriptInputSchema,
    codeModeJavaScriptResultSchema,
    type CodeModeJavaScriptResult,
} from "../BunTypeScript.js";

const BUN_EXECUTION_TIMEOUT_MS = 10_000;
const BUN_CAPTURE_MAX_BYTES = 64 * 1024;
const TRUNCATION_NOTICE = "\n[Output truncated.]";

export type CodeModeJavaScriptRun = (
    ctx: Context,
    code: string,
) => Promise<CodeModeJavaScriptResult>;

/** One stateless JavaScript or TypeScript tool backed by the system Bun executable. */
export function createCodeModeJavaScriptTool(run: CodeModeJavaScriptRun) {
    return defineAgentTool({
        name: "javascript",
        defer: false,
        capabilities: ["Run stateless JavaScript and TypeScript through Bun."],
        description:
            "Run JavaScript or TypeScript in a fresh system Bun process. State does not survive later calls. Use console.log or console.error to return output. Bun starts in the agent working directory, and filesystem, process, and network access obey the current permission mode. Each invocation has a 10-second wall timeout.",
        parameters: codeModeJavaScriptInputSchema,
        returnType: codeModeJavaScriptResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: (ctx, { code }) => run(ctx, code),
        isError: ({ isError }) => isError,
        toLLM: ({ output }) => [{ type: "text", text: output }],
    });
}

export type CodeModeJavaScriptTool = ReturnType<typeof createCodeModeJavaScriptTool>;

/** Execute one bounded Bun process through the agent's normal compute sandbox. */
export async function runCodeModeJavaScript(
    compute: HostCompute,
    permissions: ComputePermissions,
    code: string,
    signal: AbortSignal,
): Promise<CodeModeJavaScriptResult> {
    try {
        const result = await compute.shell.run({
            command: `bun -e ${shellQuote(code)}`,
            permissions,
            cwd: compute.cwd,
            timeoutMs: BUN_EXECUTION_TIMEOUT_MS,
            maxOutputBytes: BUN_CAPTURE_MAX_BYTES,
            signal,
        });
        const sections: string[] = [];
        appendStream(sections, "stdout", result.stdout, result.stdoutOmittedBytes);
        appendStream(sections, "stderr", result.stderr, result.stderrOmittedBytes);

        const interrupted = signal.aborted && !result.timedOut;
        const failed = interrupted || result.timedOut || result.exitCode !== 0;
        let terminalSection: string | undefined;
        if (interrupted) {
            terminalSection = "error:\nBun execution was interrupted.";
        } else if (result.timedOut) {
            terminalSection = "error:\nBun execution timed out after 10 seconds.";
        } else if (result.exitCode !== 0) {
            terminalSection = `error:\nBun exited with code ${
                result.exitCode === null ? "unknown" : String(result.exitCode)
            }.`;
        } else if (sections.length === 0) {
            terminalSection = "result:\nBun execution completed with no output.";
        }
        return {
            output: renderSections(sections.join("\n\n"), terminalSection),
            isError: failed,
        };
    } catch (error) {
        return { output: boundOutput(`error:\n${describeError(error)}`), isError: true };
    }
}

function appendStream(
    sections: string[],
    label: "stderr" | "stdout",
    text: string,
    omittedBytes: number | undefined,
): void {
    const clean = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (clean.length === 0 && (omittedBytes ?? 0) === 0) return;
    const omitted = (omittedBytes ?? 0) > 0 ? `\n[${String(omittedBytes)} bytes omitted.]` : "";
    sections.push(`${label}:\n${clean}${omitted}`);
}

function boundOutput(output: string): string {
    return boundOutputTo(output, MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS);
}

function renderSections(output: string, terminalSection: string | undefined): string {
    if (terminalSection === undefined) return boundOutput(output);
    if (output.length === 0) return terminalSection;
    const separator = "\n\n";
    const prefixBudget =
        MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS - terminalSection.length - separator.length;
    if (prefixBudget <= 0) return boundOutput(terminalSection);
    return `${boundOutputTo(output, prefixBudget)}${separator}${terminalSection}`;
}

function boundOutputTo(output: string, maximum: number): string {
    if (output.length <= maximum) return output;
    if (TRUNCATION_NOTICE.length >= maximum) return TRUNCATION_NOTICE.slice(0, maximum);
    return `${output.slice(0, maximum - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
    return String(error);
}

/** Quote an arbitrary eval program as one argument to the machine's POSIX shell. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
