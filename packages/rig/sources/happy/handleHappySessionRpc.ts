import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";

import type { AgentContext } from "../agent/index.js";
import {
    FileTreeChangedError,
    FileTreeInvalidRequestError,
    listFileTree,
} from "../file-tree/index.js";
import {
    listFileTreeRequestSchema,
    type ListFileTreeRequest,
} from "../protocol/ProjectFileProtocol.js";
import { resolveHappyRipgrepExecutable } from "./resolveHappyRipgrepExecutable.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export const HAPPY_SESSION_RPC_METHODS = [
    "abort",
    "bash",
    "communication",
    "killSession",
    "listFileTree",
    "readFile",
    "writeFile",
    "ripgrep",
] as const;

export async function handleHappySessionRpc(options: {
    abort: () => Promise<unknown>;
    archive: () => unknown;
    answerQuestion: (
        requestId: string,
        answers: Record<string, unknown>,
    ) => Promise<unknown> | unknown;
    cancelQuestion: (requestId: string) => Promise<unknown> | unknown;
    context: () => AgentContext;
    method: string;
    params: unknown;
}): Promise<unknown> {
    const { method } = options;
    if (method === "abort") return options.abort();
    if (method === "killSession") return options.archive();
    const params = requireRecord(options.params);
    if (method === "communication") {
        // A reply to an agent-to-user communication. Answers arrive keyed by
        // question id; a dismissal, including one from a client that could not
        // render the form, cancels the question instead of answering it.
        const id = requireString(params.id, "id");
        if (params.status !== "answered") {
            await options.cancelQuestion(id);
            return { success: true };
        }
        const answers = isRecord(params.answers) ? params.answers : undefined;
        if (answers === undefined) {
            throw new Error("Happy answered a question without any answers.");
        }
        await options.answerQuestion(id, answers);
        return { success: true };
    }
    const context = options.context();
    if (method === "bash") {
        const command = requireString(params.command, "command");
        const result = await context.bash.run({
            command,
            ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
            maxOutputBytes: MAX_OUTPUT_BYTES,
            timeoutMs: clampTimeout(params.timeout),
        });
        return {
            success: result.exitCode === 0 && !result.timedOut,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode ?? -1,
            ...(result.timedOut ? { error: "Command timed out" } : {}),
        };
    }
    if (method === "listFileTree") {
        if (!Value.Check(listFileTreeRequestSchema, params)) {
            throw new FileTreeInvalidRequestError("File-tree settings are invalid.");
        }
        try {
            return {
                success: true,
                ...(await listFileTree(context.fs, params as ListFileTreeRequest)),
            };
        } catch (error) {
            if (error instanceof FileTreeChangedError) {
                return {
                    success: false,
                    error: error.message,
                    reason: "directory_changed",
                };
            }
            throw error;
        }
    }
    if (method === "readFile") {
        const content = await context.fs.readFileBuffer(requireString(params.path, "path"));
        return { success: true, content: Buffer.from(content).toString("base64") };
    }
    if (method === "writeFile") {
        const path = requireString(params.path, "path");
        const content = Buffer.from(requireString(params.content, "content"), "base64");
        await assertExpectedHash(context, path, params.expectedHash);
        await context.fs.writeFile(path, content);
        return { success: true, hash: sha256(content) };
    }
    if (method === "ripgrep") {
        const args = requireStringArray(params.args, "args");
        const executable = await resolveHappyRipgrepExecutable(context);
        const result = await context.bash.run({
            command: [shellQuote(executable), ...args.map(shellQuote)].join(" "),
            ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
            maxOutputBytes: MAX_OUTPUT_BYTES,
            timeoutMs: 30_000,
        });
        return {
            success: result.exitCode === 0 || result.exitCode === 1,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode ?? -1,
            ...(result.timedOut ? { error: "Command timed out" } : {}),
        };
    }
    throw new Error("Method not found");
}

async function assertExpectedHash(
    context: AgentContext,
    path: string,
    expectedHash: unknown,
): Promise<void> {
    const exists = await context.fs.exists(path);
    if (expectedHash === null || expectedHash === undefined) {
        if (exists) throw new Error("File already exists but was expected to be new.");
        return;
    }
    if (typeof expectedHash !== "string") throw new Error("expectedHash must be a string or null.");
    if (!exists) throw new Error("File does not exist but a hash was provided.");
    const existing = await context.fs.readFileBuffer(path);
    if (sha256(existing) !== expectedHash) throw new Error("File hash mismatch.");
}

function clampTimeout(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(1, Math.min(value, 120_000))
        : 30_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Invalid request");
    }
    return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string") throw new Error(`${name} must be a string.`);
    return value;
}

function requireStringArray(value: unknown, name: string): string[] {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
        throw new Error(`${name} must be an array of strings.`);
    }
    return value;
}

function sha256(value: Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value: string): string {
    return /^[A-Za-z0-9_./:=@%+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
