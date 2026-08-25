import { Type, type Static } from "@sinclair/typebox";

import type { ComputeSessionSnapshot } from "../../../Compute.js";

/** The output budget Codex assumes when the model does not name one. */
export const CODEX_DEFAULT_OUTPUT_TOKENS = 10_000;

/** The tool-output policy published by the Codex models Happy Agent supports. */
export const CODEX_MODEL_OUTPUT_POLICY_TOKENS = 10_000;

/** Codex states its budget in tokens; the machine hands back characters. */
const CHARACTERS_PER_OUTPUT_TOKEN = 4;

/** The smallest window ever shown, however small a budget the model asked for. */
const MINIMUM_OUTPUT_CHARACTERS = 4_000;

/**
 * The answer `exec_command` and `write_stdin` share.
 *
 * This is Codex's own unified exec shape, not the module's: a session that is still running is
 * named by `session_id`, one that has ended by `exit_code`, and output that had to be cut says so
 * by carrying the token count the machine really produced. Another vendor's command tools answer
 * in their own words, and nothing here is meant to be reused by them.
 */
export const unifiedExecOutputSchema = Type.Object(
    {
        command: Type.Optional(Type.String()),
        exit_code: Type.Optional(Type.Integer()),
        original_token_count: Type.Optional(Type.Integer()),
        output: Type.String(),
        session_id: Type.Optional(Type.Integer()),
        wall_time_seconds: Type.Number(),
    },
    { additionalProperties: false },
);

export type UnifiedExecOutput = Static<typeof unifiedExecOutputSchema>;

/**
 * One session's state as Codex reads it.
 *
 * Only output produced since the last read is carried, because the model already holds everything
 * it was told before. Two separate cuts can shorten that output — the machine's own capture limit
 * while the command ran, and this answer's token budget now — and both are stated, since output
 * that quietly goes missing reads exactly like output that never happened.
 */
export function createUnifiedExecOutput(
    snapshot: ComputeSessionSnapshot,
    wallTimeSeconds: number,
    maxOutputTokens: number = CODEX_DEFAULT_OUTPUT_TOKENS,
): UnifiedExecOutput {
    const produced = [snapshot.stdoutDelta, snapshot.stderrDelta]
        .filter((part) => part.length > 0)
        .join("\n");
    const droppedBytes =
        (snapshot.stdoutDeltaOmittedBytes ?? 0) + (snapshot.stderrDeltaOmittedBytes ?? 0);
    const originalTokenCount = Math.ceil(
        (Buffer.byteLength(produced, "utf8") + droppedBytes) / CHARACTERS_PER_OUTPUT_TOKEN,
    );
    const maxCharacters = Math.max(
        MINIMUM_OUTPUT_CHARACTERS,
        Math.floor(
            Math.min(maxOutputTokens, CODEX_MODEL_OUTPUT_POLICY_TOKENS) *
                CHARACTERS_PER_OUTPUT_TOKEN,
        ),
    );
    const truncated = produced.length > maxCharacters;
    const shown = truncated
        ? truncateUnifiedExecOutput(produced, maxCharacters, originalTokenCount)
        : produced;
    const running = snapshot.status === "running";
    return {
        command: snapshot.command,
        ...(running ? { session_id: snapshot.sessionId } : {}),
        ...(!running && snapshot.exitCode !== null ? { exit_code: snapshot.exitCode } : {}),
        ...(truncated || droppedBytes > 0 ? { original_token_count: originalTokenCount } : {}),
        output:
            droppedBytes === 0
                ? shown
                : `[The machine dropped ${String(droppedBytes)} bytes of this session's output as it ran.]\n${shown}`,
        wall_time_seconds: wallTimeSeconds,
    };
}

/** The same answer as the text the model actually sees. */
export function formatUnifiedExecOutput(result: UnifiedExecOutput): string {
    const sections = [`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`];
    if (result.exit_code !== undefined) {
        sections.push(`Process exited with code ${String(result.exit_code)}`);
    } else if (result.session_id !== undefined) {
        sections.push(`Process running with session ID ${String(result.session_id)}`);
    } else {
        sections.push(
            "Process ended without an exit code, which is what a stopped session looks like",
        );
    }
    if (result.original_token_count !== undefined) {
        sections.push(`Original token count: ${String(result.original_token_count)}`);
    }
    sections.push("Output:", result.output.length > 0 ? result.output : "(no new output)");
    return sections.join("\n");
}

/**
 * Keep both ends of a long output.
 *
 * A command usually says what it is doing at the start and how it went at the end, so cutting out
 * the middle keeps the two parts that answer the model's actual question, and the note says how
 * much was really there.
 */
function truncateUnifiedExecOutput(
    value: string,
    maxCharacters: number,
    originalTokenCount: number,
): string {
    const notice = `Warning: truncated output (original token count: ${String(originalTokenCount)})`;
    const prefix = `${notice}\nTotal output lines: ${String(value.split("\n").length)}\n\n`;
    const marker = "\n… output truncated …\n";
    const remaining = Math.max(0, maxCharacters - prefix.length - marker.length);
    const headLength = Math.ceil(remaining / 2);
    const tailLength = Math.max(0, remaining - headLength);
    return `${prefix}${value.slice(0, headLength)}${marker}${tailLength > 0 ? value.slice(-tailLength) : ""}`;
}
