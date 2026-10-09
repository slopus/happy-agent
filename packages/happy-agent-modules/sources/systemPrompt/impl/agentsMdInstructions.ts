import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
    type AgentBaseAcceptedMessage,
    type AgentModuleAction,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { createId } from "@paralleldrive/cuid2";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../../config/index.js";
import {
    type ComputeFileStat,
    type ComputeModule,
    type ComputePermissions,
    type HostCompute,
} from "../../compute/index.js";
import {
    AGENTS_MD_SPEC,
    MAX_AGENTS_MD_DOCUMENT_BYTES,
    MAX_AGENTS_MD_DOCUMENTS,
    MAX_AGENTS_MD_GLOBAL_BYTES,
    MAX_AGENTS_MD_OUTPUT_CHARACTERS,
    MAX_AGENTS_MD_TOTAL_BYTES,
    MAX_AGENTS_SECURITY_MD_BYTES,
    agentsMdAgentIdSchema,
    agentsMdDocumentSchema,
    agentsMdGlobalDocumentSchema,
    agentsMdPathSchema,
    agentsMdSnapshotSchema,
    type AgentsMdDocument,
    type AgentsMdGlobalDocument,
    type AgentsMdSnapshot,
} from "../AgentsMd.js";

const exact = { additionalProperties: false } as const;
const callableSchema = Type.Function([], Type.Any());
/**
 * What discovery calls on the agent's machine. Any machine qualifies — this one, a runner, or a
 * container — because AGENTS.md is read wherever the agent's folder actually is.
 */
const agentsMdComputeSchema = Type.Object(
    {
        cwd: Type.String({ minLength: 1 }),
        fs: Type.Object(
            { exists: callableSchema, lstat: callableSchema, readFileBuffer: callableSchema },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);
const computeFileStatSchema = Type.Object(
    {
        isFile: Type.Boolean(),
        isDirectory: Type.Boolean(),
        isSymbolicLink: Type.Boolean(),
        mode: Type.Optional(Type.Integer({ minimum: 0 })),
        size: Type.Integer({ minimum: 0 }),
        mtimeMs: Type.Number(),
    },
    exact,
);
const optionalTextSchema = Type.Union([
    Type.String({ maxLength: MAX_AGENTS_MD_GLOBAL_BYTES + 1 }),
    Type.Undefined(),
]);
const fingerprintSchema = Type.Union([
    Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]+$" }),
    Type.Null(),
]);
const noticeMetadataSchema = Type.Object(
    {
        fingerprint: fingerprintSchema,
        kind: Type.Literal("agents-md"),
        // A notice travels as a steering message, and the agent accepts only cuid2 message IDs.
        noticeId: Type.String({
            minLength: 2,
            maxLength: 32,
            pattern: "^[a-z][a-z0-9]*$",
        }),
    },
    exact,
);
const pendingNoticeSchema = Type.Object(
    {
        from: fingerprintSchema,
        id: noticeMetadataSchema.properties.noticeId,
        to: fingerprintSchema,
    },
    exact,
);
const turnSnapshotSchema = Type.Union([agentsMdSnapshotSchema, Type.Null()]);

const FINGERPRINT_KEY = "last-delivered-fingerprint";
const PENDING_NOTICE_KEY = "pending-notice";
const TURN_SNAPSHOT_KEY = "turn-instructions-snapshot";
const AGENTS_MD_METADATA_KEY = "agentsMd";
const REPLACEMENT_NOTICE =
    "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.";
const REMOVAL_NOTICE = "The previously provided AGENTS.md instructions no longer apply.";
const TRUNCATION_NOTICE =
    "[Some AGENTS.md instruction content was omitted or truncated to stay within the instruction limit.]";
const DOCUMENT_TRUNCATION_NOTICE =
    "[This AGENTS.md document was truncated to stay within the instruction limit.]";
const OMITTED_DOCUMENT_TEXT =
    "[The contents of this AGENTS.md document were omitted because it exceeded the instruction limit.]";
const BODY_OUTPUT_CHARACTERS = Math.max(
    1,
    MAX_AGENTS_MD_OUTPUT_CHARACTERS - AGENTS_MD_SPEC.length - 2,
);

interface BoundedDocumentResult {
    readonly document?: AgentsMdDocument;
    readonly bytesRead: number;
    readonly truncated: boolean;
}

interface LoadedInstructions {
    readonly body: string;
    readonly fingerprint: string | null;
    readonly snapshot?: AgentsMdSnapshot;
}

/** Supplies AGENTS.md instruction text and change notices to the system-prompt module. */
export class AgentsMdInstructions {
    readonly #config: ConfigModule;
    readonly #compute: ComputeModule;

    constructor(config: ConfigModule, compute: ComputeModule) {
        this.#config = config;
        this.#compute = compute;
    }

    /**
     * Discover and read the current filesystem snapshot without caching file contents.
     *
     * Large or numerous files are represented by a bounded partial result instead of failing the
     * turn. A symbolic link at a document path remains an error: following one would let a
     * project instruction escape the compute's intended filesystem boundary.
     */
    async read(ctx: Context, agentId: string): Promise<AgentsMdSnapshot | undefined> {
        if (!Value.Check(agentsMdAgentIdSchema, agentId)) {
            throw new Error("AGENTS.md agent ID is invalid.");
        }
        const global = await this.#readGlobal(ctx);
        const computeModule = this.#compute;
        const compute = await computeModule.resolve(ctx, agentId);
        if (compute === undefined) {
            if (global === undefined) return undefined;
            const snapshot = {
                cwd: dirname(global.path) || ".",
                documents: [],
                global,
                ...(global.truncated === true ? { truncated: true } : {}),
            };
            if (!Value.Check(agentsMdSnapshotSchema, snapshot)) {
                throw new Error("AGENTS.md filesystem snapshot is invalid.");
            }
            return structuredClone(snapshot);
        }
        if (!Value.Check(agentsMdComputeSchema, compute)) {
            throw new Error("The compute module returned an invalid compute.");
        }

        const permissions = computeModule.permissionsForContext(ctx);
        const directories = await relevantDirectories(compute, permissions);
        const security = await readBoundedDocument(
            compute,
            permissions,
            join(directories[0] ?? compute.cwd, "AGENTS_SECURITY.md"),
            MAX_AGENTS_SECURITY_MD_BYTES,
        );
        const documents: AgentsMdSnapshot["documents"][number][] = [];
        let totalBytes = 0;
        let truncated = global?.truncated === true || security.truncated;

        for (const directory of directories) {
            const path = join(directory, "AGENTS.md");
            if (documents.length >= MAX_AGENTS_MD_DOCUMENTS) {
                truncated = true;
                break;
            }
            const remaining = MAX_AGENTS_MD_TOTAL_BYTES - totalBytes;
            if (remaining <= 0) {
                truncated = true;
                break;
            }

            const result = await readBoundedDocument(
                compute,
                permissions,
                path,
                Math.min(MAX_AGENTS_MD_DOCUMENT_BYTES, remaining),
            );
            truncated = truncated || result.truncated;
            totalBytes += result.bytesRead;
            if (result.document !== undefined) documents.push(result.document);
        }

        const snapshot = {
            cwd: compute.cwd,
            documents,
            ...(global === undefined ? {} : { global }),
            ...(security.document === undefined ? {} : { security: security.document }),
            ...(truncated ? { truncated: true } : {}),
        };
        if (!Value.Check(agentsMdSnapshotSchema, snapshot)) {
            throw new Error("AGENTS.md filesystem snapshot is invalid.");
        }
        return structuredClone(snapshot);
    }

    /**
     * Read the current global/project AGENTS.md snapshot and format it into the same context-only
     * instruction text the prompt hook produces, without touching any turn-delivery state.
     *
     * The automatic permission reviewer rereads project instructions before every review, so it
     * needs the formatted body as a standalone string rather than through the `instructions` hook,
     * which also records a per-turn delivery fingerprint that a review must not disturb. Returns
     * `undefined` when there is no project instruction content to add.
     */
    async readFormatted(ctx: Context, agentId: string): Promise<string | undefined> {
        const snapshot = await this.read(ctx, agentId);
        // The specification text explains a convention, not the project's intent. With no
        // instruction document there is nothing for a reviewer to read, so say so plainly
        // instead of handing back a specification for files that do not exist.
        if (formatBody(snapshot).length === 0) return undefined;
        return formatInstructions(snapshot);
    }

    readonly instructions = async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
        const loaded = await this.#loadInstructionsForPrompt(ctx, scope);
        // A hook scope supplied by Agent Base always has a KV. Keeping this guard makes the
        // public method useful in small host-side probes that only provide the fields it reads.
        if (scope.kv !== undefined) {
            const delivered = await scope.kv.read(ctx, FINGERPRINT_KEY);
            if (delivered === undefined) {
                await scope.kv.write(ctx, FINGERPRINT_KEY, loaded.fingerprint);
            } else if (!Value.Check(fingerprintSchema, delivered)) {
                throw new Error("Stored AGENTS.md fingerprint is invalid.");
            }
        }
        return formatInstructions(loaded.snapshot);
    };

    /**
     * Queue a replacement/removal notice after an instruction file changes.
     *
     * Agent Base's steering queue is the durable equivalent of the legacy internal message
     * insertion point and preserves any steering already queued ahead of this action. The live
     * instruction hook still supplies the updated files to the very next inference. The
     * fingerprint is committed with the accepted steering message, so a failed or interrupted
     * enqueue leaves the old fingerprint and retries the notice.
     */
    readonly beforeTurn = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<readonly AgentModuleAction[] | undefined> => {
        if (scope.kv === undefined) return undefined;
        const previous = await scope.kv.read(ctx, FINGERPRINT_KEY);
        if (previous !== undefined && !Value.Check(fingerprintSchema, previous)) {
            throw new Error("Stored AGENTS.md fingerprint is invalid.");
        }

        const loaded = await this.#loadInstructions(ctx, scope.agent.id);
        if (scope.runKV !== undefined) {
            await scope.runKV.write(ctx, TURN_SNAPSHOT_KEY, loaded.snapshot ?? null);
        }
        if (previous === undefined) return undefined;
        if (previous === loaded.fingerprint) return undefined;
        const pending = await scope.kv.update(ctx, PENDING_NOTICE_KEY, (current) => {
            if (current !== undefined && !Value.Check(pendingNoticeSchema, current)) {
                throw new Error("Stored AGENTS.md pending notice is invalid.");
            }
            if (
                current !== undefined &&
                current.from === previous &&
                current.to === loaded.fingerprint
            ) {
                return current;
            }
            return {
                from: previous,
                id: createNoticeId(),
                to: loaded.fingerprint,
            };
        });
        const text =
            loaded.body.length === 0 ? REMOVAL_NOTICE : `${REPLACEMENT_NOTICE}\n\n${loaded.body}`;
        return [
            {
                type: "steer",
                id: pending.id,
                message: {
                    role: "system",
                    content: [{ type: "text", text }],
                },
                metadata: {
                    hideFromUser: true,
                    [AGENTS_MD_METADATA_KEY]: {
                        fingerprint: loaded.fingerprint,
                        kind: "agents-md",
                        noticeId: pending.id,
                    },
                },
            },
        ];
    };

    /** Commit the fingerprint only when Base has durably accepted our steering notice. */
    readonly messageAcceptedTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        accepted: AgentBaseAcceptedMessage,
    ): Promise<void> => {
        if (scope.kv === undefined) return;
        const value = accepted.metadata?.[AGENTS_MD_METADATA_KEY];
        if (!Value.Check(noticeMetadataSchema, value)) return;
        const metadata = value as Static<typeof noticeMetadataSchema>;
        const { fingerprint, noticeId } = metadata;
        if (accepted.kind !== "steering" || accepted.id !== noticeId) return;
        if (accepted.metadata?.hideFromUser !== true) return;
        if (accepted.message.role !== "system") return;
        const content = accepted.message.content;
        if (content.length !== 1) return;
        const part = content[0];
        if (part?.type !== "text") return;
        if (fingerprint === null) {
            if (part.text !== REMOVAL_NOTICE) return;
        } else {
            const prefix = `${REPLACEMENT_NOTICE}\n\n`;
            if (!part.text.startsWith(prefix)) return;
            if (createFingerprint(part.text.slice(prefix.length)) !== fingerprint) return;
        }
        const pending = await scope.kv.read(ctx, PENDING_NOTICE_KEY);
        if (!Value.Check(pendingNoticeSchema, pending)) return;
        if (pending.id !== noticeId || pending.to !== fingerprint) return;
        const delivered = await scope.kv.read(ctx, FINGERPRINT_KEY);
        if (!Value.Check(fingerprintSchema, delivered) || delivered !== pending.from) return;
        await scope.kv.write(ctx, FINGERPRINT_KEY, fingerprint);
        await scope.kv.delete(ctx, PENDING_NOTICE_KEY);
    };

    async #loadInstructions(ctx: Context, agentId: string): Promise<LoadedInstructions> {
        const snapshot = await this.read(ctx, agentId);
        return loadedInstructionsForSnapshot(snapshot);
    }

    async #loadInstructionsForPrompt(
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<LoadedInstructions> {
        if (scope.runKV === undefined) {
            return await this.#loadInstructions(ctx, scope.agent.id);
        }
        const cached = await scope.runKV.read(ctx, TURN_SNAPSHOT_KEY);
        if (cached === undefined) {
            return await this.#loadInstructions(ctx, scope.agent.id);
        }
        if (!Value.Check(turnSnapshotSchema, cached) || !isSoundStoredSnapshot(cached)) {
            throw new Error("Stored AGENTS.md turn snapshot is invalid.");
        }
        return loadedInstructionsForSnapshot(cached === null ? undefined : structuredClone(cached));
    }

    /**
     * The person's own instructions, read fresh on every call.
     *
     * Configuration owns both the path and the reading of it; this module owns the byte bound and
     * checks what comes back, because an oversized or malformed document must not be able to turn
     * a valid turn into a permanent failure.
     */
    async #readGlobal(ctx: Context): Promise<AgentsMdGlobalDocument | undefined> {
        const path = this.#config.configuration.paths.instructionsPath;
        if (!Value.Check(agentsMdPathSchema, path)) {
            throw new Error("The configured global AGENTS.md path is invalid.");
        }
        const raw = await this.#config.readGlobalInstructions(ctx, MAX_AGENTS_MD_GLOBAL_BYTES);
        if (!Value.Check(optionalTextSchema, raw)) {
            throw new Error("Global AGENTS.md reader returned an invalid result.");
        }
        if (raw === undefined) return undefined;
        const bounded = truncateUtf8(raw, MAX_AGENTS_MD_GLOBAL_BYTES);
        const text = bounded.text.trim();
        if (text.length === 0) return undefined;
        const document = {
            path,
            text,
            ...(bounded.truncated ? { truncated: true } : {}),
        };
        if (!Value.Check(agentsMdGlobalDocumentSchema, document)) {
            throw new Error("Global AGENTS.md reader returned an invalid document.");
        }
        return document;
    }
}

/**
 * Check the facts about a persisted snapshot that a TypeBox shape cannot express.
 *
 * The schema counts characters, while every instruction bound is a UTF-8 byte bound, and it has no
 * way to say that a snapshot names each document once. A snapshot this module wrote always
 * satisfies both; one that does not was not written by discovery, so reject it rather than deliver
 * it as this turn's instructions.
 */
function isSoundStoredSnapshot(snapshot: AgentsMdSnapshot | null): boolean {
    if (snapshot === null) return true;
    const encoder = new TextEncoder();
    if (
        snapshot.global !== undefined &&
        encoder.encode(snapshot.global.text).byteLength > MAX_AGENTS_MD_GLOBAL_BYTES
    ) {
        return false;
    }
    if (
        snapshot.security !== undefined &&
        encoder.encode(snapshot.security.text).byteLength > MAX_AGENTS_SECURITY_MD_BYTES
    ) {
        return false;
    }
    const paths = new Set<string>();
    for (const document of snapshot.documents) {
        if (encoder.encode(document.text).byteLength > MAX_AGENTS_MD_DOCUMENT_BYTES) return false;
        if (paths.has(document.path)) return false;
        paths.add(document.path);
    }
    return true;
}

function loadedInstructionsForSnapshot(snapshot: AgentsMdSnapshot | undefined): LoadedInstructions {
    const body = formatBody(snapshot);
    return {
        body,
        fingerprint: body.length === 0 ? null : createFingerprint(body),
        ...(snapshot === undefined ? {} : { snapshot }),
    };
}

async function relevantDirectories(
    compute: HostCompute,
    permissions: ComputePermissions,
): Promise<readonly string[]> {
    const ancestors: string[] = [];
    let current = compute.cwd;
    while (true) {
        ancestors.push(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }

    let projectRootIndex = 0;
    for (let index = 0; index < ancestors.length; index += 1) {
        try {
            if (await compute.fs.exists(permissions, join(ancestors[index]!, ".git"))) {
                projectRootIndex = index;
                break;
            }
        } catch {
            // Ancestor discovery is optional when a compute cannot read a parent boundary.
        }
    }
    return ancestors.slice(0, projectRootIndex + 1).reverse();
}

async function readBoundedDocument(
    compute: HostCompute,
    permissions: ComputePermissions,
    path: string,
    maxBytes: number,
): Promise<BoundedDocumentResult> {
    let stat: Awaited<ReturnType<HostCompute["fs"]["lstat"]>>;
    try {
        stat = await compute.fs.lstat(permissions, path);
    } catch (error) {
        if (isMissingPathError(error)) {
            return { bytesRead: 0, truncated: false };
        }
        throw error;
    }
    if (!Value.Check(computeFileStatSchema, stat as ComputeFileStat)) {
        throw new Error(`Compute returned an invalid file stat for ${path}.`);
    }
    if (stat.isSymbolicLink) {
        throw new Error(`AGENTS.md document must not be a symbolic link: ${path}`);
    }
    if (!stat.isFile) return { bytesRead: 0, truncated: false };
    if (maxBytes <= 0) {
        return { bytesRead: 0, truncated: stat.size > 0 };
    }
    if (stat.size > maxBytes) return omittedDocument(path);

    let bytes: Uint8Array;
    try {
        bytes = await compute.fs.readFileBuffer(permissions, path, {
            maxBytes,
            noFollow: true,
        });
    } catch (error) {
        // A file may grow after the first stat. Host filesystems refuse that newly over-limit
        // read, so re-stat once and preserve it as a truncated record. Permission and every other
        // ordinary read failure remain visible.
        try {
            const current = await compute.fs.lstat(permissions, path);
            if (
                Value.Check(computeFileStatSchema, current as ComputeFileStat) &&
                current.isFile &&
                !current.isSymbolicLink &&
                current.size > maxBytes
            ) {
                return omittedDocument(path);
            }
        } catch {
            // The original bounded-read error is the useful failure when the re-stat also fails.
        }
        throw error;
    }

    const truncated = stat.size > maxBytes || bytes.byteLength > maxBytes;
    const bounded = bytes.byteLength > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
    const text = new TextDecoder().decode(bounded).trim();
    if (text.length === 0) {
        return {
            bytesRead: bounded.byteLength,
            truncated,
        };
    }
    const document = {
        path,
        text,
        ...(truncated ? { truncated: true } : {}),
    };
    if (!Value.Check(agentsMdDocumentSchema, document)) {
        throw new Error(`AGENTS.md document is invalid: ${path}`);
    }
    return {
        document,
        bytesRead: bounded.byteLength,
        truncated,
    };
}

function omittedDocument(path: string): BoundedDocumentResult {
    const document = {
        path,
        text: OMITTED_DOCUMENT_TEXT,
        truncated: true,
    };
    if (!Value.Check(agentsMdDocumentSchema, document)) {
        throw new Error(`AGENTS.md document is invalid: ${path}`);
    }
    return {
        document,
        bytesRead: 0,
        truncated: true,
    };
}

async function fileExists(
    compute: HostCompute,
    permissions: ComputePermissions,
    path: string,
): Promise<boolean> {
    try {
        const stat = await compute.fs.lstat(permissions, path);
        if (stat.isSymbolicLink) {
            throw new Error(`AGENTS.md document must not be a symbolic link: ${path}`);
        }
        return stat.isFile;
    } catch (error) {
        if (isMissingPathError(error)) return false;
        throw error;
    }
}

const MISSING_PATH_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
const MISSING_PATH_MESSAGE_PATTERN = /^(ENOENT|ENOTDIR|EISDIR): /;

function isMissingPathError(error: unknown): boolean {
    if (error === null || typeof error !== "object") return false;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return MISSING_PATH_CODES.has(code);
    if (!(error instanceof Error)) return false;
    // Some computes write a missing-path errno into the message without setting `.code`. An
    // optional file like AGENTS_SECURITY.md is the ordinary case, not a failure worth reporting,
    // so this still recognizes it. Any other message is left as a genuine, reportable error.
    return (
        error.message.startsWith("No such path:") ||
        MISSING_PATH_MESSAGE_PATTERN.test(error.message)
    );
}

function createFingerprint(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function createNoticeId(): string {
    return createId();
}

function formatInstructions(snapshot: AgentsMdSnapshot | undefined): string {
    const body = formatBody(snapshot);
    if (body.length === 0) return AGENTS_MD_SPEC;
    return joinWithinBudget([AGENTS_MD_SPEC, body], MAX_AGENTS_MD_OUTPUT_CHARACTERS);
}

function formatBody(snapshot: AgentsMdSnapshot | undefined): string {
    if (snapshot === undefined) return "";
    const sections: string[] = [];
    if (snapshot.global !== undefined) {
        sections.push(
            formatDocument(`# Global AGENTS.md instructions`, "INSTRUCTIONS", snapshot.global),
        );
    }
    if (snapshot.security !== undefined) {
        sections.push(
            formatDocument(
                `# AGENTS_SECURITY.md rules for ${dirname(snapshot.security.path)}`,
                "SECURITY_RULES",
                snapshot.security,
            ),
        );
    }
    sections.push(
        ...snapshot.documents.map((document) =>
            formatDocument(
                `# AGENTS.md instructions for ${dirname(document.path)}`,
                "INSTRUCTIONS",
                document,
            ),
        ),
    );
    if (snapshot.truncated === true) sections.push(TRUNCATION_NOTICE);
    return joinWithinBudget(sections, BODY_OUTPUT_CHARACTERS);
}

function formatDocument(
    heading: string,
    tag: "INSTRUCTIONS" | "SECURITY_RULES",
    document: AgentsMdDocument | AgentsMdGlobalDocument,
): string {
    return `${heading}\n\n<${tag}>\n${document.text}${document.truncated === true ? `\n\n${DOCUMENT_TRUNCATION_NOTICE}` : ""}\n</${tag}>`;
}

function joinWithinBudget(sections: readonly string[], maxCharacters: number): string {
    if (maxCharacters <= 0) return "";
    let result = "";
    for (const section of sections) {
        const prefix = result.length === 0 ? "" : "\n\n";
        if (result.length + prefix.length + section.length <= maxCharacters) {
            result += `${prefix}${section}`;
            continue;
        }

        const available = maxCharacters - result.length - prefix.length;
        if (available <= 0) break;
        if (available <= TRUNCATION_NOTICE.length) {
            const marker = TRUNCATION_NOTICE.slice(0, available);
            result += `${prefix}${marker}`;
        } else {
            result += `${prefix}${section.slice(0, available - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
        }
        break;
    }
    return result;
}

function truncateUtf8(
    text: string,
    maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
    const truncatedByCharacters = text.length > maxBytes;
    const boundedText = truncatedByCharacters ? text.slice(0, maxBytes) : text;
    const bytes = new TextEncoder().encode(boundedText);
    if (!truncatedByCharacters && bytes.byteLength <= maxBytes) {
        return { text, truncated: false };
    }
    const boundedBytes = bytes.subarray(0, maxBytes);
    return {
        text: decodeUtf8Prefix(boundedBytes),
        truncated: true,
    };
}

function decodeUtf8Prefix(bytes: Uint8Array): string {
    const maximumTrim = Math.min(3, bytes.byteLength);
    for (let trim = 0; trim <= maximumTrim; trim += 1) {
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(
                bytes.subarray(0, bytes.byteLength - trim),
            );
        } catch {
            // TextEncoder produced valid UTF-8, so only the trailing code point can be partial.
        }
    }
    throw new Error("The bounded AGENTS.md text is not valid UTF-8.");
}
