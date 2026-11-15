import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
    getSessionMessages,
    type SDKCompactBoundaryMessage,
    type SessionMessage as ClaudeSessionMessage,
    type SessionStore,
    type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nativeEntrySchema = Type.Intersect([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Object({ type: Type.String(), uuid: Type.Optional(Type.String()) }),
]);
type NativeEntry = Static<typeof nativeEntrySchema>;
const summarySchema = Type.Intersect([
    nativeEntrySchema,
    Type.Object({
        type: Type.Literal("user"),
        uuid: Type.String(),
        sessionId: Type.String(),
        isCompactSummary: Type.Literal(true),
        message: Type.Object({
            role: Type.Literal("user"),
            content: Type.String({ minLength: 1 }),
        }),
    }),
]);
const metadataSchema = Type.Object({
    preTokens: Type.Integer({ minimum: 0 }),
    postTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    preservedMessages: Type.Optional(
        Type.Object({
            anchorUuid: Type.String(),
            uuids: Type.Array(Type.String(), { uniqueItems: true }),
        }),
    ),
    preservedSegment: Type.Optional(
        Type.Object({
            headUuid: Type.String(),
            anchorUuid: Type.String(),
            tailUuid: Type.String(),
        }),
    ),
});
const missingFileErrorSchema = Type.Object({ code: Type.Literal("ENOENT") });
const messageSchema = Type.Object({
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: Type.Union([Type.String(), Type.Array(Type.Unknown())]),
});

/** The native process announced compaction before its complete checkpoint was readable. */
export class ClaudeNativeCompactionPendingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ClaudeNativeCompactionPendingError";
    }
}

export interface ClaudeNativeCompaction {
    readonly boundaryId: string;
    readonly summaryId: string;
    readonly summary: string;
    /** Native active-chain messages, including the summary and the preserved tail, in order. */
    readonly messages: readonly ClaudeSessionMessage[];
    readonly preTokens: number;
    readonly postTokens?: number;
}

/**
 * Read the exact checkpoint the account's native Claude process just committed. The SDK owns
 * parent-chain reconstruction (including both preserved-tail formats); this adapter only selects
 * the account's file and freezes it at that checkpoint, before a later response can join it.
 * No environment variable or native transcript is changed.
 */
export async function readClaudeNativeCompaction(options: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly configDir?: string;
    readonly projectDirectoryName?: string;
    readonly boundary: SDKCompactBoundaryMessage;
    /** A native SDK mirror for a session materialized from caller-owned history. */
    readonly entries?: readonly SessionStoreEntry[];
}): Promise<ClaudeNativeCompaction> {
    const { sessionId, boundary } = options;
    if (
        !UUID.test(sessionId) ||
        !UUID.test(boundary.uuid) ||
        boundary.session_id !== sessionId ||
        boundary.type !== "system" ||
        boundary.subtype !== "compact_boundary" ||
        !tokenCount(boundary.compact_metadata.pre_tokens) ||
        (boundary.compact_metadata.post_tokens !== undefined &&
            !tokenCount(boundary.compact_metadata.post_tokens))
    ) {
        throw new Error("Claude reported an invalid native compaction boundary.");
    }
    const { rows, incompleteTail } =
        options.entries === undefined
            ? await readAccountTranscript(options)
            : readMirroredTranscript(options.entries);
    const boundaryIndex = rows.findIndex((row) => row.uuid === boundary.uuid);
    if (boundaryIndex === -1) {
        throw new ClaudeNativeCompactionPendingError(
            incompleteTail
                ? "Claude native compaction transcript is not fully persisted yet."
                : "Claude native compaction has not been persisted yet.",
        );
    }
    const storedBoundary = rows[boundaryIndex]!;
    if (
        storedBoundary.type !== "system" ||
        storedBoundary["subtype"] !== "compact_boundary" ||
        storedBoundary["sessionId"] !== sessionId
    ) {
        throw new Error("Claude native compaction boundary does not match its transcript.");
    }
    let summaryIndex = -1;
    let superseded = false;
    for (let index = boundaryIndex + 1; index < rows.length; index++) {
        const row = rows[index]!;
        if (row.type === "system" && row["subtype"] === "compact_boundary") {
            superseded = true;
            break;
        }
        if (row["isCompactSummary"] === true) {
            summaryIndex = index;
            break;
        }
    }
    if (summaryIndex === -1) {
        if (superseded)
            throw new Error(
                "Claude native compaction has no complete persisted summary before the next boundary.",
            );
        throw new ClaudeNativeCompactionPendingError(
            incompleteTail
                ? "Claude native compaction transcript is not fully persisted yet."
                : "Claude native compaction has no complete persisted summary.",
        );
    }
    const summaryRow = rows[summaryIndex];
    if (
        !Value.Check(summarySchema, summaryRow) ||
        summaryRow.sessionId !== sessionId ||
        summaryRow.message.content.trim().length === 0
    ) {
        throw new Error(
            incompleteTail
                ? "Claude native compaction transcript is not fully persisted yet."
                : "Claude native compaction has no complete persisted summary.",
        );
    }
    const checkpoint = rows.slice(0, summaryIndex + 1);
    const identities = new Map(checkpoint.map((row) => [row.uuid, row]));
    const metadata = storedBoundary["compactMetadata"];
    if (!Value.Check(metadataSchema, metadata)) {
        throw new Error("Claude native compaction has invalid persisted checkpoint metadata.");
    }
    if (
        metadata.preTokens !== boundary.compact_metadata.pre_tokens ||
        (metadata.postTokens !== undefined &&
            boundary.compact_metadata.post_tokens !== undefined &&
            metadata.postTokens !== boundary.compact_metadata.post_tokens)
    ) {
        throw new Error("Claude native compaction token counts do not match its boundary.");
    }
    let requiredTail: readonly string[] = [];
    if (metadata.preservedMessages !== undefined) {
        const { anchorUuid, uuids } = metadata.preservedMessages;
        if (
            !identities.has(anchorUuid) ||
            uuids.includes(anchorUuid) ||
            uuids.some((id) => !identities.has(id))
        ) {
            throw new Error("Claude native compaction is missing preserved messages.");
        }
        requiredTail = uuids;
    } else if (metadata.preservedSegment !== undefined) {
        const { headUuid, anchorUuid, tailUuid } = metadata.preservedSegment;
        if (
            [headUuid, anchorUuid, tailUuid].some((id) => !identities.has(id)) ||
            anchorUuid === headUuid ||
            anchorUuid === tailUuid
        ) {
            throw new Error("Claude native compaction is missing its preserved segment.");
        }
        requiredTail = [headUuid, tailUuid];
    }
    const store: SessionStore = {
        load: async (key) => {
            if (key.sessionId !== sessionId || key.subpath !== undefined)
                throw new Error("Claude native compaction requested another session.");
            // The public history API hides isMeta rows (including tool results and local
            // command caveats). Ask it to reconstruct the complete chain from a read-only
            // projection, then restore each native row's flags below. Never edit the mirror.
            return checkpoint.map((row) =>
                (row.type === "user" || row.type === "assistant") && row["isMeta"] === true
                    ? { ...row, isMeta: false }
                    : row,
            );
        },
        append: async () => {
            throw new Error("Claude native compaction reader cannot write a transcript.");
        },
    };
    const active = await getSessionMessages(sessionId, {
        dir: options.cwd,
        includeSystemMessages: true,
        sessionStore: store,
    });
    const start = active.findIndex((message) => message.uuid === boundary.uuid);
    const messages = active
        .slice(start + 1)
        .filter((message) => message.type !== "system")
        .map((message) => ({ ...identities.get(message.uuid), ...message }));
    if (start === -1 || !messages.some((message) => message.uuid === summaryRow.uuid)) {
        throw new Error("Claude native compaction summary is not on its active conversation.");
    }
    for (const id of requiredTail) {
        const row = identities.get(id);
        if (
            (row?.type === "user" || row?.type === "assistant") &&
            !messages.some((message) => message.uuid === id)
        ) {
            throw new Error("Claude native compaction did not retain its complete declared tail.");
        }
    }
    for (const message of messages) {
        if (
            message.session_id !== sessionId ||
            !Value.Check(messageSchema, message.message) ||
            message.message.role !== message.type
        ) {
            throw new Error("Claude native compaction contains an unsupported message.");
        }
    }
    return {
        boundaryId: boundary.uuid,
        summaryId: summaryRow.uuid,
        summary: summaryRow.message.content,
        messages,
        preTokens: boundary.compact_metadata.pre_tokens,
        ...(boundary.compact_metadata.post_tokens === undefined
            ? {}
            : { postTokens: boundary.compact_metadata.post_tokens }),
    };
}

function nativeReadError(error: unknown): never {
    if (Value.Check(missingFileErrorSchema, error)) {
        throw new ClaudeNativeCompactionPendingError(
            "Claude native compaction transcript is not available yet.",
        );
    }
    throw error;
}

function tokenCount(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

async function readTranscriptSnapshot(
    filename: string,
): Promise<{ rows: NativeEntry[]; incompleteTail: boolean }> {
    const file = await open(filename, "r");
    try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > MAX_TRANSCRIPT_BYTES)
            throw new Error("Claude native compaction transcript exceeds the reader's bound.");
        const data = Buffer.alloc(metadata.size);
        let offset = 0;
        while (offset < data.length) {
            const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
            if (bytesRead === 0)
                throw new ClaudeNativeCompactionPendingError(
                    "Claude native compaction transcript changed while reading.",
                );
            offset += bytesRead;
        }
        const lines = data.toString("utf8").split("\n");
        // Native writes append newline-terminated records. A partial next record cannot belong
        // to a checkpoint whose boundary and complete summary we already find below.
        const incompleteTail = lines.pop() !== "";
        if (lines.length > MAX_TRANSCRIPT_ENTRIES)
            throw new Error("Claude native compaction transcript has too many entries.");
        const rows = lines
            .filter((line) => line.length > 0)
            .map((line) => {
                let value: unknown;
                try {
                    value = JSON.parse(line);
                } catch {
                    throw new Error(
                        "Claude native compaction transcript contains an invalid entry.",
                    );
                }
                if (!Value.Check(nativeEntrySchema, value))
                    throw new Error(
                        "Claude native compaction transcript contains an invalid entry.",
                    );
                return value;
            });
        return { rows, incompleteTail };
    } finally {
        await file.close();
    }
}

/** The native SDK's project-directory encoding, applied to this query's explicit environment. */
async function nativeProjectDirectory(cwd: string, custom: string | undefined): Promise<string> {
    if (custom !== undefined) {
        if (
            !/^[A-Za-z0-9_-]{1,64}$/.test(custom) ||
            /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(custom)
        )
            throw new Error("Claude native compaction has an invalid project directory name.");
        return custom;
    }
    const normalized = await realpath(resolve(cwd));
    const encoded = normalized.replace(/[^a-zA-Z0-9]/g, "-");
    if (encoded.length <= 200) return encoded;
    let hash = 0;
    for (let index = 0; index < normalized.length; index++)
        hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
    return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function readAccountTranscript(options: {
    sessionId: string;
    cwd: string;
    configDir?: string;
    projectDirectoryName?: string;
}): Promise<{ rows: NativeEntry[]; incompleteTail: boolean }> {
    const root = resolve(options.configDir ?? join(homedir(), ".claude"), "projects");
    const project = await nativeProjectDirectory(options.cwd, options.projectDirectoryName);
    const filename = join(root, project, `${options.sessionId}.jsonl`);
    const [resolvedRoot, resolvedFile] = await Promise.all([
        realpath(root),
        realpath(filename),
    ]).catch(nativeReadError);
    const fromRoot = relative(resolvedRoot, resolvedFile);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new Error("Claude native compaction transcript is outside its account directory.");
    }
    return await readTranscriptSnapshot(resolvedFile).catch(nativeReadError);
}

function readMirroredTranscript(entries: readonly SessionStoreEntry[]): {
    rows: NativeEntry[];
    incompleteTail: boolean;
} {
    if (entries.length > MAX_TRANSCRIPT_ENTRIES)
        throw new Error("Claude native compaction transcript has too many entries.");
    let bytes = 0;
    const rows: NativeEntry[] = [];
    for (const entry of entries) {
        bytes += Buffer.byteLength(JSON.stringify(entry));
        if (bytes > MAX_TRANSCRIPT_BYTES)
            throw new Error("Claude native compaction transcript exceeds the reader's bound.");
        if (!Value.Check(nativeEntrySchema, entry))
            throw new Error("Claude native compaction transcript contains an invalid entry.");
        rows.push(entry);
    }
    return { rows, incompleteTail: false };
}
