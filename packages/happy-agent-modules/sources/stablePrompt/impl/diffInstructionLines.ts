/** One run of lines that differs between two versions of the instructions. */
export interface InstructionsHunk {
    /** Lines of the earlier text that are gone. */
    readonly removed: readonly string[];
    /** Lines of the current text that took their place, or were added where nothing stood. */
    readonly added: readonly string[];
}

/** Beyond this many cell comparisons the changed region is reported as one replacement. */
const MAX_COMPARISONS = 4_000_000;

/**
 * What changed between two versions of the instructions, line by line.
 *
 * Instructions are written one rule to a line, so a line is the smallest piece a model can be
 * told to forget or to follow. Blank lines carry no instruction and are ignored: a section that
 * appears or disappears must not be reported as a change in spacing.
 */
export function diffInstructionLines(before: string, after: string): readonly InstructionsHunk[] {
    const old = meaningfulLines(before);
    const now = meaningfulLines(after);
    let start = 0;
    while (start < old.length && start < now.length && old[start] === now[start]) start += 1;
    let oldEnd = old.length;
    let nowEnd = now.length;
    while (oldEnd > start && nowEnd > start && old[oldEnd - 1] === now[nowEnd - 1]) {
        oldEnd -= 1;
        nowEnd -= 1;
    }
    const removed = old.slice(start, oldEnd);
    const added = now.slice(start, nowEnd);
    if (removed.length === 0 && added.length === 0) return [];
    if (removed.length * added.length > MAX_COMPARISONS) return [{ removed, added }];
    return hunks(removed, added);
}

function meaningfulLines(text: string): string[] {
    return text.split("\n").filter((line) => line.trim().length > 0);
}

/** Group the lines outside the longest common subsequence into consecutive replacements. */
function hunks(old: readonly string[], now: readonly string[]): InstructionsHunk[] {
    const width = now.length + 1;
    // lengths[i * width + j] is the longest common subsequence of old[i..] and now[j..].
    const lengths = new Uint32Array((old.length + 1) * width);
    for (let i = old.length - 1; i >= 0; i -= 1) {
        for (let j = now.length - 1; j >= 0; j -= 1) {
            lengths[i * width + j] =
                old[i] === now[j]
                    ? lengths[(i + 1) * width + j + 1]! + 1
                    : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
        }
    }
    const result: InstructionsHunk[] = [];
    let removed: string[] = [];
    let added: string[] = [];
    const close = (): void => {
        if (removed.length === 0 && added.length === 0) return;
        result.push({ removed, added });
        removed = [];
        added = [];
    };
    let i = 0;
    let j = 0;
    while (i < old.length || j < now.length) {
        if (i < old.length && j < now.length && old[i] === now[j]) {
            close();
            i += 1;
            j += 1;
        } else if (
            j >= now.length ||
            (i < old.length && lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
        ) {
            removed.push(old[i]!);
            i += 1;
        } else {
            added.push(now[j]!);
            j += 1;
        }
    }
    close();
    return result;
}
