export function containsMarkdownTable(text: string): boolean {
    const lines = text.split("\n");
    let fence: { character: string; length: number } | undefined;
    let previousCells: string[] = [];

    for (const line of lines) {
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
        if (fence !== undefined) {
            if (fenceMatch?.[1]?.[0] === fence.character && fenceMatch[1].length >= fence.length) {
                fence = undefined;
            }
            previousCells = [];
            continue;
        }
        if (fenceMatch?.[1] !== undefined) {
            fence = { character: fenceMatch[1][0] ?? "", length: fenceMatch[1].length };
            previousCells = [];
            continue;
        }

        const cells = tableCells(line);
        if (
            previousCells.length >= 2 &&
            cells.length === previousCells.length &&
            cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
        ) {
            return true;
        }
        previousCells = cells;
    }
    return false;
}

function tableCells(line: string): string[] {
    const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
    if (!trimmed.includes("|")) return [];
    return trimmed.split("|").map((cell) => cell.trim());
}
