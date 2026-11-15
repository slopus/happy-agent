import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { deterministicStringify } from "@steve.kite/stdlib";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";

const recordSchema = Type.Object({
    version: Type.Literal(1),
    model: Type.String(),
    configuration: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    prefix: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    messages: Type.Integer({ minimum: 0 }),
});
const failureSchema = Type.Object({ code: Type.Literal("context_compaction_no_progress") });
const missingSchema = Type.Object({ code: Type.Literal("ENOENT") });

function path(directory: string, id: string): string {
    return join(directory, `${encodeURIComponent(id)}.json`);
}
function hash(value: unknown): string {
    return createHash("sha256").update(deterministicStringify(value)).digest("hex");
}
function configuration(request: SessionRunRequest, tools: readonly SessionTool[]): string {
    return hash([request.context.instructions, tools]);
}
function prefix(request: SessionRunRequest, length: number): string {
    const digest = createHash("sha256");
    for (const message of request.context.messages.slice(0, length)) {
        digest.update(deterministicStringify(message)).update("\0");
    }
    return digest.digest("hex");
}

/** One failed prefix per agent, shared by compatible accounts; never a second transcript. */
export async function assertAcpRecoveryAllowed(
    directory: string | undefined,
    id: string,
    request: SessionRunRequest,
    tools: readonly SessionTool[],
): Promise<void> {
    if (directory === undefined) return;
    let value: unknown;
    try {
        value = JSON.parse(await readFile(path(directory, id), "utf8"));
    } catch (error) {
        if (Value.Check(missingSchema, error)) return;
        throw new Error("The saved context recovery status could not be read.", { cause: error });
    }
    if (!Value.Check(recordSchema, value))
        throw new Error("The saved context recovery status is invalid.");
    if (
        value.model === (request.model ?? "") &&
        value.configuration === configuration(request, tools) &&
        value.messages <= request.context.messages.length &&
        value.prefix === prefix(request, value.messages)
    ) {
        throw new AcpContextRecoveryBlockedError(
            "The previous compaction of this unchanged history made no useful progress. Reduce attached context, then use Compact to try recovery again. Continue or switching accounts cannot recover this request. Recorded history and workspace files are preserved.",
        );
    }
}

export async function recordAcpRecoveryFailure(
    directory: string | undefined,
    id: string,
    request: SessionRunRequest,
    tools: readonly SessionTool[],
    error: unknown,
): Promise<void> {
    if (directory === undefined || !Value.Check(failureSchema, error)) return;
    const record = {
        version: 1,
        model: request.model ?? "",
        configuration: configuration(request, tools),
        prefix: prefix(request, request.context.messages.length),
        messages: request.context.messages.length,
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path(directory, id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await rename(temporary, destination);
    } finally {
        await rm(temporary, { force: true });
    }
}

/** An explicit Compact action or a successful checkpoint starts a fresh recovery attempt. */
export async function clearAcpRecoveryFailure(
    directory: string | undefined,
    id: string,
): Promise<void> {
    if (directory !== undefined) await rm(path(directory, id), { force: true });
}

class AcpContextRecoveryBlockedError extends Error {
    readonly code = "context_recovery_blocked";
}
