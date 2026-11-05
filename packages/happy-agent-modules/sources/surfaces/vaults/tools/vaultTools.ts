import { defineAgentTool, cuid2Schema, type AgentModuleScope } from "@slopus/happy-agent-base";
import {
    isVaultArtifactName,
    surfaceIdSchema,
    VAULT_ARTIFACT_MANIFEST_PATH,
    vaultItemSchema,
    vaultPathSchema,
    type VaultArtifactManifest,
    type VaultItem,
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
import { MAX_MANIFEST_BYTES, parseArtifactManifest } from "../vaultBundle.js";
import { readContent } from "../vaultContentFiles.js";
import { vaultPath, vaultPathSegments } from "../vaultNames.js";
import { writeZip } from "../zip/writeZip.js";
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
/** How many items glob and grep look at below one folder. */
const MAX_SCANNED_ITEMS = 20_000;

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
    fileId: Type.String(),
    kind: Type.Union([Type.Literal("file"), Type.Literal("artifact")]),
    version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    created: Type.Boolean(),
    folders: Type.Array(Type.String()),
});
const textOutputSchema = Type.Object({ text: Type.String() });
const itemResultSchema = Type.Object({ item: vaultItemSchema, path: Type.String() });
const folderResultSchema = Type.Object({
    path: Type.String(),
    folderId: Type.String(),
    created: Type.Boolean(),
    folders: Type.Array(Type.String()),
});

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

/** How a vault tool describes the folders and files it lists. */
function describeItem(entry: VaultItem): string {
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
                'Lists a vault folder like ls: its live folders, first and ending in /, then its files with their kinds, sizes, newest version numbers, and change times. depth (1–10, default 1) also lists what is inside the folders below. An artifact is a small web site kept as one file whose name ends in ".artifact"; listing one lists the files of its newest version. At most 1,000 lines. Paths start with / at the vault\'s root and match names case-insensitively.',
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
                if (entry?.kind === "file") return { text: `${path}: ${describeItem(entry)}` };
                if (entry?.kind === "artifact") {
                    const latest = await vaults.version(ctx, input.surfaceId, entry.id, "latest");
                    const files = latest.artifact?.files ?? [];
                    return {
                        text: [
                            `${path}: ${describeItem(entry)}. Its files:`,
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
                const children = new Map<string | null, VaultItem[]>();
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
                        lines.push(`${indent}${describeItem(child)}`);
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
                            ? ["[More items were left out; list a folder below this one.]"]
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
            description: `Reads a vault file by its path, or a file inside an artifact, such as "/Sites/launch.artifact/index.html" where launch.artifact is an artifact. Text comes back as numbered lines: a line number, then a tab, then the line, numbered from 1, up to ${String(MAX_LINES_TO_READ)} lines from offset. Raster images are shown to you; other binary files are described without their bytes. version reads an earlier version of the file, or of the artifact holding it; list them with list_vault_versions.`,
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
                '- A path that runs into an artifact, such as "/Sites/launch.artifact/style.css", adds or replaces that file in the artifact\'s next version. Make a new artifact with write_vault_artifact.',
                "- Prefer edit_vault_file to change part of an existing file. Copy binary files in with import_vault_file. Make an empty folder with create_vault_folder.",
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
                            `No file is at ${JSON.stringify(input.path)}.`,
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
                'Finds vault folders and files whose paths match a glob, relative to path (default "/"): * and ? within one name, ** across folders, [abc] for one of several characters, and {a,b} for alternatives, such as "**/*.pdf". Matching ignores case. Returns at most 200 paths, most recently changed first, folders ending in /. Files inside artifacts are not matched; list an artifact with list_vault.',
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
                    MAX_SCANNED_ITEMS,
                );
                const matcher = vaultGlob(input.pattern);
                const matches = entries
                    .filter((item) => matcher.test(item.relative))
                    .sort((left, right) => right.entry.updatedAt - left.entry.updatedAt);
                if (matches.length === 0)
                    return {
                        text: `Nothing below ${root.path} matches ${JSON.stringify(input.pattern)}.`,
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
                            ? [`[More paths matched; narrow the pattern or the folder.]`]
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
                    MAX_SCANNED_ITEMS,
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
                        ? ["[The folder holds more items than one search covers; narrow path.]"]
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
            name: "create_vault_folder",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["create vault folder", "new vault folder", "vault mkdir"],
            description:
                "Creates an empty folder in a vault at path, with any missing folders above it, like mkdir -p. A folder already at path is reported and left as it is. Folders stay until they are deleted, even when empty.",
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter('The folder\'s path, such as "/Reports/Q3"'),
                },
                { additionalProperties: false },
            ),
            returnType: folderResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input, call) => {
                requireVaultWrites(ctx);
                const found = await vaults.walk(ctx, input.surfaceId, input.path);
                if (found.entry === undefined && found.rest.length === 0)
                    throw new SurfaceError(
                        "invalid_request",
                        "The vault's root is always there; name a folder inside it.",
                    );
                if (found.entry !== undefined && found.entry.kind !== "folder")
                    throw new SurfaceError(
                        "invalid_request",
                        found.rest.length === 0
                            ? `${JSON.stringify(input.path)} is a file, not a folder.`
                            : `${JSON.stringify(found.entry.name)} is a file, so no folder can be inside it.`,
                    );
                const existing = found.entry;
                if (existing !== undefined)
                    return ctx.inTx(async (tx) =>
                        call.commit(tx, {
                            path: (await vaults.location(tx, input.surfaceId, existing.id)).path,
                            folderId: existing.id,
                            created: false,
                            folders: [],
                        }),
                    );
                const base = vaultPathSegments(input.path).slice(
                    0,
                    vaultPathSegments(input.path).length - found.rest.length,
                );
                const actor = await change(ctx);
                return ctx.inTx(async (tx) => {
                    const folderId = await vaults.ensureFolders(
                        tx,
                        input.surfaceId,
                        found.parentId,
                        found.rest,
                        actor,
                    );
                    return call.commit(tx, {
                        path: (await vaults.location(tx, input.surfaceId, folderId!)).path,
                        folderId: folderId!,
                        created: true,
                        folders: found.rest.map((_, index) =>
                            vaultPath([...base, ...found.rest.slice(0, index + 1)]),
                        ),
                    });
                });
            },
            toLLM: (result) =>
                text(
                    result.created
                        ? `Created ${result.folders.map((folder) => JSON.stringify(folder)).join(", ")}.`
                        : `The folder ${JSON.stringify(result.path)} already exists; nothing changed.`,
                ),
        }),
        moveTool("file"),
        moveTool("folder"),
        defineAgentTool({
            name: "copy_vault_file",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: [
                "copy vault file",
                "duplicate vault file",
                "copy between vaults",
                "copy vault artifact",
            ],
            description:
                "Copies a vault file or artifact, any size, to toPath as a new file whose history starts at version 1 with the copied version's content; no bytes are uploaded or rewritten. toSurfaceId copies into another vault (default this one); version copies an earlier version (default the newest). An artifact's copy keeps a name ending in \".artifact\", and a plain file's copy may not take one. Folders and files inside an artifact cannot be copied. Missing folders above toPath are created, and nothing may be at toPath.",
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter("The file or artifact to copy"),
                    toPath: vaultPathParameter("The copy's path, including its name"),
                    toSurfaceId: Type.Optional(
                        Type.String({
                            ...surfaceIdSchema,
                            description: "The vault to copy into; defaults to surfaceId",
                        }),
                    ),
                    version: Type.Optional(Type.Integer({ minimum: 1 })),
                },
                { additionalProperties: false },
            ),
            returnType: writeResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input, call) => {
                requireVaultWrites(ctx);
                const source = await itemAt(ctx, input.surfaceId, input.path);
                if (source.kind === "folder")
                    throw new SurfaceError(
                        "invalid_request",
                        `${JSON.stringify(input.path)} is a folder; copy the files in it one by one.`,
                    );
                const targetId = input.toSurfaceId ?? input.surfaceId;
                const found = await vaults.walk(ctx, targetId, input.toPath);
                if (found.rest.length === 0)
                    throw new SurfaceError(
                        "invalid_request",
                        found.entry === undefined
                            ? "toPath must name the copy."
                            : `Something is already at ${JSON.stringify(input.toPath)}.`,
                    );
                if (found.entry !== undefined)
                    throw new SurfaceError(
                        "invalid_request",
                        `${JSON.stringify(found.entry.name)} is not a folder, so nothing can be copied inside it.`,
                    );
                const actor = await change(ctx);
                return ctx.inTx(async (tx) =>
                    call.commit(
                        tx,
                        await placeNew(
                            tx,
                            vaults,
                            targetId,
                            found.parentId,
                            found.rest,
                            {
                                type: "copy",
                                fileId: source.id,
                                version: input.version ?? "latest",
                            },
                            actor,
                            input.toPath,
                        ),
                    ),
                );
            },
            toLLM: (result) =>
                text(
                    `Copied it to ${JSON.stringify(result.path)}, a new ${result.kind === "artifact" ? "artifact" : "file"} at version 1.${result.folders.length === 0 ? "" : ` Created ${result.folders.map((folder) => JSON.stringify(folder)).join(", ")}.`}`,
                ),
        }),
        deleteTool("file"),
        deleteTool("folder"),
        defineAgentTool({
            name: "list_vault_trash",
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: ["vault trash", "deleted vault files", "recover vault file"],
            description:
                "Lists a vault's Trash, most recent first: each deleted folder or file, marked as which it is, with its ID, where it was, and when it was deleted. Restore a file with restore_vault_file and a folder with restore_vault_folder.",
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
                            ({ item, path }) =>
                                `${item.kind === "folder" ? "folder" : "file"}  ${item.id}  ${path}${item.kind === "folder" ? "/" : ""}  deleted ${new Date(item.deletedAt ?? 0).toISOString()}`,
                        ),
                        ...(nextPageCursor === null ? [] : ["[Older Trash items were left out.]"]),
                    ].join("\n"),
                };
            },
            toLLM: (result) => text(result.text),
        }),
        restoreTool("file"),
        restoreTool("folder"),
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
                const entry = await itemAt(ctx, input.surfaceId, input.path);
                if (entry.kind === "folder")
                    throw new SurfaceError(
                        "invalid_request",
                        `${JSON.stringify(input.path)} is a folder, and folders have no versions.`,
                    );
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
                'Copies a file on your machine into a vault exactly as it is, binary files included, creating missing folders: a new file, the next version of the file at path, or a file added to the artifact path runs into. When path ends in ".artifact", the file must be a .artifact file and makes that artifact or its next version. A zip stays a zip file; make an artifact from one with write_vault_artifact. Files up to 512 MiB. To copy within or between vaults, use copy_vault_file.',
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
                const found = await vaults.walk(ctx, input.surfaceId, input.path);
                const names = vaultPathSegments(input.path);
                if (
                    names.length > 0 &&
                    isVaultArtifactName(names.at(-1)!) &&
                    (found.rest.length === 0
                        ? found.entry !== undefined
                        : found.entry === undefined)
                ) {
                    const content = await vaults.zipBundle(ctx, bytes, true);
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
                                      { type: "stored", content },
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
                }
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
                "Copies a vault file, or an earlier version of it, to toPath on your machine, replacing a file there. An artifact is written as its .artifact file, a zip holding its files and manifest that uploads back as the same artifact; with unpack it is written as a folder of its files at toPath instead, which must not exist yet or be an empty folder. Files up to 512 MiB.",
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter("The file or artifact in the vault"),
                    toPath: machinePath("Where to write it on your machine"),
                    version: Type.Optional(Type.Integer({ minimum: 1 })),
                    unpack: Type.Optional(
                        Type.Boolean({
                            description:
                                "Write an artifact as a folder of its files rather than its .artifact file",
                        }),
                    ),
                },
                { additionalProperties: false },
            ),
            returnType: textOutputSchema,
            durable: true,
            shouldReviewInAutoMode: (input, ctx) => crosses(ctx, input.toPath, true),
            shouldRunInFullAccessInAutoMode: (input, ctx) => crosses(ctx, input.toPath, true),
            describeAutoPermissionAction: (input) =>
                `writing vault ${JSON.stringify(input.surfaceId)} file ${JSON.stringify(input.path)} to ${quoteVisibleExact(input.toPath)} on this machine. Access: filesystem write of that path`,
            execute: async (ctx, input) => {
                const host = await machine(ctx);
                const permissions = compute.permissionsForContext(ctx);
                const target = compute.resolvePath(host, input.toPath);
                const entry = await itemAt(ctx, input.surfaceId, input.path);
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
                if (input.unpack !== true) {
                    const zip = await vaults.zip(ctx, input.surfaceId, {
                        type: "version",
                        fileId: entry.id,
                        selector: version.number,
                    });
                    const chunks: Buffer[] = [];
                    for await (const chunk of writeZip(zip.items)) chunks.push(chunk);
                    const bytes = Buffer.concat(chunks);
                    await host.fs.writeFile(permissions, target, bytes);
                    return {
                        text: `Wrote version ${String(version.number)} of artifact ${JSON.stringify(input.path)} as a .artifact file (${formatSize(bytes.length)}) to ${quoteVisibleExact(input.toPath)}.`,
                    };
                }
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
                'Creates an artifact, a small static web site kept as one vault file, at path, which must end in ".artifact", or makes the next version of the artifact there whose files are exactly those given. Pass files, a list of {"path", "content"} UTF-8 text files, or fromPath, a folder, a .zip, or a .artifact file on your machine. The bundle needs "index.html" (an html site) or "index.md" (a Markdown document) at its root; up to 256 files and 256 MiB, every file at least one byte. "artifact.json" at the root is the manifest of a .artifact file: it is refused in files, and read as the manifest from a folder or zip. Missing folders above path are created.',
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter(
                        'The artifact\'s path, such as "/Sites/launch.artifact"',
                    ),
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
                    fromPath: Type.Optional(
                        machinePath("A folder, a .zip, or a .artifact file on your machine"),
                    ),
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
                const names = vaultPathSegments(input.path);
                if (names.length === 0 || !isVaultArtifactName(names.at(-1)!))
                    throw new SurfaceError(
                        "invalid_request",
                        'An artifact\'s path ends in ".artifact", such as "/Sites/launch.artifact".',
                    );
                const found = await vaults.walk(ctx, input.surfaceId, input.path);
                if (found.rest.length > 0 && found.entry !== undefined)
                    throw new SurfaceError(
                        "invalid_request",
                        `${JSON.stringify(found.entry.name)} is not a folder.`,
                    );
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
                                  { type: "stored", content },
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

    async function itemAt(ctx: Context, vaultId: string, path: string): Promise<VaultItem> {
        const found = await vaults.walk(ctx, vaultId, path);
        if (found.entry === undefined || found.rest.length > 0)
            throw new SurfaceError("not_found", `Nothing is at ${JSON.stringify(path)}.`);
        return found.entry;
    }

    /** The folder or file at a path, refusing the other kind with a pointer to its own tool. */
    async function kindAt(
        ctx: Context,
        vaultId: string,
        path: string,
        kind: "file" | "folder",
        tool: string,
    ): Promise<VaultItem> {
        const item = await itemAt(ctx, vaultId, path);
        if ((item.kind === "folder") !== (kind === "folder"))
            throw new SurfaceError(
                "invalid_request",
                `${JSON.stringify(path)} is ${item.kind === "folder" ? "a folder" : "a file"}; use ${tool}_vault_${item.kind === "folder" ? "folder" : "file"}.`,
            );
        return item;
    }

    /** A live folder named by a path's parent, or the root; it must already exist. */
    async function parentOf(
        ctx: Context,
        vaultId: string,
        names: readonly string[],
        hint: string,
    ): Promise<string | null> {
        if (names.length === 1) return null;
        const parent = await vaults.walk(ctx, vaultId, vaultPath(names.slice(0, -1)));
        if (parent.entry === undefined || parent.rest.length > 0 || parent.entry.kind !== "folder")
            throw new SurfaceError(
                "not_found",
                `No folder is at ${JSON.stringify(vaultPath(names.slice(0, -1)))}${hint}.`,
            );
        return parent.entry.id;
    }

    function moveTool(kind: "file" | "folder") {
        const noun = kind === "file" ? "file" : "folder";
        return defineAgentTool({
            name: `move_vault_${kind}`,
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: [`move vault ${noun}`, `rename vault ${noun}`],
            description:
                kind === "file"
                    ? "Renames or moves a vault file or artifact from path to toPath. The folder above toPath must already exist, and nothing may be at toPath; the move never replaces anything. An artifact's name keeps ending in \".artifact\", and a plain file's may not. Moving keeps the file's versions and history. Move folders with move_vault_folder."
                    : "Renames or moves a vault folder, with everything inside it, from path to toPath. The folder above toPath must already exist, and nothing may be at toPath; the move never replaces anything. Move files with move_vault_file.",
            parameters: Type.Object(
                {
                    surfaceId,
                    path: vaultPathParameter(`The ${noun} to move`),
                    toPath: vaultPathParameter("Its new path, including its name"),
                },
                { additionalProperties: false },
            ),
            returnType: itemResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input, call) => {
                requireVaultWrites(ctx);
                const item = await kindAt(ctx, input.surfaceId, input.path, kind, "move");
                const names = vaultPathSegments(input.toPath);
                if (names.length === 0)
                    throw new SurfaceError("invalid_request", `toPath must name the ${noun}.`);
                const parentId = await parentOf(ctx, input.surfaceId, names, "; create it first");
                return ctx.inTx(async (tx) => {
                    const moved = await vaults.moveEntry(
                        tx,
                        input.surfaceId,
                        item.id,
                        item.version,
                        { name: names.at(-1)!, parentId },
                        await change(tx),
                    );
                    return call.commit(tx, {
                        item: moved,
                        path: (await vaults.location(tx, input.surfaceId, moved.id)).path,
                    });
                });
            },
            toLLM: (result) => text(`Moved it; it is now at ${JSON.stringify(result.path)}.`),
        });
    }

    function deleteTool(kind: "file" | "folder") {
        return defineAgentTool({
            name: `delete_vault_${kind}`,
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords:
                kind === "file"
                    ? ["delete vault file", "trash vault file", "delete vault artifact"]
                    : ["delete vault folder", "trash vault folder", "remove vault folder"],
            description:
                kind === "file"
                    ? "Moves a vault file or artifact to the vault's Trash. It can be restored with restore_vault_file until the vault's Trash time runs out. Delete folders with delete_vault_folder."
                    : "Moves a vault folder, with everything inside it, to the vault's Trash. It can be restored with restore_vault_folder until the vault's Trash time runs out. Delete files with delete_vault_file.",
            parameters: Type.Object(
                { surfaceId, path: vaultPathParameter(`The ${kind} to delete`) },
                { additionalProperties: false },
            ),
            returnType: itemResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input, call) => {
                requireVaultWrites(ctx);
                const item = await kindAt(ctx, input.surfaceId, input.path, kind, "delete");
                return ctx.inTx(async (tx) =>
                    call.commit(tx, {
                        item: await vaults.deleteEntry(
                            tx,
                            input.surfaceId,
                            item.id,
                            item.version,
                            await change(tx),
                        ),
                        path: input.path,
                    }),
                );
            },
            toLLM: (result) =>
                text(
                    `Moved ${JSON.stringify(result.path)} to the Trash; restore it with restore_vault_${kind} and ${kind}Id ${result.item.id}.`,
                ),
        });
    }

    function restoreTool(kind: "file" | "folder") {
        const idKey = kind === "file" ? "fileId" : "folderId";
        return defineAgentTool({
            name: `restore_vault_${kind}`,
            defer: true,
            capabilities: [CAPABILITY],
            searchKeywords: [
                `restore vault ${kind}`,
                `undelete vault ${kind}`,
                "vault trash restore",
            ],
            description:
                kind === "file"
                    ? "Restores a file or artifact from the Trash, by its ID from list_vault_trash, to where it was, or to toPath, whose folder must exist. Restore folders with restore_vault_folder."
                    : "Restores a folder from the Trash, by its ID from list_vault_trash, to where it was, or to toPath, whose folder must exist. Everything inside it comes back with it, except what was deleted on its own before. Restore files with restore_vault_file.",
            parameters: Type.Object(
                {
                    surfaceId,
                    [idKey]: cuid2Schema,
                    toPath: Type.Optional(
                        vaultPathParameter("Where to restore it, including its name"),
                    ),
                },
                { additionalProperties: false },
            ),
            returnType: itemResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, rawInput, call) => {
                requireVaultWrites(ctx);
                const input = rawInput as { surfaceId: string; toPath?: string } & Record<
                    string,
                    string
                >;
                const { entry } = await vaults.location(ctx, input.surfaceId, input[idKey]!);
                if ((entry.kind === "folder") !== (kind === "folder"))
                    throw new SurfaceError(
                        "invalid_request",
                        `That ID belongs to ${entry.kind === "folder" ? "a folder; use restore_vault_folder" : "a file; use restore_vault_file"}.`,
                    );
                let target: { name?: string; parentId?: string | null } = {};
                if (input.toPath !== undefined) {
                    const names = vaultPathSegments(input.toPath);
                    if (names.length === 0)
                        throw new SurfaceError("invalid_request", `toPath must name the ${kind}.`);
                    target = {
                        name: names.at(-1)!,
                        parentId: await parentOf(ctx, input.surfaceId, names, ""),
                    };
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
                        item: restored,
                        path: (await vaults.location(tx, input.surfaceId, restored.id)).path,
                    });
                });
            },
            toLLM: (result) => text(`Restored it to ${JSON.stringify(result.path)}.`),
        });
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

    /**
     * A folder's files, or a zip's bundle, on the agent's machine, stored as artifact content.
     * `artifact.json` at the root of either is read as the manifest.
     */
    async function readMachineBundle(ctx: Context, path: string): Promise<VaultContent> {
        const host = await machine(ctx);
        const permissions = compute.permissionsForContext(ctx);
        const root = compute.resolvePath(host, path);
        const facts = await host.fs.stat(permissions, root);
        if (facts.isFile) return vaults.zipBundle(ctx, await readMachineFile(ctx, path), false);
        if (!facts.isDirectory)
            throw new SurfaceError(
                "invalid_request",
                `${quoteVisibleExact(path)} is neither a folder nor a zip file.`,
            );
        const files: { path: string; bytes: Uint8Array }[] = [];
        let manifest: VaultArtifactManifest | undefined;
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
                else if (stat.isFile && prefix === "" && name === VAULT_ARTIFACT_MANIFEST_PATH) {
                    if (stat.size > MAX_MANIFEST_BYTES)
                        throw new SurfaceError(
                            "invalid_request",
                            `${quoteVisibleExact(child)} is too large to be a manifest.`,
                        );
                    manifest = parseArtifactManifest(
                        await host.fs.readFileBuffer(permissions, child, {
                            maxBytes: MAX_MANIFEST_BYTES,
                        }),
                    );
                } else if (stat.isFile && stat.size > 0) {
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
        return vaults.storeBundle(ctx, files, [], manifest);
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
