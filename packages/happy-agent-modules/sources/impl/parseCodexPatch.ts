/** The four lines that name a file inside a patch. */
const DIRECTIVES: readonly { readonly kind: CodexPatchDirectiveKind; readonly prefix: string }[] = [
    { kind: "add", prefix: "*** Add File: " },
    { kind: "delete", prefix: "*** Delete File: " },
    { kind: "update", prefix: "*** Update File: " },
    { kind: "move", prefix: "*** Move to: " },
];

export type CodexPatchDirectiveKind = "add" | "delete" | "move" | "update";

/** A directive line, split into what it does and which file it names. */
export interface CodexPatchDirective {
    readonly kind: CodexPatchDirectiveKind;
    readonly path: string;
}

/** One line of an update hunk, as the patch format writes it. */
export interface CodexPatchHunkLine {
    readonly marker: " " | "-" | "+";
    readonly text: string;
}

/** One run of changes inside a file, and where in that file it is looked for. */
export interface CodexPatchHunk {
    /** The text after `@@`, when the patch named a place to search from. */
    readonly anchor?: string;
    /** The hunk was marked `*** End of File`, so it matches only at the very end. */
    readonly endOfFile: boolean;
    readonly lines: readonly CodexPatchHunkLine[];
}

/** One file's worth of the patch, in the order the patch wrote it. */
export type CodexPatchOperation =
    | { readonly kind: "add"; readonly path: string; readonly lines: readonly string[] }
    | { readonly kind: "delete"; readonly path: string }
    | {
          readonly kind: "update";
          readonly path: string;
          readonly moveTo?: string;
          readonly hunks: readonly CodexPatchHunk[];
      };

/** Read one directive line, or nothing when the line is not a directive. */
export function parseCodexPatchDirective(line: string): CodexPatchDirective | undefined {
    for (const directive of DIRECTIVES) {
        if (line.startsWith(directive.prefix)) {
            return { kind: directive.kind, path: line.slice(directive.prefix.length) };
        }
    }
    return undefined;
}

/**
 * Turn Codex's patch text into the file operations it describes.
 *
 * Nothing is resolved against the filesystem here and nothing is applied: this is only the reading
 * of the format, so that a malformed patch is refused with a sentence naming what is wrong rather
 * than half-applied and then discovered. Every complaint names the file it is about, because a
 * patch touching several files otherwise leaves the model guessing which one it wrote badly.
 * Anything written after `*** End Patch` is refused too: the model meant something by it, and
 * applying the part before it while dropping the rest is the half-application this refuses.
 */
export function parseCodexPatch(patch: string): readonly CodexPatchOperation[] {
    const lines = patch.replace(/\r\n/g, "\n").split("\n");
    if (lines[0] !== "*** Begin Patch") {
        throw new Error("This patch is missing its `*** Begin Patch` first line.");
    }
    if (!lines.includes("*** End Patch")) {
        throw new Error("This patch is missing its `*** End Patch` last line.");
    }

    const operations: CodexPatchOperation[] = [];
    let index = 1;
    let endIndex: number | undefined;
    while (index < lines.length) {
        const line = lines[index] ?? "";
        if (line === "*** End Patch") {
            endIndex = index;
            break;
        }
        const directive = parseCodexPatchDirective(line);
        if (directive === undefined || directive.kind === "move") {
            throw new Error(`This is not a patch directive: ${line}`);
        }
        index += 1;

        if (directive.kind === "add") {
            const body: string[] = [];
            while (index < lines.length && !(lines[index] ?? "").startsWith("*** ")) {
                const added = lines[index] ?? "";
                if (!added.startsWith("+")) {
                    throw new Error(
                        `Every line of an added file must start with "+": ${directive.path}`,
                    );
                }
                body.push(added.slice(1));
                index += 1;
            }
            operations.push({ kind: "add", path: directive.path, lines: body });
            continue;
        }

        if (directive.kind === "delete") {
            operations.push({ kind: "delete", path: directive.path });
            continue;
        }

        const move = parseCodexPatchDirective(lines[index] ?? "");
        const moveTo = move?.kind === "move" ? move.path : undefined;
        if (moveTo !== undefined) index += 1;
        const hunks: CodexPatchHunk[] = [];
        while (index < lines.length && !(lines[index] ?? "").startsWith("*** ")) {
            const header = lines[index] ?? "";
            if (header !== "@@" && !header.startsWith("@@ ")) {
                throw new Error(`An update hunk must begin with "@@": ${directive.path}`);
            }
            const anchor = header === "@@" ? undefined : header.slice(3);
            index += 1;
            const hunkLines: CodexPatchHunkLine[] = [];
            while (
                index < lines.length &&
                !(lines[index] ?? "").startsWith("@@") &&
                !(lines[index] ?? "").startsWith("*** ")
            ) {
                const patchLine = lines[index] ?? "";
                const marker = patchLine.slice(0, 1);
                if (marker !== " " && marker !== "-" && marker !== "+") {
                    throw new Error(
                        `Every line of an update hunk must start with a space, "-", or "+": ${directive.path}`,
                    );
                }
                hunkLines.push({ marker, text: patchLine.slice(1) });
                index += 1;
            }
            const endOfFile = lines[index] === "*** End of File";
            if (endOfFile) index += 1;
            hunks.push({
                ...(anchor === undefined ? {} : { anchor }),
                endOfFile,
                lines: hunkLines,
            });
        }
        if (hunks.length === 0) {
            throw new Error(`This update has no hunks, so it changes nothing: ${directive.path}`);
        }
        operations.push({
            kind: "update",
            path: directive.path,
            ...(moveTo === undefined ? {} : { moveTo }),
            hunks,
        });
    }

    if (endIndex !== undefined) {
        const trailing = lines.slice(endIndex + 1).find((line) => line.trim().length > 0);
        if (trailing !== undefined) {
            throw new Error(
                `This patch has content after its \`*** End Patch\` last line: ${trailing}`,
            );
        }
    }
    if (operations.length === 0) throw new Error("This patch changes no files.");
    return operations;
}
