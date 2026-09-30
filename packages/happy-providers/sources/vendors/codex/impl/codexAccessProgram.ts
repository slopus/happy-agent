import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { isCodexAccessProgramUnavailableError } from "@/vendors/codex/errors/codexErrors.js";

const codexAccessProgramSchema = Type.Union([
    Type.Literal("standard"),
    Type.Literal("daybreak_blue"),
    Type.Literal("daybreak_red"),
]);

/** ChatGPT Codex access program; the backend still decides whether an account is authorized. */
export type CodexAccessProgram = Static<typeof codexAccessProgramSchema>;

export function parseCodexAccessProgram(value: unknown): CodexAccessProgram | undefined {
    if (value === undefined) return undefined;
    if (!Value.Check(codexAccessProgramSchema, value)) {
        throw new Error("Codex does not support the requested access program.");
    }
    return value;
}

export function assertCodexAccessProgramCredential(
    program: CodexAccessProgram | undefined,
    credential: { readonly name: string },
): void {
    if (program !== undefined && credential.name !== "codex-session") {
        throw new Error("Codex access programs require a ChatGPT Codex session credential.");
    }
}

/** Retains the native parameter before the shared mapper turns an error into a terminal event. */
export async function* preserveCodexAccessProgramErrors(
    stream: AsyncIterable<ResponseStreamEvent>,
): AsyncGenerator<ResponseStreamEvent> {
    for await (const event of stream) {
        if (event.type === "error" && isCodexAccessProgramUnavailableError(event)) {
            throw new Error(event.message, { cause: event });
        }
        yield event;
    }
}
