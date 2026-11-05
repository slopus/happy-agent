import { defineAgentTool, cuid2Schema, type AgentModuleScope } from "@slopus/happy-agent-base";
import {
    surfaceIdSchema,
    vaultEntrySchema,
    vaultPathSchema,
    type VaultEntry,
} from "@slopus/happy-agent-client";
import type { SessionOutputBlock } from "@slopus/happy-providers";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { ImageProcessingError } from "../../../impl/images/ImageProcessingError.js";
import { prepareImageForPrompt } from "../../../impl/images/prepareImageForPrompt.js";
import { MAX_PROMPT_IMAGE_INPUT_BYTES } from "../../../impl/images/referenceImageLimits.js";
import { quoteVisibleExact } from "../../../impl/quoteVisibleExact.js";
import { SurfaceError } from "../../SurfaceError.js";
import type { SurfacesModule } from "../../SurfacesModule.js";
import type { VaultChange, VaultContent } from "../SurfaceVaults.js";
import { readContent } from "../vaultContentFiles.js";
import { vaultPath, vaultPathSegments } from "../vaultNames.js";
import { vaultGlob } from "./vaultGlob.js";
import {
    describeVaultWrite,
    MAX_VAULT_TOOL_COPY_BYTES,
    MAX_VAULT_TOOL_TEXT_BYTES,
    placeNew,
    placeVersion,
    requireVaultWrites,
    vaultToolFile,
    vaultToolText,
    writeVaultPath,
    type VaultToolWrite,
} from "./vaultToolPaths.js";

/** The one capability every vault tool contributes to the model's instructions. */
const CAPABILITY =
    "Read, search, write, and organize files, folders, and small web sites in shared vault Surfaces, with every earlier version kept.";
const MAX_LINES_TO_READ = 2_000;
const MAX_CHARACTERS = 60_000;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const RASTER_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
]);
const MAX_LIST_LINES = 1_000;
const MAX_GLOB_RESULTS = 200;
/** How many entries glob and grep look at below one folder. */
const MAX_SCANNED_ENTRIES = 20_000;

const surfaceId = Type.String({
    ...surfaceIdSchema,
    description: "The vault Surface's ID, from list_surfaces",
});
const vaultPathParameter = (description: string) =>
    Type.String({ ...vaultPathSchema, description });
const machinePath = (description: string) =>
    Type.String({ minLength: 1, maxLength: 4096, description });

const writeResultSchema = Type.Object({
    path: Type.String(),
    entryId: Type.String(),
    kind: Type.Union([Type.Literal("file"), Type.Literal("artifact")]),
    version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    created: Type.Boolean(),
    folders: Type.Array(Type.String()),
});
const textOutputSchema = Type.Object({ text: Type.String() });
const entryResultSchema = Type.Object({ entry: vaultEntrySchema, path: Type.String() });

const fileReadSchema = Type.Object({
    path: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    mediaType: Type.String(),
    size: Type.Integer({ minimum: 0 }),
    text: Type.Optional(Type.String()),
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    returnedLines: Type.Optional(Type.Integer({ minimum: 0 })),
    totalLines: Type.Optional(Type.Integer({ minimum: 0 })),
    nextOffset: Type.Optional(Type.Integer({ minimum: 1 })),
    image: Type.Optional(Type.Object({ data: Type.String(), mimeType: Type.String() })),
    note: Type.Optional(Type.String()),
});
type FileRead = Static<typeof fileReadSchema>;

/** How a vault tool describes the entries it lists. */
function describeEntry(entry: VaultEntry): string {
    const changed = new Date(entry.updatedAt).toISOString().replace(/\.\d{3}Z$/, "Z");
    if (entry.kind === "folder") return `${entry.name}/  folder, changed ${changed}`;
    const size = formatSize(entry.size);
    if (entry.kind === "artifact")
        return `${entry.name}  ${entry.artifact.type} artifact (${String(entry.artifact.fileCount)} files, ${size}), v${String(entry.latestVersion)}, changed ${changed}`;
    return `${entry.name}  ${entry.mediaType}, ${size}, v${String(entry.latestVersion)}, changed ${changed}`;
}

function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${String(bytes)} bytes`;
}

const text = (value: string): SessionOutputBlock[] => [{ type: "text", text: value }];

/**
 * The fixed common vault tools every ordinary agent gets, shaped like the file tools models
 * already know. Reads are never reviewed; vault writes keep their history and Trash, so they are
 * not reviewed either and only Read only refuses them. Copies to and from the agent's machine go
 * through Compute's ordinary file boundary.
 */
export function vaultTools(surfaces: SurfacesModule, scope: AgentModuleScope) {
    const vaults = surfaces.vaults;
    const compute = surfaces.compute;
    const agentId = scope.agent.id;
    const change = async (ctx: Context): Promise<VaultChange> => ({
        actor: await surfaces.actor(ctx, agentId, scope.kv),
        source: "tool",
    });
    const machine = async (ctx: Context) => {
        const resolved = await compute.resolve(ctx, agentId);
        if (resolved === undefined)
            throw new SurfaceError(
                "invalid_request",
                "This conversation has no machine to copy files with.",
            );
        return resolved;
    };
    const crosses = async (ctx: Context, path: string, write: boolean) => {
        const resolved = await compute.resolve(ctx, agentId);
        return (
            resolved === undefined ||
            (await compute.shouldReviewPath(ctx, resolved, path, { write }))
        );
    };
    /** Read one file on the agent's machine, bounded before it is read. */
    const readMachineFile = async (ctx: Context, path: string): Promise<Uint8Array> => {
        const host = await machine(ctx);
        const permissions = compute.permissionsForContext(ctx);
        const resolved = compute.resolvePath(host, path);
        const facts = await host.fs.stat(permissions, resolved);
        if (!facts.isFile)
            throw new SurfaceError("invalid_request", `${quoteVisibleExact(path)} is not a file.`);
        if (facts.size > MAX_VAULT_TOOL_COPY_BYTES)
            throw new SurfaceError(
                "invalid_request",
                `${quoteVisibleExact(path)} is larger than the 512 MiB a tool copies; ask the person to upload it in the vault instead.`,
            );
        return host.fs.readFileBuffer(permissions, resolved, {
            maxBytes: MAX_VAULT_TOOL_COPY_BYTES,
        });
    };

    return [
        defineAgentTool({
            name: "list_vault",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["list vault", "vault folder", "browse vault", "vault ls"],
            description:
                "Lists a vault folder like ls: its live entries with their kinds, sizes, newest version numbers, and change times, folders first. depth (1–10, default 1) also lists what is inside the folders below. Listing an artifact, a small web site kept as one entry, lists the files of its newest version. At most 1,000 lines. Paths start with / at the vault's root and match names case-insensitively.",
            parameters: Type.Object(
                {
                    surfaceId,
                    path: Type.Optional(
                        vaultPathParameter(
                            'The folder to list, such as "/Reports". Defaults to "/".',
                        ),
                    ),
                    depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
                },
                { additionalProperties: false },
            ),
            returnType: textOutputSchema,
            durable: false,
            reloadable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const path = input.path ?? "/";
                const found = await vaults.walk(ctx, input.surfaceId, path);
                if (found.entry === undefined && found.rest.length > 0)
                    throw new SurfaceError("not_found", `Nothing is at ${JSON.stringify(path)}.`);
                const entry = found.entry;
                if (entry !== undefined && found.rest.length > 0)
                    throw new SurfaceError("not_found", `Nothing is at ${JSON.stringify(path)}.`);
                if (entry?.kind === "file") return { text: `${path}: ${describeEntry(entry)}` };
                if (entry?.kind === "artifact") {
                    const latest = await vaults.version(ctx, input.surfaceId, entry.id, "latest");
                    const files = latest.artifact?.files ?? [];
                    return {
                        text: [
                            `${path}: ${describeEntry(entry)}. Its files:`,
                            ...files.map(
                                (file) =>
                                    `  ${file.path}  ${file.mimeType}, ${formatSize(file.size)}`,
                            ),
                        ].join("\n"),
                    };
                }
                const { entries, more } = await vaults.subtree(
                    ctx,
                    input.surfaceId,
                    entry?.id ?? null,
                    input.depth ?? 1,
                    MAX_LIST_LINES,
                );
                const children = new Map<string | null, VaultEntry[]>();
                for (const { entry: child } of entries) {
                    const list = children.get(child.parentId) ?? [];
                    list.push(child);
                    children.set(child.parentId, list);
                }
                const lines: string[] = [];
                const walk = (parentId: string | null, indent: string) => {
                    const list = (children.get(parentId) ?? []).sort(
                        (left, right) =>
                            Number(left.kind !== "folder") - Number(right.kind !== "folder") ||
                            left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
                    );
                    for (const child of list) {
                        if (lines.length >= MAX_LIST_LINES) return;
                        lines.push(`${indent}${describeEntry(child)}`);
                        if (child.kind === "folder") walk(child.id, `${indent}  `);
                    }
                };
                walk(entry?.id ?? null, "");
                const header = `${path === "/" ? "The vault's root" : path} holds:`;
                if (lines.length === 0)
                    return { text: `${path === "/" ? "The vault" : path} is empty.` };
                return {
                    text: [
                        header,
                        ...lines,
                        ...(more || lines.length >= MAX_LIST_LINES
                            ? ["[More entries were left out; list a folder below this one.]"]
                            : []),
                    ].join("\n"),
                };
            },
            toLLM: (result) => text(result.text),
        }),
        defineAgentTool({
            name: "read_vault_file",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: [
                "read vault file",
                "open vault document",
                "vault image",
                "vault version",
            ],
            description: `Reads a vault file by its path, or a file inside an artifact, such as "/Sites/launch/index.html" where launch is an artifact. Text comes back as numbered lines: a line number, then a tab, then the line, numbered from 1, up to ${String(MAX_LINES_TO_READ)} lines from offset. Raster images are shown to you; other binary files are described without their bytes. version reads an earlier version of the file, or of the artifact holding it; list them with list_vault_versions.`,
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter('The file\'s path, such as "/Reports/summary.md"'),
                    version: Type.Optional(Type.Integer({ minimum: 1 })),
                    offset: Type.Optional(
                        Type.Integer({
                            minimum: 0,
                            maximum: Number.MAX_SAFE_INTEGER,
                            description:
                                "The line number to start reading from. Only provide if the file is too large to read at once",
                        }),
                    ),
                    limit: Type.Optional(
                        Type.Integer({
                            exclusiveMinimum: 0,
                            maximum: Number.MAX_SAFE_INTEGER,
                            description:
                                "The number of lines to read. Only provide if the file is too large to read at once.",
                        }),
                    ),
                },
                { additionalProperties: false },
            ),
            returnType: fileReadSchema,
            durable: false,
            reloadable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input): Promise<FileRead> => {
                const file = await vaultToolFile(
                    ctx,
                    vaults,
                    input.surfaceId,
                    input.path,
                    input.version,
                );
                const base = {
                    path: input.path,
                    version: file.version,
                    mediaType: file.stored.mimeType,
                    size: file.stored.size,
                };
                if (RASTER_IMAGE_MIME_TYPES.has(file.stored.mimeType)) {
                    if (file.stored.size > MAX_PROMPT_IMAGE_INPUT_BYTES)
                        return { ...base, note: "This image is too large to show." };
                    try {
                        const prepared = await prepareImageForPrompt(
                            await readContent(file.stored.contentPath, 0, file.stored.size),
                            {
                                maxDimension: MAX_IMAGE_DIMENSION,
                                maxPatches: Number.POSITIVE_INFINITY,
                            },
                        );
                        if (prepared.bytes.byteLength > MAX_IMAGE_BYTES)
                            return {
                                ...base,
                                note: "This image is too large to show, even scaled down.",
                            };
                        return {
                            ...base,
                            image: {
                                data: prepared.bytes.toString("base64"),
                                mimeType: prepared.mediaType,
                            },
                        };
                    } catch (error: unknown) {
                        if (!(error instanceof ImageProcessingError)) throw error;
                        return { ...base, note: `This image cannot be shown. ${error.message}` };
                    }
                }
                if (file.stored.size > MAX_VAULT_TOOL_TEXT_BYTES)
                    return {
                        ...base,
                        note: "This file is larger than the 16 MiB a text file may be to read.",
                    };
                const decoded = await vaultToolText(file);
                if (decoded === undefined)
                    return {
                        ...base,
                        note: "This file is not text or an image, so its bytes are not shown.",
                    };
                const lines = decoded.split(/\r?\n/);
                if (lines.length > 1 && lines.at(-1) === "") lines.pop();
                const totalLines = decoded === "" ? 0 : lines.length;
                const startLine = Math.max(1, input.offset ?? 1);
                const wanted = lines.slice(
                    startLine - 1,
                    startLine - 1 + Math.min(input.limit ?? MAX_LINES_TO_READ, MAX_LINES_TO_READ),
                );
                let body = "";
                let returnedLines = 0;
                for (const [index, line] of wanted.entries()) {
                    const numbered = `${String(startLine + index)}\t${line}`;
                    if (returnedLines > 0 && body.length + 1 + numbered.length > MAX_CHARACTERS)
                        break;
                    body =
                        returnedLines === 0
                            ? numbered.slice(0, MAX_CHARACTERS)
                            : `${body}\n${numbered}`;
                    returnedLines += 1;
                }
                const next = startLine + returnedLines;
                return {
                    ...base,
                    text: body,
                    startLine,
                    returnedLines,
                    totalLines,
                    ...(next <= totalLines ? { nextOffset: next } : {}),
                };
            },
            toLLM: (read) => formatFileRead(read),
        }),
        defineAgentTool({
            name: "write_vault_file",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: [
                "write vault file",
                "save to vault",
                "restore vault version",
                "create vault file",
            ],
            description: [
                "Writes a whole text file in a vault, creating it and any missing folders above it, or making the next version of the file already there. Every earlier version is kept.",
                "Usage:",
                "- Pass exactly one of content, the file's whole UTF-8 text, and fromVersion, which restores an earlier version of the file or artifact at path as its newest version.",
                '- A path that runs into an artifact, such as "/Sites/launch/style.css", adds or replaces that file in the artifact\'s next version.',
                "- Prefer edit_vault_file to change part of an existing file. Copy binary files in with import_vault_file.",
                "- Writing content identical to the newest version makes no version.",
            ].join("\n"),
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter('Where the file is, such as "/Notes/plan.md"'),
                    content: Type.Optional(
                        Type.String({ description: "The whole text of the file" }),
                    ),
                    fromVersion: Type.Optional(Type.Integer({ minimum: 1 })),
                },
                { additionalProperties: false },
            ),
            returnType: writeResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input, call): Promise<VaultToolWrite> => {
                requireVaultWrites(ctx);
                const commit = (tx: Context, result: VaultToolWrite) => call.commit(tx, result);
                if ((input.content === undefined) === (input.fromVersion === undefined))
                    throw new SurfaceError(
                        "invalid_request",
                        "Pass exactly one of content and fromVersion.",
                    );
                if (input.fromVersion !== undefined) {
                    const found = await vaults.walk(ctx, input.surfaceId, input.path);
                    if (
                        found.entry === undefined ||
                        found.rest.length > 0 ||
                        found.entry.kind === "folder"
                    )
                        throw new SurfaceError(
                            "not_found",
                            `No file or artifact is at ${JSON.stringify(input.path)}.`,
                        );
                    const entry = found.entry;
                    const fromVersion = input.fromVersion;
                    return ctx.inTx(async (tx) =>
                        commit(
                            tx,
                            await placeVersion(
                                tx,
                                vaults,
                                input.surfaceId,
                                entry,
                                input.path,
                                { fromVersion },
                                await change(tx),
                                entry.version,
                            ),
                        ),
                    );
                }
                const bytes = new TextEncoder().encode(input.content);
                if (bytes.byteLength > MAX_VAULT_TOOL_TEXT_BYTES)
                    throw new SurfaceError(
                        "invalid_request",
                        "content can be at most 16 MiB; import larger files with import_vault_file.",
                    );
                return writeVaultPath(
                    ctx,
                    vaults,
                    input.surfaceId,
                    input.path,
                    bytes,
                    await change(ctx),
                    commit,
                );
            },
            toLLM: (result) => text(describeVaultWrite(result)),
        }),
        defineAgentTool({
            name: "edit_vault_file",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["edit vault file", "patch vault file", "replace text in vault"],
            description: [
                "Performs exact string replacements in a vault text file, or a text file inside an artifact, making its next version. Every earlier version is kept.",
                "Usage:",
                "- When editing text from read_vault_file output, preserve the exact indentation as it appears AFTER the line number prefix: a line number, then a tab. Never include any part of the prefix in old_string or new_string.",
                "- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.",
                "- Use replace_all for replacing and renaming strings across the file.",
                "- The edit also fails, changing nothing, when someone made a version while it ran; read the file again and repeat it.",
            ].join("\n"),
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter("The file's path"),
                    old_string: Type.String({ description: "The text to replace" }),
                    new_string: Type.String({
                        description:
                            "The text to replace it with (must be different from old_string)",
                    }),
                    replace_all: Type.Optional(
                        Type.Boolean({
                            default: false,
                            description: "Replace all occurrences of old_string (default false)",
                        }),
                    ),
                },
                { additionalProperties: false },
            ),
            returnType: writeResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input, call): Promise<VaultToolWrite> => {
                requireVaultWrites(ctx);
                const file = await vaultToolFile(ctx, vaults, input.surfaceId, input.path);
                const current = await vaultToolText(file);
                if (current === undefined)
                    throw new SurfaceError(
                        "invalid_request",
                        `${JSON.stringify(input.path)} is not a text file of at most 16 MiB.`,
                    );
                const edited = replaceText(
                    current,
                    input.path,
                    input.old_string,
                    input.new_string,
                    input.replace_all === true,
                );
                return writeVaultPath(
                    ctx,
                    vaults,
                    input.surfaceId,
                    input.path,
                    new TextEncoder().encode(edited),
                    await change(ctx),
                    (tx, result) => call.commit(tx, result),
                    file.entry.version,
                );
            },
            toLLM: (result) => text(describeVaultWrite(result)),
        }),
        defineAgentTool({
            name: "glob_vault",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["find vault files", "vault glob", "vault file pattern"],
            description:
                'Finds vault entries whose paths match a glob, relative to path (default "/"): * and ? within one name, ** across folders, [abc] for one of several characters, and {a,b} for alternatives, such as "**/*.pdf". Matching ignores case. Returns at most 200 paths, most recently changed first. Files inside artifacts are not matched; list an artifact with list_vault.',
            parameters: Type.Object(
                {
                    surfaceId,
                    pattern: Type.String({ minLength: 1, maxLength: 1024 }),
                    path: Type.Optional(
                        vaultPathParameter("The folder to search below; defaults to the root"),
                    ),
                },
                { additionalProperties: false },
            ),
            returnType: textOutputSchema,
            durable: false,
            reloadable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const root = await folderOf(ctx, input.surfaceId, input.path ?? "/");
                const { entries, more } = await vaults.subtree(
                    ctx,
                    input.surfaceId,
                    root.id,
                    64,
                    MAX_SCANNED_ENTRIES,
                );
                const matcher = vaultGlob(input.pattern);
                const matches = entries
                    .filter((item) => matcher.test(item.relative))
                    .sort((left, right) => right.entry.updatedAt - left.entry.updatedAt);
                if (matches.length === 0)
                    return {
                        text: `No entries below ${root.path} match ${JSON.stringify(input.pattern)}.`,
                    };
                return {
                    text: [
                        ...matches
                            .slice(0, MAX_GLOB_RESULTS)
                            .map(
                                (item) =>
                                    joinPath(root.path, item.relative) +
                                    (item.entry.kind === "folder" ? "/" : ""),
                            ),
                        ...(matches.length > MAX_GLOB_RESULTS || more
                            ? [`[More entries matched; narrow the pattern or the folder.]`]
                            : []),
                    ].join("\n"),
                };
            },
            toLLM: (result) => text(result.text),
        }),
        defineAgentTool({
            name: "grep_vault",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["search vault contents", "grep vault", "find text in vault"],
            description: [
                "Searches the text of vault files, and of text files inside artifacts, for a JavaScript regular expression.",
                "Usage:",
                '- path limits the search to one folder; glob limits it to matching file paths relative to that folder, such as "**/*.md".',
                '- output_mode is "files_with_matches" (the default) for the matching paths, "content" for matching lines with their numbers, or "count" for the number of matching lines per file. head_limit caps the lines returned (default 100).',
                "- Only the newest version of files that are UTF-8 text of at most 1 MiB is searched; the result says how many other files were skipped.",
            ].join("\n"),
            parameters: Type.Object(
                {
                    surfaceId,
                    pattern: Type.String({ minLength: 1, maxLength: 1024 }),
                    path: Type.Optional(
                        vaultPathParameter("The folder to search below; defaults to the root"),
                    ),
                    glob: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
                    case_insensitive: Type.Optional(Type.Boolean()),
                    output_mode: Type.Optional(
                        Type.Union([
                            Type.Literal("files_with_matches"),
                            Type.Literal("content"),
                            Type.Literal("count"),
                        ]),
                    ),
                    head_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
                },
                { additionalProperties: false },
            ),
            returnType: textOutputSchema,
            durable: false,
            reloadable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                let pattern: RegExp;
                try {
                    pattern = new RegExp(
                        input.pattern,
                        input.case_insensitive === true ? "iu" : "u",
                    );
                } catch (error) {
                    throw new SurfaceError(
                        "invalid_request",
                        `The pattern is not a valid regular expression: ${(error as Error).message}`,
                    );
                }
                const root = await folderOf(ctx, input.surfaceId, input.path ?? "/");
                const { entries, more } = await vaults.subtree(
                    ctx,
                    input.surfaceId,
                    root.id,
                    64,
                    MAX_SCANNED_ENTRIES,
                );
                const files = entries.filter((item) => item.entry.kind !== "folder");
                const relativeOf = new Map(files.map((item) => [item.entry.id, item.relative]));
                const matcher = input.glob === undefined ? undefined : vaultGlob(input.glob);
                const texts = await vaults.texts(
                    ctx,
                    input.surfaceId,
                    files.map((item) => item.entry.id),
                );
                const searched = new Set(texts.map((item) => item.entryId));
                const skipped = files.filter(
                    (item) => item.entry.kind === "file" && !searched.has(item.entry.id),
                ).length;
                const mode = input.output_mode ?? "files_with_matches";
                const limit = input.head_limit ?? 100;
                const lines: string[] = [];
                let truncated = false;
                for (const item of texts) {
                    const relative =
                        item.innerPath === null
                            ? relativeOf.get(item.entryId)!
                            : `${relativeOf.get(item.entryId)!}/${item.innerPath}`;
                    if (matcher !== undefined && !matcher.test(relative)) continue;
                    const full = joinPath(root.path, relative);
                    const matching = item.text
                        .split(/\r?\n/)
                        .map((line, index) => ({ line, number: index + 1 }))
                        .filter(({ line }) => pattern.test(line));
                    if (matching.length === 0) continue;
                    const add = (line: string) => {
                        if (lines.length >= limit) truncated = true;
                        else lines.push(line);
                    };
                    if (mode === "files_with_matches") add(full);
                    else if (mode === "count") add(`${full}:${String(matching.length)}`);
                    else
                        for (const { line, number } of matching)
                            add(`${full}:${String(number)}:${line.slice(0, 500)}`);
                    if (truncated) break;
                }
                const notes = [
                    ...(truncated
                        ? [`[More matches; raise head_limit or narrow the search.]`]
                        : []),
                    ...(more
                        ? ["[The folder holds more entries than one search covers; narrow path.]"]
                        : []),
                    ...(skipped > 0
                        ? [
                              `[${String(skipped)} files were not searched because they are binary or larger than 1 MiB.]`,
                          ]
                        : []),
                ];
                return {
                    text: [...(lines.length === 0 ? ["No matches."] : lines), ...notes].join("\n"),
                };
            },
            toLLM: (result) => text(result.text),
        }),
        defineAgentTool({
            name: "move_vault_entry",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["move vault file", "rename vault file", "rename vault folder"],
            description:
                "Renames or moves a vault file, folder, or artifact from path to toPath. The folder above toPath must already exist, and nothing may be at toPath; the move never replaces anything. Moving keeps the entry's versions and history.",
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter("The entry to move"),
                    toPath: vaultPathParameter("Its new path, including its name"),
                },
                { additionalProperties: false },
            ),
            returnType: entryResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input, call) => {
                requireVaultWrites(ctx);
                const entry = await entryAt(ctx, input.surfaceId, input.path);
                const names = vaultPathSegments(input.toPath);
                if (names.length === 0)
                    throw new SurfaceError("invalid_request", "toPath must name the entry.");
                const parent =
                    names.length === 1
                        ? null
                        : await vaults.walk(ctx, input.surfaceId, vaultPath(names.slice(0, -1)));
                if (
                    parent !== null &&
                    (parent.entry === undefined ||
                        parent.rest.length > 0 ||
                        parent.entry.kind !== "folder")
                )
                    throw new SurfaceError(
                        "not_found",
                        `No folder is at ${JSON.stringify(vaultPath(names.slice(0, -1)))}; create it first.`,
                    );
                const parentId = parent?.entry?.id ?? null;
                return ctx.inTx(async (tx) => {
                    const moved = await vaults.moveEntry(
                        tx,
                        input.surfaceId,
                        entry.id,
                        entry.version,
                        { name: names.at(-1)!, parentId },
                        await change(tx),
                    );
                    return call.commit(tx, {
                        entry: moved,
                        path: (await vaults.location(tx, input.surfaceId, moved.id)).path,
                    });
                });
            },
            toLLM: (result) => text(`Moved it; it is now at ${JSON.stringify(result.path)}.`),
        }),
        defineAgentTool({
            name: "delete_vault_entry",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["delete vault file", "trash vault entry", "remove vault folder"],
            description:
                "Moves a vault file, folder, or artifact to the vault's Trash, with everything inside a folder. It can be restored with restore_vault_entry until the vault's Trash time runs out.",
            parameters: Type.Object(
                { surfaceId, path: vaultPathParameter("The entry to delete") },
                { additionalProperties: false },
            ),
            returnType: entryResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input, call) => {
                requireVaultWrites(ctx);
                const entry = await entryAt(ctx, input.surfaceId, input.path);
                return ctx.inTx(async (tx) =>
                    call.commit(tx, {
                        entry: await vaults.deleteEntry(
                            tx,
                            input.surfaceId,
                            entry.id,
                            entry.version,
                            await change(tx),
                        ),
                        path: input.path,
                    }),
                );
            },
            toLLM: (result) =>
                text(
                    `Moved ${JSON.stringify(result.path)} to the Trash; its entry ID is ${result.entry.id}.`,
                ),
        }),
        defineAgentTool({
            name: "list_vault_trash",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["vault trash", "deleted vault files", "recover vault file"],
            description:
                "Lists a vault's Trash: each deleted entry's ID, where it was, and when it was deleted, most recent first. Restore one with restore_vault_entry.",
            parameters: Type.Object({ surfaceId }, { additionalProperties: false }),
            returnType: textOutputSchema,
            durable: false,
            reloadable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const { items, nextPageCursor } = await vaults.trash(ctx, input.surfaceId, {
                    limit: 200,
                });
                if (items.length === 0) return { text: "The Trash is empty." };
                return {
                    text: [
                        ...items.map(
                            ({ entry, path }) =>
                                `${entry.id}  ${path}${entry.kind === "folder" ? "/" : ""}  deleted ${new Date(entry.deletedAt ?? 0).toISOString()}`,
                        ),
                        ...(nextPageCursor === null ? [] : ["[Older Trash items were left out.]"]),
                    ].join("\n"),
                };
            },
            toLLM: (result) => text(result.text),
        }),
        defineAgentTool({
            name: "restore_vault_entry",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["restore vault entry", "undelete vault file", "vault trash restore"],
            description:
                "Restores a Trash item, by its entry ID from list_vault_trash, to where it was, or to toPath, whose folder must exist. Everything inside a restored folder comes back with it.",
            parameters: Type.Object(
                {
                    surfaceId,
                    entryId: cuid2Schema,
                    toPath: Type.Optional(
                        vaultPathParameter("Where to restore it, including its name"),
                    ),
                },
                { additionalProperties: false },
            ),
            returnType: entryResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input, call) => {
                requireVaultWrites(ctx);
                const { entry } = await vaults.location(ctx, input.surfaceId, input.entryId);
                let target: { name?: string; parentId?: string | null } = {};
                if (input.toPath !== undefined) {
                    const names = vaultPathSegments(input.toPath);
                    if (names.length === 0)
                        throw new SurfaceError("invalid_request", "toPath must name the entry.");
                    const parent =
                        names.length === 1
                            ? null
                            : await vaults.walk(
                                  ctx,
                                  input.surfaceId,
                                  vaultPath(names.slice(0, -1)),
                              );
                    if (
                        parent !== null &&
                        (parent.entry === undefined ||
                            parent.rest.length > 0 ||
                            parent.entry.kind !== "folder")
                    )
                        throw new SurfaceError(
                            "not_found",
                            `No folder is at ${JSON.stringify(vaultPath(names.slice(0, -1)))}.`,
                        );
                    target = { name: names.at(-1)!, parentId: parent?.entry?.id ?? null };
                }
                return ctx.inTx(async (tx) => {
                    const restored = await vaults.restoreEntry(
                        tx,
                        input.surfaceId,
                        entry.id,
                        entry.version,
                        target,
                        await change(tx),
                    );
                    return call.commit(tx, {
                        entry: restored,
                        path: (await vaults.location(tx, input.surfaceId, restored.id)).path,
                    });
                });
            },
            toLLM: (result) => text(`Restored it to ${JSON.stringify(result.path)}.`),
        }),
        defineAgentTool({
            name: "list_vault_versions",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["vault file history", "vault versions", "who changed vault file"],
            description:
                "Lists a vault file's or artifact's kept versions, newest first, with who made each, its size, whether it is pinned, and which version it restored, followed by recent activity such as moves and renames. Read an old version with read_vault_file and version; restore one with write_vault_file and fromVersion.",
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter("The file or artifact"),
                    pageCursor: Type.Optional(Type.String()),
                    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
                },
                { additionalProperties: false },
            ),
            returnType: textOutputSchema,
            durable: false,
            reloadable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input) => {
                const entry = await entryAt(ctx, input.surfaceId, input.path);
                const page = await vaults.versions(ctx, input.surfaceId, entry.id, {
                    limit: input.limit ?? 20,
                    pageCursor: input.pageCursor,
                });
                const activity = await vaults.activity(ctx, input.surfaceId, entry.id, {
                    limit: 10,
                });
                const who = (actor: { userId: string | null; agentId: string | null }) =>
                    actor.agentId !== null
                        ? `agent ${actor.agentId}`
                        : actor.userId !== null
                          ? `user ${actor.userId}`
                          : "a person";
                return {
                    text: [
                        `Versions of ${input.path}, newest first:`,
                        ...page.versions.map(
                            (version) =>
                                `v${String(version.number)}  ${new Date(version.createdAt).toISOString()}  ${formatSize(version.size)}  by ${who(version.actor)}${version.pinned ? "  pinned" : ""}${version.restoredFrom === null ? "" : `  restored from v${String(version.restoredFrom)}`}`,
                        ),
                        ...(page.nextPageCursor === null
                            ? []
                            : [
                                  `[Older versions follow; pass pageCursor ${JSON.stringify(page.nextPageCursor)}.]`,
                              ]),
                        "Recent activity:",
                        ...activity.activity.map(
                            (item) =>
                                `${new Date(item.at).toISOString()}  ${describeActivity(item)} by ${who(item.actor)}`,
                        ),
                    ].join("\n"),
                };
            },
            toLLM: (result) => text(result.text),
        }),
        defineAgentTool({
            name: "import_vault_file",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: [
                "copy file into vault",
                "import to vault",
                "upload to vault",
                "save binary to vault",
            ],
            description:
                "Copies a file on your machine into a vault exactly as it is, binary files included, creating missing folders: a new file, the next version of the file at path, or a file added to the artifact path runs into. A zip stays a zip file; make an artifact from one with write_vault_artifact. Files up to 512 MiB.",
            parameters: Type.Object(
                {
                    surfaceId,
                    fromPath: machinePath("The file on your machine"),
                    path: vaultPathParameter("Where it goes in the vault, including its name"),
                },
                { additionalProperties: false },
            ),
            returnType: writeResultSchema,
            durable: true,
            shouldReviewInAutoMode: (input, ctx) => crosses(ctx, input.fromPath, false),
            shouldRunInFullAccessInAutoMode: (input, ctx) => crosses(ctx, input.fromPath, false),
            describeAutoPermissionAction: (input) =>
                `reading ${quoteVisibleExact(input.fromPath)} from this machine into vault ${JSON.stringify(input.surfaceId)} at ${JSON.stringify(input.path)}. Access: filesystem read of that path`,
            execute: async (ctx, input, call) => {
                requireVaultWrites(ctx);
                const bytes = await readMachineFile(ctx, input.fromPath);
                return writeVaultPath(
                    ctx,
                    vaults,
                    input.surfaceId,
                    input.path,
                    bytes,
                    await change(ctx),
                    (tx, result) => call.commit(tx, result),
                );
            },
            toLLM: (result) => text(describeVaultWrite(result)),
        }),
        defineAgentTool({
            name: "export_vault_file",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["copy file out of vault", "export from vault", "download vault file"],
            description:
                "Copies a vault file, or an earlier version of it, to toPath on your machine, replacing a file there. An artifact is written as a folder of its files at toPath, which must not exist yet or be an empty folder. Files up to 512 MiB.",
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter("The file or artifact in the vault"),
                    toPath: machinePath("Where to write it on your machine"),
                    version: Type.Optional(Type.Integer({ minimum: 1 })),
                },
                { additionalProperties: false },
            ),
            returnType: textOutputSchema,
            durable: true,
            shouldReviewInAutoMode: (input, ctx) => crosses(ctx, input.toPath, true),
            shouldRunInFullAccessInAutoMode: (input, ctx) => crosses(ctx, input.toPath, true),
            describeAutoPermissionAction: (input) =>
                `writing vault ${JSON.stringify(input.surfaceId)} entry ${JSON.stringify(input.path)} to ${quoteVisibleExact(input.toPath)} on this machine. Access: filesystem write of that path`,
            execute: async (ctx, input) => {
                const host = await machine(ctx);
                const permissions = compute.permissionsForContext(ctx);
                const target = compute.resolvePath(host, input.toPath);
                const entry = await entryAt(ctx, input.surfaceId, input.path);
                if (entry.kind === "folder")
                    throw new SurfaceError(
                        "invalid_request",
                        `${JSON.stringify(input.path)} is a folder; export its files one at a time.`,
                    );
                if (entry.kind === "file") {
                    const stored = await vaults.fileContent(
                        ctx,
                        input.surfaceId,
                        entry.id,
                        input.version ?? "latest",
                    );
                    if (stored.size > MAX_VAULT_TOOL_COPY_BYTES)
                        throw new SurfaceError(
                            "invalid_request",
                            "The file is larger than the 512 MiB a tool copies.",
                        );
                    await host.fs.writeFile(
                        permissions,
                        target,
                        await readContent(stored.contentPath, 0, stored.size),
                    );
                    return {
                        text: `Wrote ${JSON.stringify(input.path)} (${formatSize(stored.size)}) to ${quoteVisibleExact(input.toPath)}.`,
                    };
                }
                const version = await vaults.version(
                    ctx,
                    input.surfaceId,
                    entry.id,
                    input.version ?? "latest",
                );
                const files = version.artifact?.files ?? [];
                if (await host.fs.exists(permissions, target)) {
                    const facts = await host.fs.stat(permissions, target);
                    if (
                        !facts.isDirectory ||
                        (await host.fs.readdir(permissions, target)).length > 0
                    )
                        throw new SurfaceError(
                            "invalid_request",
                            `${quoteVisibleExact(input.toPath)} must not exist yet, or be an empty folder.`,
                        );
                }
                for (const file of files) {
                    const destination = `${target.replace(/[\\/]$/, "")}/${file.path}`;
                    await host.fs.mkdir(permissions, compute.parentPath(destination), {
                        recursive: true,
                    });
                    await host.fs.writeFile(
                        permissions,
                        destination,
                        await readContent(vaults.contentPath(file.sha256), 0, file.size),
                    );
                }
                return {
                    text: `Wrote version ${String(version.number)} of artifact ${JSON.stringify(input.path)}, ${String(files.length)} files, into ${quoteVisibleExact(input.toPath)}.`,
                };
            },
            toLLM: (result) => text(result.text),
        }),
        defineAgentTool({
            name: "write_vault_artifact",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: [
                "vault artifact",
                "vault web site",
                "publish html to vault",
                "zip site to vault",
            ],
            description:
                'Creates an artifact, a small static web site kept as one vault entry, at path, or makes the next version of the artifact there whose files are exactly those given. Pass files, a list of {"path", "content"} UTF-8 text files, or fromPath, a folder or a .zip on your machine. The bundle needs "index.html" (an html site) or "index.md" (a Markdown document) at its root; up to 256 files and 256 MiB, every file at least one byte. Missing folders above path are created.',
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter('The artifact\'s path, such as "/Sites/launch"'),
                    files: Type.Optional(
                        Type.Array(
                            Type.Object(
                                {
                                    path: Type.String({ minLength: 1, maxLength: 1024 }),
                                    content: Type.String(),
                                },
                                { additionalProperties: false },
                            ),
                            { minItems: 1, maxItems: 256 },
                        ),
                    ),
                    fromPath: Type.Optional(machinePath("A folder or a .zip file on your machine")),
                },
                { additionalProperties: false },
            ),
            returnType: writeResultSchema,
            durable: true,
            shouldReviewInAutoMode: (input, ctx) =>
                input.fromPath === undefined ? false : crosses(ctx, input.fromPath, false),
            shouldRunInFullAccessInAutoMode: (input, ctx) =>
                input.fromPath === undefined ? false : crosses(ctx, input.fromPath, false),
            describeAutoPermissionAction: (input) =>
                `reading ${quoteVisibleExact(input.fromPath ?? "")} from this machine into an artifact in vault ${JSON.stringify(input.surfaceId)} at ${JSON.stringify(input.path)}. Access: filesystem read of that path`,
            execute: async (ctx, input, call): Promise<VaultToolWrite> => {
                requireVaultWrites(ctx);
                if ((input.files === undefined) === (input.fromPath === undefined))
                    throw new SurfaceError(
                        "invalid_request",
                        "Pass exactly one of files and fromPath.",
                    );
                const found = await vaults.walk(ctx, input.surfaceId, input.path);
                if (found.rest.length > 0 && found.entry !== undefined)
                    throw new SurfaceError(
                        "invalid_request",
                        `${JSON.stringify(found.entry.name)} is not a folder.`,
                    );
                if (found.entry !== undefined && found.entry.kind !== "artifact")
                    throw new SurfaceError(
                        "invalid_request",
                        `${JSON.stringify(input.path)} is a ${found.entry.kind}, not an artifact.`,
                    );
                if (found.entry === undefined && found.rest.length === 0)
                    throw new SurfaceError("invalid_request", "Name the artifact's path.");
                const content =
                    input.files === undefined
                        ? await readMachineBundle(ctx, input.fromPath!)
                        : await vaults.storeBundle(
                              ctx,
                              input.files.map((file) => ({
                                  path: file.path,
                                  bytes: new TextEncoder().encode(file.content),
                              })),
                          );
                const actor = await change(ctx);
                const existing = found.entry;
                return ctx.inTx(async (tx) =>
                    call.commit(
                        tx,
                        existing === undefined
                            ? await placeNew(
                                  tx,
                                  vaults,
                                  input.surfaceId,
                                  found.parentId,
                                  found.rest,
                                  "artifact",
                                  content,
                                  actor,
                                  input.path,
                              )
                            : await placeVersion(
                                  tx,
                                  vaults,
                                  input.surfaceId,
                                  existing,
                                  input.path,
                                  content,
                                  actor,
                                  existing.version,
                              ),
                    ),
                );
            },
            toLLM: (result) => text(describeVaultWrite(result)),
        }),
    ];

    async function entryAt(ctx: Context, vaultId: string, path: string): Promise<VaultEntry> {
        const found = await vaults.walk(ctx, vaultId, path);
        if (found.entry === undefined || found.rest.length > 0)
            throw new SurfaceError("not_found", `Nothing is at ${JSON.stringify(path)}.`);
        return found.entry;
    }

    async function folderOf(
        ctx: Context,
        vaultId: string,
        path: string,
    ): Promise<{ id: string | null; path: string }> {
        const found = await vaults.walk(ctx, vaultId, path);
        if (found.entry === undefined && found.rest.length === 0) return { id: null, path: "/" };
        if (found.entry === undefined || found.rest.length > 0 || found.entry.kind !== "folder")
            throw new SurfaceError("not_found", `No folder is at ${JSON.stringify(path)}.`);
        return {
            id: found.entry.id,
            path: (await vaults.location(ctx, vaultId, found.entry.id)).path,
        };
    }

    /** A folder's files, or a zip's bundle, on the agent's machine, stored as artifact content. */
    async function readMachineBundle(ctx: Context, path: string): Promise<VaultContent> {
        const host = await machine(ctx);
        const permissions = compute.permissionsForContext(ctx);
        const root = compute.resolvePath(host, path);
        const facts = await host.fs.stat(permissions, root);
        if (facts.isFile) return vaults.zipBundle(ctx, await readMachineFile(ctx, path));
        if (!facts.isDirectory)
            throw new SurfaceError(
                "invalid_request",
                `${quoteVisibleExact(path)} is neither a folder nor a zip file.`,
            );
        const files: { path: string; bytes: Uint8Array }[] = [];
        let total = 0;
        const visit = async (folder: string, prefix: string): Promise<void> => {
            for (const name of await host.fs.readdir(permissions, folder)) {
                if (name === ".DS_Store" || name === "__MACOSX") continue;
                const child = `${folder.replace(/[\\/]$/, "")}/${name}`;
                const stat = await host.fs.lstat(permissions, child);
                if (stat.isSymbolicLink)
                    throw new SurfaceError(
                        "invalid_request",
                        `${quoteVisibleExact(child)} is a symbolic link.`,
                    );
                if (stat.isDirectory) await visit(child, `${prefix}${name}/`);
                else if (stat.isFile && stat.size > 0) {
                    total += stat.size;
                    if (files.length >= 256 || total > 256 * 1024 * 1024)
                        throw new SurfaceError(
                            "invalid_request",
                            "An artifact holds at most 256 files and 256 MiB.",
                        );
                    files.push({
                        path: `${prefix}${name}`,
                        bytes: await host.fs.readFileBuffer(permissions, child, {
                            maxBytes: 256 * 1024 * 1024,
                        }),
                    });
                }
            }
        };
        await visit(root, "");
        return vaults.storeBundle(ctx, files);
    }
}

function joinPath(root: string, relative: string): string {
    return root === "/" ? `/${relative}` : `${root}/${relative}`;
}

function describeActivity(item: { kind: string } & Record<string, unknown>): string {
    switch (item.kind) {
        case "created":
            return "created";
        case "moved":
            return item["fromParentId"] === item["toParentId"]
                ? `renamed from ${JSON.stringify(item["fromName"])} to ${JSON.stringify(item["toName"])}`
                : `moved from another folder as ${JSON.stringify(item["toName"])}`;
        case "deleted":
            return "moved to the Trash";
        case "restored":
            return "restored from the Trash";
        case "version_created":
            return `made v${String(item["number"])}${item["restoredFrom"] === null ? "" : ` from v${String(item["restoredFrom"])}`}`;
        case "pinned":
        case "unpinned":
            return `${item.kind} v${String(item["number"])}`;
        default:
            return "changed";
    }
}

/** Exact replacement with the uniqueness rule the file tools use. */
function replaceText(
    content: string,
    path: string,
    oldText: string,
    newText: string,
    all: boolean,
): string {
    if (oldText === newText)
        throw new SurfaceError(
            "invalid_request",
            "The replacement is identical to the text it replaces.",
        );
    if (oldText.length === 0)
        throw new SurfaceError(
            "invalid_request",
            "old_string is empty; name the text to replace, or write the whole file with write_vault_file.",
        );
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0)
        throw new SurfaceError(
            "invalid_request",
            `This text does not appear in ${JSON.stringify(path)}.`,
        );
    if (occurrences > 1 && !all)
        throw new SurfaceError(
            "invalid_request",
            `This text appears ${String(occurrences)} times in ${JSON.stringify(path)}. Add surrounding context to make it unique, or replace every occurrence.`,
        );
    return all
        ? content.replaceAll(oldText, () => newText)
        : content.replace(oldText, () => newText);
}

function formatFileRead(read: FileRead): readonly SessionOutputBlock[] {
    const header = `${JSON.stringify(read.path)} at version ${String(read.version)}: ${read.mediaType}, ${formatSize(read.size)}.`;
    if (read.image !== undefined)
        return [
            { type: "text", text: header },
            { type: "image", data: read.image.data, mimeType: read.image.mimeType },
        ];
    if (read.text === undefined)
        return [{ type: "text", text: `${header} ${read.note ?? ""}`.trim() }];
    const lines = [
        read.totalLines === 0
            ? `${header} (empty file)`
            : read.returnedLines === 0
              ? `${header} It has ${String(read.totalLines)} lines, so nothing follows line ${String((read.startLine ?? 1) - 1)}.`
              : `${header} Lines ${String(read.startLine)}–${String((read.startLine ?? 1) + (read.returnedLines ?? 0) - 1)} of ${String(read.totalLines)}:`,
    ];
    if (read.text !== "") lines.push(read.text);
    if (read.nextOffset !== undefined)
        lines.push(`[More follows; read on with offset ${String(read.nextOffset)}.]`);
    return [{ type: "text", text: lines.join("\n") }];
}
