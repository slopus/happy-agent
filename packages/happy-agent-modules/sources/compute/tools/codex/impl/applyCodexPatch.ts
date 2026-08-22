import type { Context } from "@steve.kite/stdlib";

import type { Compute, ComputePermissions } from "../../../Compute.js";
import type {
    ComputeFileDiffHunk,
    ComputeFileDiffPresentation,
} from "../../../ComputeToolPresentation.js";
import { BoundedFileDiffCollector } from "../../../impl/BoundedFileDiffCollector.js";
import { computePermissionsForContext } from "../../../impl/computePermissionsForContext.js";
import { deleteComputeFile } from "../../../impl/deleteComputeFile.js";
import type { FileReadLog } from "../../../../impl/FileReadLog.js";
import { moveComputeFile } from "../../../impl/moveComputeFile.js";
import { iterateDiffContentLines } from "../../../impl/iterateDiffContentLines.js";
import { resolveComputePath } from "../../../impl/resolveComputePath.js";
import { writeComputeTextFile } from "../../../impl/writeComputeTextFile.js";
import { parseCodexPatch, type CodexPatchHunk } from "./parseCodexPatch.js";

/** One file the patch changed, named both as the patch wrote it and as the machine sees it. */
export interface CodexPatchChange {
    readonly kind: "add" | "delete" | "move" | "update";
    readonly path: string;
    readonly moved_to?: string;
}

/** What a whole patch did. */
export interface CodexPatchResult {
    readonly changes: CodexPatchChange[];
    readonly summary: string;
    readonly presentation: ComputeFileDiffPresentation;
}

/** One file as the patch will leave it, before anything has been written. */
interface SimulatedFile {
    content: string;
    exists: boolean;
}

interface AppliedPatchHunks {
    readonly content: string;
    readonly hunks: ComputeFileDiffHunk[];
}

/** One change decided during the dry run and carried out afterwards. */
type PlannedChange =
    | { readonly kind: "add"; readonly path: string; readonly content: string }
    | { readonly kind: "delete"; readonly path: string }
    | {
          readonly kind: "update";
          readonly path: string;
          readonly content: string;
          readonly provenByContext: boolean;
      }
    | {
          readonly kind: "move";
          readonly path: string;
          readonly destination: string;
          readonly content: string;
          readonly contentChanged: boolean;
          readonly provenByContext: boolean;
      };

/**
 * Whether these hunks had to match the file to apply at all.
 *
 * A hunk that removes or quotes a line proves the agent is working from what the file really
 * holds: if any of those lines were not there, the patch was refused before a byte was written.
 * A hunk made only of additions proves nothing about the file's existing contents.
 */
function hunksProveFileContents(hunks: readonly CodexPatchHunk[]): boolean {
    return (
        hunks.length > 0 && hunks.every((hunk) => hunk.lines.some((line) => line.marker !== "+"))
    );
}

/**
 * Apply one Codex patch to the machine.
 *
 * The patch is read, resolved and simulated in full before a single file is written, so a patch
 * whose third hunk does not match leaves the machine exactly as it was rather than half-changed.
 * Every file it then touches goes through the module's own write, move, and delete helpers, so
 * the staleness check and the file read log apply to a patch as they apply to any other change.
 *
 * Existing files need no prior logged read. A patch whose hunks quote current lines uses that
 * match as its freshness proof. Appends and deletions consult any remembered timestamp but are
 * also allowed when the file has no read-log entry.
 */
export async function applyCodexPatch(
    compute: Compute,
    reads: FileReadLog,
    ctx: Context,
    options: { readonly patch: string; readonly workdir?: string },
): Promise<CodexPatchResult> {
    const permissions = computePermissionsForContext(ctx);
    const workdir = resolveComputePath(
        options.workdir ?? compute.cwd,
        compute.cwd,
        compute.fs.home,
    );
    const operations = parseCodexPatch(options.patch);
    const fileDiffs = new BoundedFileDiffCollector();
    const simulated = new Map<string, SimulatedFile>();
    const planned: PlannedChange[] = [];
    const summaries: string[] = [];

    for (const operation of operations) {
        const path = resolveComputePath(operation.path, workdir, compute.fs.home);
        const file = await loadSimulatedFile(compute, permissions, simulated, path);

        if (operation.kind === "add") {
            if (file.exists) {
                throw new Error(`This patch adds a file that already exists: ${path}`);
            }
            file.content = operation.lines.join("\n");
            file.exists = true;
            planned.push({ kind: "add", path, content: file.content });
            fileDiffs.addWholeFile(operation.path, "add", operation.lines);
            summaries.push(`A ${operation.path}`);
            continue;
        }

        if (operation.kind === "delete") {
            if (!file.exists) {
                throw new Error(`This patch deletes a file that does not exist: ${path}`);
            }
            await reads.assertRead(ctx, compute.fs, permissions, path);
            const deletedContent = file.content;
            file.content = "";
            file.exists = false;
            planned.push({ kind: "delete", path });
            fileDiffs.addWholeFile(
                operation.path,
                "delete",
                iterateDiffContentLines(deletedContent),
            );
            summaries.push(`D ${operation.path}`);
            continue;
        }

        if (!file.exists) {
            throw new Error(`This patch updates a file that does not exist: ${path}`);
        }
        const provenByContext = hunksProveFileContents(operation.hunks);
        if (!provenByContext) {
            await reads.assertRead(ctx, compute.fs, permissions, path);
        }
        const sourceContent = file.content;
        const updated = applyCodexPatchHunks(sourceContent, operation.hunks, path);

        if (operation.moveTo === undefined) {
            if (updated.content === file.content) {
                throw new Error(`This update changes nothing in ${path}.`);
            }
            file.content = updated.content;
            planned.push({ kind: "update", path, content: updated.content, provenByContext });
            fileDiffs.add({ kind: "update", path: operation.path, hunks: updated.hunks });
            summaries.push(`M ${operation.path}`);
            continue;
        }

        const destination = resolveComputePath(operation.moveTo, workdir, compute.fs.home);
        if (destination === path) {
            throw new Error(`This patch moves ${path} onto itself.`);
        }
        const target = await loadSimulatedFile(compute, permissions, simulated, destination);
        if (target.exists) {
            throw new Error(`This patch moves a file onto one that already exists: ${destination}`);
        }
        const contentChanged = updated.content !== file.content;
        file.content = "";
        file.exists = false;
        target.content = updated.content;
        target.exists = true;
        planned.push({
            kind: "move",
            path,
            destination,
            content: updated.content,
            contentChanged,
            provenByContext,
        });
        fileDiffs.addWholeFile(operation.path, "delete", iterateDiffContentLines(sourceContent));
        fileDiffs.addWholeFile(operation.moveTo, "add", iterateDiffContentLines(updated.content));
        summaries.push(`M ${operation.path}`);
    }

    const changes: CodexPatchChange[] = [];
    for (const change of planned) {
        if (change.kind === "add" || change.kind === "update") {
            await writeComputeTextFile(compute, reads, ctx, {
                path: change.path,
                content: change.content,
                // The hunks matched the file before anything was planned, so a remembered
                // timestamp does not add another useful freshness check.
                ...(change.kind === "update" && change.provenByContext
                    ? { requireRead: false }
                    : {}),
            });
            changes.push({ kind: change.kind, path: change.path });
            continue;
        }
        if (change.kind === "delete") {
            await deleteComputeFile(compute, reads, ctx, { path: change.path });
            changes.push({ kind: "delete", path: change.path });
            continue;
        }
        await moveComputeFile(compute, reads, ctx, {
            source: change.path,
            destination: change.destination,
            ...(change.provenByContext ? { requireRead: false } : {}),
        });
        // The move records the destination, so the following rewrite checks the state just moved.
        if (change.contentChanged) {
            await writeComputeTextFile(compute, reads, ctx, {
                path: change.destination,
                content: change.content,
            });
        }
        changes.push({ kind: "move", path: change.path, moved_to: change.destination });
    }

    return {
        changes,
        summary: ["Success. Updated the following files:", ...summaries].join("\n"),
        presentation: fileDiffs.finish(),
    };
}

/** What one file holds right now, remembered so several hunks can build on each other. */
async function loadSimulatedFile(
    compute: Compute,
    permissions: ComputePermissions,
    simulated: Map<string, SimulatedFile>,
    path: string,
): Promise<SimulatedFile> {
    const known = simulated.get(path);
    if (known !== undefined) return known;
    const exists = await compute.fs.exists(permissions, path);
    if (exists) {
        const stat = await compute.fs.stat(permissions, path);
        if (stat.isDirectory) {
            throw new Error(`This patch changes a directory, which it cannot do: ${path}`);
        }
    }
    const file: SimulatedFile = {
        content: exists ? await compute.fs.readFile(permissions, path) : "",
        exists,
    };
    simulated.set(path, file);
    return file;
}

/**
 * Work one file's hunks through its text.
 *
 * Hunks are applied in the order the patch wrote them and each search begins where the last one
 * finished, so a patch changing the same short line twice changes the two places it meant rather
 * than the first one twice. A hunk that does not match is refused outright: guessing at where the
 * model meant is how a patch quietly lands in the wrong function.
 */
function applyCodexPatchHunks(
    content: string,
    hunks: readonly CodexPatchHunk[],
    path: string,
): AppliedPatchHunks {
    const document = splitDocument(content);
    const lines = [...document.lines];
    const diffHunks: ComputeFileDiffHunk[] = [];
    let cursor = 0;
    let priorLineDelta = 0;
    for (const hunk of hunks) {
        const remove: string[] = [];
        const add: string[] = [];
        const diffLines: ComputeFileDiffHunk["lines"][number][] = [];
        for (const line of hunk.lines) {
            if (line.marker !== "+") remove.push(line.text);
            if (line.marker !== "-") add.push(line.text);
            diffLines.push({
                kind: line.marker === "+" ? "add" : line.marker === "-" ? "delete" : "context",
                text: line.text,
            });
        }
        let searchFrom = cursor;
        if (hunk.anchor !== undefined) {
            const anchorAt = seekLines(lines, [hunk.anchor], searchFrom, false);
            if (anchorAt < 0) {
                throw new Error(
                    `This patch looks for "${hunk.anchor}" in ${path}, and it is not there.`,
                );
            }
            searchFrom = anchorAt + 1;
        }
        const at =
            remove.length === 0
                ? lines.length
                : seekLines(lines, remove, searchFrom, hunk.endOfFile);
        if (at < 0) {
            throw new Error(`This patch hunk does not match anything in ${path}.`);
        }
        diffHunks.push({
            lines: diffLines,
            newStart: Math.max(1, at + 1),
            oldStart: Math.max(1, at - priorLineDelta + 1),
        });
        lines.splice(at, remove.length, ...add);
        cursor = at + add.length;
        priorLineDelta += add.length - remove.length;
    }
    return {
        content: joinDocument(lines, document.eol, document.hasFinalNewline),
        hunks: diffHunks,
    };
}

/**
 * Where a run of lines appears, searching forward from a cursor.
 *
 * An exact match is looked for first and trailing or surrounding whitespace is forgiven only
 * afterwards, so a file that really does contain what the patch quoted is never matched against
 * some other, sloppier place.
 */
function seekLines(
    lines: readonly string[],
    pattern: readonly string[],
    start: number,
    endOfFile: boolean,
): number {
    if (pattern.length === 0) return Math.min(start, lines.length);
    if (pattern.length > lines.length) return -1;
    const lastStart = lines.length - pattern.length;
    const searchStart = Math.max(0, endOfFile ? lastStart : start);
    const normalizers: readonly ((value: string) => string)[] = [
        (value) => value,
        (value) => value.trimEnd(),
        (value) => value.trim(),
    ];
    for (const normalize of normalizers) {
        for (let index = searchStart; index <= lastStart; index += 1) {
            let matched = true;
            for (let offset = 0; offset < pattern.length; offset += 1) {
                if (normalize(lines[index + offset] ?? "") !== normalize(pattern[offset] ?? "")) {
                    matched = false;
                    break;
                }
            }
            if (matched) return index;
        }
    }
    return -1;
}

/** Split a file into lines while remembering how it ends its lines, so a write puts them back. */
function splitDocument(content: string): {
    readonly eol: string;
    readonly hasFinalNewline: boolean;
    readonly lines: readonly string[];
} {
    if (content.length === 0) return { eol: "\n", hasFinalNewline: false, lines: [] };
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const normalized = content.replace(/\r\n/g, "\n");
    const hasFinalNewline = normalized.endsWith("\n");
    const lines = normalized.split("\n");
    if (hasFinalNewline) lines.pop();
    return { eol, hasFinalNewline, lines };
}

/** Put the file back together the way it was written. */
function joinDocument(lines: readonly string[], eol: string, hasFinalNewline: boolean): string {
    if (lines.length === 0) return "";
    return lines.join(eol) + (hasFinalNewline ? eol : "");
}
