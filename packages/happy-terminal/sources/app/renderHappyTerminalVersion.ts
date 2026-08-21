const VERSION_GLYPHS: Readonly<Record<string, readonly string[]>> = {
    "0": [" ██████╗ ", "██╔═████╗", "██║██╔██║", "████╔╝██║", "╚██████╔╝", " ╚═════╝ "],
    "1": [" ██╗", "███║", "╚██║", " ██║", " ██║", " ╚═╝"],
    "2": ["██████╗ ", "╚════██╗", " █████╔╝", "██╔═══╝ ", "███████╗", "╚══════╝"],
    "3": ["██████╗ ", "╚════██╗", " █████╔╝", " ╚═══██╗", "██████╔╝", "╚═════╝ "],
    "4": ["██╗  ██╗", "██║  ██║", "███████║", "╚════██║", "     ██║", "     ╚═╝"],
    "5": ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
    "6": [" ██████╗ ", "██╔════╝ ", "███████╗ ", "██╔═══██╗", "╚██████╔╝", " ╚═════╝ "],
    "7": ["███████╗", "╚════██║", "    ██╔╝", "   ██╔╝ ", "   ██║  ", "   ╚═╝  "],
    "8": [" █████╗ ", "██╔══██╗", "╚█████╔╝", "██╔══██╗", "╚█████╔╝", " ╚════╝ "],
    "9": [" █████╗ ", "██╔══██╗", "╚██████║", " ╚═══██║", " █████╔╝", " ╚════╝ "],
    ".": ["   ", "   ", "   ", "   ", "██╗", "╚═╝"],
};

export function renderHappyTerminalVersion(version: string, width: number): string[] {
    const glyphs = [...version].map((character) => VERSION_GLYPHS[character]);
    if (width < 40 || glyphs.some((glyph) => glyph === undefined)) {
        return [version.slice(0, width)];
    }

    const chunks: Array<Array<readonly string[]>> = [];
    let chunk: Array<readonly string[]> = [];
    for (const glyph of glyphs as Array<readonly string[]>) {
        const candidate = [...chunk, glyph];
        const candidateWidth = Math.max(
            ...Array.from({ length: 6 }, (_, rowIndex) =>
                candidate.reduce((rowWidth, item) => rowWidth + (item[rowIndex]?.length ?? 0), 0),
            ),
        );
        if (chunk.length > 0 && candidateWidth > width) {
            chunks.push(chunk);
            chunk = [glyph];
        } else {
            chunk = candidate;
        }
    }
    if (chunk.length > 0) chunks.push(chunk);

    return chunks.flatMap((items) => {
        const rows = Array.from({ length: 6 }, (_, rowIndex) =>
            items
                .map((glyph) => glyph[rowIndex] ?? "")
                .join("")
                .trimEnd(),
        );
        while (rows[0] === "") rows.shift();
        while (rows.at(-1) === "") rows.pop();
        return rows;
    });
}
